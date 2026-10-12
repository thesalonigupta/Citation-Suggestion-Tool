/**
 * Config.gs
 *
 * All the knobs live here. Values are read from Script Properties so the
 * same code can run against different docs / Zotero exports without editing
 * source. Set these once via:
 *   Project Settings > Script Properties, or
 *   the setup menu item added in Main.gs (run setConfig_(docId, csvId) from the editor)
 */

var CONFIG = {
  // Google Doc to scan. Leave blank to fall back to the active doc
  // (only works if this script is ever bound/opened against a doc via a
  // custom menu triggered from that doc's UI).
  DOC_ID_PROPERTY: 'CITE_DOC_ID',

  // Drive File ID(s) of the Zotero CSV export(s). a library is often split
  // across multiple collection exports (e.g. topic_A.csv, topic_B.csv)
  // -- stored as a list, all of them get combined into one TF-IDF index
  // (see ZoteroLibrary.loadMultiple). Add new ones as they show up rather
  // than replacing what's there; see addZoteroCsv_/removeZoteroCsv_ below.
  ZOTERO_CSV_IDS_PROPERTY: 'CITE_ZOTERO_CSV_IDS',

  // Confidence thresholds for the TF-IDF cosine similarity score (0-1).
  // Starting values -- expect to adjust after running against your own library.
  // WEAK exists to distinguish "some faint signal, worth a human glance"
  // from "genuinely nothing found" -- e.g. a correct source scored 0.154
  // against its own target sentence in testing, just under the 0.18 MEDIUM
  // cutoff; lumping that into a flat NO_MATCH threw away a real, if
  // uncertain, signal.
  MATCH_THRESHOLDS: {
    HIGH: 0.35,
    MEDIUM: 0.18,
    WEAK: 0.08
  },

  // How many candidate sources to surface per flagged sentence. Applies
  // uniformly before tier classification happens (matches are fetched
  // first, then classified into HIGH/MEDIUM/WEAK/NO_MATCH by score).
  MAX_CANDIDATES: {
    HIGH: 2,
    MEDIUM: 3
  },

  // Consensus/background claims ("citation stacking") get more
  // candidates surfaced since real citations here are routinely 2-5 sources.
  MAX_CANDIDATES_CONSENSUS: 5,

  // Comment text templates. {SENTENCE_STYLE} is filled in from the detected
  // doc citation style (see DocScanner.detectDocCitationStyle).
  COMMENT_PREFIX: '[Citation suggestion]',

  // Safety valve: don't touch documents automatically. Every run requires
  // the person to invoke it from the menu.
  DRY_RUN_DEFAULT: false,

  // ---- LLM detection (optional, off by default) ----------------------
  // Which detector runs the citation-need pass: 'RULE' uses RuleDetector.gs
  // (free, regex-based). 'LLM' uses LlmDetector.gs (costs a small amount
  // per call -- see LlmDetector.gs header for pricing detail). Rule-based
  // stays the default; LLM detection is opt-in.
  DETECTION_MODE: 'RULE',

  LLM_API_KEY_PROPERTY: 'CITE_CLAUDE_API_KEY',
  LLM_MODEL: 'claude-haiku-4-5-20251001',
  LLM_API_URL: 'https://api.anthropic.com/v1/messages',

  // How many sentences go into a single detection call. Found necessary in
  // testing: a real 793-sentence document sent as one giant batch produced
  // a response that got truncated mid-JSON at the old flat 4000-token cap,
  // losing every sentence's result to one parse failure. Chunking bounds
  // each call's output regardless of document size (Haiku 4.5's real
  // ceiling is 64,000 output tokens, but a single call anywhere near that
  // is both slow and fragile -- a bad chunk should only cost you that
  // chunk, not the whole document).
  LLM_BATCH_SIZE: 50,

  // Output budget for one batch. At ~50 sentences/batch, this gives roughly
  // 150 tokens/sentence of headroom (a verdict JSON object is typically
  // 20-40 tokens) -- comfortable margin without approaching Haiku 4.5's
  // 64,000-token ceiling.
  LLM_MAX_OUTPUT_TOKENS: 8000,

  // Per-sentence result cache TTL, in seconds. A sentence that hasn't
  // changed since the last run costs nothing on the next run -- this is
  // what makes cost-minimization structural rather than something to
  // remember. 6 hours covers same-day iterate-and-rerun cycles; bump this
  // (and consider PropertiesService instead of CacheService, which is
  // capped at 6 hours max) for longer-lived memoization across days.
  LLM_CACHE_TTL_SECONDS: 21600,

  // Hard monthly spend ceiling in USD. Once cumulative tracked spend
  // reaches this, LlmDetector refuses further calls and the caller should
  // fall back to RuleDetector rather than the run failing outright.
  LLM_MONTHLY_BUDGET_CAP_USD: 10.00,
  LLM_SPEND_PROPERTY: 'CITE_LLM_SPEND_MONTH',
  LLM_SPEND_MONTH_PROPERTY: 'CITE_LLM_SPEND_MONTH_LABEL'
};

function getClaudeApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty(CONFIG.LLM_API_KEY_PROPERTY);
  if (!key) {
    throw new Error(
      'No Claude API key set. Run setClaudeApiKey_("sk-ant-...") once from the editor, ' +
      'or set Script Property ' + CONFIG.LLM_API_KEY_PROPERTY + ' directly in Project Settings.'
    );
  }
  return key;
}

function setClaudeApiKey_(apiKey) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.LLM_API_KEY_PROPERTY, apiKey);
}

// ---- Web search matching (optional, off by default) --------------------
// Augments (does not replace) TfIdfMatcher/LlmDetector matching by letting
// Claude search the live web for a candidate source when the Zotero
// library doesn't have a confident match. Opt-in, separate budget from
// LLM detection so one can't silently cannibalize the other's cap.
CONFIG.WEB_SEARCH = {
  // 'OFF' -- never search. 'WEAK_AND_BELOW' -- only for WEAK/NO_MATCH tier
  // results (cheaper, targeted). 'ALL' -- search for every flagged
  // sentence regardless of TF-IDF/LLM tier, per explicit request -- catches
  // sources that may not be in the Zotero library at all, at the cost of
  // also re-querying sentences that already had a confident match.
  MODE: 'OFF',

  MODEL: 'claude-sonnet-5', // judging search-result relevance benefits from stronger reasoning than Haiku
  MAX_USES_PER_SENTENCE: 2, // caps runaway search chains on any one sentence
  MAX_ALLOWED_DOMAINS: 10,  // allowed_domains has practical limits; top N by frequency from the library

  MONTHLY_BUDGET_CAP_USD: 10.00, // deliberately separate from LLM_MONTHLY_BUDGET_CAP_USD
  SPEND_PROPERTY: 'CITE_WEBSEARCH_SPEND_MONTH',
  SPEND_MONTH_PROPERTY: 'CITE_WEBSEARCH_SPEND_MONTH_LABEL',

  SEARCH_FEE_PER_1000: 10.0 // $10 per 1,000 searches, billed separately from token usage
};

// ---- Free academic pre-filter (Google Books / OpenAlex / Crossref) -----
// Runs BEFORE the paid Claude web_search call in WebSearchMatcher.gs. No
// LLM call, no per-search fee -- just three free, keyless public APIs.
CONFIG.ACADEMIC_SEARCH = {
  // Optional: your email, sent as a 'mailto' param to OpenAlex/Crossref's
  // "polite pool" for more reliable service. Not required to function.
  CONTACT_EMAIL: '',

  // Optional: Script Property name holding a Google Books API key. The
  // keyless quota is shared across all users and can be exhausted; a key
  // makes Google Books results more reliable. Not required to function.
  GOOGLE_BOOKS_API_KEY_PROPERTY: 'CITE_GOOGLE_BOOKS_API_KEY',

  // A free-search candidate scoring at or above this threshold is treated
  // as confident enough to skip the paid Claude web_search call entirely
  // for that sentence -- this is the actual cost-saving mechanism. Tuned
  // from real testing: a correct, DOI-verified, author-matched result
  // scored 22; a wrong-author match (capped by design) scored 6. 12 sits
  // comfortably between those with room to tune as more real runs happen.
  SKIP_PAID_SEARCH_THRESHOLD: 12
};

