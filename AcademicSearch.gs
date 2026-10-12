/**
 * AcademicSearch.gs
 *
 * FREE academic source lookup -- no LLM call, no per-search fee -- fanning
 * out to three public, keyless bibliographic APIs simultaneously:
 *
 *   - Google Books   (books.googleapis.com/books/v1/volumes)
 *                    Full-text phrase search: finds published BOOKS whose
 *                    text contains a quoted passage verbatim.
 *   - OpenAlex       (api.openalex.org/works)
 *                    Scholarly works of every type, with citation counts,
 *                    keyless (a `mailto` param is recommended for
 *                    reliability, not required).
 *   - Crossref       (api.crossref.org/works)
 *                    Canonical DOI-backed metadata for journals, books,
 *                    chapters, reports -- from every major academic
 *                    publisher. `query.bibliographic` is documented by
 *                    Crossref itself as "useful for citation lookup."
 *
 * All three response schemas were verified against official documentation
 * before this was written (Crossref's own GitHub docs + a captured real
 * response; OpenAlex's work-object README; Google Books' Volume reference)
 * -- see the field names below, they match those sources exactly.
 *
 * WHY THIS RUNS FIRST: this is the actual mechanism for "search every
 * sentence, but pay for very few of them." WebSearchMatcher.gs calls this
 * module before it ever calls Claude's paid web_search tool. If a
 * confident match comes back here, the paid call is skipped entirely for
 * that sentence -- coverage stays at 100% (every flagged sentence is
 * still checked), cost drops because academic citation lookup is exactly
 * what these three APIs are built for.
 */

