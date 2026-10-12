/**
 * Main.gs
 *
 * Entry points. This is a standalone script (not container-bound), so there
 * is no automatic onOpen() in a specific doc. Two ways to run it:
 *
 *   1. From the Apps Script editor: run runCitationPass() directly.
 *   2. From any Doc you have edit access to: add a custom menu by running
 *      installMenuToActiveDoc() ONCE from the editor while that doc is open
 *      in another tab -- this adds a simple trigger-free menu for that
 *      session. (Standalone scripts can't auto-add menus to arbitrary docs
 *      without a container-bound onOpen, so this is a manual convenience,
 *      not a permanent installation.)
 *
 * Recommended day-to-day usage: run setupWizard() once to store the doc ID
 * and Zotero CSV ID, then run runCitationPass() before each review cycle.
 */

function setupWizard() {
  var ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (e) {
    // Not running from a bound context -- fall back to logging instructions.
  }
  Logger.log(
    'Standalone setup: call setConfig_(docId, csvId) to set the doc and add a CSV library ' +
    '(call it again with more csvId values to add additional libraries -- they all get combined), ' +
    'or addZoteroCsv_(csvId) / removeZoteroCsv_(csvId) to manage the library list directly.'
  );
}

/**
 * Main orchestration. Reads the target doc, runs the rule-based detector,
 * matches flagged sentences against the Zotero library via TF-IDF, and
 * writes confidence-tiered comments back to the doc via the Drive API.
 *
 * NOTE ON COMMENT ANCHORING: Drive API v3's quotedFileContent is the only
 * anchoring mechanism available to third-party scripts, and it is not a
 * reliable one -- Google Docs frequently can't re-verify the quoted text
 * and shows the comment as anchored to "deleted" content even though
 * nothing was deleted and the comment body itself is fully intact and
 * readable in the Comments panel. If you need guaranteed correct
 * positioning in the document body itself, use runInlineAnnotationPass()
 * instead (see InlineAnnotator.gs), which highlights the exact sentence
 * and inserts a suggestion marker using DocumentApp's native text-range
 * API rather than relying on Drive's comment anchor.
 */
function runCitationPass(options) {
  options = options || {};
  var dryRun = options.dryRun || CONFIG.DRY_RUN_DEFAULT;

  var docId = options.docId || getDocId_();
  var zoteroCsvIds = options.zoteroCsvIds || getZoteroCsvIds_();

  var computed = computeResults_(docId, zoteroCsvIds);
  var results = computed.results;

  if (dryRun) {
    Logger.log('DRY RUN -- no comments written. Results:');
    results.forEach(function (r) {
      Logger.log(
        '[%s] "%s..." -> %s candidate(s)',
        r.tier,
        r.sentenceInfo.text.substring(0, 80),
        r.matches.length
      );
    });
    return results;
  }

  var written = 0;
  results.forEach(function (r) {
    var commentText = CommentWriter.buildCommentText(r, computed.style);
    var ok = CommentWriter.writeComment(docId, r.sentenceInfo.text, commentText);
    if (ok) written++;
  });
  Logger.log('Wrote %s comments to the doc.', written);

  return results;
}

/**
 * Shared pipeline: load library, scan doc, run rule detection + list
 * context tracking, run TF-IDF matching. Used by both runCitationPass()
 * (Drive API comments) and runInlineAnnotationPass() (native highlights) so
 * the two modes can never disagree about which sentences got flagged or why.
 */
/**
 * Dispatches to whichever detector CONFIG.DETECTION_MODE selects, and
 * always returns a plain array of verdicts aligned 1:1 with the input
 * sentences array -- callers don't need to know or care which detector
 * actually produced them. Falls back to RuleDetector.gs automatically if
 * LLM mode hits its budget cap, rather than failing the whole run.
 */
