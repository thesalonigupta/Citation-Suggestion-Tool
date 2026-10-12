/**
 * SentenceState.gs
 *
 * Tracks which flagged sentences a human has explicitly dismissed, per
 * document, so re-running the tool doesn't re-surface the same rejected
 * suggestion forever. Modeled directly on the reference Chicago Citation
 * Assistant's `state.dismissed` registry (hash -> true), adapted for our
 * batch-pass architecture: since we don't have a live sidebar with a
 * Dismiss button, dismissal is triggered by calling markDismissed() with a
 * copy-pasted snippet of the sentence (e.g. from a comment or inline
 * marker the reviewer just read and rejected).
 *
 * Storage: Script Properties, keyed per document so dismissals in one doc
 * never bleed into another. Each doc's dismissed set is one JSON property
 * (hash -> true map) -- compact enough that realistic document sizes
 * (tens of flagged sentences) stay well within Script Properties' ~9KB
 * per-value limit.
 */

var SentenceState = (function () {

  var PROP_PREFIX = 'CITE_DISMISSED_';

  function propKey_(docId) {
    return PROP_PREFIX + docId;
  }

  function normalize_(text) {
    // Same normalization on both write and read so minor whitespace
    // differences (e.g. a trailing space picked up during copy-paste)
    // don't cause a dismissal to silently fail to match.
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function hash_(text) {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, normalize_(text));
    return digest.map(function (b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('');
  }

  function loadSet_(docId) {
    var raw = PropertiesService.getScriptProperties().getProperty(propKey_(docId));
    return raw ? JSON.parse(raw) : {};
  }

  function saveSet_(docId, set) {
    PropertiesService.getScriptProperties().setProperty(propKey_(docId), JSON.stringify(set));
  }

  /**
   * Marks a sentence dismissed for a given document. searchText can be the
   * full sentence or any substring unique enough to identify it among the
   * currently-flagged sentences passed in candidateSentences (typically
   * the tool's own last-run results) -- this lets a human dismiss by
   * pasting a short snippet copied from a comment/marker rather than
   * needing the sentence's exact full text.
   *
   * Returns the matched full sentence text on success, or null if no
   * unique match was found (ambiguous or not found -- caller should tell
   * the human to paste more context).
   */
  function markDismissed(docId, searchText, candidateSentences) {
    var needle = normalize_(searchText);
    var matches = (candidateSentences || []).filter(function (s) {
      return normalize_(s).indexOf(needle) !== -1;
    });

    if (matches.length === 0) {
      Logger.log('SentenceState: no flagged sentence matched "%s..." -- nothing dismissed.', searchText.substring(0, 60));
      return null;
    }
    if (matches.length > 1) {
      Logger.log('SentenceState: "%s..." matched %s different sentences -- ambiguous, paste more context.',
        searchText.substring(0, 60), matches.length);
      return null;
    }

    var set = loadSet_(docId);
    set[hash_(matches[0])] = true;
    saveSet_(docId, set);
    Logger.log('SentenceState: dismissed "%s..."', matches[0].substring(0, 60));
    return matches[0];
  }

  /** Direct dismissal by exact sentence text -- used internally and by markDismissed(). */
  function markDismissedExact(docId, sentenceText) {
    var set = loadSet_(docId);
    set[hash_(sentenceText)] = true;
    saveSet_(docId, set);
  }

  function isDismissed(docId, sentenceText) {
    var set = loadSet_(docId);
    return !!set[hash_(sentenceText)];
  }

  function clearDismissed(docId) {
    PropertiesService.getScriptProperties().deleteProperty(propKey_(docId));
    Logger.log('SentenceState: cleared all dismissed sentences for doc %s.', docId);
  }

  function countDismissed(docId) {
    return Object.keys(loadSet_(docId)).length;
  }

  return {
    markDismissed: markDismissed,
    markDismissedExact: markDismissedExact,
    isDismissed: isDismissed,
    clearDismissed: clearDismissed,
    countDismissed: countDismissed
  };
})();
