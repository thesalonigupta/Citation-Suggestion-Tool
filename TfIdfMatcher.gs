/**
 * TfIdfMatcher.gs
 *
 * Scores a flagged sentence against every entry in the Zotero library index
 * built by ZoteroLibrary.load(), using cosine similarity over TF-IDF
 * vectors (n-grams + stemming applied identically on both sides via
 * TextProcessing.gs). This is the free/no-embeddings stand-in for semantic
 * matching, per the cost decision -- title/tags are weighted at index time
 * (see ZoteroLibrary.FIELD_WEIGHTS), and the domain synonym dictionary
 * (Synonyms.gs) does the work embeddings would otherwise do for related
 * terminology.
 */

var TfIdfMatcher = (function () {

  function topMatches(sentenceText, library, maxCandidates) {
    var queryTokens = tokenizeWithNgrams(sentenceText);
    if (!queryTokens.length) return [];

    var queryTf = {};
    queryTokens.forEach(function (t) { queryTf[t] = (queryTf[t] || 0) + 1; });

    var queryVector = {};
    var queryNormSq = 0;
    Object.keys(queryTf).forEach(function (term) {
      var idfVal = library.idf[term] || fallbackIdf_(library.docCount);
      var weight = queryTf[term] * idfVal;
      queryVector[term] = weight;
      queryNormSq += weight * weight;
    });
    var queryNorm = Math.sqrt(queryNormSq) || 1e-9;

    var scored = library.entries.map(function (entry) {
      var score = cosineSimilarity_(queryVector, queryNorm, entry.vector, entry.norm);
      return {
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        score: score
      };
    });

    scored.sort(function (a, b) { return b.score - a.score; });

    return scored.slice(0, maxCandidates).filter(function (s) { return s.score > 0; });
  }

  function cosineSimilarity_(vecA, normA, vecB, normB) {
    var dot = 0;
    var smaller = Object.keys(vecA).length < Object.keys(vecB).length ? vecA : vecB;
    var other = smaller === vecA ? vecB : vecA;
    Object.keys(smaller).forEach(function (term) {
      if (other[term]) dot += smaller[term] * other[term];
    });
    return dot / (normA * normB);
  }

  function fallbackIdf_(n) {
    return Math.log((n + 1) / 1.5) + 1;
  }

  return { topMatches: topMatches };
})();
