/**
 * RuleDetector.gs
 *
 * Implements the project's citation-need pattern rules:
 *   - positive triggers (needs citation)
 *   - negative triggers (suppress false positives)
 *   - refinements: field-definitions vs stipulations, hypothetical
 *               objections, named-author frameworks, consensus stacking
 *
 * evaluate() returns a verdict object rather than a bare boolean so Main.gs
 * can decide how many match candidates to request (consensus claims want
 * more than one source suggested) and so comments can explain *why* a
 * sentence was flagged.
 */

var RuleDetector = (function () {

  // ---- positive triggers ---------------------------------------------

  // 'hold' is tightened to require a that-clause. Bare "hold"/"holds" is an
  // ordinary English verb far more often than an attribution verb, and it
  // survived the agent gate in sentences like "the practices through which
  // we recognise and HOLD them responsible". Every genuine attribution in
  // typical academic prose uses the that-clause form ("a view that holds that...").
  var ATTRIBUTION_VERBS_RE =
    /\b(argu(?:e|es|ed)|have argued|holds? that|have held that|held that|suggest(?:s|ed)?|have suggested|propos(?:e|es|ed)|have proposed|contend(?:s|ed)?|maintain(?:s|ed)?|claim(?:s|ed)? that|have claimed|note(?:s|d)? that|observe(?:s|d)? that|show(?:s|ed)? that|found that|find(?:s)? that|conclud(?:e|es|ed) that|demonstrat(?:e|es|ed))\b/i;

  // Research-methodology verbs that introduce a finding even without an
  // explicit "that" clause immediately after (e.g. "reviewed the evidence
  // and concluded...", "analyzed X and found..."). Caught this gap while
  // building test fixtures: sentences using present-tense "find"/"analyze"
  // + a separate result clause weren't matching the stricter pattern above.
  var RESEARCH_METHOD_VERBS_RE =
    /\b(review(?:s|ed)? the (?:scientific |empirical )?evidence|analy[sz](?:e|es|ed) (?:internal representations|the data|the evidence)|survey(?:s|ed) the (?:scientific |empirical )?(?:evidence|literature))\b/i;

  // "on this view" only signals an anonymous position when it FRAMES the
  // clause ("On this view, a notebook is..."). As a prepositional object it
  // is anaphoric, pointing back at something the authors just described --
  // "the second case puts significant pressure on this view" needs no
  // citation of its own.
  var ANONYMOUS_POSITION_RE =
    /(?:^\s*on this view\b|,\s*on this view,|^\s*according to this view\b|,\s*according to this view,)|\b(others (?:argue|have argued|hold)|some (?:have argued|hold)|critics (?:have argued|of \w+ argue)|proponents of \w+ argue)\b/i;

  var NAMED_FRAMEWORK_RE =
    /\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s(?:Report|Policy|Act|Framework|Theory|Rule|Standard))\b/;

  // Known named frameworks that don't fit the generic capitalized-suffix
  // pattern above (e.g. lowercase "framework" trailing a capitalized proper
  // name, or an acronym with no trailing noun). EDIT THIS LIST for your own
  // field: each entry is matched case-insensitively as a whole phrase, and
  // only its first mention in a document is flagged. An empty list is fine.
  var KNOWN_NAMED_FRAMEWORKS = [
    'the belmont report',
    'the common rule'
  ];
  var KNOWN_NAMED_FRAMEWORKS_RE = KNOWN_NAMED_FRAMEWORKS.length
    ? new RegExp('\\b(' + KNOWN_NAMED_FRAMEWORKS.map(function (p) {
        return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('|') + ')\\b', 'i')
    : /(?!)/; // never matches

  var EMPIRICAL_CLAIM_RE =
    /\b(research suggests|research indicates|studies show|evidence suggests|there is (?:growing|increasing)?\s?evidence that|scientists have (?:attempted|sought|worked)|researchers have (?:attempted|sought|worked))\b/i;

  var STATISTIC_RE = /\b\d{1,3}(\.\d+)?%\b/;

  var SURVEY_RE =
    /\b(in a survey of|according to (?:one|a) survey|survey of \w+.*?(?:responded|answered))\b/i;

  var HISTORICAL_CASE_RE =
    /\b(study,? [A-Z][a-z]+ v\.|the [A-Z][a-z]+ (?:incident|case|experiments?))\b/;

  var QUOTE_WITH_NAME_RE =
    /["\u201C][^"\u201D]{5,}["\u201D]/; // quoted span; combined with a nearby proper noun

  var SEE_POINTER_RE =
    /\b(see,? (?:among others,? )?[A-Z]|for (?:a review|an overview|discussion) of .*?,? see|cf\.)\b/i;

  var HEDGE_WORDS_RE =
    /\b(plausibly|arguably|presumably|it seems|one might think|it might be that|some argue)\b/i;

  // A hedge on its own is NOT evidence that a sentence needs a citation.
  // In academic prose "it seems", "arguably" and "plausibly" are far
  // more often the author advancing their own reasoning than deferring to
  // someone else's claim. Measured against a real draft, the bare
  // hedge rule fired on roughly a quarter of all flagged sentences and was
  // wrong on nearly all of them -- e.g. "it seems to remain part of the
  // body", "it seems less likely to be subject to important
  // counterexamples", both of which are the authors' own argument.
  //
  // So the hedge now has to attach to something that actually points at
  // existing scholarship. This trades recall for precision deliberately:
  // a hedged claim about the literature with no explicit referent will be
  // missed, which is the cheaper error.
  var SCHOLARLY_REFERENT_RE =
    /\b(literature|scholars?|philosophers?|researchers?|theorists?|commentators?|proponents?|critics?|the (?:standard|received|orthodox|dominant|prevailing|traditional) (?:view|account|position|reading)|existing (?:work|accounts?|literature|scholarship)|others have|it has been (?:argued|suggested|proposed|claimed|noted))\b/i;

  var NAMED_AUTHOR_FRAMEWORK_RE =
    /\b[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\set al\.\s*(?:\([^)]*\)\s*)?(?:helpfully\s)?(?:provide|offer|present|introduce)s?\b/i;

  // ---- agent detection (gates the attribution-verb rule) --------------
  //
  // An attribution verb only signals citation-need if somebody is doing the
  // attributing. "Smith argued that..." reports a person's view and needs
  // a source; "This suggests that..." is the authors reasoning about their
  // own material and needs nothing. The verbs are identical, so the verb
  // alone cannot tell them apart.
  //
  // Worse, several entries in ATTRIBUTION_VERBS_RE are ordinary English
  // verbs in other senses: "the body MAINTAINS itself", "there still HOLDS
  // the potential". Measured on a real draft, roughly a third of the
  // remaining false positives were one of these two patterns.
  //
  // Known cost: a genuine attribution with no visible agent is now missed --
  // e.g. "a view that holds that outcomes follow from some
  // hidden mechanism" plainly needs a source but names nobody.
  // Accepted deliberately; a spurious marker on the author's own reasoning
  // is the more corrosive error.

  var SCHOLARLY_AGENT_RE =
    /\b(scholars?|philosophers?|researchers?|theorists?|psychologists?|scientists?|critics?|proponents?|commentators?|defenders?|advocates?|the literature)\b/i;

  // "some argue", "others have argued", "many hold" -- an indefinite stand-in
  // for people, but only when an attributing verb follows closely. Without
  // that proximity check, "some of the intuitive pull" reads as an agent.
  var INDEFINITE_AGENT_RE =
    /\b(some|others|many|several|a number of|most|few)\b(?:\s+\w+){0,2}\s+\b(argue[sd]?|have argued|holds?|have held|maintains?|contends?|claims?|suggests?|propose[sd]?|thinks?|believes?|defends?|denies|deny|notes?|observe[sd]?|writes?|says?)\b/i;

  // Capitalized words that are not names. Without this, any sentence with a
  // capitalized word after position 0 counts as having a proper noun, which
  // includes clause-initial "The", "This", "But" and heading-style prefixes
  // like "Definition:" and "Takeaway:".
  var NON_NAME_CAPITALS = {};
  ('the this that these those there then thus but and or if so yet for nor ' +
   'however moreover indeed rather first second third finally conversely ' +
   'similarly likewise consider definition takeaway note see it its we our ' +
   'they their one some what where when while whether given on in at by as ' +
   'an a is are such each both all no not only even still also again now ' +
   'here well since although because before after without within against ' +
   'suppose imagine unlike beyond across toward towards strong weak')
    .split(' ').forEach(function (w) { NON_NAME_CAPITALS[w] = true; });

  function hasProperNoun_(text) {
    var words = text.split(/\s+/);
    for (var i = 1; i < words.length; i++) { // skip index 0: sentence-initial capital
      var w = words[i]
        .replace(/^[("'\u201C\[]+/, '')
        .replace(/[.,;:)\]"'\u201D]+$/, '');
      if (!w) continue;
      var isSimpleName = /^[A-Z\u00C0-\u00DE][a-z\u00DF-\u00FF'\u2019-]+$/.test(w);
      var isCamelName = /^[A-Z][a-z]+[A-Z][A-Za-z]*$/.test(w); // McDonald, DeVries
      if (!isSimpleName && !isCamelName) continue;
      if (NON_NAME_CAPITALS[w.toLowerCase()]) continue;
      return true;
    }
    return false;
  }

  // hasProperNoun_ skips word 0 so it doesn't mistake a sentence's own
  // leading capital for a name -- but subject position is exactly where an
  // agent usually sits ("Smith has argued that...", "Jones argued
  // that..."). This checks word 0 specifically, and only counts it when an
  // attributing verb follows within a few words, so "Tests are a
  // central test case" doesn't read as an attribution.
  var LEADING_AGENT_RE =
    /^\s*([A-Z\u00C0-\u00DE][a-z\u00DF-\u00FF'\u2019-]+)\b(?:\s+\w+){0,3}\s+\b(?:argue[sd]?|argued|holds?|held|maintains?|contends?|claims?|suggests?|propose[sd]?|noted?|notes|observe[sd]?|shows?|showed|found|conclude[sd]?|demonstrate[sd]?|writes?|says?|defends?)\b/;

  function hasLeadingAgent_(text) {
    var m = LEADING_AGENT_RE.exec(text);
    return !!m && !NON_NAME_CAPITALS[m[1].toLowerCase()];
  }

  // A position can stand in for a person. "A view that holds that outcomes
  // follow from some hidden mechanism..." attributes to whoever holds that view, and needs a
  // source just as much as "Smith argued that...". This is categorically
  // different from "This suggests that...", where the subject is the
  // authors' own inference rather than a position someone occupies -- note
  // that "framework", "case", "point" and "reading" are deliberately absent
  // from the noun list for exactly that reason.
  var POSITION_AGENT_RE =
    /\b(a|an|the|this|that|one|another|such|these|those)\s+(?:\w+\s+){0,3}(views?|accounts?|theor(?:y|ies)|positions?|traditions?|doctrines?|thes[ie]s|schools?|orthodox\w*)\b[^.]{0,60}?\b(holds?|held|maintains?|claims?|contends?|argues?|asserts?|denies|has it that)\b/i;

  function hasAgent_(text) {
    return SCHOLARLY_AGENT_RE.test(text) ||
      INDEFINITE_AGENT_RE.test(text) ||
      POSITION_AGENT_RE.test(text) ||
      hasLeadingAgent_(text) ||
      hasProperNoun_(text);
  }

  // ---- negative triggers ---------------------------------------------

  var STIPULATIVE_DEFINITION_RE =
    /\b(we use the term|we define|by\s['"“]?[\w\s-]+['"”]?,?\s?we mean|for (?:my|our) purposes here)\b/i;

  var FIELD_DEFINITION_RE =
    /\b(\w+\s(?:is|are)\s(?:often\s|typically\s|commonly\s)?defined as)\b/i;

  var FIRST_PERSON_ASSERT_RE =
    /^\s*(we|our)\b.{0,40}\b(take it that|argue that|claim that|contend that|maintain that|believe that)\b/i;

  var FIRST_PERSON_SIMPLE_RE = /^\s*(we|our)\b/i;

  var STRUCTURAL_METACOMMENTARY_RE =
    /\b(in this section,? we will|we will now discuss|the remainder of this (?:section|paper|report))\b/i;

  // Broadened from the original "one could argue" / "someone might object".
  // A real draft used "One might argue that virtual systems can exhibit
  // functional analogs..." -- structurally identical to the forms already
  // covered, but it slipped the gate on the modal verb alone.
  var HYPOTHETICAL_OBJECTION_RE =
    /\b(one (?:could|might|may) (?:argue|object|say|respond|reply|think|insist|counter)|someone (?:could|might|may) (?:argue|object|say|respond|reply|insist|counter)|it (?:could|might|may) be (?:argued|objected|said|thought|replied)|of course,? one could)\b/i;

  function evaluate(sentenceInfo, frameworkMentionsSeen) {
    var text = sentenceInfo.text;
    var reasons = [];
    var isConsensusClaim = false;

    // --- Negative gates first: these can override an otherwise-positive
    // surface pattern, per the citation rules' explicit warnings that
    // hypothetical objections and stipulative definitions look identical
    // to real triggers on the surface. ---

    if (HYPOTHETICAL_OBJECTION_RE.test(text)) {
      return verdict_(false, ['hypothetical objection (author\'s own rhetorical move)'], false);
    }

    if (STIPULATIVE_DEFINITION_RE.test(text)) {
      return verdict_(false, ['authorial stipulative definition'], false);
    }

    if (STRUCTURAL_METACOMMENTARY_RE.test(text)) {
      return verdict_(false, ['structural meta-commentary'], false);
    }

    // Field-convention definitions ARE cited even though they look like
    // definitions -- check before the generic first-person suppression.
    if (FIELD_DEFINITION_RE.test(text)) {
      reasons.push('field-convention definition ("typically defined as")');
      return verdict_(true, reasons, false);
    }

    var isFirstPersonAssertion = FIRST_PERSON_ASSERT_RE.test(text) || FIRST_PERSON_SIMPLE_RE.test(text);
    var hasHedge = HEDGE_WORDS_RE.test(text);

    if (isFirstPersonAssertion && !hasHedge) {
      return verdict_(false, ['first-person synthesis, no hedge'], false);
    }

    // --- Positive triggers ---

    var quoteMatch = QUOTE_WITH_NAME_RE.test(text) && hasProperNoun_(text);
    if (quoteMatch) {
      reasons.push('direct quote with named attribution (high confidence)');
    }

    if (SURVEY_RE.test(text) || (STATISTIC_RE.test(text) && /\b(participants|respondents|survey)\b/i.test(text))) {
      reasons.push('survey / expert-consensus statistic');
    }

    if (ANONYMOUS_POSITION_RE.test(text)) {
      reasons.push('anonymous-position framing');
      isConsensusClaim = true;
    }

    // Attribution verb PLUS somebody to do the attributing. See the block
    // comment on agent detection above for why the verb alone isn't enough.
    if (ATTRIBUTION_VERBS_RE.test(text) && !isFirstPersonAssertion && hasAgent_(text)) {
      reasons.push('attribution / reported-position verb');
    }

    // Left ungated: these phrases ("reviewed the evidence", "surveyed the
    // literature") already imply a researcher doing the reviewing.
    if (RESEARCH_METHOD_VERBS_RE.test(text) && !isFirstPersonAssertion) {
      reasons.push('research-methodology verb introducing a finding');
    }

    var frameworkMatch = text.match(NAMED_FRAMEWORK_RE);
    if (frameworkMatch) {
      var phrase = frameworkMatch[1];
      if (!frameworkMentionsSeen[phrase]) {
        frameworkMentionsSeen[phrase] = true;
        reasons.push('first mention of named framework/report/policy: "' + phrase + '"');
      }
    }

    var knownFrameworkMatch = text.match(KNOWN_NAMED_FRAMEWORKS_RE);
    if (knownFrameworkMatch) {
      var knownPhrase = knownFrameworkMatch[0].toLowerCase();
      if (!frameworkMentionsSeen[knownPhrase]) {
        frameworkMentionsSeen[knownPhrase] = true;
        reasons.push('first mention of known named framework: "' + knownFrameworkMatch[0] + '"');
      }
    }

    if (EMPIRICAL_CLAIM_RE.test(text)) {
      reasons.push('empirical/research-finding claim');
    }

    if (HISTORICAL_CASE_RE.test(text)) {
      reasons.push('named historical case/incident');
    }

    if (SEE_POINTER_RE.test(text)) {
      reasons.push('"see X" pointer citation');
    }

    if (NAMED_AUTHOR_FRAMEWORK_RE.test(text)) {
      reasons.push('named-author framework introduction (check list items individually)');
    }

    // Hedge + an explicit pointer at existing scholarship. See the comment
    // on SCHOLARLY_REFERENT_RE above for why the bare hedge is not enough.
    if (hasHedge && SCHOLARLY_REFERENT_RE.test(text) &&
        !STIPULATIVE_DEFINITION_RE.test(text) && looksSubstantive_(text)) {
      reasons.push('hedged claim about existing theory/evidence');
    }

    // Consensus/background claims often stack multiple citations.
    if (/\bmany (researchers|have argued|scholars)\b/i.test(text) || reasons.some(function (r) {
      return r.indexOf('anonymous-position') !== -1;
    })) {
      isConsensusClaim = true;
    }

    return verdict_(reasons.length > 0, reasons, isConsensusClaim);
  }

  function verdict_(needsCitation, reasons, isConsensusClaim) {
    return { needsCitation: needsCitation, reasons: reasons, isConsensusClaim: !!isConsensusClaim };
  }

  function looksSubstantive_(text) {
    // Distinguishes "hedged claim about the world" from a hedge attached to
    // a definition, per the refined hedging rule. If the sentence still
    // contains defines/means/refers-to language, treat it as definitional
    // (and thus not this trigger, even if hedged) -- the calibration
    // example ("By 'near term'...we mean...") confirms this should stay
    // uncited despite the first-person hedge-adjacent phrasing.
    return !/\b(mean|means|refer to|refers to|define[sd]?)\b/i.test(text);
  }

  return { evaluate: evaluate };
})();
