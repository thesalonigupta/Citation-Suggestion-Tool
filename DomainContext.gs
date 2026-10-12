/**
 * DomainContext.gs
 *
 * Shared background context about YOUR research area, injected into LLM
 * prompts (LlmDetector.gs, WebSearchMatcher.gs) as reasoning material -- NOT
 * a rigid pattern list. An LLM generalizes from this context to sentences
 * you never specifically anticipated, unlike RuleDetector.gs's regex lists,
 * which can only match exactly what's written into them.
 *
 * HOW TO CUSTOMIZE: replace the text in DOMAIN_CONTEXT below with a short
 * description of what your documents cover. Useful things to include:
 *   - the main topics and sub-fields your reports discuss;
 *   - named theories, frameworks, or reports that recur;
 *   - recurring authors or organizations whose work is often cited.
 * Only include things you can source from your own documents and library --
 * nothing invented or inferred.
 *
 * PHRASING PRINCIPLE: write it as "our work has covered X" (context), never
 * "our work only covers X" (constraint). Domain context that reads as a
 * constraint biases judgment AWAY from correctly handling a genuinely new
 * topic you start covering later. If your focus shifts, update this one
 * file rather than letting each prompt drift independently.
 *
 * It's fine to leave this generic; the tool works without any customization.
 */

var DOMAIN_CONTEXT =
  'Background context: these are academic research reports and working drafts. ' +
  'The topics, theories, and authors they discuss vary by report. This is context to ' +
  'inform judgment about what a sentence is likely discussing and who is likely being ' +
  'cited -- it is NOT an exhaustive or exclusive list, and a report may legitimately cover ' +
  'any topic.';
