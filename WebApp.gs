/**
 * WebApp.gs
 *
 * Serves the citation tool as a web page (Deploy > New deployment > Web app).
 * The page takes a Google Doc link, runs the same pipeline as
 * runCitationPass()/runInlineAnnotationPass() (computeResults_ in Main.gs),
 * shows the flagged sentences, and lets the reviewer choose which ones to
 * highlight inline (InlineAnnotator, Mode B) or add as comments
 * (CommentWriter, Mode A).
 *
 * DEPLOYMENT IDENTITY: appsscript.json sets "executeAs": "USER_DEPLOYING"
 * and "access": "ANYONE_ANONYMOUS". The page runs as the account that
 * deployed it (the account with the docs), so it opens in any browser no
 * matter how many Google accounts are signed in there. Consequences:
 *   - it can reach exactly the docs and Zotero CSVs the DEPLOYING account
 *     can reach, for everyone who uses it;
 *   - highlights and comments are attributed to the deploying account;
 *   - anyone with the link can scan and highlight any doc that account can
 *     edit, so share the link only with the team.
 * Script Properties (doc-independent config: CSV IDs, Claude API key, spend
 * counters, dismissals, calibration stats) are shared as before.
 *
 * Nothing here changes how the existing editor entry points behave --
 * CONFIG overrides below are scoped to a single call and restored after.
 */

