# Citation Suggestion Tool

A standalone Google Apps Script project that scans a research report or draft (Google Doc)
and adds **comments** (never inline edits) suggesting where citations may be
needed, matched against a static Zotero library export via TF-IDF.

Free to run by default: detection is rule-based and matching is TF-IDF with
n-grams, light stemming, and a hand-built domain synonym dictionary. Optional
Claude-powered detection, reranking and web search are available but **off by
default** (see `Config.gs`); they need your own Claude API key and have
monthly spend caps.

## Files

| File | Purpose |
|---|---|
| `appsscript.json` | Manifest -- enables the Drive Advanced Service and required OAuth scopes |
| `Config.gs` | Script Properties (doc ID, Zotero CSV ID), thresholds, tunables |
| `Main.gs` | Entry points: `runCitationPass()`, `runDryRun()` |
| `DocScanner.gs` | Reads the doc, splits sentences, detects existing citations + doc-wide style |
| `RuleDetector.gs` | Positive/negative pattern rules (citation-need rules) |
| `Synonyms.gs` | Domain synonym dictionary for TF-IDF term normalization |
| `TextProcessing.gs` | Tokenizer, lightweight stemmer, n-gram generation |
| `ZoteroLibrary.gs` | Parses the Zotero CSV export, builds a TF-IDF index |
| `TfIdfMatcher.gs` | Cosine-similarity matching of a sentence against the library |
| `CommentWriter.gs` | Writes confidence-tiered comments via the Drive API (Mode A) |
| `InlineAnnotator.gs` | Highlights + inserts markers directly via DocumentApp (Mode B, more reliable positioning) |
| `DomainContext.gs` | `DOMAIN_CONTEXT`: short description of your field, injected into Claude prompts (edit this) |
| `LlmDetector.gs` | Optional Claude-based citation-need detection (`DETECTION_MODE: 'LLM'`) |
| `WebSearchMatcher.gs` | Optional reranking and web search for sources outside your library |
| `AcademicSearch.gs` | Free Google Books / OpenAlex / Crossref lookup used before paid web search |
| `SentenceState.gs` | Per-document dismissed-flag tracking |
| `CalibrationStats.gs` | Flagged-vs-dismissed statistics per tier and rule |
| `WebApp.gs`, `Index.html` | Optional web page (Deploy > Web app) to scan a doc by link and choose which flags to apply |

## One-time setup

1. **Create the project in a Shared Drive** (not My Drive), so ownership
   survives account turnover:
   - In the Shared Drive, `+ New > More > Google Apps Script` (or create at
     script.google.com and then move the resulting project file into the
     Shared Drive folder via Drive).
2. **Paste in all `.gs` files and `appsscript.json`** from this folder.
   In the Apps Script editor: Project Settings > check "Show
   'appsscript.json' manifest file in editor" to edit the manifest directly,
   or use `clasp push` if you're managing this locally (see "Using clasp"
   below).
3. **Enable the Drive Advanced Service**: Services (+) > Drive API > v3.
   (Already declared in `appsscript.json`, but the editor sometimes wants
   you to also click through it once.)
4. **Authorize**: run any function (e.g. `setupWizard`) once from the
   editor and step through the OAuth consent screen. This is the "a real
   person claims execution authorization" step -- whoever does this becomes
   the identity the triggers run as. Re-run this if that person ever loses
   access; ownership of the *file* (Shared Drive) is separate from *who
   last authorized execution*.
5. **Export your Zotero library to CSV** (title, authors, year, abstract
   note, manual tags columns) and upload it to the same Shared Drive.
