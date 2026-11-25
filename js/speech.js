/*
 * speech.js
 * ---------
 * Voice input (speech-to-text) and voice output (text-to-speech).
 *
 * Normally this uses the browser's built-in Web Speech API:
 *   - SpeechRecognition (Chrome and Edge) for listening
 *   - speechSynthesis (all modern browsers) for speaking
 *
 * Speaking voice, in order of preference:
 *   1. A Microsoft "Natural" neural voice (built into Edge): human-sounding, instant.
 *   2. Kokoro, a free open-source neural voice model that runs inside the page
 *      (British male voice "George"). It downloads once in the background
 *      (about 90 MB, then cached by the browser); until it is ready, and if it
 *      cannot load, the browser's own voice is used.
 *   3. The browser's built-in voice.
 *
 * If voice is not available at all, the app hides the mic button and the
 * whole order can still be done by typing (accessibility requirement:
 * "do not rely on voice alone").
 */
window.BB = window.BB || {};

BB.Speech = (function () {
  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var synth = window.speechSynthesis || null;
  var recognizer = null;
  var listening = false;
  var speaking = false;
  var chosenVoice = null;
  var listenHandlers = null;
  var silenceTimer = null;
  var speakToken = 0;

  /* ---------- picking a voice ----------
   * BrewBot speaks with a calm British male voice where the computer has one.
   * Voice names differ by browser and system, so we try the common ones first:
   *   Chrome: "Google UK English Male"
   *   Edge:   "Microsoft Ryan / Thomas Online (Natural) - English (United Kingdom)"
   *   Windows: "Microsoft George - English (United Kingdom)"
   *   Mac:     "Daniel" (English, UK)
   * then any UK English voice that sounds male, then any UK English voice,
   * and finally any English voice.
   */
  var VOICE_RATE = 1.0;    // set by the Voice speed control (0.85 / 1.0 / 1.15)
  var VOICE_PITCH = 1.0;   // changing pitch makes browser voices sound more robotic

  function pickVoice() {
    if (!synth) return;
    var voices = synth.getVoices();
    if (!voices.length) return;
    var preferred = [
      'Google UK English Male',
      'Microsoft Ryan Online (Natural) - English (United Kingdom)',
      'Microsoft Thomas Online (Natural) - English (United Kingdom)',
      'Microsoft Alfie Online (Natural) - English (United Kingdom)',
      'Microsoft Oliver Online (Natural) - English (United Kingdom)',
      'Microsoft George - English (United Kingdom)',
      'Daniel', 'Arthur', 'Oliver'
    ];
    for (var i = 0; i < preferred.length; i++) {
      var v = voices.find(function (x) { return x.name === preferred[i] || x.name.indexOf(preferred[i] + ' ') === 0; });
      if (v && /^en(-|_)GB/i.test(v.lang)) { chosenVoice = v; return; }
    }
    var gb = voices.filter(function (x) { return /^en(-|_)GB/i.test(x.lang); });
    chosenVoice = gb.find(function (x) { return /male|ryan|thomas|george|daniel|arthur|oliver|alfie|elliot/i.test(x.name) && !/female/i.test(x.name); }) ||
      gb[0] ||
      voices.find(function (x) { return /^en(-|_)(US|CA)/i.test(x.lang); }) ||
      voices.find(function (x) { return /^en/i.test(x.lang); }) || null;
  }

  if (synth) {
    pickVoice();
    if (typeof synth.onvoiceschanged !== 'undefined') synth.onvoiceschanged = pickVoice;
  }

  /* ---------- natural neural voice (Kokoro) ---------- */
  var KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
  var KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
  var KOKORO_VOICE = 'bm_george';        // British English, male, calm
  var neural = { state: 'off', tts: null, percent: 0, files: {} };
  var audioCtx = null;
  var currentSource = null;
  var statusListener = null;

  function hasNaturalBrowserVoice() { return !!(chosenVoice && /natural/i.test(chosenVoice.name)); }

  function report() {
    if (!statusListener) return;
    var label;
    if (hasNaturalBrowserVoice()) label = 'Natural voice (' + chosenVoice.name.replace(/^Microsoft\s+/, '').replace(/\s+Online.*$/, '') + ')';
    else if (neural.state === 'ready') label = 'Natural voice (George)';
    else if (neural.state === 'loading') label = 'Loading natural voice… ' + neural.percent + '%';
    else if (chosenVoice) label = 'Standard browser voice';
    else label = 'Voice not available';
    statusListener({ state: hasNaturalBrowserVoice() ? 'ready' : neural.state, label: label });
  }

  /* Start downloading the neural voice, unless the browser already has a natural one. */
  function loadNaturalVoice() {
    if (neural.state !== 'off' || hasNaturalBrowserVoice()) { report(); return; }
    if (typeof window.AudioContext === 'undefined' && typeof window.webkitAudioContext === 'undefined') return;
    neural.state = 'loading';
    report();
    import(KOKORO_URL).then(function (mod) {
      return mod.KokoroTTS.from_pretrained(KOKORO_MODEL, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: function (p) {
          if (!p || !p.file || !p.total) return;
          neural.files[p.file] = { loaded: p.loaded || 0, total: p.total };
          var loaded = 0, total = 0;
          Object.keys(neural.files).forEach(function (f) { loaded += neural.files[f].loaded; total += neural.files[f].total; });
          var pct = total ? Math.min(99, Math.round(loaded / total * 100)) : 0;
          if (pct !== neural.percent) { neural.percent = pct; report(); }
        }
      });
    }).then(function (tts) {
      neural.tts = tts;
      neural.state = 'ready';
      report();
    }).catch(function () {
      neural.state = 'failed';
      report();
    });
  }

  function useNeural() { return neural.state === 'ready' && !hasNaturalBrowserVoice(); }

  function ensureAudio() {
    if (!audioCtx) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  /* Text tweaks so the voice reads it naturally. */
  function forSpeech(text) {
    return text.replace(/&/g, 'and').replace(/×/g, ' times ').replace(/#(\d+)/g, 'number $1').replace(/\s+/g, ' ').trim();
  }

  /*
   * Speak with the neural voice. The first sentence is generated on its own so
   * BrewBot starts talking quickly; while one part plays, the next one is
   * already being generated, so there are no gaps between sentences.
   */
  function speakNeural(clean, token, finish, onStart) {
    var ctx = ensureAudio();
    var sentences = (forSpeech(clean).match(/[^.!?]+[.!?]*/g) || [clean]).map(function (t) { return t.trim(); }).filter(Boolean);
    var parts = [];
    sentences.forEach(function (t, i) {
      var last = parts[parts.length - 1];
      if (i > 0 && parts.length > 1 && last && (last + ' ' + t).length <= 160) parts[parts.length - 1] = last + ' ' + t;
      else if (i > 0 && parts.length === 1 && last && last.length < 40) parts[0] = last + ' ' + t;
      else parts.push(t);
    });
    var jobs = [];
    function job(i) {
      if (!jobs[i]) {
        // A slow computer should never leave BrewBot stuck: after 12 seconds, give up on this part.
        var timeout = new Promise(function (_, reject) { setTimeout(function () { reject(new Error('slow')); }, 12000); });
        jobs[i] = Promise.race([neural.tts.generate(parts[i], { voice: KOKORO_VOICE, speed: VOICE_RATE }), timeout]);
      }
      return jobs[i];
    }
    var started = false;
    function play(i) {
      if (token !== speakToken) return;
      if (i >= parts.length) { finish(); return; }
      job(i).then(function (audio) {
        if (token !== speakToken) return;
        if (i + 1 < parts.length) job(i + 1);           // generate the next part while this one plays
        var data = audio.audio, rate = audio.sampling_rate || 24000;
        var buffer = ctx.createBuffer(1, data.length, rate);
        buffer.copyToChannel ? buffer.copyToChannel(data, 0) : buffer.getChannelData(0).set(data);
        var src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = function () { if (currentSource === src) currentSource = null; play(i + 1); };
        currentSource = src;
        if (!started) { started = true; if (onStart) onStart(); }
        src.start();
      }).catch(function () {
        // If the neural voice fails mid-reply, finish with the browser voice.
        if (token !== speakToken) return;
        neural.state = 'failed';
        report();
        if (!started) { started = true; if (onStart) onStart(); }
        speakBrowser(parts.slice(i).join(' '), token, finish);
      });
    }
    play(0);
  }

  /* "um", "uh", a cough heard as "hmm": not an answer, so keep listening. */
  function isFiller(text) {
    return /^\s*(u+m+|u+h+|h+m+|m+|a+h+|o+h+|e+r+|e+h+|huh|ha|\[.*\]|\(.*\))[.!?,]*\s*$/i.test(text || '');
  }

  /* ---------- listening ---------- */
  function canListen() { return !!Recognition; }

  function resetSilence() {
    clearTimeout(silenceTimer);
    // If nothing is said for 8 seconds, stop and tell the user.
    silenceTimer = setTimeout(function () {
      if (!listening) return;
      var h = listenHandlers;
      stopListening();
      if (h) { h.onError('no-speech'); h.onEnd(); }
    }, 8000);
  }

  function finishListening() {
    listening = false;
    clearTimeout(silenceTimer);
    listenHandlers = null;
  }

  /*
   * startListening(handlers) - must be called directly from a click or key press.
   *   handlers.onStart()                    microphone is on
   *   handlers.onPartial(text)              live words while the user is talking
   *   handlers.onFinal(text, {confidence, alternatives})
   *   handlers.onError(kind)                'no-speech' | 'not-allowed' | 'unsupported' | 'other'
   *   handlers.onEnd()                      listening has stopped
   */
  function startListening(handlers) {
    stopSpeaking();
    if (listening) stopListening();
    if (!Recognition) { handlers.onError('unsupported'); handlers.onEnd(); return false; }

    recognizer = new Recognition();
    recognizer.lang = 'en-US';
    recognizer.interimResults = true;
    recognizer.continuous = false;
    recognizer.maxAlternatives = 3;
    listening = true;
    listenHandlers = handlers;
    var gotFinal = false;
    var errorKind = null;

    recognizer.onstart = function () { handlers.onStart(); resetSilence(); };
    recognizer.onresult = function (event) {
      resetSilence();
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var res = event.results[i];
        if (res.isFinal) {
          if (isFiller(res[0].transcript)) continue;
          gotFinal = true;
          var alts = [];
          for (var a = 1; a < res.length; a++) alts.push(res[a].transcript);
          handlers.onFinal(res[0].transcript.trim(), { confidence: res[0].confidence || 0, alternatives: alts });
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim) handlers.onPartial(interim);
    };
    recognizer.onerror = function (event) {
      if (event.error === 'no-speech') errorKind = 'no-speech';
      else if (event.error === 'not-allowed' || event.error === 'service-not-allowed' || event.error === 'audio-capture') errorKind = 'not-allowed';
      else if (event.error === 'aborted') errorKind = null;
      else errorKind = 'other';
    };
    recognizer.onend = function () {
      var wasListening = listening;
      finishListening();
      recognizer = null;
      if (errorKind) handlers.onError(errorKind);
      else if (!gotFinal && wasListening) handlers.onError('no-speech');
      handlers.onEnd();
    };
    try { recognizer.start(); } catch (e) { finishListening(); handlers.onError('other'); handlers.onEnd(); return false; }
    return true;
  }

  function stopListening() {
    clearTimeout(silenceTimer);
    if (recognizer) {
      listening = false;
      try { recognizer.abort(); } catch (e) {}
    }
  }

  /* ---------- speaking ---------- */
  function canSpeak() { return !!synth; }

  /*
   * speak(text, {onStart, onEnd})
   * Long text is split into a few chunks because Chrome sometimes cuts off
   * long utterances. onEnd is always called, even if the browser forgets.
   */
  function speak(text, cb) {
    cb = cb || {};
    stopSpeaking();
    var token = ++speakToken;
    var clean = String(text).replace(/[“”"]/g, '').replace(/\$(\d+)\.(\d{2})/g, '$1 dollars $2');
    var done = false;
    function finish() {
      if (done || token !== speakToken) return;
      done = true;
      speaking = false;
      if (cb.onEnd) cb.onEnd();
    }

    if (useNeural()) {
      speaking = true;
      speakNeural(clean, token, finish, cb.onStart);
      return;
    }
    if (cb.onStart) cb.onStart();
    speakBrowser(clean, token, finish);
  }

  /* Speak with the browser's own voice, in as few pieces as possible. */
  function speakBrowser(clean, token, finish) {
    if (!synth) { finish(); return; }

    // Speak in as few pieces as possible. Every separate utterance adds a gap
    // (and with online "Natural" voices, a network round trip), which caused
    // long pauses between sentences. Natural voices take the whole reply at
    // once; other voices get chunks of a few sentences, because Chrome can cut
    // off a single very long utterance. Pauses inside a chunk are the voice's
    // own natural pauses, which scale with the speaking speed.
    var natural = chosenVoice && /natural|online/i.test(chosenVoice.name);
    var maxLen = natural ? 1000 : 220;
    var sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
    var chunks = [];
    sentences.forEach(function (sentence) {
      var t = sentence.trim();
      if (!t) return;
      var last = chunks[chunks.length - 1];
      if (last && (last + ' ' + t).length <= maxLen) chunks[chunks.length - 1] = last + ' ' + t;
      else chunks.push(t);
    });
    var index = 0;
    var fallback = setTimeout(finish, 2000 + clean.split(/\s+/).length * 520 / Math.max(VOICE_RATE, 0.5));
    speaking = true;
    function next() {
      if (token !== speakToken) return;
      if (index >= chunks.length) { clearTimeout(fallback); finish(); return; }
      var u = new SpeechSynthesisUtterance(chunks[index++]);
      if (chosenVoice) u.voice = chosenVoice;
      u.lang = chosenVoice ? chosenVoice.lang : 'en-GB';
      u.rate = VOICE_RATE;
      u.pitch = VOICE_PITCH;
      u.onend = next;
      u.onerror = next;
      synth.speak(u);
    }
    next();
  }

  function stopSpeaking() {
    speakToken++;
    speaking = false;
    if (synth) synth.cancel();
    if (currentSource) { try { currentSource.stop(); } catch (e) {} currentSource = null; }
  }

  return {
    canListen: canListen,
    canSpeak: canSpeak,
    startListening: startListening,
    stopListening: stopListening,
    isListening: function () { return listening; },
    speak: speak,
    stopSpeaking: stopSpeaking,
    isSpeaking: function () { return speaking; },
    setRate: function (r) { VOICE_RATE = r; },
    loadNaturalVoice: loadNaturalVoice,
    onVoiceStatus: function (fn) { statusListener = fn; report(); },
    unlockAudio: function () { try { if (neural.state !== 'off') ensureAudio(); } catch (e) {} },
    voiceName: function () { return chosenVoice ? chosenVoice.name : 'none'; }
  };
})();
