/**
 * ZoteroLibrary.gs
 *
 * Loads the static Zotero CSV export (title, authors, year, abstract, tags)
 * per the "static export, refreshed before each pass" architecture
 * decision -- no live Zotero API calls. Builds a TF-IDF index over the
 * library so TfIdfMatcher can score doc sentences against it.
 *
 * Expected CSV columns (header row required, case-insensitive match):
 *   Title, Author, Publication Year, Abstract Note, Manual Tags
 * (These are Zotero's default CSV export column names -- adjust
 * COLUMN_ALIASES below if your export uses different headers.)
 */

var ZoteroLibrary = (function () {

  var COLUMN_ALIASES = {
    title: ['title'],
    authors: ['author', 'authors', 'creator', 'creators'],
    year: ['publication year', 'year', 'date'],
    abstract: ['abstract note', 'abstract'],
    tags: ['manual tags', 'tags', 'automatic tags'],
    url: ['url'],
    doi: ['doi']
  };

  // Title and tags carry more disambiguating signal per entry than raw
  // abstract prose, so their tokens are repeated to boost term frequency
  // in the entry's vector -- a cheap stand-in for field-weighted TF-IDF.
  var FIELD_WEIGHTS = { title: 3, tags: 3, abstract: 1 };

  /**
   * Loads and combines MULTIPLE Zotero CSV exports into one library index.
   * This is the normal entry point when a library is split across
   * separate collection exports (e.g. topic_A.csv, topic_B.csv) --
   * each covering a different research grouping, all part of the same
   * overall body of work.
   *
   * Critically, this builds ONE combined TF-IDF index across the union of
   * all entries, not one index per file -- term rarity (IDF) has to be
   * computed against the whole combined library, or a term that's common
   * within one small collection but rare across the full set would be
   * mis-weighted. Duplicate entries across files (the same paper present
   * in more than one collection export) are detected and merged rather
   * than double-counted.
   */
  function loadMultiple(csvFileIds) {
    var allRawEntries = [];
    csvFileIds.forEach(function (id) {
      var entries = parseCsvToRawEntries_(id);
      Logger.log('ZoteroLibrary: loaded %s entries from %s.', entries.length, id);
      allRawEntries = allRawEntries.concat(entries);
    });

    var deduped = dedupeRawEntries_(allRawEntries);
    if (allRawEntries.length !== deduped.length) {
      Logger.log('ZoteroLibrary: merged %s duplicate entries found across libraries (%s -> %s total).',
        allRawEntries.length - deduped.length, allRawEntries.length, deduped.length);
    }

    return buildIndex_(deduped);
  }

  /** Single-file convenience wrapper -- same path loadMultiple() uses for one file. */
  function load(csvFileId) {
    return loadMultiple([csvFileId]);
  }

  function parseCsvToRawEntries_(csvFileId) {
    var file = DriveApp.getFileById(csvFileId);
    var csvText = file.getBlob().getDataAsString('UTF-8');
    var rows = parseCsvRobust_(csvText);
    if (!rows.length) throw new Error('Zotero CSV (' + csvFileId + ') is empty.');

    var header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    var colIndex = resolveColumns_(header);

    var rawEntries = [];
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row.length || row.every(function (c) { return !c; })) continue;

      var entry = {
        title: getCol_(row, colIndex.title),
        authors: getCol_(row, colIndex.authors),
        year: getCol_(row, colIndex.year),
        abstract: getCol_(row, colIndex.abstract),
        tags: getCol_(row, colIndex.tags),
        url: getCol_(row, colIndex.url),
        doi: getCol_(row, colIndex.doi)
      };
      if (!entry.title) continue;
      rawEntries.push(entry);
    }

    return rawEntries;
  }

  /**
   * Merges entries that appear in more than one source CSV (by DOI when
   * present, else normalized title+year -- same approach as
   * AcademicSearch.gs's candidate dedup). Keeps the entry with the most
   * complete data (longest abstract, since that's the field TF-IDF gets
   * the most signal from) and fills in any fields the kept entry lacks
   * from the duplicate before discarding it.
   */
  function dedupeRawEntries_(entries) {
    var seen = {};
    var out = [];

    entries.forEach(function (entry) {
      var key = entry.doi
        ? 'd:' + entry.doi.toLowerCase()
        : 't:' + entry.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + '|' + (entry.year || '');

      var existing = seen[key];
      if (!existing) {
        seen[key] = entry;
        out.push(entry);
        return;
      }

      if ((entry.abstract || '').length > (existing.abstract || '').length) {
        // Swap which copy is kept, but preserve the shorter one's fields
        // as a fallback for anything the longer one is missing.
        ['title', 'authors', 'year', 'tags', 'url', 'doi'].forEach(function (f) {
          if (!entry[f] && existing[f]) entry[f] = existing[f];
        });
        var idx = out.indexOf(existing);
        out[idx] = entry;
        seen[key] = entry;
      } else {
        ['abstract', 'tags', 'url', 'doi'].forEach(function (f) {
          if (!existing[f] && entry[f]) existing[f] = entry[f];
        });
      }
    });

    return out;
  }

  function resolveColumns_(header) {
    var colIndex = {};
    Object.keys(COLUMN_ALIASES).forEach(function (field) {
      var idx = -1;
      COLUMN_ALIASES[field].some(function (alias) {
        var found = header.indexOf(alias);
        if (found !== -1) { idx = found; return true; }
        return false;
      });
      colIndex[field] = idx;
    });
    return colIndex;
  }

  function getCol_(row, idx) {
    return idx >= 0 && idx < row.length ? (row[idx] || '').trim() : '';
  }

  /**
   * Builds document-frequency counts across the library, then per-entry
   * weighted term-frequency vectors multiplied by IDF, with precomputed
   * L2 norms for fast cosine similarity later.
   */
  function buildIndex_(rawEntries) {
    var docFreq = {}; // term -> number of entries containing it
    var entryTokens = rawEntries.map(function (entry) {
      var titleTokens = repeat_(tokenizeWithNgrams(entry.title), FIELD_WEIGHTS.title);
      var tagTokens = repeat_(tokenizeWithNgrams(entry.tags), FIELD_WEIGHTS.tags);
      var abstractTokens = repeat_(tokenizeWithNgrams(entry.abstract), FIELD_WEIGHTS.abstract);
      var all = titleTokens.concat(tagTokens, abstractTokens);

      var uniqueTerms = {};
      all.forEach(function (t) { uniqueTerms[t] = true; });
      Object.keys(uniqueTerms).forEach(function (term) {
        docFreq[term] = (docFreq[term] || 0) + 1;
      });

      return all;
    });

    var n = rawEntries.length;
    var idf = {};
    Object.keys(docFreq).forEach(function (term) {
      idf[term] = Math.log((n + 1) / (docFreq[term] + 0.5)) + 1; // smoothed idf
    });

    var entries = rawEntries.map(function (entry, i) {
      var tf = {};
      entryTokens[i].forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });

      var vector = {};
      var normSq = 0;
      Object.keys(tf).forEach(function (term) {
        var weight = tf[term] * (idf[term] || defaultIdf_(n));
        vector[term] = weight;
        normSq += weight * weight;
      });

      return {
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        tags: entry.tags,
        url: entry.url,
        doi: entry.doi,
        vector: vector,
        norm: Math.sqrt(normSq) || 1e-9
      };
    });

    return {
      entries: entries,
      idf: idf,
      docCount: n,
      knownDomains: extractKnownDomains_(entries)
    };
  }

  /**
   * Extracts the domains your library actually draws from, ranked by
   * frequency, for use as the web_search tool's allowed_domains parameter
   * (see WebSearchMatcher.gs). This is derived once per library load, at
   * zero API cost -- pure string parsing of the Url column.
   */
  function extractKnownDomains_(entries) {
    var counts = {};
    entries.forEach(function (e) {
      if (!e.url) return;
      var match = e.url.match(/^https?:\/\/([^\/]+)/i);
      if (!match) return;
      var domain = match[1].replace(/^www\./i, '').toLowerCase();
      counts[domain] = (counts[domain] || 0) + 1;
    });
    return Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a];
    });
  }

  /**
   * Returns every library entry by the same last name as a given author
   * string, for use as a search-steering hint -- e.g. "the closest TF-IDF
   * match was by Smith, but scored low; here's every other Smith entry in
   * the library" gives an LLM-driven web search a much more targeted
   * starting point than the raw sentence text alone.
   */
  function findAuthorEntries_(authorString, entries) {
    if (!authorString) return [];
    var lastName = authorString.split(/[,;]/)[0].trim();
    if (!lastName) return [];
    return entries.filter(function (e) {
      return (e.authors || '').indexOf(lastName) !== -1;
    });
  }

  function repeat_(tokens, times) {
    if (times <= 1) return tokens;
    var out = [];
    for (var i = 0; i < times; i++) out = out.concat(tokens);
    return out;
  }

  function defaultIdf_(n) {
    // fallback IDF for terms present in a query sentence but never seen in
    // the library -- treat as maximally rare/informative but not infinite.
    return Math.log((n + 1) / 1.5) + 1;
  }

  /**
   * Utilities.parseCsv() is known to be fragile against real-world CSV
   * exports -- it can throw "Could not parse text" on files that every
   * other CSV parser (Python's csv module, Excel, etc.) reads fine,
   * especially when quoted fields (like Zotero abstract text) contain
   * irregular internal quote characters. This is a standard RFC4180-style
   * state-machine parser instead: handles quoted fields, doubled ""
   * escaped quotes, commas and newlines inside quoted fields, and is
   * tolerant of stray unescaped quotes inside a field rather than throwing.
   */
  function parseCsvRobust_(text) {
    // Strip a UTF-8 BOM if present -- common in Zotero/Excel exports and
    // occasionally trips up strict parsers on the header row.
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    var len = text.length;

    while (i < len) {
      var ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += ch;
        i++;
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === ',') {
        row.push(field);
        field = '';
        i++;
        continue;
      }
      if (ch === '\r') {
        i++;
        continue; // normalize CRLF/CR -> handled by \n below
      }
      if (ch === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        i++;
        continue;
      }
      field += ch;
      i++;
    }

    // flush trailing field/row (files without a final newline)
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    return rows.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
  }

  return { load: load, loadMultiple: loadMultiple, findAuthorEntries: findAuthorEntries_ };
})();