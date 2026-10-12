/**
 * Synonyms.gs
 *
 * Hand-built domain synonym dictionary, standing in for semantic embeddings
 * as a free, no-paid-API approach. Keys map to a single canonical
 * token so that, e.g., a sentence using "AI welfare" and a Zotero abstract
 * using "artificial intelligence welfare" still overlap in the TF-IDF
 * vector space.
 *
 * This list is a starting point. Replace the example entries below with
 * terms from YOUR field, and grow the file over time as your documents
 * introduce recurring terminology -- it's the main lever for improving
 * match quality without paid embeddings, so it's worth investing in.
 *
 * Format: canonical term -> array of variant phrases (lowercase, matched
 * as whole phrases during tokenization in TextProcessing.gs).
 */

var SYNONYM_DICTIONARY = {
  // Examples -- replace or extend with your own domain terms:
  'research_ethics': ['research ethics', 'ethics of research', 'human subjects research'],
  'informed_consent': ['informed consent', 'consent procedures']
  // 'machine_learning': ['machine learning', 'statistical learning'],
  // 'climate_change': ['climate change', 'global warming'],
};

/**
 * Builds a reverse lookup: variant phrase -> canonical token, sorted by
 * phrase length descending so multi-word variants are matched before their
 * single-word substrings during phrase substitution.
 */
function buildSynonymLookup_() {
  var lookup = [];
  Object.keys(SYNONYM_DICTIONARY).forEach(function (canonical) {
    SYNONYM_DICTIONARY[canonical].forEach(function (variant) {
      lookup.push({ variant: variant, canonical: canonical });
    });
  });
  lookup.sort(function (a, b) { return b.variant.length - a.variant.length; });
  return lookup;
}

var SYNONYM_LOOKUP = buildSynonymLookup_();

/**
 * Replaces known variant phrases in lowercase text with their canonical
 * token (underscored, so it survives tokenization as one unit).
 */
function applySynonyms_(lowerText) {
  var result = lowerText;
  SYNONYM_LOOKUP.forEach(function (entry) {
    if (result.indexOf(entry.variant) !== -1) {
      var re = new RegExp(escapeRegex_(entry.variant), 'g');
      result = result.replace(re, entry.canonical);
    }
  });
  return result;
}

function escapeRegex_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
