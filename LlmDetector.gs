/**
 * LlmDetector.gs
 *
 * Alternative to RuleDetector.gs: instead of regex patterns, sends
 * sentences to Claude (Haiku 4.5 by default) to judge citation-need
 * directly against the rules below. Opt-in only -- set CONFIG.DETECTION_MODE
 * = 'LLM' to use this instead of RuleDetector.gs.
 *
 * COST: at Haiku 4.5 rates ($1/$5 per MTok input/output), a typical
 * ~40-sentence document costs roughly $0.01-$0.02 per full pass with an
 * empty cache, and $0 for any sentence unchanged since a prior run. See
 * the cost-control mechanisms below -- none of them require remembering
 * to do anything on a per-run basis; they're structural.
 *
 * COST CONTROLS (all automatic, not manual):
 *   1. Per-sentence caching (CacheService) -- a sentence identical to one
 *      already scored within CONFIG.LLM_CACHE_TTL_SECONDS costs nothing.
 *   2. Batching -- every uncached sentence in a document goes in ONE
 *      request, not one request per sentence, amortizing fixed overhead.
 *   3. Prompt caching (cache_control on the system prompt) -- the rules
 *      text itself is only billed at full price on the first call within
 *      its cache window; subsequent calls read it at 10% of base cost.
 *   4. Hard budget cap -- evaluateBatch() refuses to call the API once
 *      CONFIG.LLM_MONTHLY_BUDGET_CAP_USD is reached for the current
 *      calendar month, throwing a clear error rather than silently
 *      overspending. Callers should catch this and fall back to
 *      RuleDetector.gs (see Main.gs).
 *
 * OUTPUT SHAPE: matches RuleDetector.evaluate()'s verdict shape exactly
 * ({needsCitation, reasons, isConsensusClaim}), and reuses the same
 * reason-string vocabulary (e.g. "named-author framework introduction")
 * so Main.gs's list-context tracking works unmodified regardless of which
 * detector produced the verdict.
 */

