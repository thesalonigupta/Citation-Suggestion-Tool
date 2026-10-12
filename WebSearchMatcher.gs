/**
 * WebSearchMatcher.gs
 *
 * Augments TfIdfMatcher/LlmDetector matching with a live web search,
 * using Claude's native `web_search` tool. This does NOT replace the
 * Zotero-library matching -- it's an optional additional signal, scoped
 * by CONFIG.WEB_SEARCH.MODE ('OFF' / 'WEAK_AND_BELOW' / 'ALL').
 *
 * DESIGN NOTE ON DOMAIN CONTROL: the web_search tool accepts a native
 * `allowed_domains` parameter -- a server-enforced restriction, not
 * something achieved by hoping Claude includes the right `site:` operator
 * in its own query text. We build that list from YOUR Zotero library's
 * actual Url column (see ZoteroLibrary.extractKnownDomains_), so results
 * are structurally biased toward the same kinds of sources (arxiv.org,
 * publisher sites, etc.) your library already draws from -- zero LLM reasoning
 * spent deciding this, it's derived once at load time. Claude still writes
 * the literal search query text itself (that part isn't something the API
 * lets a caller override), but we steer it hard via author hints pulled
 * from the library (see ZoteroLibrary.findAuthorEntries).
 *
 * COST: billed on two axes -- $10 per 1,000 searches (flat), PLUS standard
 * token costs for whatever search-result content gets pulled into context.
 * This is why MODE defaults to 'OFF' and why this has its own separate
 * monthly budget cap (CONFIG.WEB_SEARCH.MONTHLY_BUDGET_CAP_USD) rather
 * than sharing LlmDetector's cap -- 'ALL' mode (searching every flagged
 * sentence, not just weak ones) can add up meaningfully faster than
 * detection or TF-IDF-shortlist ranking do.
 */