var AcademicSearch = (function () {

  var REPUTABLE_PUBLISHERS = [
    'mit press', 'oxford university press', 'cambridge university press',
    'harvard university press', 'princeton university press',
    'university of chicago press', 'stanford university press',
    'yale university press', 'columbia university press',
    'cornell university press', 'duke university press',
    'johns hopkins university press', 'university of california press',
    'university of minnesota press', 'penn state university press',
    'routledge', 'taylor & francis', 'taylor and francis', 'springer',
    'elsevier', 'wiley', 'blackwell', 'de gruyter', 'sage', 'brill',
    'palgrave', 'bloomsbury academic', 'rowman', 'kluwer',
    'university press', 'nature', 'plos', 'frontiers'
  ];

  function isReputable_(name) {
    var n = String(name || '').toLowerCase();
    if (!n) return false;
    for (var i = 0; i < REPUTABLE_PUBLISHERS.length; i++) {
      if (n.indexOf(REPUTABLE_PUBLISHERS[i]) !== -1) return true;
    }
    return false;
  }

  /**
   * Main entry point. sentenceText is the flagged sentence; authorHint is
   * an optional last name (from the sentence itself or TF-IDF's top pick --
   * see WebSearchMatcher.gs) used both to build a better Crossref query
   * and to score/gate candidates afterward.
   *
   * Returns { candidates: [...] }, each candidate shaped like:
   *   { title, authors (string), year, url, doi, score, containsQuote }
   * -- the same shape TfIdfMatcher's matches already use, so downstream
   * code (CommentWriter, InlineAnnotator) needs no special-casing.
   */
  function search(sentenceText, authorHint) {
    var quote = extractQuote_(sentenceText);
    var searchBasis = quote || sentenceText;
    var words = searchBasis.trim().split(/\s+/).filter(function (w) { return w.length > 0; });

    if (words.length < 4) {
      return { candidates: [] }; // too short to search any of these APIs reliably
    }

    var phrase = words.slice(0, 12).join(' ');       // for Google Books verbatim phrase search
    var bibQuery = words.slice(0, 20).join(' ');       // for Crossref's bibliographic field query

    var mailto = (CONFIG.ACADEMIC_SEARCH && CONFIG.ACADEMIC_SEARCH.CONTACT_EMAIL) || '';
    var booksKey = '';
    try {
      booksKey = PropertiesService.getScriptProperties().getProperty(
        CONFIG.ACADEMIC_SEARCH.GOOGLE_BOOKS_API_KEY_PROPERTY
      ) || '';
    } catch (e) { /* Config not fully set up yet -- proceed keyless */ }

    var reqs = [
      {
        url: 'https://www.googleapis.com/books/v1/volumes?q=' +
          encodeURIComponent('"' + phrase + '"') + '&maxResults=5&printType=books&country=US' +
          (booksKey ? '&key=' + encodeURIComponent(booksKey) : ''),
        muteHttpExceptions: true
      },
      {
        url: 'https://api.openalex.org/works?search=' + encodeURIComponent(bibQuery) +
          '&per-page=5' + (mailto ? '&mailto=' + encodeURIComponent(mailto) : ''),
        muteHttpExceptions: true
      },
      {
        url: 'https://api.crossref.org/works?rows=5&query.bibliographic=' + encodeURIComponent(bibQuery) +
          (authorHint ? '&query.author=' + encodeURIComponent(authorHint) : '') +
          (mailto ? '&mailto=' + encodeURIComponent(mailto) : ''),
        muteHttpExceptions: true
      }
    ];

    var resps;
    try {
      resps = UrlFetchApp.fetchAll(reqs);
    } catch (e) {
      // fetchAll fails wholesale if one host is unreachable -- retry individually
      // so one flaky API doesn't take down the other two.
      resps = reqs.map(function (r) {
        try { return UrlFetchApp.fetch(r.url, { muteHttpExceptions: true }); }
        catch (e2) { return null; }
      });
    }

    var cands = [];
    try { cands = cands.concat(parseBooksResults_(resps[0], quote)); } catch (e) { Logger.log('AcademicSearch: Books parse failed: %s', e); }
    try { cands = cands.concat(parseOpenAlexResults_(resps[1])); } catch (e) { Logger.log('AcademicSearch: OpenAlex parse failed: %s', e); }
    try { cands = cands.concat(parseCrossrefResults_(resps[2])); } catch (e) { Logger.log('AcademicSearch: Crossref parse failed: %s', e); }

    cands = dedupeCandidates_(cands);
    cands.forEach(function (c) { c.score = scoreCandidate_(c, authorHint); });
    cands.sort(function (a, b) { return b.score - a.score; });

    return { candidates: cands.slice(0, 6) };
  }

  /** First quoted passage in the sentence, if any -- used for verbatim Google Books search. */
  function extractQuote_(text) {
    var m = String(text || '').match(/["\u201C]([^"\u201C\u201D\n]{8,300})["\u201D]/);
    return m ? m[1].trim() : null;
  }

  /* ------------------------------ per-API parsers ------------------------------ */

  // Google Books: items[].volumeInfo.{title, subtitle, authors:[string,...],
  // publisher, publishedDate}. Verified against developers.google.com/books/docs/v1.
  function parseBooksResults_(resp, quote) {
    if (!resp || resp.getResponseCode() !== 200) return [];
    var items = (JSON.parse(resp.getContentText()) || {}).items || [];
    return items.map(function (it, k) {
      var v = it.volumeInfo || {};
      if (!v.title) return null;
      var title = v.title;
      if (v.subtitle && title.indexOf(':') === -1) title += ': ' + v.subtitle;
      return {
        title: title,
        authors: (v.authors || []).join('; '),
        year: extractYear_(v.publishedDate),
        url: it.volumeInfo && it.volumeInfo.canonicalVolumeLink || (it.id ? 'https://books.google.com/books?id=' + it.id : ''),
        doi: null,
        rank: k,
        from: 'books',
        containsQuote: !!quote, // a hit on a verbatim-phrase query IS the quote match
        venue: v.publisher || '',
        citedBy: 0
      };
    }).filter(Boolean);
  }

  // OpenAlex: display_name, authorships[].author.display_name,
  // primary_location.source.{display_name, host_organization_name},
  // publication_year, biblio.{volume,issue,first_page,last_page}, doi,
  // cited_by_count. Verified against openalex-docs work-object README
  // (primary_location supersedes the deprecated host_venue).
  function parseOpenAlexResults_(resp) {
    if (!resp || resp.getResponseCode() !== 200) return [];
    var items = (JSON.parse(resp.getContentText()) || {}).results || [];
    var typeMap = { article: 'journal', book: 'book', 'book-chapter': 'chapter', report: 'report', dissertation: 'thesis' };
    return items.map(function (w, k) {
      if (!w.display_name) return null;
      var authors = (w.authorships || [])
        .map(function (a) { return a.author && a.author.display_name; })
        .filter(Boolean)
        .join('; ');
      var loc = w.primary_location && w.primary_location.source;
      var venue = (loc && loc.display_name) || '';
      var publisher = (loc && loc.host_organization_name) || '';
      var b = w.biblio || {};
      var pages = b.first_page ? (b.first_page + (b.last_page && b.last_page !== b.first_page ? '-' + b.last_page : '')) : '';
      return {
        title: w.display_name,
        authors: authors,
        year: w.publication_year || null,
        url: w.doi ? ('https://doi.org/' + String(w.doi).replace(/^https?:\/\/doi\.org\//i, '')) : (w.id || ''),
        doi: w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, '') : null,
        rank: k,
        from: 'openalex',
        containsQuote: false,
        venue: publisher || venue,
        citedBy: w.cited_by_count || 0,
        _type: typeMap[w.type] || 'other'
      };
    }).filter(Boolean);
  }

  // Crossref: DOI, title[0], container-title[0], author[].{given,family},
  // issued.date-parts[0], publisher, is-referenced-by-count. Verified
  // against Crossref's official GitHub docs + a captured real response.
  function parseCrossrefResults_(resp) {
    if (!resp || resp.getResponseCode() !== 200) return [];
    var body = JSON.parse(resp.getContentText());
    var items = (body.message && body.message.items) || [];
    return items.map(function (m, k) {
      var title = (m.title && m.title[0]) || '';
      if (!title) return null;
      var authors = (m.author || [])
        .map(function (a) { return [a.given, a.family].filter(Boolean).join(' ') || a.name || ''; })
        .filter(Boolean)
        .join('; ');
      var issued = m.issued && m.issued['date-parts'] && m.issued['date-parts'][0];
      var year = issued && issued[0] ? issued[0] : null;
      return {
        title: title,
        authors: authors,
        year: year,
        url: m.DOI ? ('https://doi.org/' + m.DOI) : (m.URL || ''),
        doi: m.DOI || null,
        rank: k,
        from: 'crossref',
        containsQuote: false,
        venue: (m['container-title'] && m['container-title'][0]) || m.publisher || '',
        citedBy: m['is-referenced-by-count'] || 0,
        _type: m.type || 'other'
      };
    }).filter(Boolean);
  }

  function extractYear_(dateStr) {
    var m = String(dateStr || '').match(/\b(19|20)\d{2}\b/);
    return m ? parseInt(m[0], 10) : null;
  }

  /* ------------------------------ dedupe & scoring ------------------------------ */

  function dedupeCandidates_(cands) {
    var seen = {};
    var out = [];
    cands.forEach(function (c) {
      var key = c.doi
        ? 'd:' + c.doi.toLowerCase()
        : 't:' + String(c.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + (c.year || '');
      if (seen[key]) {
        var existing = seen[key];
        existing.citedBy = Math.max(existing.citedBy, c.citedBy);
        existing.containsQuote = existing.containsQuote || c.containsQuote;
        if (!existing.doi && c.doi) existing.doi = c.doi;
        return;
      }
      seen[key] = c;
      out.push(c);
    });
    return out;
  }

  /**
   * Scoring mirrors the reference tool's formula (verbatim quote match,
   * DOI presence, reputable venue, log-scaled citation count, structural
   * type bonus, missing-author penalty), PLUS one addition specific to our
   * use case: a bonus when the candidate's authors include the sentence's
   * own named author (authorHint) -- and conversely, when authorHint is
   * given but NOT present in the candidate's authors, the score is capped
   * rather than allowed to look confident on citation-count/venue alone.
   * This mirrors the tool's "never silently attach the wrong work"
   * philosophy for the DOI-enrichment fuzzy match.
   */
  function scoreCandidate_(c, authorHint) {
    var s = 5 - Math.min(c.rank, 5);
    if (c.containsQuote) s += 8;
    if (c.doi) s += 2;
    if (isReputable_(c.venue)) s += 4;
    if (c.citedBy) s += Math.min(4, Math.log(c.citedBy + 1));
    if (c._type === 'book' || c._type === 'journal' || c._type === 'chapter' ||
        c.from === 'books') s += 1;
    if (!c.authors) s -= 2;

    if (authorHint) {
      var hintLower = authorHint.toLowerCase();
      var authorMatch = (c.authors || '').toLowerCase().indexOf(hintLower) !== -1;
      if (authorMatch) {
        s += 6;
      } else if (c.authors) {
        // Has authors, but none match the sentence's own named author --
        // cap the score so venue/citation prestige alone can't look like a
        // confident match for what may be the wrong person's paper.
        s = Math.min(s, 6);
      }
    }
    return s;
  }

  /**
   * Extracts a DOI from a URL or bare DOI string, if present.
   * e.g. "https://doi.org/10.1038/s41583-022-00587-4" -> "10.1038/s41583-022-00587-4"
   */
  function extractDoi_(text) {
    var m = String(text || '').match(/(?:doi\.org\/|doi:\s*)(10\.\d{4,9}\/[^\s"'<>?#]+)/i);
    if (m) return m[1];
    m = String(text || '').match(/^(10\.\d{4,9}\/\S+)$/);
    return m ? m[1] : null;
  }

  /**
   * Given a URL (or bare DOI) returned by ANY source -- Claude's own paid
   * web_search included -- fetches the canonical Crossref record directly
   * and returns verified {title, authors, year, doi, url}, or null if no
   * DOI is present or Crossref has no record. This is how we replace an
   * LLM's own transcription of a search snippet with structured,
   * authoritative bibliographic data: free, and strictly more trustworthy
   * than trusting the model to have copied the title/authors correctly.
   */
  function verifyDoi(urlOrDoi) {
    var doi = extractDoi_(urlOrDoi);
    if (!doi) return null;

    try {
      var resp = UrlFetchApp.fetch('https://api.crossref.org/works/' + encodeURIComponent(doi), {
        muteHttpExceptions: true,
        headers: { 'Accept': 'application/json' }
      });
      if (resp.getResponseCode() !== 200) return null;

      var m = JSON.parse(resp.getContentText()).message;
      if (!m) return null;
      var title = (m.title && m.title[0]) || '';
      if (!title) return null;

      var authors = (m.author || [])
        .map(function (a) { return [a.given, a.family].filter(Boolean).join(' ') || a.name || ''; })
        .filter(Boolean)
        .join('; ');
      var issued = m.issued && m.issued['date-parts'] && m.issued['date-parts'][0];

      return {
        title: title,
        authors: authors,
        year: issued && issued[0] ? issued[0] : null,
        doi: m.DOI || doi,
        url: 'https://doi.org/' + (m.DOI || doi),
        verified: true
      };
    } catch (e) {
      Logger.log('AcademicSearch.verifyDoi: lookup failed for "%s": %s', doi, e);
      return null;
    }
  }

  return { search: search, verifyDoi: verifyDoi };
})();