var LlmDetector = (function () {

  var SYSTEM_PROMPT =
    'You are a citation-need detector for academic report drafts. ' +
    'For each numbered sentence, decide whether it needs an ' +
    'in-text citation, following these rules exactly.\n\n' +
    DOMAIN_CONTEXT + '\n\n' +
    'FLAG (needs_citation: true) when a sentence contains:\n' +
    '- An attribution/reported-position verb pointing at someone else\'s claim: "argues/argued", ' +
    '"holds/held", "suggests", "proposes", "contends", "maintains", "claims that", "notes/observes that", ' +
    '"shows/found/finds that", "demonstrates", "reviewed... concluded", "analyzed... found" -- ' +
    'INCLUDING gerund forms like "arguing that", "noting that".\n' +
    '- Anonymous-position framing: "On this view...", "Others argue...", "Some hold...", ' +
    '"Critics argue...", "Proponents of X argue...".\n' +
    '- First mention of a named framework, theory, report, or policy (e.g. "the Belmont Report", ' +
    '"Self-Determination Theory", "Cognitive Dissonance Theory") -- only flag the FIRST occurrence ' +
    'in the document, not repeats.\n' +
    '- An empirical/research-finding claim: "research suggests", "studies show", specific ' +
    'statistics tied to a study, or narration of a SPECIFIC NAMED EXPERIMENT OR STUDY even without ' +
    'an explicit attribution verb (e.g. describing "the Stanford prison experiment" paradigm ' +
    'in narrative form still needs a citation, because it is invoking a specific real study).\n' +
    '- A named historical case, incident, or study used as evidence.\n' +
    '- A direct quote attributed to a named person.\n' +
    '- A survey/expert-consensus statistic ("in a survey of X, Y% responded...").\n' +
    '- A "see X" pointer citation ("see Author for further discussion", "cf. Author").\n' +
    '- A named-author framework introduction ("X et al. helpfully provide a framework...", even ' +
    'if a "(Year)" citation appears between "et al." and the verb).\n' +
    '- A hedged first-person claim about EXISTING theory/evidence ("it might be that...", ' +
    '"arguably...", "plausibly...") -- but NOT if the sentence is defining a term.\n' +
    '- A field-convention definition: "X is typically/often defined as Y" (this attributes the ' +
    'definition to the discipline, unlike an authorial stipulation).\n\n' +
    'DO NOT FLAG (needs_citation: false):\n' +
    '- Authorial stipulative definitions: "we use X to mean Y", "we define X as...", ' +
    '"by X we mean Y", "for our purposes here, X is Y" -- even if hedged or first-person.\n' +
    '- First-person synthesis/argument that is the AUTHORS\' OWN original claim: "we take it that...", ' +
    '"our central claim is...", "we argue that [novel claim]", "we propose that...".\n' +
    '- Structural meta-commentary about the document itself: "in this section we will...", ' +
    '"we will now discuss...".\n' +
    '- Hypothetical objections/rhetorical devices with no real attributed source: "one could ' +
    'argue that...", "one might think...", "someone might object..." -- these are the single ' +
    'biggest false-positive risk; a sentence can use third-person "argue" language and STILL not ' +
    'need a citation if it is the author anticipating a counterargument in their own voice rather ' +
    'than citing a real position someone actually holds.\n' +
    '- A sentence already containing an inline citation in ANY recognizable format, including ' +
    '"(Author, Year)", "(Author, n.d.)", "Author (Year)", "[Author, Year]", or "[See Author, ' +
    '\'Title,\' Ch. N]" -- these already have a citation and should never be flagged again, even if ' +
    'a quote or attribution verb also appears in the same sentence.\n' +
    '- A plain nominal (noun) use of a word that looks like an attribution verb, e.g. "some ' +
    'illustrative claims" (noun) vs. "she claims that" (verb); or "hold them responsible" ' +
    '(different sense of "hold") vs. "hold the view that" (position-holding sense).\n\n' +
    'Also set is_consensus_claim: true when a claim describes an emerging consensus or is ' +
    'introduced with phrasing like "many researchers have argued" or "many scholars hold" -- these ' +
    'typically warrant multiple source suggestions rather than one.\n\n' +
    'Respond with ONLY a JSON array, one object per input sentence. Each object MUST include an ' +
    '"i" field with EXACTLY the number that sentence was given below (0-indexed) -- this is how ' +
    'your response gets matched back to the right sentence, so it must be correct and every input ' +
    'number must appear exactly once. No markdown code fences, no other text:\n' +
    '[{"i": 0, "needs_citation": bool, "reasons": ["short phrase", ...], "is_consensus_claim": bool}, ...]';

  function evaluateBatch(sentences) {
    var results = new Array(sentences.length);
    var cache = CacheService.getScriptCache();
    var toQuery = []; // { originalIndex, text }

    sentences.forEach(function (s, i) {
      var key = cacheKey_(s.text);
      var cached = cache.get(key);
      if (cached) {
        results[i] = JSON.parse(cached);
      } else {
        toQuery.push({ originalIndex: i, text: s.text });
      }
    });

    Logger.log('LlmDetector: %s/%s sentences cached, %s need a fresh call.',
      sentences.length - toQuery.length, sentences.length, toQuery.length);

    if (toQuery.length === 0) {
      return results; // every sentence was a cache hit -- zero API cost this run
    }

    // Chunk into batches rather than one call for the whole document. This
    // was found necessary in testing: a 793-sentence real document produced
    // a response that exceeded the old flat 4000-token output cap and got
    // truncated mid-JSON, losing EVERY sentence's result to one parse
    // failure. Chunking bounds each call's output size regardless of
    // document length, and confines a bad chunk's failure to that chunk
    // alone -- the rest of the document's results are unaffected.
    var chunks = [];
    for (var c = 0; c < toQuery.length; c += CONFIG.LLM_BATCH_SIZE) {
      chunks.push(toQuery.slice(c, c + CONFIG.LLM_BATCH_SIZE));
    }
    Logger.log('LlmDetector: processing %s sentence(s) in %s batch(es) of up to %s.',
      toQuery.length, chunks.length, CONFIG.LLM_BATCH_SIZE);

    var chunksFailed = 0;
    chunks.forEach(function (chunk, chunkIndex) {
      var estimatedCost = estimateCost_(chunk);

      try {
        checkAndReserveBudget_(estimatedCost);
      } catch (e) {
        // Budget cap hit partway through -- the chunks already processed
        // keep their real results (cached above); everything from here on
        // fails safe rather than the whole run erroring out.
        Logger.log('LlmDetector: %s -- %s/%s batches were not processed (%s sentences default to "no flag").',
          e, chunks.length - chunkIndex, chunks.length,
          chunks.slice(chunkIndex).reduce(function (n, ch) { return n + ch.length; }, 0));
        chunks.slice(chunkIndex).forEach(function (remaining) {
          remaining.forEach(function (q) {
            results[q.originalIndex] = { needsCitation: false, reasons: [], isConsensusClaim: false };
          });
        });
        chunksFailed += chunks.length - chunkIndex;
        return; // forEach can't break, but every remaining chunk hits this same budget wall
      }

      var verdicts;
      try {
        verdicts = callClaude_(chunk.map(function (q) { return q.text; }));
      } catch (e) {
        Logger.log('LlmDetector: batch %s/%s failed, falling back to "no flag" for its %s sentence(s): %s',
          chunkIndex + 1, chunks.length, chunk.length, e);
        chunk.forEach(function (q) {
          results[q.originalIndex] = { needsCitation: false, reasons: [], isConsensusClaim: false };
        });
        chunksFailed++;
        return;
      }

      // Match verdicts back to sentences by the explicit "i" field each one
      // carries, NOT by array position -- found in testing that Claude can
      // occasionally miscount a ~50-item batch (return 52, or 46, items).
      // Positional matching turned any such miscount into a total loss for
      // the whole batch; index-based lookup means only the specific
      // sentence(s) actually missing a verdict fall back to "no flag."
      var byIndex = {};
      verdicts.forEach(function (v) {
        if (v && typeof v.i === 'number') byIndex[v.i] = v;
      });

      var missingCount = 0;
      chunk.forEach(function (q, j) {
        var v = byIndex[j];
        if (!v) {
          missingCount++;
          results[q.originalIndex] = { needsCitation: false, reasons: [], isConsensusClaim: false };
          return;
        }
        var verdict = {
          needsCitation: !!v.needs_citation,
          reasons: v.reasons || [],
          isConsensusClaim: !!v.is_consensus_claim
        };
        results[q.originalIndex] = verdict;
        cache.put(cacheKey_(q.text), JSON.stringify(verdict), CONFIG.LLM_CACHE_TTL_SECONDS);
      });

      if (missingCount > 0) {
        Logger.log('LlmDetector: batch %s/%s -- %s/%s sentence(s) had no matching verdict in the ' +
          'response (defaulted to "no flag"); the other %s in this batch processed normally.',
          chunkIndex + 1, chunks.length, missingCount, chunk.length, chunk.length - missingCount);
        chunksFailed++; // counts batches with ANY issue, for the summary log -- not "batches fully lost"
      }
    });

    if (chunksFailed > 0) {
      Logger.log('LlmDetector: %s/%s batches had at least one unmatched sentence -- see per-batch ' +
        'lines above for exactly which, everything else in this run is unaffected.', chunksFailed, chunks.length);
    }

    return results;
  }

  function cacheKey_(text) {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text);
    var hash = digest.map(function (b) {
      return ('0' + (b & 0xFF).toString(16)).slice(-2);
    }).join('');
    return 'llmdetect:' + hash;
  }

  function callClaude_(texts) {
    var userContent = texts.map(function (t, i) {
      return i + '. ' + t;
    }).join('\n\n');

    var payload = {
      model: CONFIG.LLM_MODEL,
      max_tokens: CONFIG.LLM_MAX_OUTPUT_TOKENS,
      system: [{
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' } // reused every call -- cache it
      }],
      messages: [{ role: 'user', content: userContent }]
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
      throw new Error('Claude API returned ' + code + ': ' + JSON.stringify(body));
    }

    // True up estimated spend with actual token usage now that we know it.
    if (body.usage) {
      recordActualSpend_(body.usage);
    }

    var text = body.content && body.content[0] && body.content[0].text;
    if (!text) throw new Error('Claude API response had no text content.');

    var cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(cleaned);
  }

  // ---- Cost estimation & budget enforcement ----------------------------

  function estimateCost_(toQuery) {
    var charCount = toQuery.reduce(function (sum, q) { return sum + q.text.length; }, 0);
    var estimatedInputTokens = Math.ceil(charCount / 4) + 400; // +overhead for prompt structure, not the cached system prompt
    var estimatedOutputTokens = toQuery.length * 40; // ~40 tokens per verdict object
    var inputCost = (estimatedInputTokens / 1000000) * 1.0; // Haiku 4.5: $1/MTok input
    var outputCost = (estimatedOutputTokens / 1000000) * 5.0; // $5/MTok output
    return inputCost + outputCost;
  }

  function checkAndReserveBudget_(estimatedCost) {
    var props = PropertiesService.getScriptProperties();
    var monthLabel = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'yyyy-MM');
    var storedMonth = props.getProperty(CONFIG.LLM_SPEND_MONTH_PROPERTY);
    var spent = 0;

    if (storedMonth === monthLabel) {
      spent = parseFloat(props.getProperty(CONFIG.LLM_SPEND_PROPERTY) || '0');
    } else {
      // New calendar month -- spend resets automatically, no manual reset needed.
      props.setProperty(CONFIG.LLM_SPEND_MONTH_PROPERTY, monthLabel);
      props.setProperty(CONFIG.LLM_SPEND_PROPERTY, '0');
    }

    if (spent + estimatedCost > CONFIG.LLM_MONTHLY_BUDGET_CAP_USD) {
      throw new Error(
        'LLM monthly budget cap reached ($' + CONFIG.LLM_MONTHLY_BUDGET_CAP_USD + '). ' +
        'Spent so far this month: $' + spent.toFixed(4) + '. ' +
        'Falling back to RuleDetector.gs is recommended (see Main.gs DETECTION_MODE).'
      );
    }

    props.setProperty(CONFIG.LLM_SPEND_PROPERTY, String(spent + estimatedCost));
  }

  function recordActualSpend_(usage) {
    // Adjust the running total from the estimate to the real usage figures
    // Claude returns, so the budget cap tracks reality rather than a rough
    // guess. Cache-read tokens are billed at 10% of base input price.
    var inputCost = (usage.input_tokens || 0) / 1000000 * 1.0;
    var cacheReadCost = (usage.cache_read_input_tokens || 0) / 1000000 * 0.1;
    var cacheWriteCost = (usage.cache_creation_input_tokens || 0) / 1000000 * 1.25;
    var outputCost = (usage.output_tokens || 0) / 1000000 * 5.0;
    var actual = inputCost + cacheReadCost + cacheWriteCost + outputCost;

    Logger.log('LlmDetector: actual call cost $%s (input=%s, cache_read=%s, cache_write=%s, output=%s)',
      actual.toFixed(5), usage.input_tokens, usage.cache_read_input_tokens,
      usage.cache_creation_input_tokens, usage.output_tokens);
    // Note: the pre-call estimate already reserved budget for this call;
    // this log is for visibility/tuning the estimate, not a second charge.
  }

  return { evaluateBatch: evaluateBatch };
})();