// ---- Ambiguous-match reranking (optional, off by default) --------------
// Claude judges among TF-IDF's OWN candidates (no web search, no search
// fee) for the specific cases we've shown a formula alone gets wrong: WEAK
// tier results, and near-tied top-two scores even in MEDIUM/HIGH tier.
// Deliberately NOT applied to every sentence -- see WebSearchMatcher.gs's
// rerankAmbiguous() docstring for why.
CONFIG.RERANK = {
  MODE: 'OFF', // 'OFF' or 'ON'
  MODEL: 'claude-sonnet-5',

  // How close the top two TF-IDF scores need to be (as an absolute
  // difference) to count as a "near-tie" worth Claude's judgment, even in
  // a tier that would otherwise look confident on its own.
  AMBIGUITY_MARGIN: 0.05,

  MONTHLY_BUDGET_CAP_USD: 5.00, // separate from both LLM detection and web search caps
  SPEND_PROPERTY: 'CITE_RERANK_SPEND_MONTH',
  SPEND_MONTH_PROPERTY: 'CITE_RERANK_SPEND_MONTH_LABEL'
};

function getDocId_() {
  var id = PropertiesService.getScriptProperties().getProperty(CONFIG.DOC_ID_PROPERTY);
  if (!id) {
    throw new Error('No target Doc ID set. Run setConfig_(docId, csvId) first.');
  }
  return id;
}

function getZoteroCsvIds_() {
  var ids = listZoteroCsvs_();
  if (!ids.length) {
    throw new Error('No Zotero CSV file(s) set. Run setConfig_(docId, csvId) or addZoteroCsv_(id) first.');
  }
  return ids;
}

/** Non-throwing version, for display/management purposes (e.g. "here's what's currently configured"). */
function listZoteroCsvs_() {
  var raw = PropertiesService.getScriptProperties().getProperty(CONFIG.ZOTERO_CSV_IDS_PROPERTY);
  return raw ? JSON.parse(raw) : [];
}

/** Adds a CSV to the library list (deduped -- adding the same ID twice is a no-op). */
function addZoteroCsv_(csvId) {
  var ids = listZoteroCsvs_();
  if (ids.indexOf(csvId) === -1) {
    ids.push(csvId);
    PropertiesService.getScriptProperties().setProperty(CONFIG.ZOTERO_CSV_IDS_PROPERTY, JSON.stringify(ids));
    Logger.log('Added CSV %s to the library list (%s total now).', csvId, ids.length);
  } else {
    Logger.log('CSV %s is already in the library list -- no change.', csvId);
  }
  return ids;
}

/** Removes a CSV from the library list (e.g. a stale/superseded export). */
function removeZoteroCsv_(csvId) {
  var ids = listZoteroCsvs_().filter(function (id) { return id !== csvId; });
  PropertiesService.getScriptProperties().setProperty(CONFIG.ZOTERO_CSV_IDS_PROPERTY, JSON.stringify(ids));
  Logger.log('Removed CSV %s from the library list (%s remaining).', csvId, ids.length);
  return ids;
}

function setConfig_(docId, zoteroCsvId) {
  var props = PropertiesService.getScriptProperties();
  if (docId) props.setProperty(CONFIG.DOC_ID_PROPERTY, docId);
  // Kept for backward compatibility with the existing setConfig_(docId, csvId)
  // calling convention -- now ADDS the given CSV to the library list rather
  // than overwriting it, matching the "keep adding, don't keep replacing"
  // behavior. Use addZoteroCsv_/removeZoteroCsv_ directly for finer control.
  if (zoteroCsvId) addZoteroCsv_(zoteroCsvId);
}
