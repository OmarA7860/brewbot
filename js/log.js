/*
 * log.js
 * ------
 * A small session log used during usability testing. It records each
 * turn (how the user answered, what they said, how BrewBot handled it),
 * and works out the numbers we report: time to complete the order,
 * number of turns, errors, corrections and voice retries.
 *
 * The facilitator opens it with the "Test log" link in the footer and can
 * download it as a CSV file after each participant. Nothing is sent
 * anywhere; it only lives in the open browser tab.
 */
window.BB = window.BB || {};

BB.Log = (function () {
  var events = [];
  var startedAt = null;
  var completedAt = null;
  var participant = '';

  function now() { return new Date(); }

  function add(type, detail) {
    var e = {
      time: now(),
      seconds: startedAt ? Math.round((now() - startedAt) / 100) / 10 : 0,
      type: type,
      mode: detail.mode || '',
      text: detail.text || '',
      outcome: detail.outcome || '',
      slot: detail.slot || ''
    };
    events.push(e);
    if (type === 'session_start') { startedAt = e.time; completedAt = null; e.seconds = 0; }
    if (type === 'bot' && detail.outcome === 'completed' && !completedAt) completedAt = e.time;
    if (BB.Log.onChange) BB.Log.onChange();
    return e;
  }

  function summary() {
    var userTurns = events.filter(function (e) { return e.type === 'user'; });
    var bots = events.filter(function (e) { return e.type === 'bot'; });
    function countMode(m) { return userTurns.filter(function (e) { return e.mode === m; }).length; }
    function countOutcome(list) { return bots.filter(function (e) { return list.indexOf(e.outcome) !== -1; }).length; }
    return {
      participant: participant,
      completed: !!completedAt,
      secondsToComplete: completedAt && startedAt ? Math.round((completedAt - startedAt) / 1000) : null,
      turns: userTurns.length,
      voiceTurns: countMode('voice'),
      typedTurns: countMode('text'),
      buttonTurns: countMode('button'),
      notUnderstood: countOutcome(['not_understood']),
      unsupportedOrInvalid: countOutcome(['unsupported', 'invalid']),
      clarifications: countOutcome(['clarify']),
      corrections: countOutcome(['correction', 'change', 'back']) + events.filter(function (e) { return e.type === 'edit'; }).length,
      voiceRetries: events.filter(function (e) { return e.type === 'voice_retry' || e.type === 'voice_edit'; }).length,
      voiceErrors: countOutcome(['voice_error']),
      helpOrRepeat: countOutcome(['help', 'repeat']),
      nudges: countOutcome(['nudge'])
    };
  }

  function toCSV() {
    var s = summary();
    var rows = [['participant', 'seconds', 'type', 'mode', 'outcome', 'slot', 'text']];
    events.forEach(function (e) { rows.push([participant, e.seconds, e.type, e.mode, e.outcome, e.slot, e.text]); });
    rows.push([]);
    rows.push(['summary']);
    Object.keys(s).forEach(function (k) { rows.push([k, s[k] === null ? '' : s[k]]); });
    return rows.map(function (r) {
      return r.map(function (v) {
        v = String(v === undefined ? '' : v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\n');
  }

  return {
    add: add,
    summary: summary,
    toCSV: toCSV,
    events: function () { return events.slice(); },
    clear: function () { events = []; startedAt = null; completedAt = null; if (BB.Log.onChange) BB.Log.onChange(); },
    setParticipant: function (p) { participant = p; },
    getParticipant: function () { return participant; },
    onChange: null
  };
})();
