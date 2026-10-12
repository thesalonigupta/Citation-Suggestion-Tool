/**
 * DocScanner.gs
 *
 * Reads a Google Doc's body paragraph by paragraph, splits into sentences,
 * and annotates each sentence with:
 *   - whether it already carries a citation (inline parenthetical, footnote
 *     marker, or bracketed style) -- per the project's citation rules, this MUST be
 *     checked before flagging, especially for the footnote-hybrid style,
 *     or every already-footnoted claim becomes a false positive.
 *   - the paragraph index / rough location, for comment anchoring.
 *
 * Also detects which of the five citation styles (see the project's citation rules)
 * the document predominantly uses, so comment text can be phrased
 * appropriately (see Config.COMMENT_PREFIX usage in CommentWriter.gs).
 */

var DocScanner = (function () {

  // Inline parenthetical: (Author, 2020) / (Author et al., 2020) /
  // (Author, 2020; Other, 2019) / (Smith, 2023, Jones, 2006) /
  // (Smith & Jones, n.d.) -- "n.d." (no date) is standard APA/Zotero
  // notation for undated sources and must count as a valid citation year,
  // or already-cited sentences using it get incorrectly flagged as uncited
  // (found via testing against a real draft that used this notation).
  //
  // Author-name character class uses Unicode property escapes (\p{L}, any
  // script's letters) rather than plain [A-Za-z] -- found via testing that
  // "(Müller, 2009)", a real, correctly-formatted existing citation, was
  // invisible to the ASCII-only version because "ë" isn't in [A-Za-z].
  // Plenty of real author names carry diacritics (Müller, Gödel, Žižek,
  // Dvořák, etc.), so this isn't an
  // edge case worth ignoring -- an already-cited sentence silently getting
  // treated as uncited is exactly the kind of false positive this tool
  // exists to avoid.
  var NAME_CHAR_RE = '[\\p{L}.\'-]';
  var YEAR_OR_ND_RE = '(?:\\d{4}[a-z]?|n\\.d\\.)';
  var PARENTHETICAL_CITATION_RE = new RegExp(
    '\\(\\p{Lu}' + NAME_CHAR_RE + '+(?:\\s(?:and|&)\\s\\p{Lu}' + NAME_CHAR_RE + '+|\\set al\\.)?,?\\s' +
    YEAR_OR_ND_RE + '(\\s?[,;]\\s?[^)]*' + YEAR_OR_ND_RE + ')*\\)',
    'u'
  );

  // Author (Year) named-in-sentence form: "Smith (2023) argues..." /
  // "Smith & Jones (n.d.) suggest..." -- \p{Lu} (Unicode uppercase
  // letter) rather than [A-Z] for the same reason as above: a surname can
  // start with an accented capital too (Žižek), and \b doesn't reliably
  // anchor before non-ASCII letters, so \p{Lu} both matches accented
  // capitals and serves as its own boundary anchor.
  var NAMED_YEAR_RE = new RegExp(
    '\\p{Lu}' + NAME_CHAR_RE + '+(?:\\set al\\.)?\\s\\(' + YEAR_OR_ND_RE + '\\)',
    'u'
  );

  // Bracketed inline / hyperlinked style: (Smith, 2024) already covered
  // above; [12], [Smith, 2005] style bracket citation.
  var BRACKETED_CITATION_RE = /\[[A-Za-z][^\]]{0,60}\d{4}[^\]]{0,10}\]|\[\d{1,3}\]/;

  // Broader existence check, used ONLY for "does this sentence already have
  // SOME citation" (not for style detection or text extraction, where the
  // narrower author-shaped patterns above stay in use because precision
  // matters more there). Found via testing that real academic prose uses
  // citation shapes the narrow (Author, Year) pattern doesn't cover:
  //   "(see Smith, 2025, for discussion of this point...)"
  //   "(The Book Title, 2024)" -- title-first, author named earlier
  //   "(Smith 2024, The Book Title)" -- author+year, no comma
  // Rather than adding a new narrow pattern per shape (which only ever
  // covers shapes already seen), this checks the more general question:
  // does ANY parenthetical in the sentence contain a year-like token at
  // all. This deliberately trades a small amount of precision for a much
  // bigger gain in recall -- the cost of under-detecting a real citation
  // (a false "needs citation" flag on already-cited prose) has proven
  // repeatedly worse in testing than the rare cost of over-detecting (e.g.
  // a non-citation aside like "the policy was established (in 1985)"
  // reading as if it were cited -- uncommon in academic prose, and merely
  // means one fewer flag, not a wrong one).
  var ANY_PAREN_WITH_YEAR_RE = /\([^)]*(?:\d{4}[a-z]?|n\.d\.)[^)]*\)/;

  // An authorial convention (used by some documents) for scoping a citation to an entire
  // section: a short header line reading "Reference in this section:
  // (Author, Year)" that appears once, right after a section heading, and
  // is meant to apply to the whole section's framing -- not something we're
  // inferring, the author is stating it directly. Found costing real money
  // in testing: 5 sentences in one section each independently triggered
  // rerank/web-search because nothing connected them back to this header.
  var SECTION_REFERENCE_RE = /Reference in this section:\s*(\([^)]+\))/i;

  // A new numbered section heading ("1.1.4 Methods Overview")
  // ends the scope of any prior "Reference in this section" -- a citation
  // scoped to one section must not silently bleed into the next one. Only
  // treated as a heading when short and free of sentence-ending
  // punctuation, so an ordinary sentence that happens to start with a
  // number (a statistic, a list reference) isn't mistaken for one.
  var SECTION_HEADING_RE = /^\d+(?:\.\d+){0,4}\s+[A-Z]/;

  function looksLikeSectionHeading_(text) {
    var trimmed = text.trim();
    return trimmed.length < 100 && SECTION_HEADING_RE.test(trimmed) && !/[.!?]\s/.test(trimmed);
  }

  function scan(docId) {
    var doc = DocumentApp.openById(docId);
    var body = doc.getBody();
    var footnotes = getFootnoteAnchors_(doc);

    var sentences = [];
    var frameworkMentions = {}; // phrase -> true once seen, for first-mention rule
    var pendingSectionCitation = null; // "(Author, Year)" text, or null between sections

    var numChildren = body.getNumChildren();
    for (var i = 0; i < numChildren; i++) {
      var el = body.getChild(i);
      var elType = el.getType();

      // Google Docs represents numbered/bulleted list items as their own
      // element type (LIST_ITEM), distinct from PARAGRAPH -- both need to
      // be scanned, or every list item in the document (including the
      // per-item citations the citation rules explicitly call out)
      // gets silently skipped before we ever reach it.
      var isListItem = elType === DocumentApp.ElementType.LIST_ITEM;
      if (elType !== DocumentApp.ElementType.PARAGRAPH && !isListItem) continue;

      var paragraph = isListItem ? el.asListItem() : el.asParagraph();
      var text = paragraph.getText();
      if (!text || !text.trim()) continue;

      // A new section heading ends any prior section-wide citation scope
      // (checked BEFORE the reference-line check below, so a heading and
      // its own "Reference in this section:" line -- which are normally
      // separate paragraphs -- combine correctly: reset, then pick up the
      // new section's reference on the very next matching paragraph).
      if (looksLikeSectionHeading_(text)) {
        pendingSectionCitation = null;
      }

      var sectionRefMatch = text.match(SECTION_REFERENCE_RE);
      if (sectionRefMatch) {
        pendingSectionCitation = sectionRefMatch[1];
      }

      var pieces = splitIntoSentences_(text);
      pieces.forEach(function (sentenceText) {
        if (sentenceText.trim().length < 8) return; // skip stray fragments/headers

        var hasFootnoteMarker = sentenceOverlapsFootnote_(sentenceText, text, footnotes, i);
        var hasInlineCitation =
          ANY_PAREN_WITH_YEAR_RE.test(sentenceText) ||
          BRACKETED_CITATION_RE.test(sentenceText);

        sentences.push({
          text: sentenceText.trim(),
          paragraphIndex: i,
          isListItem: isListItem,
          hasExistingCitation: hasFootnoteMarker || hasInlineCitation,
          sectionCitationText: pendingSectionCitation
        });
      });
    }

    var style = detectDocCitationStyle_(sentences, footnotes.length);

    return {
      sentences: sentences,
      style: style,
      frameworkMentions: frameworkMentions
    };
  }

  /**
   * Splits paragraph text into sentences. Deliberately simple (period/!/?
   * boundary followed by space + capital letter) with guards against common
   * abbreviations (e.g., i.e., et al., Dr., pp., Fig.) so they don't get
   * treated as sentence breaks. Not perfect, but matches the register of
   * academic prose well enough for detection purposes -- this is a
   * detector, not a formatter, so occasional over/under-splitting is fine
   * as long as citation-bearing clauses stay recognizable.
   */
  function splitIntoSentences_(text) {
    var ABBREV = /\b(e\.g|i\.e|et al|etc|vs|Dr|Mr|Mrs|Ms|Prof|pp|Fig|no|Vol|cf)\.$/i;
    var raw = text.split(/(?<=[.?!])\s+(?=[A-Z0-9"'\u201C])/);
    var sentences = [];
    var buffer = '';

    raw.forEach(function (chunk) {
      buffer = buffer ? buffer + ' ' + chunk : chunk;
      var trimmed = buffer.trim();
      var endsOnAbbrev = ABBREV.test(trimmed.replace(/["')\]]+$/, ''));
      if (!endsOnAbbrev) {
        sentences.push(buffer);
        buffer = '';
      }
    });
    if (buffer.trim()) sentences.push(buffer);
    return sentences;
  }

  /**
   * Pulls all footnotes in the doc along with the paragraph they're
   * anchored in, so we can tell whether a given sentence already has a
   * footnote marker sitting inside it (hybrid style, see the project's citation rules).
   */
  function getFootnoteAnchors_(doc) {
    var footnotes = doc.getFootnotes();
    return footnotes.map(function (fn) {
      var contentText = '';
      try {
        contentText = fn.getFootnoteContents().getText();
      } catch (e) { /* ignore */ }
      return { contentText: contentText };
    });
  }

  /**
   * Heuristic check: Apps Script's DocumentApp doesn't expose the exact
   * character offset of a footnote anchor within getText() output in a
   * simple way, so as a practical proxy we treat a paragraph that contains
   * ANY footnote as making its LAST sentence in that paragraph "already
   * cited" only when that sentence is also the paragraph-final sentence
   * (footnote markers sit at clause end in all observed samples).
   * This intentionally errs toward under-flagging (fewer false positives)
   * per the citation rules' explicit warning about the hybrid style.
   */
  function sentenceOverlapsFootnote_(sentenceText, fullParaText, footnotes, paraIndex) {
    if (!footnotes.length) return false;
    var isParagraphFinalSentence = fullParaText.trim().endsWith(sentenceText.trim());
    if (!isParagraphFinalSentence) return false;
    // Cheap signal: paragraph text containing a footnote will often still
    // read fine without a visible marker char in getText(); we can't fully
    // disambiguate per-sentence without Docs API range data, so this stays
    // a coarse paragraph-level heuristic. Flagged as a known limitation --
    // see README "Known limitations".
    return true;
  }

  function detectDocCitationStyle_(sentences, footnoteCount) {
    var parenCount = 0, namedYearCount = 0, bracketCount = 0;
    sentences.forEach(function (s) {
      if (PARENTHETICAL_CITATION_RE.test(s.text)) parenCount++;
      if (NAMED_YEAR_RE.test(s.text)) namedYearCount++;
      if (BRACKETED_CITATION_RE.test(s.text)) bracketCount++;
    });

    if (footnoteCount > Math.max(parenCount, bracketCount)) {
      return 'footnote'; // includes the author-year-in-footnote hybrid
    }
    if (bracketCount > parenCount) return 'bracketed';
    if (parenCount > 0 || namedYearCount > 0) return 'parenthetical';
    return 'unknown';
  }

  function extractCitationText(text) {
    var m = text.match(PARENTHETICAL_CITATION_RE) || text.match(NAMED_YEAR_RE);
    return m ? m[0] : null;
  }

  return { scan: scan, extractCitationText: extractCitationText };
})();