var WebSearchMatcher = (function () {

  function enrichResults(results, library) {
    var mode = CONFIG.WEB_SEARCH.MODE;
    if (mode === 'OFF') return results;

    var targets = results.filter(function (r) {
      if (mode === 'ALL') return true;
      if (mode === 'WEAK_AND_BELOW') return r.tier === 'WEAK' || r.tier === 'NO_MATCH';
      return false;
    });

    Logger.log('WebSearchMatcher: mode=%s, searching %s/%s flagged sentences.',
      mode, targets.length, results.length);

    targets.forEach(function (r) {
      try {
        r.webSearchCandidate = searchOne_(r, library);
      } catch (e) {
        Logger.log('WebSearchMatcher: search failed for "%s...": %s',
          r.sentenceInfo.text.substring(0, 60), e);
        r.webSearchCandidate = null;
      }
    });

    return results;
  }

  /**
   * Re-ranks TF-IDF's own candidate list via Claude, for sentences where a
   * formula-only ranking is most likely to be wrong: WEAK-tier results, and
   * MEDIUM/HIGH results whose top two scores are within AMBIGUITY_MARGIN of
   * each other (a near-tie TF-IDF can't meaningfully break). This does NOT
   * search the web -- it judges among candidates TF-IDF already found in
   * your own Zotero library, so it costs only tokens, no $10/1000 search
   * fee, and has its own small separate budget line.
   *
   * Deliberately narrow in scope (see the chat discussion this came from):
   * running Claude judgment over every sentence adds cost and
   * non-determinism for the ~70-80% of cases a deterministic TF-IDF score
   * already gets right. This targets specifically the cases we've shown
   * formulas get wrong (e.g. a near-tie between two authors' papers where the lower-scored one is correct).
   *
   * A successful rerank sets tier to 'RERANKED' (not back to HIGH/MEDIUM/
   * WEAK) so it stays visibly distinct as an LLM judgment call rather than
   * a recomputed TF-IDF score -- consistent with keeping deterministic and
   * LLM-derived tiers separately labeled throughout this tool.
   */
  function rerankAmbiguous(results) {
    if (!CONFIG.RERANK || CONFIG.RERANK.MODE === 'OFF') return results;

    var targets = results.filter(needsRerank_);
    Logger.log('WebSearchMatcher: reranking %s/%s ambiguous TF-IDF matches via Claude.',
      targets.length, results.length);

    targets.forEach(function (r) {
      try {
        var rerank = rerankOne_(r);
        if (!rerank) return;

        r.rerankResult = rerank;
        if (rerank.pick_index !== null && rerank.pick_index !== undefined &&
            r.matches[rerank.pick_index]) {
          var picked = r.matches[rerank.pick_index];
          var rest = r.matches.filter(function (m, i) { return i !== rerank.pick_index; });
          r.matches = [picked].concat(rest);
          r.tier = 'RERANKED';
        }
        // If pick_index is null (Claude found none of the candidates fit),
        // the original tier and match order are left untouched -- reranking
        // only ever promotes a candidate, never silently discards one.
      } catch (e) {
        Logger.log('WebSearchMatcher: rerank failed for "%s...": %s',
          r.sentenceInfo.text.substring(0, 60), e);
      }
    });

    return results;
  }

  function needsRerank_(r) {
    // CONTEXTUAL results are exempt entirely -- these carry an explicit,
    // human-authored citation (a "Reference in this section:" declaration,
    // or a list item's inherited framework citation), which is a stronger
    // signal than anything reranking over TF-IDF's matches could produce.
    // Found via testing: without this check, reranking silently overwrote
    // 5 of 8 CONTEXTUAL results back to RERANKED just because their
    // underlying (irrelevant, since unused) TF-IDF matches happened to
    // have a close score gap -- discarding the better answer for a worse
    // one computed from a signal we'd already decided to ignore.
    if (r.tier === 'CONTEXTUAL') return false;
    if (r.tier === 'WEAK') return true;
    var m = r.matches;
    if (m && m.length >= 2) {
      var gap = m[0].score - m[1].score;
      if (gap < CONFIG.RERANK.AMBIGUITY_MARGIN) return true;
    }
    return false;
  }

  function rerankOne_(result) {
    var estimatedCost = estimateRerankCost_();
    checkAndReserveRerankBudget_(estimatedCost);

    var lines = [];
    lines.push('You are choosing the best-matching source, from candidates already found by ' +
      'keyword search in a Zotero library, for a sentence from a research document.');
    lines.push(DOMAIN_CONTEXT);
    lines.push('Sentence: "' + result.sentenceInfo.text + '"');
    lines.push('\nCandidates (in original keyword-match order -- keyword score does not mean ' +
      'meaning-match; a lower-scored candidate can be the correct one):');
    result.matches.forEach(function (m, i) {
      lines.push(i + '. "' + m.title + '" by ' + m.authors + ' (' + m.year +
        ') -- keyword match score ' + m.score.toFixed(2));
    });
    lines.push('\nWhich candidate (by index) is actually the correct citation for this sentence, ' +
      'based on what the sentence is claiming and who is making that claim -- not just keyword ' +
      'overlap? If none of the candidates are a good fit, use null.');
    lines.push('\nRespond with ONLY a JSON object:');
    lines.push('{"pick_index": int or null, "confidence": "high"|"medium"|"low", "reasoning": "short explanation"}');

    var payload = {
      model: CONFIG.RERANK.MODEL,
      max_tokens: 300,
      messages: [{ role: 'user', content: lines.join('\n') }]
    };

    var response = UrlFetchApp.fetch(CONFIG.LLM_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': getClaudeApiKey_(),
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    var body = JSON.parse(response.getContentText());
    if (code !== 200) {
      throw new Error('Claude API (rerank) returned ' + code + ': ' + JSON.stringify(body));
    }

    recordRerankSpend_(body);

    var text = body.content && body.content[0] && body.content[0].text;
    if (!text) return null;
    var cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    var jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      return JSON.parse(sanitizeJsonText_(jsonMatch[0]));
    } catch (e) {
      Logger.log('WebSearchMatcher: failed to parse rerank JSON: %s', e);
      return null;
    }
  }

  /**
   * Fixes a specific, observed failure mode: Claude occasionally writes
   * Python literals (None/True/False) instead of their JSON equivalents
   * (null/true/false) -- e.g. {"pick_index": None} -- which is invalid
   * JSON and previously caused the whole verdict to be silently discarded.
   * Only replaces these tokens where they appear as a JSON VALUE (after
   * a colon or inside an array), not inside a quoted string, so this can't
   * corrupt a legitimate string that happens to contain the word "None".
   */
  function sanitizeJsonText_(text) {
    return text
      .replace(/:(\s*)None\b/g, ':$1null')
      .replace(/:(\s*)True\b/g, ':$1true')
      .replace(/:(\s*)False\b/g, ':$1false')
      .replace(/\[(\s*)None\b/g, '[$1null')
      .replace(/,(\s*)None\b/g, ',$1null');
  }

  function estimateRerankCost_() {
    // Small: sentence + up to ~5 short candidate lines in, a short JSON
    // verdict out. No search fee -- this never calls the web_search tool.
    var estimatedInputTokens = 700;
    var estimatedOutputTokens = 120;
    var inputCost = (estimatedInputTokens / 1000000) * 2.0;  // Sonnet 5 introductory input rate
    var outputCost = (estimatedOutputTokens / 1000000) * 10.0; // Sonnet 5 introductory output rate
    return inputCost + outputCost;
  }

  function checkAndReserveRerankBudget_(estimatedCost) {
    var props = PropertiesService.getScriptProperties();
    var monthLabel = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyy-MM');
    var storedMonth = props.getProperty(CONFIG.RERANK.SPEND_MONTH_PROPERTY);
    var spent = 0;

    if (storedMonth === monthLabel) {
      spent = parseFloat(props.getProperty(CONFIG.RERANK.SPEND_PROPERTY) || '0');
    } else {
      props.setProperty(CONFIG.RERANK.SPEND_MONTH_PROPERTY, monthLabel);
      props.setProperty(CONFIG.RERANK.SPEND_PROPERTY, '0');
    }

    if (spent + estimatedCost > CONFIG.RERANK.MONTHLY_BUDGET_CAP_USD) {
      throw new Error(
        'Rerank monthly budget cap reached ($' + CONFIG.RERANK.MONTHLY_BUDGET_CAP_USD + '). ' +
        'Spent so far this month: $' + spent.toFixed(4) + '.'
      );
    }

    props.setProperty(CONFIG.RERANK.SPEND_PROPERTY, String(spent + estimatedCost));
  }

  function recordRerankSpend_(body) {
    var usage = body.usage || {};
    var inputCost = (usage.input_tokens || 0) / 1000000 * 2.0;
    var outputCost = (usage.output_tokens || 0) / 1000000 * 10.0;
    var actual = inputCost + outputCost;
    Logger.log('WebSearchMatcher: rerank call cost $%s (input=%s, output=%s)',
      actual.toFixed(5), usage.input_tokens, usage.output_tokens);
  }

  function searchOne_(result, library) {
    var topTfIdfMatch = result.matches && result.matches[0];

    // Pull author hints from TWO independent sources, not just TF-IDF's
    // top pick -- that pick can itself be wrong (the exact scenario this
    // feature exists to fix: TF-IDF ranked a related paper by a different author
    // above the named author's own paper on the sentence "Smith argues that..."). A
    // name mentioned directly in the sentence is often the more reliable
    // signal, so both sources are merged and deduplicated.
    var sentenceAuthorName = extractNamedAuthorFromSentence_(result.sentenceInfo.text);
    var freeAuthorHint = sentenceAuthorName ||
      (topTfIdfMatch ? (topTfIdfMatch.authors || '').split(/[,;]/)[0].trim() : null);

    // ---- Step 1: FREE pre-filter (Google Books / OpenAlex / Crossref) ----
    // No LLM call, no per-search fee. If this finds a confident match, the
    // paid Claude web_search call below is skipped entirely for this
    // sentence -- this is the actual cost-reduction mechanism, not a
    // reduction in coverage (every flagged sentence still gets checked).
    var freeResult = { candidates: [] };
    try {
      freeResult = AcademicSearch.search(result.sentenceInfo.text, freeAuthorHint);
    } catch (e) {
      Logger.log('WebSearchMatcher: free pre-filter failed, proceeding to paid search: %s', e);
    }

    var topFree = freeResult.candidates[0];
    if (topFree && topFree.score >= CONFIG.ACADEMIC_SEARCH.SKIP_PAID_SEARCH_THRESHOLD) {
      Logger.log('WebSearchMatcher: free match (score %s) for "%s..." -- skipping paid search.',
        topFree.score.toFixed(1), result.sentenceInfo.text.substring(0, 50));
      return {
        found: true,
        title: topFree.title,
        authors: topFree.authors,
        year: topFree.year,
        url: topFree.url,
        confidence: topFree.score >= 18 ? 'high' : 'medium',
        reasoning: 'Found via free bibliographic search (' + topFree.from +
          (topFree.doi ? ', DOI-verified' : '') + ') -- no paid API call needed.'
      };
    }

    // ---- Step 2: paid Claude web_search fallback ----
    var estimatedCost = estimateCost_();
    checkAndReserveBudget_(estimatedCost);

    var allowedDomains = library.knownDomains.slice(0, CONFIG.WEB_SEARCH.MAX_ALLOWED_DOMAINS);
    var authorHints = [];
    if (sentenceAuthorName) {
      authorHints = authorHints.concat(ZoteroLibrary.findAuthorEntries(sentenceAuthorName, library.entries));
    }
    if (topTfIdfMatch) {
      ZoteroLibrary.findAuthorEntries(topTfIdfMatch.authors, library.entries).forEach(function (e) {
        if (authorHints.indexOf(e) === -1) authorHints.push(e);
      });
    }

    // The free pre-filter's own (unconfident, but not worthless) candidates
    // are already fetched and cost nothing further -- pass the best one or
    // two along as extra leads rather than discarding that information.
    var freeLeads = freeResult.candidates.slice(0, 2);

    var userPrompt = buildPrompt_(result, topTfIdfMatch, authorHints, sentenceAuthorName, freeLeads);

    var payload = {
      model: CONFIG.WEB_SEARCH.MODEL,
      max_tokens: 1200,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: CONFIG.WEB_SEARCH.MAX_USES_PER_SENTENCE,
        allowed_domains: allowedDomains
      }],
      messages: [{ role: 'user', content: userPrompt }]
    };

    var response = UrlFetchApp.fetch(CONFIG.LLM_API_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': getClaudeApiKey_(),
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    var body = JSON.parse(response.getContentText());
    if (code !== 200) {
      throw new Error('Claude API (web search) returned ' + code + ': ' + JSON.stringify(body));
    }

    recordActualSpend_(body);

    var verdict = extractVerdict_(body);

    // ---- Step 3: verify/upgrade whatever the paid search found ----
    // If Claude's result includes a URL with a DOI, replace its own
    // transcription of title/authors/year with Crossref's canonical
    // record -- free, and strictly more trustworthy than trusting the
    // model to have copied a search snippet correctly.
    if (verdict && verdict.found && verdict.url) {
      try {
        var verified = AcademicSearch.verifyDoi(verdict.url);
        if (verified) {
          verdict.title = verified.title;
          verdict.authors = verified.authors;
          verdict.year = verified.year;
          verdict.url = verified.url;
          verdict.reasoning = (verdict.reasoning || '') + ' (Verified against Crossref.)';
        }
      } catch (e) {
        Logger.log('WebSearchMatcher: Crossref verification failed, keeping Claude\'s own result: %s', e);
      }
    }

    return verdict;
  }

  /**
   * Extracts a plausible named author directly from the sentence text --
   * e.g. "Smith argues that..." or "Smith (2025) argues..." -- as an author
   * hint independent of whatever TF-IDF ranked highest. Deliberately
   * simple (single capitalized word before an attribution verb); a miss
   * here just means we fall back to the TF-IDF-derived hint alone.
   */
  function extractNamedAuthorFromSentence_(text) {
    var m = text.match(
      /\b([A-Z][a-z]+)\b(?:\s\(\d{4}[a-z]?\))?(?:\set al\.|\sand colleagues)?\s+(?:argues?|holds?|suggests?|proposes?|contends?|maintains?|claims?|notes?|observes?|shows?|found|finds?|reviewed|analyzed|analyz(?:e|es))\b/
    );
    return m ? m[1] : null;
  }

  function buildPrompt_(result, topTfIdfMatch, authorHints, sentenceAuthorName, freeLeads) {
    var lines = [];
    lines.push('You are verifying/finding an academic citation for a sentence from a research document.');
    lines.push(DOMAIN_CONTEXT);
    lines.push('Sentence: "' + result.sentenceInfo.text + '"');

    if (sentenceAuthorName) {
      lines.push('\nThe sentence itself names "' + sentenceAuthorName + '" as making this claim -- ' +
        'treat this as a STRONGER signal than the library keyword match below if they conflict.');
    }

    if (topTfIdfMatch) {
      lines.push('\nThe closest match found in our own library (via keyword search, may be weak or wrong) is:');
      lines.push('"' + topTfIdfMatch.title + '" by ' + topTfIdfMatch.authors + ' (' + topTfIdfMatch.year + '), score ' + topTfIdfMatch.score.toFixed(2));
    }

    if (authorHints.length) {
      lines.push('\nOther works already in our library by the named author(s) above (search for more work by ' +
        'them on this specific topic first, before searching generally):');
      authorHints.slice(0, 5).forEach(function (e) {
        lines.push('- "' + e.title + '" (' + e.year + ')');
      });
    }

    if (freeLeads && freeLeads.length) {
      lines.push('\nA free bibliographic search (Google Books/OpenAlex/Crossref) already found these ' +
        'possible leads, but not confidently enough to use automatically -- check these first before ' +
        'searching the open web:');
      freeLeads.forEach(function (c) {
        lines.push('- "' + c.title + '" by ' + (c.authors || 'unknown') + ' (' + (c.year || 'n.d.') + ')' +
          (c.doi ? ', DOI: ' + c.doi : ''));
      });
    }

    lines.push('\nSearch the web (restricted to the allowed domains) to find the specific paper this ' +
      'sentence is most likely citing or should cite. Prefer the sentence\'s own named author over the ' +
      'library keyword match if they point to different people.');
    lines.push('\nRespond with ONLY a final JSON object (no other text after it):');
    lines.push('{"found": bool, "title": "...", "authors": "...", "year": "...", "url": "...", ' +
      '"confidence": "high"|"medium"|"low", "reasoning": "short explanation"}');

    return lines.join('\n');
  }

  function extractVerdict_(body) {
    var content = body.content || [];
    // The response interleaves text/server_tool_use/web_search_tool_result
    // blocks; the final judgment we asked for is in the LAST text block.
    var textBlocks = content.filter(function (b) { return b.type === 'text'; });
    if (!textBlocks.length) return null;

    var lastText = textBlocks[textBlocks.length - 1].text;
    var cleaned = lastText.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');

    var jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      Logger.log('WebSearchMatcher: no JSON object found in final response text.');
      return null;
    }

    try {
      return JSON.parse(sanitizeJsonText_(jsonMatch[0]));
    } catch (e) {
      Logger.log('WebSearchMatcher: failed to parse verdict JSON: %s', e);
      return null;
    }
  }

  // ---- Cost estimation & budget enforcement (separate from LlmDetector) --

  function estimateCost_() {
    // Worst-case estimate assuming max_uses searches all happen, each
    // pulling back a moderate amount of result content. True-up happens
    // via recordActualSpend_ once the real response.usage is known.
    var maxUses = CONFIG.WEB_SEARCH.MAX_USES_PER_SENTENCE;
    var searchFees = (maxUses / 1000) * CONFIG.WEB_SEARCH.SEARCH_FEE_PER_1000;
    var estimatedResultTokens = maxUses * 2500;
    var inputCost = (estimatedResultTokens / 1000000) * 2.0; // Sonnet 5 introductory input rate
    var outputCost = (600 / 1000000) * 10.0; // Sonnet 5 introductory output rate
    return searchFees + inputCost + outputCost;
  }

  function checkAndReserveBudget_(estimatedCost) {
    var props = PropertiesService.getScriptProperties();
    var monthLabel = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyy-MM');
    var storedMonth = props.getProperty(CONFIG.WEB_SEARCH.SPEND_MONTH_PROPERTY);
    var spent = 0;

    if (storedMonth === monthLabel) {
      spent = parseFloat(props.getProperty(CONFIG.WEB_SEARCH.SPEND_PROPERTY) || '0');
    } else {
      props.setProperty(CONFIG.WEB_SEARCH.SPEND_MONTH_PROPERTY, monthLabel);
      props.setProperty(CONFIG.WEB_SEARCH.SPEND_PROPERTY, '0');
    }

    if (spent + estimatedCost > CONFIG.WEB_SEARCH.MONTHLY_BUDGET_CAP_USD) {
      throw new Error(
        'Web search monthly budget cap reached ($' + CONFIG.WEB_SEARCH.MONTHLY_BUDGET_CAP_USD + '). ' +
        'Spent so far this month: $' + spent.toFixed(4) + '.'
      );
    }

    props.setProperty(CONFIG.WEB_SEARCH.SPEND_PROPERTY, String(spent + estimatedCost));
  }

  function recordActualSpend_(body) {
    var usage = body.usage || {};
    var searchCount = 0;
    (body.content || []).forEach(function (b) {
      if (b.type === 'server_tool_use' && b.name === 'web_search') searchCount++;
    });

    var searchFees = (searchCount / 1000) * CONFIG.WEB_SEARCH.SEARCH_FEE_PER_1000;
    var inputCost = (usage.input_tokens || 0) / 1000000 * 2.0;
    var cacheReadCost = (usage.cache_read_input_tokens || 0) / 1000000 * 0.2;
    var outputCost = (usage.output_tokens || 0) / 1000000 * 10.0;
    var actual = searchFees + inputCost + cacheReadCost + outputCost;

    Logger.log('WebSearchMatcher: actual call cost $%s (%s searches, input=%s, output=%s)',
      actual.toFixed(5), searchCount, usage.input_tokens, usage.output_tokens);
  }

  return { enrichResults: enrichResults, rerankAmbiguous: rerankAmbiguous };
})();