6. **Point the script at your doc + CSV**. In the Apps Script editor
   console (View > Execution log, or just the console at the bottom),
   run:
   ```js
   setConfig_('YOUR_GOOGLE_DOC_ID', 'YOUR_ZOTERO_CSV_FILE_ID');
   ```
   (Both IDs are the long string in each file's URL.)

## Running it

Two modes are available, depending on how you want suggestions to appear.

### Mode A: Drive API comments (`runCitationPass`)
Writes real Google Docs comments via the Drive API. **Known issue:**
Drive API v3's comment anchoring is unreliable for third-party scripts --
Docs frequently shows "Original content deleted" on these comments even
though nothing was deleted and the comment text itself is fully intact and
readable in the Comments panel. Use this mode if you're comfortable with
comments that are readable-but-not-visually-anchored, since it keeps
suggestions in the separate comments layer rather than the document body.

- **Dry run first, always**: `runDryRun()` -- logs what would be flagged
  and matched, writes nothing.
- **Live run**: `runCitationPass()`.

### Mode B: Inline highlights + markers (`runInlineAnnotationPass`)
Alternative that guarantees correct positioning by searching the document
body directly (via `DocumentApp`, not the Drive API) and editing it: each
flagged sentence gets a tier-colored highlight, and a short bracketed
marker (e.g. `⟦CITE-SUGGEST [HIGH] Smith, 2021 "Review of the Evidence..." 
(score 0.45) — empirical/research-finding claim⟧`) is inserted immediately
after it. Trade-off: this edits the document body (highlight color +
marker text), rather than staying purely in the comments layer.

- **Dry run first, always**: `runInlineAnnotationPass({ dryRun: true })`.
- **Live run**: `runInlineAnnotationPass()`.
- **Before re-annotating a doc you've already annotated**: run
  `clearInlineAnnotations()` first, or markers will pile up from each pass
  (the function does skip sentences that already have a marker
  immediately following them, but it's cleaner to clear-and-redo when the
  underlying doc text has changed).
- `clearInlineAnnotations()` removes every marker it inserted and resets
  background color across the **entire** document body -- if you use
  highlighting elsewhere in the doc for something unrelated, that will be
  cleared too. There's no way to tag "our" highlights separately from
  pre-existing ones once applied.

Re-run `setConfig_(...)` any time you switch target docs or refresh the
Zotero CSV export.

## Tuning

- `Config.gs` -> `MATCH_THRESHOLDS.HIGH` / `MEDIUM` control the cosine
  similarity cutoffs for confidence tiers. Start by running a dry run
  against a doc where you already know which sentences are cited, and
  compare the scores against your own expectations.
- `Synonyms.gs` -> `SYNONYM_DICTIONARY` is the main lever for match quality
  without paid embeddings. Add terms as you notice near-misses (e.g. a
  clearly-relevant source not surfacing because of vocabulary mismatch).
- `RuleDetector.gs` regexes can be tightened/loosened per pattern if you
  see systematic false positives or negatives -- each block is commented with the false positive/negative it addresses.

## Known limitations (read before relying on this)

1. **Mode A (Drive API comments) anchoring is unreliable, in practice, not
   just in theory.** The Drive API has no documented way for third-party
   scripts to anchor a comment to an exact character range in a Doc. This
   tool sets `quotedFileContent` to the flagged sentence's exact text,
   which in testing against a real doc still resulted in Google Docs
   showing every comment as "Original content deleted," even though
   nothing was deleted and the comment text itself was fully intact and
   readable in the Comments panel. **Use Mode B
   (`runInlineAnnotationPass`) if correct visual positioning matters** --
   it searches and edits the document body directly via `DocumentApp`
   instead of relying on Drive's comment anchor, and was verified with an
   offset round-trip test (annotate then clear reproduces the original
   document byte-for-byte).
2. **Footnote-overlap detection is a paragraph-level heuristic**, not a
   precise offset check (`DocScanner.sentenceOverlapsFootnote_`). Apps
   Script's `DocumentApp` doesn't cleanly expose footnote anchor offsets
   within `getText()`. In practice this means: a sentence is treated as
   "already cited" if it's the last sentence in a paragraph that contains
   any footnote. This intentionally favors under-flagging (fewer false
   positives) per the citation rules' warning about the hybrid footnote style,
   but it means an uncited final sentence in a paragraph that *also*
   contains an earlier unrelated footnote could be missed.
3. **Sentence splitting is regex-based**, not a real NLP sentence
   tokenizer. It handles common abbreviations (e.g., et al., pp., Fig.) but
   will occasionally over- or under-split on unusual punctuation.
4. **Draft-note bracket detection (`[TO DRAFT: ...]`) is explicitly out of
   scope** for this pass, -- those aren't
   filtered out, so if your working drafts contain them, expect them to be
   scanned as regular text (they're unlikely to trigger positive patterns,
   but haven't been specifically tested against).
5. **TF-IDF has no true semantic understanding.** It will miss a genuinely
   relevant source that uses very different vocabulary than the sentence,
   and can occasionally over-match on coincidental term overlap. The
   synonym dictionary narrows this gap but doesn't close it -- this is the
   tradeoff made in the cost decision to avoid embeddings.

## Using clasp (optional, for local editing)

If you'd rather edit these files locally and push them:
```bash
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "Citation Suggestion Tool" --rootDir ./citation-tool
clasp push
```
Then move the resulting Apps Script file into your Shared Drive folder from
the Drive UI (clasp create doesn't let you target a Shared Drive directly).