function doGet() {
  // The page lives in an HTML file named "Index". It can't be named
  // "WebApp": Apps Script won't allow a .gs and an .html file to share a name.
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Citation Scout')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Every page call sends {doc}. Returns the doc ID. */
function auth_(req) {
  return parseDocId_(req && req.doc);
}

/** Accepts a full Docs URL, a /d/<id>/ fragment, or a bare doc ID. */
function parseDocId_(input) {
  var s = String(input || '').trim();
  var m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || s.match(/^([a-zA-Z0-9_-]{20,})$/) || s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (!m) throw new Error('That doesn\'t look like a Google Doc link. Copy the link from the doc\'s address bar.');
  return m[1];
}

/** Runs fn with temporary CONFIG overrides, always restoring them. */
function withConfig_(overrides, fn) {
  var saved = {
    det: CONFIG.DETECTION_MODE,
    web: CONFIG.WEB_SEARCH.MODE,
    rerank: CONFIG.RERANK ? CONFIG.RERANK.MODE : null
  };
  if ('detection' in overrides) CONFIG.DETECTION_MODE = overrides.detection;
  if ('webSearch' in overrides) CONFIG.WEB_SEARCH.MODE = overrides.webSearch;
  if ('rerank' in overrides && CONFIG.RERANK) CONFIG.RERANK.MODE = overrides.rerank;
  try {
    return fn();
  } finally {
    CONFIG.DETECTION_MODE = saved.det;
    CONFIG.WEB_SEARCH.MODE = saved.web;
    if (CONFIG.RERANK) CONFIG.RERANK.MODE = saved.rerank;
  }
}

/** Plain-object version of a pipeline result, safe to send to the page. */
function serializeResult_(r) {
  return {
    text: r.sentenceInfo.text,
    tier: r.tier,
    reasons: r.verdict.reasons || [],
    isConsensusClaim: !!r.verdict.isConsensusClaim,
    contextualCitationText: r.contextualCitationText || null,
    matches: (r.matches || []).map(function (m) {
      return { title: m.title, authors: m.authors, year: m.year, score: m.score };
    }),
    rerank: r.rerankResult || null,
    web: r.webSearchCandidate || null
  };
}

/** Rebuilds the object shape InlineAnnotator/CommentWriter expect from what the page sends back. */
function deserializeResult_(o) {
  return {
    sentenceInfo: { text: String(o.text) },
    tier: o.tier,
    verdict: { reasons: o.reasons || [], isConsensusClaim: !!o.isConsensusClaim },
    matches: (o.matches || []).map(function (m) {
      return { title: m.title, authors: m.authors, year: m.year, score: Number(m.score) || 0 };
    }),
    contextualCitationText: o.contextualCitationText || null,
    rerankResult: o.rerank || null,
    webSearchCandidate: o.web || null
  };
}

/** Step 1: confirm the doc opens for this person, return its name. */
function apiCheckDoc(req) {
  var docId = auth_(req);
  var doc;
  try {
    doc = DocumentApp.openById(docId);
  } catch (e) {
    throw new Error('Couldn\'t open that doc. Share it (Editor access) with ' +
      (Session.getEffectiveUser().getEmail() || 'the account that deployed this tool') + '.');
  }
  return {
    docId: docId,
    name: doc.getName(),
    url: doc.getUrl(),
    user: Session.getEffectiveUser().getEmail() || '',
    libraries: listZoteroCsvs_().length,
    llmAvailable: !!PropertiesService.getScriptProperties().getProperty(CONFIG.LLM_API_KEY_PROPERTY)
  };
}

/**
 * Step 2: scan. options.detection is 'RULE' or 'LLM'. Web search and
 * reranking are switched OFF for the scan itself so a whole-document pass
 * stays inside Apps Script's 6-minute limit and doesn't spend the web
 * search budget on every flag; the page offers apiFindSource() per
 * sentence instead.
 */
function apiScan(req, options) {
  options = options || {};
  var docId = auth_(req);
  var csvIds = getZoteroCsvIds_();
  var detection = options.detection === 'LLM' ? 'LLM' : 'RULE';

  var computed = withConfig_({ detection: detection, webSearch: 'OFF', rerank: 'OFF' }, function () {
    return computeResults_(docId, csvIds);
  });

  return {
    docId: docId,
    style: computed.style,
    detection: detection,
    dismissedCount: SentenceState.countDismissed(docId),
    results: computed.results.map(serializeResult_)
  };
}

/**
 * Looks one sentence up beyond the Zotero library: free academic search
 * (Google Books / OpenAlex / Crossref) first, then Claude's paid web
 * search only if that isn't confident. Same code path and budget caps as
 * WebSearchMatcher.enrichResults in a normal run.
 */
function apiFindSource(req, item) {
  auth_(req); // validates input; the doc itself isn't needed here
  var library = ZoteroLibrary.loadMultiple(getZoteroCsvIds_());
  var r = deserializeResult_(item);
  if (!r.matches.length) {
    r.matches = TfIdfMatcher.topMatches(r.sentenceInfo.text, library, CONFIG.MAX_CANDIDATES.MEDIUM);
  }
  withConfig_({ webSearch: 'ALL' }, function () {
    WebSearchMatcher.enrichResults([r], library);
  });
  return r.webSearchCandidate || { found: false, reasoning: 'Nothing found.' };
}

/** Highlights the chosen sentences in the doc body and inserts a ⟦CITE-SUGGEST⟧ marker after each (Mode B). */
function apiHighlight(req, items) {
  var docId = auth_(req);
  return InlineAnnotator.annotate(docId, (items || []).map(deserializeResult_));
}

/**
 * Adds the chosen sentences as Drive comments (Mode A). Known limitation,
 * unchanged: Docs may show these as "Original content deleted" because
 * the Drive API can't anchor to a text range. The comment text is intact.
 */
function apiComment(req, items, style) {
  var docId = auth_(req);
  var written = 0, failed = 0;
  (items || []).forEach(function (o) {
    var r = deserializeResult_(o);
    var ok = CommentWriter.writeComment(docId, r.sentenceInfo.text, CommentWriter.buildCommentText(r, style || 'unknown'));
    if (ok) written++; else failed++;
  });
  return { written: written, failed: failed };
}

/** Dismisses one flag so future scans of this doc skip it; feeds CalibrationStats. */
function apiDismiss(req, item) {
  var docId = auth_(req);
  SentenceState.markDismissedExact(docId, String(item.text));
  CalibrationStats.recordDismissed(item.tier, item.reasons || []);
  return true;
}

/** Brings back every dismissed flag for this doc. */
function apiClearDismissed(req) {
  var docId = auth_(req);
  SentenceState.clearDismissed(docId);
  return true;
}

/** Removes all ⟦CITE-SUGGEST⟧ markers and ALL background highlighting in the doc body. */
function apiClearHighlights(req) {
  var docId = auth_(req);
  return InlineAnnotator.clearAnnotations(docId);
}
