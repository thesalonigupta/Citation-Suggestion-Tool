/**
 * InlineAnnotator.gs
 *
 * Alternative to CommentWriter.gs. Drive API v3's quotedFileContent (used
 * by CommentWriter) is not a reliable anchoring mechanism -- Google Docs
 * frequently can't re-verify the quoted text and shows the comment as
 * anchored to "deleted" content even though the comment body itself is
 * fully intact. This module instead uses DocumentApp's native text-search
 * and formatting APIs directly on the document body: it finds the exact
 * flagged sentence, highlights it with a tier-colored background, and
 * inserts a short bracketed marker immediately after it.
 *
 * Tradeoff: this edits the document body (adds highlight color + marker
 * text) rather than staying purely in the separate comments layer. It
 * guarantees correct positioning, at the cost of being slightly more
 * visually intrusive than a real comment thread. Markers are still just
 * suggestions in visible bracketed text -- nothing is auto-inserted as an
 * actual citation, preserving the human-review requirement.
 *
 * Re-running: call clearInlineAnnotations() (Main.gs) before annotating a
 * doc that was already annotated, or annotate() will skip sentences that
 * already have a marker immediately following them.
 */

var InlineAnnotator = (function () {

  var MARKER_PREFIX = '\u27E6CITE-SUGGEST'; // ⟦CITE-SUGGEST -- rare bracket char, unlikely to occur naturally
  var MARKER_SUFFIX = '\u27E7'; // ⟧

  var TIER_COLORS = {
    HIGH: { bg: '#d9ead3', fg: '#38761d' },
    MEDIUM: { bg: '#fff2cc', fg: '#bf9000' },
    WEAK: { bg: '#fce5cd', fg: '#b45f06' },
    RERANKED: { bg: '#e8d5f5', fg: '#6a329f' },
    CONTEXTUAL: { bg: '#cfe2f3', fg: '#1155cc' },
    NO_MATCH: { bg: '#f4cccc', fg: '#cc0000' }
  };

  function annotate(docId, results) {
    var doc = DocumentApp.openById(docId);
    var bodyText = doc.getBody().editAsText();

    // Read the ENTIRE body text exactly once, before making any edits.
    // Searching against this single snapshot (via plain JS regex, not
    // repeated bodyText.findText() calls) avoids a real bug found in
    // testing: Apps Script's Text object does not reliably reflect
    // preceding insertText() calls to a subsequent findText() call within
    // the same execution. Calling findText() fresh before each insertion
    // (the original approach) caused later searches to match inside text
    // that an earlier iteration had *just* inserted, producing badly
    // nested, word-splitting corruption instead of correct placement.
    var fullText = bodyText.getText();

    var located = [];
    var notFound = 0, skipped = 0;

    results.forEach(function (r) {
      // No length cap here: earlier versions truncated to 300 chars to
      // protect against Apps Script's own findText() regex limits, but
      // this implementation searches with a plain JS RegExp against a
      // full-text snapshot instead (no such limit applies), and the cap
      // was observed to truncate a legitimate 309-char sentence mid-word,
      // splitting "affective" into "affectiv" + marker + "e states."
      var searchText = r.sentenceInfo.text;
      var pattern = escapeRegex_(searchText);

      var match;
      try {
        match = new RegExp(pattern).exec(fullText);
      } catch (e) {
        Logger.log('Regex failed for "%s...": %s', searchText.substring(0, 60), e);
        notFound++;
        return;
      }

      if (!match) {
        Logger.log('Could not locate sentence in doc body: "%s..."', searchText.substring(0, 60));
        notFound++;
        return;
      }

      var startOffset = match.index;
      var endOffsetInclusive = match.index + match[0].length - 1;
      var checkStart = endOffsetInclusive + 1;

      if (fullText.substr(checkStart, MARKER_PREFIX.length) === MARKER_PREFIX) {
        skipped++; // already annotated in a previous pass
        return;
      }

      located.push({ result: r, startOffset: startOffset, endOffsetInclusive: endOffsetInclusive });
    });

    // Apply all edits in REVERSE document order (highest offset first).
    // Every offset was computed against the untouched original text, so
    // inserting from the end backwards guarantees each edit's own offset
    // is still valid at the moment it's applied -- nothing after it in
    // the document (which is all that could shift) has been touched yet.
    located.sort(function (a, b) { return b.startOffset - a.startOffset; });

    located.forEach(function (item) {
      var r = item.result;
      var colors = TIER_COLORS[r.tier] || TIER_COLORS.NO_MATCH;

      bodyText.setBackgroundColor(item.startOffset, item.endOffsetInclusive, colors.bg);

      var marker = buildMarker_(r);
      bodyText.insertText(item.endOffsetInclusive + 1, marker);

      var markerStart = item.endOffsetInclusive + 1;
      var markerEnd = markerStart + marker.length - 1;
      bodyText.setForegroundColor(markerStart, markerEnd, colors.fg);
      bodyText.setBold(markerStart, markerEnd, true);
      bodyText.setFontSize(markerStart, markerEnd, 9);
      bodyText.setBackgroundColor(markerStart, markerEnd, null);
    });

    var annotated = located.length;
    Logger.log('Inline annotation -- annotated: %s, not found: %s, already annotated: %s', annotated, notFound, skipped);
    return { annotated: annotated, notFound: notFound, skipped: skipped };
  }

  function buildMarker_(result) {
    var main;
    if (result.contextualCitationText) {
      main = 'carried over: ' + result.contextualCitationText;
    } else if (result.matches.length) {
      var top = result.matches[0];
      main = formatShortCitation_(top) + ' (score ' + top.score.toFixed(2) + ')';
    } else {
      main = 'no strong match -- verify manually';
    }

    var reason = result.verdict.reasons[0] || '';
    var text = ' ' + MARKER_PREFIX + ' [' + result.tier + '] ' + main +
      (reason ? ' \u2014 ' + truncate_(reason, 50) : '') + MARKER_SUFFIX;

    return truncate_(text, 200);
  }

  function formatShortCitation_(match) {
    var authorLastName = (match.authors || 'Unknown').split(/[,;]/)[0].trim();
    return authorLastName + ', ' + (match.year || 'n.d.') + ' "' + truncate_(match.title, 40) + '"';
  }

  function truncate_(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    return text.substring(0, maxLen - 1) + '\u2026';
  }

  /**
   * Removes every marker inserted by annotate() and resets background
   * highlighting across the whole document body.
   *
   * CAVEAT: this clears ALL background color in the body, not just the
   * highlights this tool added -- if the document uses background
   * highlighting for anything else, that will be removed too. There's no
   * reliable way to distinguish "our highlight" from "pre-existing
   * highlight" once applied, since Apps Script doesn't let you tag a
   * formatting range with metadata.
   */
  function clearAnnotations(docId) {
    var doc = DocumentApp.openById(docId);
    var bodyText = doc.getBody().editAsText();

    var pattern = ' ?' + escapeRegex_(MARKER_PREFIX) + '.*?' + escapeRegex_(MARKER_SUFFIX);
    var removed = 0;
    var found;
    var safetyLimit = 1000;

    while ((found = bodyText.findText(pattern)) !== null && removed < safetyLimit) {
      bodyText.deleteText(found.getStartOffset(), found.getEndOffsetInclusive());
      removed++;
    }

    var fullLen = bodyText.getText().length;
    if (fullLen > 0) {
      bodyText.setBackgroundColor(0, fullLen - 1, null);
    }

    return removed;
  }

  return { annotate: annotate, clearAnnotations: clearAnnotations };
})();