function getVerdicts_(sentences, frameworkMentions) {
  if (CONFIG.DETECTION_MODE === 'LLM') {
    try {
      return LlmDetector.evaluateBatch(sentences);
    } catch (e) {
      Logger.log('LlmDetector unavailable (%s) -- falling back to RuleDetector.gs for this run.', e);
      // fall through to rule-based below
    }
  }
  return sentences.map(function (s) { return RuleDetector.evaluate(s, frameworkMentions); });
}

function computeResults_(docId, zoteroCsvIds) {
  Logger.log('Loading Zotero library from %s CSV file(s)...', zoteroCsvIds.length);
  var library = ZoteroLibrary.loadMultiple(zoteroCsvIds);
  Logger.log('Loaded %s combined library entries.', library.entries.length);

  Logger.log('Scanning doc %s...', docId);
  var scan = DocScanner.scan(docId);
  Logger.log('Doc citation style detected: %s', scan.style);
  Logger.log('Extracted %s sentences.', scan.sentences.length);

  var verdicts = getVerdicts_(scan.sentences, scan.frameworkMentions);

  var flagged = [];
  var dismissedCount = 0;
  var inFrameworkListContext = false;
  var sawListItemSinceTrigger = false;
  var contextualCitationText = null;
  scan.sentences.forEach(function (sentenceInfo, i) {
    var verdict = verdicts[i];
    var isContextOnlyFlag = false;

    // Section-reference carryover: "Reference in this section: (Author,
    // Year)" is an EXPLICIT authorial statement that the whole section
    // draws on one source -- stronger than an inference we're making, so
    // it's checked ahead of the list-item context logic below. Unlike the
    // list-item rule, this never forces a sentence to be flagged that the
    // detector didn't already flag -- it only supplies which citation to
    // point to once the detector has independently decided a sentence
    // needs one.
    var sectionContextText = sentenceInfo.sectionCitationText;
    if (sectionContextText && verdict.needsCitation) {
      verdict.reasons.push('section-scoped reference ("Reference in this section:" declaration)');
    }

    if (sentenceInfo.isListItem) {
      if (inFrameworkListContext && !verdict.needsCitation) {
        verdict.needsCitation = true;
        isContextOnlyFlag = true;
        verdict.reasons.push('list item following named-framework introduction (per-item citation rule)');
      }
      sawListItemSinceTrigger = true;
    } else {
      var triggersNow = verdict.reasons.some(function (r) {
        return r.indexOf('named-author framework introduction') !== -1 ||
          r.indexOf('first mention of named framework') !== -1 ||
          r.indexOf('first mention of known named framework') !== -1;
      });

      if (triggersNow) {
        inFrameworkListContext = true;
        sawListItemSinceTrigger = false;
        // Capture the citation already attached to the sentence that
        // introduced this framework/list, so context-only list items can
        // be pointed at it directly -- TF-IDF has no reliable way to match
        // a paraphrased list item back to the framework paper's abstract
        // (observed in testing: a paraphrased indicator item scored 0.0
        // against its own source paper despite being unambiguously part
        // of that paper's framework).
        contextualCitationText = DocScanner.extractCitationText(sentenceInfo.text);
      } else if (sawListItemSinceTrigger) {
        inFrameworkListContext = false;
        sawListItemSinceTrigger = false;
        contextualCitationText = null;
      }
    }

    var finalContextualCitationText = sectionContextText ||
      (isContextOnlyFlag ? contextualCitationText : null);

    if (verdict.needsCitation && !sentenceInfo.hasExistingCitation) {
      if (SentenceState.isDismissed(docId, sentenceInfo.text)) {
        dismissedCount++;
      } else {
        flagged.push({
          sentenceInfo: sentenceInfo,
          verdict: verdict,
          contextualCitationText: finalContextualCitationText
        });
      }
    }
  });
  Logger.log('%s sentences flagged as possibly needing citation (%s previously dismissed, skipped).',
    flagged.length, dismissedCount);

  var results = flagged.map(function (item) {
    var maxCandidates = item.verdict.isConsensusClaim
      ? CONFIG.MAX_CANDIDATES_CONSENSUS
      : CONFIG.MAX_CANDIDATES.MEDIUM;

    var matches = TfIdfMatcher.topMatches(item.sentenceInfo.text, library, maxCandidates);
    var tier = item.contextualCitationText ? 'CONTEXTUAL' : classifyTier_(matches);

    CalibrationStats.recordFlagged(tier, item.verdict.reasons);

    return {
      sentenceInfo: item.sentenceInfo,
      verdict: item.verdict,
      matches: matches,
      tier: tier,
      contextualCitationText: item.contextualCitationText
    };
  });

  Logger.log(
    'Tier breakdown -- high: %s, medium: %s, weak: %s, contextual: %s, no-match: %s',
    results.filter(function (r) { return r.tier === 'HIGH'; }).length,
    results.filter(function (r) { return r.tier === 'MEDIUM'; }).length,
    results.filter(function (r) { return r.tier === 'WEAK'; }).length,
    results.filter(function (r) { return r.tier === 'CONTEXTUAL'; }).length,
    results.filter(function (r) { return r.tier === 'NO_MATCH'; }).length
  );

  if (CONFIG.RERANK && CONFIG.RERANK.MODE !== 'OFF') {
    results = WebSearchMatcher.rerankAmbiguous(results);
    Logger.log('After reranking -- reranked: %s',
      results.filter(function (r) { return r.tier === 'RERANKED'; }).length);
  }

  if (CONFIG.WEB_SEARCH.MODE !== 'OFF') {
    results = WebSearchMatcher.enrichResults(results, library);
  }

  cacheLastRunSentences_(docId, results);

  return { results: results, style: scan.style };
}

