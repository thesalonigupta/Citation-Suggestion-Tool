/**
 * TextProcessing.gs
 *
 * Shared tokenization used by both ZoteroLibrary (indexing) and
 * TfIdfMatcher (querying), so the vector spaces are built consistently.
 *
 * Pipeline: lowercase -> synonym substitution -> strip punctuation ->
 * split on whitespace -> drop stopwords -> lightweight suffix-stripping
 * stem -> emit unigrams + bigrams.
 *
 * The stemmer here is a simplified suffix-stripper, not a full Porter
 * implementation -- good enough to collapse "argues/argued/arguing" and
 * "citations/citation" without pulling in an external library (keeping
 * with the no-external-dependency cost decision).
 */

var STOPWORDS = {};
[
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'for',
  'with', 'as', 'by', 'at', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'that', 'this', 'these', 'those', 'it', 'its', 'we', 'our', 'their',
  'they', 'he', 'she', 'his', 'her', 'them', 'which', 'who', 'whom', 'what',
  'not', 'no', 'so', 'than', 'then', 'there', 'here', 'such', 'also', 'into',
  'about', 'over', 'under', 'between', 'while', 'has', 'have', 'had', 'do',
  'does', 'did', 'can', 'could', 'may', 'might', 'will', 'would', 'should'
].forEach(function (w) { STOPWORDS[w] = true; });

function tokenize(text) {
  var lower = text.toLowerCase();
  lower = applySynonyms_(lower);
  var cleaned = lower.replace(/[^a-z0-9_\s]/g, ' ');
  var raw = cleaned.split(/\s+/).filter(function (t) { return t.length > 0; });

  var tokens = raw
    .filter(function (t) { return !STOPWORDS[t] && t.length > 1; })
    .map(stem_);

  return tokens;
}

/**
 * Returns unigrams + bigrams as a single flat token list. Bigrams are
 * joined with an underscore so they behave as distinct vector dimensions
 * from their component unigrams -- this is how "climate change" gets weighed
 * differently than "moral" and "status" appearing separately elsewhere.
 */
function tokenizeWithNgrams(text) {
  var unigrams = tokenize(text);
  var bigrams = [];
  for (var i = 0; i < unigrams.length - 1; i++) {
    bigrams.push(unigrams[i] + '_' + unigrams[i + 1]);
  }
  return unigrams.concat(bigrams);
}

/**
 * Simplified suffix-stripping stemmer. Handles the common English suffixes
 * that matter most for typical academic vocabulary (argue/argued/arguing,
 * citation/citations, ethical/ethics, etc.) without the full Porter rule
 * cascade.
 */
function stem_(word) {
  if (word.length <= 3) return word;

  var suffixes = [
    ['ational', 'ate'], ['tional', 'tion'], ['ization', 'ize'],
    ['fulness', 'ful'], ['ousness', 'ous'], ['iveness', 'ive'],
    ['ing', ''], ['edly', ''], ['ed', ''], ['ies', 'y'],
    ['ied', 'y'], ['ies', 'y'], ['es', ''], ['s', ''],
    ['ly', ''], ['ment', ''], ['ness', ''], ['ity', ''],
    ['ical', 'ic'], ['ive', ''], ['ous', '']
  ];

  for (var i = 0; i < suffixes.length; i++) {
    var suf = suffixes[i][0];
    var repl = suffixes[i][1];
    if (word.length > suf.length + 2 && word.slice(-suf.length) === suf) {
      return word.slice(0, -suf.length) + repl;
    }
  }
  return word;
}
