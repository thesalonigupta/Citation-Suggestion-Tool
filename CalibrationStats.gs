/**
 * CalibrationStats.gs
 *
 * Every time a sentence is flagged, we know its tier and the RuleDetector/
 * LlmDetector reason(s) that fired. Every time a human dismisses one, that's
 * ground truth: "the tool was wrong here, specifically." This module keeps
 * a running tally of flagged-vs-dismissed counts per tier and per reason,
 * across ALL documents and ALL runs (global, not per-doc -- the question
 * this answers is "is this tier/rule reliable in general," not "was this
 * one document reviewed"), so patterns become visible that a single run's
 * dismissal count never would.
 *
 * Example of what this surfaces that raw dismissal tracking doesn't: if
 * WEAK-tier suggestions get dismissed 80% of the time, that's a measured
 * signal the threshold is too aggressive -- not a guess, a count. If one
 * specific rule reason (e.g. "attribution / reported-position verb") has a
 * much higher dismissal rate than others, that rule specifically may need
 * tightening, independent of tier.
 *
 * Storage: one Script Property, a JSON object:
 *   { tiers: { HIGH: {flagged, dismissed}, ... },
 *     reasons: { "<reason string>": {flagged, dismissed}, ... } }
 * Small and simple by design -- this is aggregate counts, not per-sentence
 * history, so it stays well within Script Properties' size limits no
 * matter how long the tool has been in use.
 */

var CalibrationStats = (function () {

  var PROP_KEY = 'CITE_CALIBRATION_STATS';

  // Below this many observations, a dismissal rate is more likely to be
  // noise than signal -- the report omits entries under this count rather
  // than implying false confidence from a tiny sample.
  var MIN_SAMPLE_SIZE = 3;

  function load_() {
    var raw = PropertiesService.getScriptProperties().getProperty(PROP_KEY);
    return raw ? JSON.parse(raw) : { tiers: {}, reasons: {} };
  }

  function save_(stats) {
    PropertiesService.getScriptProperties().setProperty(PROP_KEY, JSON.stringify(stats));
  }

  function bump_(bucket, key, field) {
    if (!bucket[key]) bucket[key] = { flagged: 0, dismissed: 0 };
    bucket[key][field]++;
  }

  /** Call once per sentence at the moment it's flagged and shown to a human. */
  function recordFlagged(tier, reasons) {
    var stats = load_();
    bump_(stats.tiers, tier, 'flagged');
    (reasons || []).forEach(function (r) { bump_(stats.reasons, r, 'flagged'); });
    save_(stats);
  }

  /** Call once per sentence at the moment a human dismisses it. */
  function recordDismissed(tier, reasons) {
    var stats = load_();
    bump_(stats.tiers, tier, 'dismissed');
    (reasons || []).forEach(function (r) { bump_(stats.reasons, r, 'dismissed'); });
    save_(stats);
  }

  /**
   * Returns a plain-object report: for each tier/reason with at least
   * MIN_SAMPLE_SIZE observations, the flagged count, dismissed count, and
   * dismissal rate, sorted worst (highest dismissal rate) first -- the
   * ones most worth a human's attention when tuning thresholds or rules.
   */
  function getReport() {
    var stats = load_();

    function summarize(bucket) {
      var rows = [];
      Object.keys(bucket).forEach(function (key) {
        var b = bucket[key];
        if (b.flagged < MIN_SAMPLE_SIZE) return; // not enough data yet
        rows.push({
          key: key,
          flagged: b.flagged,
          dismissed: b.dismissed,
          rate: b.dismissed / b.flagged
        });
      });
      rows.sort(function (a, b) { return b.rate - a.rate; });
      return rows;
    }

    return { tiers: summarize(stats.tiers), reasons: summarize(stats.reasons) };
  }

  /** Logs a human-readable version of getReport(). Call this any time to check calibration. */
  function printReport() {
    var report = getReport();

    Logger.log('=== Calibration report: tiers ===');
    if (!report.tiers.length) {
      Logger.log('(not enough data yet -- each tier needs at least %s flagged sentences)', MIN_SAMPLE_SIZE);
    }
    report.tiers.forEach(function (r) {
      Logger.log('%s: %s/%s dismissed (%s%%)', r.key, r.dismissed, r.flagged, (r.rate * 100).toFixed(0));
    });

    Logger.log('=== Calibration report: rule reasons ===');
    if (!report.reasons.length) {
      Logger.log('(not enough data yet -- each reason needs at least %s flagged sentences)', MIN_SAMPLE_SIZE);
    }
    report.reasons.forEach(function (r) {
      Logger.log('"%s": %s/%s dismissed (%s%%)', r.key, r.dismissed, r.flagged, (r.rate * 100).toFixed(0));
    });

    return report;
  }

  function resetStats() {
    PropertiesService.getScriptProperties().deleteProperty(PROP_KEY);
    Logger.log('CalibrationStats: all calibration data cleared.');
  }

  return {
    recordFlagged: recordFlagged,
    recordDismissed: recordDismissed,
    getReport: getReport,
    printReport: printReport,
    resetStats: resetStats
  };
})();