/**
 * Caches the full sentence text of every sentence flagged in this run,
 * keyed per document. Cheap (plain strings, no re-computation) -- lets
 * dismissSuggestion() fuzzy-match a human-pasted snippet against the
 * actual full sentence text without re-running detection/matching (which,
 * in LLM detection mode, would cost real money just to look something up).
 */
/**
 * Caches the full sentence text, tier, and rule reasons of every sentence
 * flagged in this run, keyed per document. Cheap (small JSON, no
 * re-computation) -- lets dismissSuggestion() fuzzy-match a human-pasted
 * snippet against the actual full sentence text AND recover the tier/
 * reasons needed to record the dismissal for calibration, all without
 * re-running detection/matching (which, in LLM detection mode, would cost
 * real money just to look something up).
 */
function cacheLastRunSentences_(docId, results) {
  var entries = results.map(function (r) {
    return { text: r.sentenceInfo.text, tier: r.tier, reasons: r.verdict.reasons };
  });
  PropertiesService.getScriptProperties().setProperty(
    'CITE_LASTRUN_SENTENCES_' + docId, JSON.stringify(entries)
  );
}

function getLastRunSentences_(docId) {
  var raw = PropertiesService.getScriptProperties().getProperty('CITE_LASTRUN_SENTENCES_' + docId);
  return raw ? JSON.parse(raw) : [];
}

function classifyTier_(matches) {
  if (!matches.length) return 'NO_MATCH';
  var topScore = matches[0].score;
  if (topScore >= CONFIG.MATCH_THRESHOLDS.HIGH) return 'HIGH';
  if (topScore >= CONFIG.MATCH_THRESHOLDS.MEDIUM) return 'MEDIUM';
  if (topScore >= CONFIG.MATCH_THRESHOLDS.WEAK) return 'WEAK';
  return 'NO_MATCH';
}

/**
 * Convenience wrapper for testing against a doc without writing comments.
 */
function runDryRun() {
  return runCitationPass({ dryRun: true });
}

