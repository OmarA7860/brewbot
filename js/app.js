/*
 * app.js
 * ------
 * Connects the page to the conversation (dialogue.js) and to voice
 * (speech.js). It is responsible for everything the user sees:
 *   - chat bubbles and quick-reply buttons
 *   - the avatar's state (idle, listening, thinking, speaking, paused)
 *     and mood (neutral, confused, happy), plus the status label
 *   - the live "Your order" panel with Edit links and prices
 *   - the Repeat / Back / Pause / Voice controls
 *   - Retry and Edit for answers given by voice
 *   - a gentle nudge if nobody answers for a while
 *   - the usability test log drawer
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var dialogue = new BB.Dialogue();

  var el = {
    avatar: $('avatar'), status: $('status'), statusText: $('statusText'),
    welcome: $('welcome'), startBtn: $('startBtn'), voiceNote: $('voiceNote'),
    chatLog: $('chatLog'), quick: $('quickReplies'), paused: $('pausedBanner'), resumeBtn: $('resumeBtn'),
    form: $('inputForm'), input: $('textInput'), interim: $('interim'), mic: $('micBtn'), hint: $('inputHint'),
    repeatBtn: $('repeatBtn'), backBtn: $('backBtn'), pauseBtn: $('pauseBtn'), muteBtn: $('muteBtn'),
    orderList: $('orderList'), orderSub: $('orderSub'), totals: $('totals'), ticket: $('ticket'), restartBtn: $('restartBtn'),
    logBtn: $('logBtn'), logDrawer: $('logDrawer'), logClose: $('logClose'), logSummary: $('logSummary'),
    logEvents: $('logEvents'), logDownload: $('logDownload'), logClear: $('logClear'), participant: $('participantInput')
  };

  var IDLE_NUDGE_MS = 30000;   // nudge after 30 seconds with no answer
  var THINK_MS = 380;          // short "thinking" pause so users see the system is working (follows voice speed)

  var STATUS_TEXT = {
    ready: 'Ready when you are',
    idle: 'Your turn',
    listening: 'Listening, go ahead',
    thinking: 'Thinking',
    speaking: 'Speaking',
    paused: 'Paused',
    done: 'Order placed'
  };

  var ui = {
    started: false,
    paused: false,
    muted: false,
    busy: false,            // BrewBot is thinking or talking
    lastMode: 'text',       // how the user last answered
    lastTurn: null,         // { snapshot, userNode, botNode, text, mode } for voice Retry/Edit
    idleTimer: null,
    replyTimer: null,
    prevOrder: {}
  };

  var CUP_ICON = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M8 13h22l-2 16c-.4 3-2.6 5-5.6 5h-6.8c-3 0-5.2-2-5.6-5z" fill="#fffaf3" stroke="#5a3825" stroke-width="2.4"/><path d="M29 16c6 0 6 9 0 10" fill="none" stroke="#5a3825" stroke-width="2.4"/><circle cx="15" cy="20" r="1.6" fill="#3f2618"/><circle cx="23" cy="20" r="1.6" fill="#3f2618"/><path d="M16 25q3 2.4 6 0" fill="none" stroke="#3f2618" stroke-width="1.8" stroke-linecap="round"/></svg>';
  var MIC_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';

  /* ---------------- avatar and status ---------------- */

  function setState(state) {
    el.avatar.setAttribute('data-state', state === 'ready' || state === 'done' ? 'idle' : state);
    el.status.setAttribute('data-state', state);
    el.statusText.textContent = STATUS_TEXT[state] || state;
  }

  function setMood(mood) { el.avatar.setAttribute('data-mood', mood || 'neutral'); }

  /* ---------------- chat bubbles ---------------- */

  function scrollDown() { el.chatLog.scrollTop = el.chatLog.scrollHeight; }

  function addBotMessage(reply) {
    var wrap = document.createElement('div');
    wrap.className = 'msg bot' + (reply.mood && reply.mood !== 'neutral' ? ' ' + reply.mood : '');
    wrap.innerHTML = '<div class="mini">' + CUP_ICON + '</div>';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var p = document.createElement('div');
    p.textContent = reply.text;
    bubble.appendChild(p);

    // When a voice answer may have been misheard, offer Retry and Type instead right here.
    if (reply.heardCheck && ui.lastTurn && ui.lastTurn.mode === 'voice') {
      var row = document.createElement('div');
      row.className = 'heard-check';
      row.appendChild(makeButton('Try again by voice', 'btn-small', retryVoice));
      row.appendChild(makeButton('Type it instead', 'btn-small ghost', editVoice));
      bubble.appendChild(row);
    }
    wrap.appendChild(bubble);
    el.chatLog.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function addUserMessage(text, mode) {
    var wrap = document.createElement('div');
    wrap.className = 'msg user';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    if (mode === 'voice') {
      // Show that this was heard by voice, with Retry / Edit in case it's wrong.
      var meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = '<span>' + MIC_ICON + ' Heard by voice</span>';
      meta.appendChild(makeButton('Retry', '', retryVoice, 'Say that answer again'));
      meta.appendChild(makeButton('Edit', '', editVoice, 'Fix that answer by typing'));
      wrap.appendChild(meta);
    }
    // Only the most recent voice answer can be retried, so older Retry/Edit links are removed.
    Array.prototype.forEach.call(el.chatLog.querySelectorAll('.msg-meta button, .heard-check'), function (b) { b.remove(); });
    el.chatLog.appendChild(wrap);
    scrollDown();
    return wrap;
  }

  function makeButton(label, cls, onClick, aria) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  }

  /* ---------------- quick replies ---------------- */

  function renderQuick(list) {
    el.quick.innerHTML = '';
    (list || []).forEach(function (q) {
      var b = makeButton(q.label, 'chip', function () { submit(q.value, 'button'); });
      b.disabled = ui.paused;
      el.quick.appendChild(b);
    });
  }

  /* ---------------- order panel ---------------- */

  function renderOrder() {
    var o = dialogue.order;
    el.orderList.innerHTML = '';
    BB.SLOT_ORDER.forEach(function (slot) {
      var li = document.createElement('li');
      var filled = dialogue.isFilled(slot);
      var asking = dialogue.current === slot && dialogue.phase === 'asking';
      if (asking) li.className = 'asking';
      var now = JSON.stringify(o[slot]);
      if (filled && ui.prevOrder[slot] !== undefined && ui.prevOrder[slot] !== now) li.classList.add('flash');
      ui.prevOrder[slot] = now;

      var k = document.createElement('span'); k.className = 'k'; k.textContent = BB.SLOT_LABELS[slot];
      var v = document.createElement('span');
      v.className = 'v' + (filled ? '' : ' empty');
      v.textContent = filled ? dialogue.displayValue(slot) : (asking ? 'Asking now' : 'Not chosen yet');
      var edit = makeButton('Edit', 'edit-btn', function () { editSlot(slot); }, 'Edit ' + BB.SLOT_LABELS[slot].toLowerCase());
      edit.disabled = !filled || dialogue.phase === 'done';
      li.appendChild(k); li.appendChild(v); li.appendChild(edit);
      el.orderList.appendChild(li);
    });

    if (BB.Preview) BB.Preview.update(o);

    var t = dialogue.totals();
    if (t) {
      var money = BB.Dialogue.money;
      el.totals.hidden = false;
      el.totals.innerHTML =
        '<div><span>' + t.qty + ' &times; ' + money(t.unit) + '</span><span>' + money(t.subtotal) + '</span></div>' +
        '<div><span>HST (13%)</span><span>' + money(t.tax) + '</span></div>' +
        '<div class="grand"><span>Total</span><span>' + money(t.total) + '</span></div>';
    } else {
      el.totals.hidden = true;
    }

    if (dialogue.phase === 'done' && dialogue.placed) {
      el.ticket.hidden = false;
      el.ticket.innerHTML = '<p>Order number</p><div class="num">#' + dialogue.placed.number + '</div>' +
        '<p>Ready around <strong>' + BB.Dialogue.formatTime(dialogue.placed.ready) + '</strong></p>' +
        '<p>Name on the cup: <strong>' + escapeHTML(o.name) + '</strong></p><p>Status: <span class="tk-status">Received</span></p><p>Pay at the pickup counter.</p>';
      el.orderSub.textContent = 'Your order has been placed.';
    } else {
      el.ticket.hidden = true;
      el.orderSub.textContent = dialogue.phase === 'confirm' ? 'Please check everything before you confirm.' : 'Your choices show up here as you go. Use Edit to change one.';
    }
    el.backBtn.disabled = !ui.started || dialogue.phase === 'done';
    el.pauseBtn.disabled = !ui.started || dialogue.phase === 'done';
  }

  function escapeHTML(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* ---------------- BrewBot replies ---------------- */

  /*
   * Show and speak a reply. The avatar "thinks" for a moment first so the
   * user can see their answer was received (visibility of system status).
   */
  function respond(reply, opts) {
    opts = opts || {};
    clearTimeout(ui.idleTimer);
    clearTimeout(ui.replyTimer);
    ui.busy = true;
    renderQuick([]);
    setState('thinking');

    ui.replyTimer = setTimeout(function () {
      var node = addBotMessage(reply);
      if (ui.lastTurn && opts.fromTurn) ui.lastTurn.botNode = node;
      setMood(reply.mood);
      if (reply.speed) setSpeed(stepSpeed(reply.speed), false);
      if (reply.outcome === 'greeting' || reply.outcome === 'restart') stopTracker();
      if (reply.outcome === 'completed') startTracker();
      renderQuick(reply.quick);
      renderOrder();
      BB.Log.add('bot', { text: reply.text, outcome: reply.outcome, slot: reply.current || '' });

      if (reply.pause) { ui.busy = false; enterPause(true); return; }

      // Names are easy to mishear and easy to type, so the mic is not reopened for the name question.
      var autoListen = opts.autoListen && reply.phase !== 'done' && !reply.transient && reply.current !== 'name' && !reply.focusInput;
      if (reply.focusInput) el.input.focus();
      if (ui.muted || !BB.Speech.canSpeak()) { finishTurn(reply, autoListen); return; }
      setState('speaking');
      BB.Speech.speak(reply.text, { onEnd: function () { finishTurn(reply, autoListen); } });
    }, opts.instant ? 0 : THINK_MS);
  }

  function finishTurn(reply, autoListen) {
    ui.busy = false;
    if (ui.paused) return;
    setState(reply.phase === 'done' ? 'done' : 'idle');
    if (reply.phase === 'done') return;
    // After a spoken answer, listen again automatically so voice users stay hands-free.
    if (autoListen && BB.Speech.canListen()) { startListening(true); return; }
    startIdleTimer();
  }

  function startIdleTimer() {
    clearTimeout(ui.idleTimer);
    ui.idleTimer = setTimeout(function () {
      if (ui.paused || ui.busy || BB.Speech.isListening() || el.input.value.trim()) return;
      var r = dialogue.nudge();
      if (r) respond(r);
    }, IDLE_NUDGE_MS);
  }

  /* ---------------- user answers ---------------- */

  function submit(text, mode, meta) {
    text = String(text || '').trim();
    if (!text || !ui.started) return;
    if (ui.paused) leavePause(false);
    BB.Speech.stopSpeaking();
    if (mode !== 'voice') BB.Speech.stopListening();
    clearTimeout(ui.idleTimer);

    var snapshot = dialogue.snapshot();
    var node = addUserMessage(text, mode);
    BB.Log.add('user', { text: text, mode: mode, slot: dialogue.current || '' });
    ui.lastMode = mode;
    ui.lastTurn = { snapshot: snapshot, userNode: node, botNode: null, text: text, mode: mode };

    meta = meta || {};
    var reply = dialogue.handle(text, { mode: mode, alternatives: meta.alternatives, confidence: meta.confidence });
    respond(reply, { fromTurn: true, autoListen: mode === 'voice' && reply.outcome !== 'not_understood' });
  }

  /* Undo the last voice answer and listen again. */
  function retryVoice() {
    if (!undoLastTurn()) return;
    BB.Log.add('voice_retry', { mode: 'voice' });
    startListening();
  }

  /* Undo the last voice answer and put the words in the text box to fix. */
  function editVoice() {
    var text = ui.lastTurn ? ui.lastTurn.text : '';
    if (!undoLastTurn()) return;
    BB.Log.add('voice_edit', { mode: 'voice', text: text });
    el.input.value = text;
    el.input.focus();
    el.input.select();
  }

  function undoLastTurn() {
    var t = ui.lastTurn;
    if (!t || t.mode !== 'voice') return false;
    clearTimeout(ui.replyTimer);
    BB.Speech.stopSpeaking();
    BB.Speech.stopListening();
    dialogue.restore(t.snapshot);
    if (t.userNode) t.userNode.remove();
    if (t.botNode) t.botNode.remove();
    ui.lastTurn = null;
    ui.busy = false;
    setMood('neutral');
    renderOrder();
    renderQuick(dialogue.lastReply ? dialogue.lastReply.quick : []);
    setState('idle');
    return true;
  }

  function editSlot(slot) {
    if (dialogue.phase === 'done') return;
    if (ui.paused) leavePause(false);
    BB.Speech.stopSpeaking();
    BB.Speech.stopListening();
    BB.Log.add('edit', { mode: 'button', slot: slot, text: 'Edit ' + slot });
    addUserMessage('Change ' + BB.SLOT_LABELS[slot].toLowerCase(), 'button');
    ui.lastTurn = null;
    respond(dialogue.startChange(slot));
  }

  /* ---------------- voice input ---------------- */

  /* auto = true when the mic was turned on automatically after BrewBot spoke. */
  function startListening(auto) {
    if (!ui.started || ui.paused) return;
    clearTimeout(ui.idleTimer);
    clearTimeout(ui.replyTimer);
    ui.busy = false;
    BB.Speech.startListening({
      onStart: function () {
        setState('listening');
        el.mic.classList.add('listening');
        el.mic.setAttribute('aria-label', 'Stop listening');
        el.mic.querySelector('.mic-label').textContent = 'Stop';
        el.interim.textContent = 'Listening... say your answer';
        el.interim.classList.add('show');
      },
      onPartial: function (text) { el.interim.textContent = text; },
      onFinal: function (text, info) {
        resetMic();
        submit(text, 'voice', info);
      },
      onError: function (kind) {
        resetMic();
        // If the mic came on by itself and the user simply didn't talk, just stop quietly.
        if (auto === true && kind === 'no-speech') { setState('idle'); startIdleTimer(); return; }
        BB.Log.add('voice_problem', { mode: 'voice', outcome: kind });
        if (kind === 'not-allowed' || kind === 'unsupported') el.mic.title = 'Microphone not available. You can type instead.';
        respond(dialogue.voiceProblem(kind));
      },
      onEnd: function () {
        resetMic();
        if (!ui.busy && !ui.paused && el.status.getAttribute('data-state') === 'listening') { setState('idle'); startIdleTimer(); }
      }
    });
  }

  function resetMic() {
    el.mic.classList.remove('listening');
    el.mic.setAttribute('aria-label', 'Press to talk');
    el.mic.querySelector('.mic-label').textContent = 'Talk';
    el.interim.classList.remove('show');
  }

  function toggleMic() {
    if (!ui.started || ui.paused) return;
    if (BB.Speech.isListening()) { BB.Speech.stopListening(); resetMic(); setState('idle'); startIdleTimer(); return; }
    startListening();
  }

  /* ---------------- pause / resume ---------------- */

  function enterPause(fromVoice) {
    ui.paused = true;
    clearTimeout(ui.idleTimer);
    clearTimeout(ui.replyTimer);
    BB.Speech.stopSpeaking();
    BB.Speech.stopListening();
    resetMic();
    setState('paused');
    el.paused.hidden = false;
    el.mic.disabled = true;
    el.pauseBtn.querySelector('span').textContent = 'Resume';
    el.pauseBtn.title = 'Carry on with the order';
    Array.prototype.forEach.call(el.quick.querySelectorAll('button'), function (b) { b.disabled = true; });
    BB.Log.add('pause', { mode: fromVoice ? 'voice' : 'button' });
  }

  function leavePause(repeatQuestion) {
    ui.paused = false;
    el.paused.hidden = true;
    el.mic.disabled = !BB.Speech.canListen();
    el.pauseBtn.querySelector('span').textContent = 'Pause';
    el.pauseBtn.title = 'Pause the conversation';
    setState('idle');
    BB.Log.add('resume', {});
    if (repeatQuestion) {
      var r = dialogue.repeat();
      r = Object.assign({}, r, { text: 'Okay, let’s carry on. ' + r.text });
      respond(r);
    } else {
      Array.prototype.forEach.call(el.quick.querySelectorAll('button'), function (b) { b.disabled = false; });
    }
  }

  /* ---------------- start ---------------- */

  function startOrder() {
    ui.started = true;
    el.welcome.hidden = true;
    el.chatLog.hidden = false;
    el.form.hidden = false;
    el.hint.hidden = false;
    el.chatLog.innerHTML = '';
    ui.prevOrder = {};
    BB.Log.add('session_start', { text: BB.Speech.canListen() ? 'voice available' : 'voice not available' });
    respond(dialogue.start(), { instant: true });
    el.input.focus();
  }

  /* ---------------- wiring ---------------- */

  el.startBtn.addEventListener('click', startOrder);

  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = el.input.value;
    el.input.value = '';
    submit(text, 'text');
  });

  el.input.addEventListener('input', function () {
    // Typing while the mic is on means the user would rather type.
    if (BB.Speech.isListening()) { BB.Speech.stopListening(); resetMic(); setState('idle'); }
    startIdleTimer();
  });

  el.mic.addEventListener('click', toggleMic);

  el.repeatBtn.addEventListener('click', function () {
    if (!ui.started) return;
    if (ui.paused) { leavePause(true); return; }
    BB.Log.add('repeat', { mode: 'button' });
    respond(dialogue.repeat(), { instant: true });
  });

  el.backBtn.addEventListener('click', function () {
    if (!ui.started || dialogue.phase === 'done') return;
    if (ui.paused) leavePause(false);
    addUserMessage('Go back', 'button');
    BB.Log.add('user', { text: 'Go back', mode: 'button' });
    ui.lastTurn = null;
    respond(dialogue.back());
  });

  el.pauseBtn.addEventListener('click', function () {
    if (!ui.started) return;
    if (ui.paused) leavePause(true); else enterPause(false);
  });
  el.resumeBtn.addEventListener('click', function () { leavePause(true); });

  el.muteBtn.addEventListener('click', function () {
    ui.muted = !ui.muted;
    el.muteBtn.setAttribute('aria-pressed', String(ui.muted));
    el.muteBtn.querySelector('span').textContent = ui.muted ? 'Voice off' : 'Voice on';
    BB.Log.add(ui.muted ? 'mute' : 'unmute', {});
    if (ui.muted && BB.Speech.isSpeaking()) {
      BB.Speech.stopSpeaking();
      ui.busy = false;
      if (!ui.paused) { setState(dialogue.phase === 'done' ? 'done' : 'idle'); startIdleTimer(); }
    }
  });

  // Start over is in two places: under the avatar (always visible) and under the order.
  // It still asks "are you sure?" first unless the order is empty or already placed.
  function restartOrder() {
    if (!ui.started) { startOrder(); return; }
    if (dialogue.phase === 'done') { submit('Start a new order', 'button'); return; }
    submit('Start over', 'button');
  }
  el.restartBtn.addEventListener('click', restartOrder);
  $('restartCtrl').addEventListener('click', restartOrder);

  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'm' || e.key === 'M')) { e.preventDefault(); toggleMic(); }
    if (e.key === 'Escape' && BB.Speech.isListening()) { BB.Speech.stopListening(); resetMic(); setState('idle'); }
  });

  /* ---------------- voice speed ----------------
   * Three clear choices instead of a slider: easy to hit, easy to say
   * ("slow down", "talk faster"), and the chosen one is always visible.
   * The choice is remembered on this computer only.
   */
  var SPEEDS = { slower: 0.8, normal: 0.95, faster: 1.15 };
  var THINK_BY_SPEED = { slower: 520, normal: 380, faster: 220 };
  var speedNow = 'normal';
  var speedButtons = Array.prototype.slice.call(document.querySelectorAll('.seg button'));

  function setSpeed(name, announce) {
    if (!SPEEDS[name]) return;
    speedNow = name;
    BB.Speech.setRate(SPEEDS[name]);
    THINK_MS = THINK_BY_SPEED[name];
    speedButtons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-speed') === name)); });
    try { localStorage.setItem('brewbot-speed', name); } catch (e) {}
    // Let people hear the new speed straight away (feedback).
    if (announce && !ui.muted && !ui.paused && !BB.Speech.isListening() && BB.Speech.canSpeak()) {
      var line = name === 'slower' ? 'Okay, I’ll speak more slowly.' : name === 'faster' ? 'Okay, I’ll speak a bit faster.' : 'Okay, back to my normal speed.';
      var before = el.status.getAttribute('data-state');
      setState('speaking');
      BB.Speech.speak(line, { onEnd: function () { if (!ui.paused && !ui.busy) setState(before === 'speaking' ? 'idle' : before); } });
    }
  }
  function stepSpeed(dir) {
    var order = ['slower', 'normal', 'faster'];
    var i = order.indexOf(speedNow) + (dir === 'slower' ? -1 : 1);
    return order[Math.max(0, Math.min(2, i))];
  }
  speedButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      BB.Log.add('speed', { mode: 'button', text: b.getAttribute('data-speed') });
      setSpeed(b.getAttribute('data-speed'), true);
    });
  });
  try { var savedSpeed = localStorage.getItem('brewbot-speed'); if (SPEEDS[savedSpeed]) setSpeed(savedSpeed, false); } catch (e) {}

  /* ---------------- order tracker ----------------
   * After the order is placed: Received -> Being made -> Ready for pickup,
   * with a countdown, a progress bar, a soft chime and a spoken alert when
   * it is ready, and "Ready!" in the tab title in case the user is in
   * another tab. Stage changes (not every second) are announced to screen
   * readers. "Skip ahead" is only for demos, so nobody waits 10 minutes.
   */
  var tracker = null;

  function startTracker() {
    stopTracker();
    var p = dialogue.placed;
    if (!p) return;
    var placedAt = new Date(p.placedAt).getTime();
    var ready = new Date(p.ready).getTime();
    var makingAt = Math.max(placedAt + 15000, ready - BB.SHOP.prepMinutes * 60000);
    var fmt = BB.Dialogue.formatTime;

    var card = document.createElement('div');
    card.className = 'tracker';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', 'Order ' + p.number + ' status');
    card.innerHTML =
      '<div class="tr-head"><span class="tr-num">Order #' + p.number + '</span><span class="tr-eta"></span></div>' +
      '<ol class="tr-steps">' +
        '<li class="s1">Received<small>' + fmt(new Date(placedAt)) + '</small></li>' +
        '<li class="s2">Being made<small>' + (makingAt - placedAt > 60000 ? 'from ' + fmt(new Date(makingAt)) : 'right away') + '</small></li>' +
        '<li class="s3">Ready for pickup<small>' + fmt(new Date(ready)) + '</small></li>' +
      '</ol>' +
      '<div class="tr-bar" aria-hidden="true"><i></i></div>' +
      '<p class="tr-note"></p>' +
      '<span class="visually-hidden tr-live" aria-live="polite"></span>';
    var skip = makeButton('Demo: skip ahead', 'link-btn tr-skip', function () {
      var nowMs = Date.now() + tracker.offset;
      var target = nowMs < makingAt ? makingAt : ready;
      tracker.offset = target - Date.now();
      BB.Log.add('tracker_skip', {});
      tick();
    });
    card.appendChild(skip);
    el.chatLog.appendChild(card);
    scrollDown();

    tracker = { card: card, offset: 0, stage: 0, timer: null, skip: skip };

    function tick() {
      if (!tracker) return;
      var nowMs = Date.now() + tracker.offset;
      var stage = nowMs >= ready ? 3 : nowMs >= makingAt ? 2 : 1;
      var pct = Math.max(4, Math.min(100, (nowMs - placedAt) / (ready - placedAt) * 100));
      card.querySelector('.tr-bar i').style.width = pct + '%';
      ['s1', 's2', 's3'].forEach(function (s, i) {
        var li = card.querySelector('.' + s);
        li.classList.toggle('done', i + 1 < stage || stage === 3);
        li.classList.toggle('now', i + 1 === stage && stage !== 3);
      });
      var mins = Math.ceil((ready - nowMs) / 60000);
      var eta = stage === 3 ? 'Ready now' : mins <= 1 ? 'Ready in about a minute' : 'Ready in ' + mins + ' min';
      card.querySelector('.tr-eta').textContent = eta;
      var note = stage === 1 ? (makingAt - placedAt > 60000
          ? 'We’ll start making it at ' + fmt(new Date(makingAt)) + ' so it’s fresh when you arrive.'
          : 'Your order is in the queue.')
        : stage === 2 ? 'A barista is making your ' + (p.plural ? 'drinks' : 'drink') + ' now.'
        : 'Look for \u201c' + p.name + '\u201d on the cup at the pickup counter.';
      card.querySelector('.tr-note').textContent = note;
      var tkStatus = document.querySelector('#ticket .tk-status');
      if (tkStatus) tkStatus.textContent = stage === 3 ? 'Ready for pickup' : stage === 2 ? 'Being made' : 'Received';
      el.ticket.classList.toggle('ready', stage === 3);

      if (stage !== tracker.stage) {
        var first = tracker.stage === 0;
        tracker.stage = stage;
        card.querySelector('.tr-live').textContent = 'Order ' + p.number + ': ' + (stage === 3 ? 'ready for pickup' : stage === 2 ? 'being made' : 'received');
        if (stage === 3) {
          card.classList.add('ready');
          skip.remove();
          clearInterval(tracker.timer);
          if (!first) announceReady(p);
        }
      }
    }
    tick();
    tracker.timer = setInterval(tick, 1000);
  }

  function stopTracker() {
    if (!tracker) return;
    clearInterval(tracker.timer);
    if (tracker.skip) tracker.skip.remove();
    tracker.card.classList.add('old');
    tracker = null;
    document.title = baseTitle;
  }

  var baseTitle = document.title;
  function announceReady(p) {
    document.title = 'Ready! ' + baseTitle;
    if (!ui.muted) chime();
    respond({
      text: 'Good news, ' + p.name + '! Your ' + (p.plural ? 'drinks are' : 'drink is') + ' ready at the pickup counter. Order number ' + p.number + '.',
      quick: [{ label: 'Start a new order', value: 'Start a new order' }], mood: 'happy', outcome: 'ready', phase: 'done', current: null, transient: true
    }, { instant: true });
  }
  window.addEventListener('focus', function () { if (document.title !== baseTitle && !tracker) document.title = baseTitle; });

  /* A soft two-note chime made in the browser (no sound file needed). */
  function chime() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = chime.ctx || (chime.ctx = new Ctx());
      [[659.25, 0], [987.77, 0.18]].forEach(function (n) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = n[0];
        var t = ctx.currentTime + n[1];
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.18, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 1);
      });
    } catch (e) {}
  }

  /* ---------------- Menu and Find us panels ---------------- */

  var modalOpen = null, modalReturn = null;
  function openModal(id, opener) {
    closeModal();
    modalOpen = $(id);
    modalReturn = opener;
    $('modalBackdrop').hidden = false;
    modalOpen.hidden = false;
    modalOpen.querySelector('.modal-close').focus();
  }
  function closeModal() {
    if (!modalOpen) return;
    modalOpen.hidden = true;
    $('modalBackdrop').hidden = true;
    modalOpen = null;
    if (modalReturn) modalReturn.focus();
  }

  // The menu panel is built from menu.js, so it always matches what BrewBot accepts.
  function buildMenu() {
    var money = BB.Dialogue.money;
    function section(title, items, priceFn) {
      return '<table class="menu-table"><caption>' + title + '</caption>' + items.map(function (o) {
        return '<tr><td>' + escapeHTML(o.label) + (o.icedOnly ? ' (iced only)' : '') + '</td><td>' + priceFn(o) + '</td></tr>';
      }).join('') + '</table>';
    }
    $('menuBody').innerHTML =
      section('Drinks', BB.MENU.drink, function (o) { return money(o.price); }) +
      section('Sizes', BB.MENU.size, function (o) { return o.price ? '+' + money(o.price) : 'included'; }) +
      section('Milk', BB.MENU.milk, function (o) { return o.price ? '+' + money(o.price) : 'free'; }) +
      section('Extras', BB.MENU.extras.filter(function (e) { return e.id !== 'none'; }), function (o) { return '+' + money(o.price); }) +
      '<p>All drinks come hot or iced (cold brew is iced only).</p>';
  }
  buildMenu();

  $('navMenu').addEventListener('click', function () { openModal('menuModal', $('navMenu')); });
  $('navFind').addEventListener('click', function () { openModal('findModal', $('navFind')); });
  $('navOrder').addEventListener('click', function () { closeModal(); (ui.started ? el.input : el.startBtn).focus(); });
  $('modalBackdrop').addEventListener('click', closeModal);
  Array.prototype.forEach.call(document.querySelectorAll('.modal-close'), function (b) { b.addEventListener('click', closeModal); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && modalOpen) { e.preventDefault(); closeModal(); } });

  /* ---------------- test log drawer ---------------- */

  var LOG_LABELS = {
    participant: 'Participant', completed: 'Order completed', secondsToComplete: 'Seconds to complete', turns: 'User turns',
    voiceTurns: 'Voice answers', typedTurns: 'Typed answers', buttonTurns: 'Button taps', notUnderstood: 'Not understood',
    unsupportedOrInvalid: 'Invalid / not on menu', clarifications: 'Clarifying questions', corrections: 'Changes and back',
    voiceRetries: 'Voice retries / edits', voiceErrors: 'Voice errors', helpOrRepeat: 'Help or repeat', nudges: 'Idle nudges'
  };

  function renderLog() {
    if (el.logDrawer.hidden) return;
    var s = BB.Log.summary();
    el.logSummary.innerHTML = Object.keys(LOG_LABELS).map(function (k) {
      var v = s[k];
      if (v === true) v = 'Yes'; else if (v === false) v = 'No'; else if (v === null || v === '') v = '-';
      return '<dt>' + LOG_LABELS[k] + '</dt><dd>' + escapeHTML(v) + '</dd>';
    }).join('');
    el.logEvents.innerHTML = BB.Log.events().map(function (e) {
      return '<li><span class="t">' + e.seconds + 's</span> ' + escapeHTML(e.type) + (e.mode ? ' (' + e.mode + ')' : '') +
        (e.outcome ? '<span class="o">' + escapeHTML(e.outcome) + '</span>' : '') + (e.text ? ': ' + escapeHTML(e.text.slice(0, 90)) : '') + '</li>';
    }).join('');
  }
  BB.Log.onChange = renderLog;

  el.logBtn.addEventListener('click', function () { el.logDrawer.hidden = false; renderLog(); el.logClose.focus(); });
  el.logClose.addEventListener('click', function () { el.logDrawer.hidden = true; el.logBtn.focus(); });
  el.participant.addEventListener('input', function () { BB.Log.setParticipant(el.participant.value.trim()); renderLog(); });
  // Two-step clear (no browser confirm dialog): first click asks, second click clears.
  var clearArmed = null;
  el.logClear.addEventListener('click', function () {
    if (clearArmed) { clearTimeout(clearArmed); clearArmed = null; BB.Log.clear(); el.logClear.textContent = 'Clear log'; return; }
    el.logClear.textContent = 'Click again to clear';
    clearArmed = setTimeout(function () { clearArmed = null; el.logClear.textContent = 'Clear log'; }, 4000);
  });
  el.logDownload.addEventListener('click', function () {
    var csv = BB.Log.toCSV();
    var name = 'brewbot-test-log-' + (BB.Log.getParticipant() || 'session') + '.csv';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  /* ---------------- first load ---------------- */

  setState('ready');
  renderOrder();
  el.backBtn.disabled = true;
  if (!BB.Speech.canListen()) {
    el.voiceNote.textContent = 'Voice input isn’t available in this browser, but you can type everything. For voice, open this page in Chrome or Edge.';
  }
  el.mic.disabled = !BB.Speech.canListen();
})();
