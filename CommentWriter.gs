/**
 * CommentWriter.gs
 *
 * Writes suggestions as Google Docs COMMENTS (never edits body text or
 * inserts citations directly) -- this is the core "assistive, not
 * authoritative" requirement. Uses the Drive Advanced Service (v3) rather
 * than DocumentApp, since DocumentApp has no API for creating comments.
 *
 * KNOWN LIMITATION: the public Drive/Docs API does not expose a documented
 * way to anchor a comment to a precise character range from a third-party
 * script. The practical workaround used here -- setting quotedFileContent
 * to the exact sentence text -- causes Google Docs to auto-locate and
 * highlight that quoted text when it finds a unique match, which is
 * reliable for most sentences. If a sentence's exact text appears more
 * than once in the doc (rare, but possible for short quoted fragments),
 * Docs may anchor to the wrong occurrence or fall back to an unanchored
 * comment. Worth spot-checking after each run, especially early on.
 */

var CommentWriter = (function () {

  function buildCommentText(result, docStyle) {
    var lines = [];
    lines.push(CONFIG.COMMENT_PREFIX + ' [' + result.tier + ' confidence]');
    lines.push('Why flagged: ' + result.verdict.reasons.join('; '));

    if (result.contextualCitationText) {
      lines.push(
        'Likely citation (carried over from the list\'s framework introduction, not independently TF-IDF matched): ' +
        result.contextualCitationText
      );
    }

    if (result.rerankResult) {
      lines.push(
        'Note: this ranking was judged by Claude among the library\'s own keyword-matched candidates ' +
        '(not a raw keyword score) -- ' + (result.rerankResult.reasoning || 'no reasoning given') +
        ' [Claude\'s own confidence: ' + result.rerankResult.confidence + ']'
      );
    }

    if (result.matches.length) {
      lines.push('Possible source(s) from Zotero library (TF-IDF match):');
      result.matches.forEach(function (m) {
        lines.push(
          '  - ' + formatCitation_(m, docStyle) + ' (match score ' + m.score.toFixed(2) + ')'
        );
      });
    } else if (!result.contextualCitationText) {
      lines.push('No close match found in the Zotero library -- may need a source added, or this may be a false positive.');
    }

    if (result.webSearchCandidate && result.webSearchCandidate.found) {
      var w = result.webSearchCandidate;
      lines.push(
        'Web search candidate (NOT from your curated Zotero library -- verify independently before use): ' +
        w.title + ' by ' + w.authors + ' (' + w.year + '), confidence: ' + w.confidence
      );
      if (w.url) lines.push('  ' + w.url);
      if (w.reasoning) lines.push('  Reasoning: ' + w.reasoning);
    }

    lines.push('(Auto-suggested -- please verify before adding a citation.)');
    return lines.join('\n');
  }

  function formatCitation_(match, docStyle) {
    var authorLastName = (match.authors || 'Unknown').split(/[,;]/)[0].trim();
    var year = match.year || 'n.d.';
    var base = authorLastName + ', ' + year + ' -- "' + match.title + '"';
    return base;
  }

  /**
   * Creates a Drive API comment on the doc, anchored via quotedFileContent
   * matching the flagged sentence text. Returns true on success, false on
   * failure (logged, not thrown -- one failed comment shouldn't abort the
   * whole pass).
   */
  function writeComment(docId, quotedSentenceText, commentBody) {
    try {
      var trimmedQuote = quotedSentenceText.length > 500
        ? quotedSentenceText.substring(0, 500)
        : quotedSentenceText;

      Drive.Comments.create(
        {
          content: commentBody,
          quotedFileContent: {
            mimeType: 'text/plain',
            value: trimmedQuote
          }
        },
        docId,
        { fields: 'id' }
      );
      return true;
    } catch (err) {
      Logger.log('Failed to write comment for sentence "%s...": %s',
        quotedSentenceText.substring(0, 60), err);
      return false;
    }
  }

  return { buildCommentText: buildCommentText, writeComment: writeComment };
})();