/**
 * Alternative to runCitationPass(): instead of Drive API comments (whose
 * anchoring is unreliable -- see the note on runCitationPass above),
 * highlights each flagged sentence directly in the document body and
 * inserts a short bracketed suggestion marker right after it, using
 * DocumentApp's native text-search and formatting APIs. This guarantees
 * correct positioning since it searches for and formats the sentence's
 * actual text range, but it does edit the document body (adds highlight
 * color + marker text) rather than staying purely in the comments layer.
 * Safe to re-run: call clearInlineAnnotations() first to remove markers
 * from a previous pass before annotating again, or annotateInline_ will
 * skip sentences that already have a marker immediately following them.
 */
function runInlineAnnotationPass(options) {
  options = options || {};
  var dryRun = options.dryRun || CONFIG.DRY_RUN_DEFAULT;

  var docId = options.docId || getDocId_();
  var zoteroCsvIds = options.zoteroCsvIds || getZoteroCsvIds_();

  var computed = computeResults_(docId, zoteroCsvIds);

  if (dryRun) {
    Logger.log('DRY RUN -- no annotations written. Results:');
    computed.results.forEach(function (r) {
      Logger.log('[%s] "%s..."', r.tier, r.sentenceInfo.text.substring(0, 80));
    });
    return computed.results;
  }

  var summary = InlineAnnotator.annotate(docId, computed.results);
  Logger.log(
    'Inline annotation complete -- highlighted: %s, not found in doc: %s',
    summary.annotated, summary.notFound
  );
  return computed.results;
}

/**
 * Removes all markers and highlight formatting inserted by a previous
 * runInlineAnnotationPass() call. Run this before re-annotating a doc
 * you've already annotated once, to avoid duplicate markers piling up.
 */
function clearInlineAnnotations() {
  var docId = getDocId_();
  var removed = InlineAnnotator.clearAnnotations(docId);
  Logger.log('Removed %s annotation marker(s).', removed);
  return removed;
}

/**
 * Dismisses a flagged sentence so future runs stop re-suggesting it.
 * Paste any unique substring of the sentence -- copied from a Drive
 * comment or an inline marker you just reviewed and rejected -- as
 * searchText. Matches against the sentences flagged in the MOST RECENT
 * run (cached by computeResults_, not re-computed here), so this never
 * triggers a fresh detection pass or costs anything, even in LLM mode.
 *
 * Returns the full sentence text that was dismissed, or null if the
 * snippet didn't match exactly one sentence from the last run (paste
 * more context, or run the tool again first if you haven't run it yet
 * in this session).
 */
function dismissSuggestion(searchText) {
  var docId = getDocId_();
  var candidates = getLastRunSentences_(docId);
  if (!candidates.length) {
    Logger.log('No cached sentences for this doc -- run runDryRun() or runCitationPass() at least once first.');
    return null;
  }

  var texts = candidates.map(function (c) { return c.text; });
  var matchedText = SentenceState.markDismissed(docId, searchText, texts);

  if (matchedText) {
    var matched = candidates.filter(function (c) { return c.text === matchedText; })[0];
    if (matched) {
      CalibrationStats.recordDismissed(matched.tier, matched.reasons);
    }
  }

  return matchedText;
}

/** Re-shows every previously dismissed suggestion for the current doc on the next run. */
function clearDismissedSuggestions() {
  var docId = getDocId_();
  SentenceState.clearDismissed(docId);
}

/** How many sentences are currently dismissed for the current doc. */
function countDismissedSuggestions() {
  var docId = getDocId_();
  var count = SentenceState.countDismissed(docId);
  Logger.log('%s sentence(s) currently dismissed for this doc.', count);
  return count;
}

/**
 * Prints the calibration report: which tiers and which rule reasons have
 * the highest dismissal rates, based on real dismissals across every doc
 * you've run this tool against. Only shows entries with enough
 * observations (see CalibrationStats.gs) to mean something. Worth
 * checking periodically -- a high dismissal rate on a specific tier or
 * rule is a concrete, measured signal to retune it, not a guess.
 */
function viewCalibrationReport() {
  return CalibrationStats.printReport();
}
