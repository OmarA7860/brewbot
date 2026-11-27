/*
 * dialogue.js
 * -----------
 * The conversation manager. It keeps track of the order, decides which
 * question to ask next, and builds every reply BrewBot gives. It has no
 * screen or audio code in it: app.js shows the replies and speech.js
 * speaks them. That split keeps the conversation logic easy to test.
 *
 * How it works (a "slot-filling" dialogue):
 *   - The order has nine slots (drink, size, temp, milk, extras, quantity,
 *     pickup, name, payment).
 *   - Every message is run through BB.NLU, and EVERY slot value found is
 *     saved, not only the one being asked about. So "two large iced oat
 *     lattes" fills five slots at once and BrewBot only asks what's left.
 *   - Saying a new value for a slot that is already filled changes it
 *     ("actually make it almond milk"), with no need to start over.
 *   - When all slots are filled, BrewBot reads back a summary and only
 *     places the order after the user says yes.
 *
 * Every public method returns a "reply" object:
 *   { text, quick: [{label, value}], mood, outcome, phase, heardCheck, pause }
 *     text        what BrewBot says (shown as text AND spoken)
 *     quick       quick-reply buttons to show under the message
 *     mood        avatar expression: 'neutral' | 'happy' | 'confused'
 *     outcome     what kind of turn this was, used by the test log
 *     heardCheck  set when voice input may have been misheard
 */
window.BB = window.BB || {};

BB.Dialogue = (function () {
  var ACKS = ['Got it.', 'Great.', 'Perfect.', 'Lovely.', 'Okay.', 'Nice choice.', 'Sure thing.'];

  // What BrewBot SAYS for each question. The screen keeps the full question with
  // every option, so the spoken line can be short and natural, like a barista.
  // Repeat, Help and any retry after a problem still read the full version.
  var SPOKEN_QUESTIONS = {
    drink: 'What can I get you today?',
    size: 'What size would you like?',
    temp: 'Hot or iced?',
    milk: 'And which milk would you like?',
    extras: 'Any extras, like a syrup or an extra shot?',
    quantity: 'How many would you like?',
    pickup: 'When would you like to pick it up?',
    name: 'And what name should I put on it?',
    payment: 'Will that be card or cash at pickup?'
  };

  var QUESTIONS = {
    drink: 'What would you like to drink? We have lattes, cappuccinos, americanos, mochas, cold brew, chai lattes and tea.',
    size: 'What size would you like: small, medium or large?',
    temp: 'Would you like it hot or iced?',
    milk: 'Which milk would you like? Whole, skim, oat or almond, or no milk.',
    extras: 'Any extras? You can add an extra shot, vanilla or caramel syrup, or whipped cream. Or just say no extras.',
    quantity: 'How many would you like? Tap a number or say any number up to 10.',
    pickup: 'When do you want to pick it up? As soon as possible is about 10 minutes, or you can give me a time like 3:30 pm.',
    name: 'What first name should we put on the order? Typing it works best for names.',
    payment: 'How would you like to pay: card or cash at pickup? You won’t need to give me any card details.'
  };

  // Shorter versions used when a question is asked again after a change.
  var SHORT_QUESTIONS = {
    drink: 'Which drink would you like?',
    size: 'What size: small, medium or large?',
    temp: 'Hot or iced?',
    milk: 'Which milk: whole, skim, oat, almond, or no milk?',
    extras: 'Which extras would you like? Extra shot, vanilla, caramel, whipped cream, or no extras.',
    quantity: 'How many would you like?',
    pickup: 'What time would you like to pick it up?',
    name: 'What first name should go on the order?',
    payment: 'Card or cash at pickup?'
  };

  function money(n) { return '$' + n.toFixed(2); }

  function formatTime(d) {
    var h = d.getHours(), m = d.getMinutes();
    var suffix = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + suffix;
  }

  function plural(label, qty) {
    var l = label.toLowerCase();
    if (qty === 1) return l;
    return l + 's';
  }

  function Dialogue(options) {
    options = options || {};
    this.now = options.now || function () { return new Date(); };
    this.reset();
  }

  Dialogue.prototype.reset = function () {
    this.order = { drink: null, size: null, temp: null, milk: null, extras: null, quantity: null, pickup: null, name: null, payment: null };
    this.history = [];        // slots in the order they were answered (for Back)
    this.phase = 'welcome';   // welcome -> asking -> confirm -> done
    this.current = null;      // the slot BrewBot is asking about
    this.pending = null;      // a follow-up BrewBot is waiting on (clarify, restart?)
    this.fails = 0;           // misunderstandings in a row on this question
    this.lastReply = null;
    this.nudged = false;
    this.placed = null;       // { number, ready } once the order is placed
    this.nextOrder = null;    // a second, different drink to order right after this one
    this.ackIndex = 0;
  };

  /* ---------- helpers about the order ---------- */

  Dialogue.prototype.isFilled = function (slot) {
    var v = this.order[slot];
    return v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);
  };

  Dialogue.prototype.nextSlot = function () {
    for (var i = 0; i < BB.SLOT_ORDER.length; i++) {
      if (!this.isFilled(BB.SLOT_ORDER[i])) return BB.SLOT_ORDER[i];
    }
    return null;
  };

  Dialogue.prototype.displayValue = function (slot) {
    var v = this.order[slot];
    if (v === null || v === undefined) return '';
    if (slot === 'quantity') return String(v);
    if (slot === 'name') return v;
    if (slot === 'pickup') return v.asap ? 'ASAP, about ' + formatTime(this.readyTime()) : formatTime(v.time);
    if (slot === 'extras') return v.map(function (id) { return BB.option('extras', id).label; }).join(', ');
    var o = BB.option(slot, v);
    return o ? o.label : String(v);
  };

  /* A sensible example pickup time: about 45 minutes from now, on a quarter hour, before closing. */
  Dialogue.prototype.exampleTime = function () {
    var d = new Date(this.now().getTime() + 40 * 60000);
    var m = d.getMinutes();
    d.setMinutes(Math.ceil(m / 15) * 15, 0, 0);
    if (d.getHours() > BB.SHOP.closesAt || (d.getHours() === BB.SHOP.closesAt && d.getMinutes() > 0)) return null;
    if (d.getHours() < BB.SHOP.opensAt) return null;
    if (d.toDateString() !== this.now().toDateString()) return null;
    return d;
  };

  Dialogue.prototype.readyTime = function () {
    var p = this.order.pickup;
    if (p && !p.asap && p.time) return p.time;
    return new Date(this.now().getTime() + BB.SHOP.prepMinutes * 60000);
  };

  /* Prices for the order panel. Returns null until a drink is chosen. */
  Dialogue.prototype.totals = function () {
    var o = this.order;
    if (!o.drink) return null;
    var unit = BB.option('drink', o.drink).price;
    if (o.size) unit += BB.option('size', o.size).price;
    if (o.milk) unit += BB.option('milk', o.milk).price;
    (o.extras || []).forEach(function (e) { unit += BB.option('extras', e).price; });
    var qty = o.quantity || 1;
    var subtotal = Math.round(unit * qty * 100) / 100;
    var tax = Math.round(subtotal * BB.SHOP.taxRate * 100) / 100;
    return { unit: unit, qty: qty, subtotal: subtotal, tax: tax, total: Math.round((subtotal + tax) * 100) / 100 };
  };

  /* "2 large iced lattes with oat milk and vanilla syrup" */
  Dialogue.prototype.describeDrink = function () {
    var o = this.order, parts = [];
    var qty = o.quantity || 1;
    var first = o.size ? o.size : (o.temp && o.drink !== 'coldbrew' ? o.temp : (o.drink || 'drink'));
    parts.push(qty === 1 ? (/^[aeiou]/.test(first) ? 'an' : 'a') : String(qty));
    if (o.size) parts.push(BB.option('size', o.size).label.toLowerCase());
    if (o.temp && o.drink !== 'coldbrew') parts.push(o.temp === 'iced' ? 'iced' : 'hot');
    parts.push(o.drink ? plural(BB.option('drink', o.drink).label, qty) : 'drink');
    var withs = [];
    if (o.milk && o.milk !== 'none') withs.push(BB.option('milk', o.milk).label.toLowerCase());
    (o.extras || []).forEach(function (e) {
      if (e === 'none') return;
      var l = BB.option('extras', e).label.toLowerCase();
      withs.push(e === 'shot' ? 'an extra shot' : l);
    });
    var text = parts.join(' ');
    if (o.milk === 'none') text += ' with no milk';
    if (withs.length) text += (o.milk === 'none' ? ' and ' : ' with ') + joinList(withs);
    return text;
  };

  function joinList(items) {
    if (items.length <= 1) return items.join('');
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  /* ---------- building replies ---------- */

  Dialogue.prototype.quickFor = function (slot) {
    switch (slot) {
      case 'drink': return BB.MENU.drink.map(function (d) { return { label: d.label, value: d.label, icon: d.id, price: money(d.price) }; });
      case 'size': return BB.MENU.size.map(function (s) { return { label: s.label + (s.price ? ' (+' + money(s.price) + ')' : ''), value: s.label }; });
      case 'temp': return [{ label: 'Hot', value: 'Hot' }, { label: 'Iced', value: 'Iced' }];
      case 'milk': return BB.MENU.milk.map(function (m) { return { label: m.label + (m.price ? ' (+' + money(m.price) + ')' : ''), value: m.label }; });
      case 'extras':
        var list = BB.MENU.extras.filter(function (e) { return e.id !== 'none'; })
          .map(function (e) { return { label: e.label + ' (+' + money(e.price) + ')', value: e.label }; });
        return [{ label: 'No extras', value: 'No extras' }].concat(list);
      case 'quantity': return ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].map(function (n) { return { label: n, value: n }; });
      case 'pickup':
        var chips = [{ label: 'As soon as possible', value: 'As soon as possible' }];
        var self = this, nowMs = this.now().getTime();
        [20, 30].forEach(function (m) {
          var d = new Date(nowMs + m * 60000);
          if (d.getHours() < BB.SHOP.closesAt) chips.push({ label: 'In ' + m + ' minutes (' + formatTime(d) + ')', value: 'In ' + m + ' minutes' });
        });
        var ex = self.exampleTime();
        if (ex) chips.push({ label: 'At ' + formatTime(ex), value: 'At ' + formatTime(ex) });
        return chips;
      case 'payment': return BB.MENU.payment.map(function (p) { return { label: p.label, value: p.label }; });
      default: return [];
    }
  };

  // "Nice choice" fits a drink, not a payment method or a time.
  var PLAIN_ACKS = ['Got it.', 'Okay.', 'Perfect.', 'Sure thing.', 'Great.'];
  Dialogue.prototype.ack = function (plain) {
    var list = plain ? PLAIN_ACKS : ACKS;
    var a = list[this.ackIndex % list.length];
    this.ackIndex++;
    return a;
  };

  Dialogue.prototype.reply = function (text, extra) {
    var r = {
      text: text,
      quick: [],
      mood: 'neutral',
      outcome: 'ok',
      phase: this.phase,
      current: this.current,
      heardCheck: null,
      pause: false
    };
    for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    r.phase = this.phase;
    r.current = this.current;
    if (!r.isRepeat && !r.transient) this.lastReply = r;
    this.nudged = false;
    return r;
  };

  /* Ask about a slot. 'prefix' is any acknowledgement said first. */
  Dialogue.prototype.ask = function (slot, prefix, extra) {
    this.phase = 'asking';
    if (this.current !== slot) this.fails = 0;
    this.current = slot;
    var q = (extra && extra.short) ? SHORT_QUESTIONS[slot] : QUESTIONS[slot];
    if (slot === 'pickup' && !(extra && extra.short)) {
      var ex = this.exampleTime();
      q = 'When do you want to pick it up? As soon as possible is about ' + BB.SHOP.prepMinutes + ' minutes' +
        (ex ? ', or you can give me a time like ' + formatTime(ex) + '.' : '.');
    }
    var said = (extra && extra.short) || this.fails > 0 ? q : SPOKEN_QUESTIONS[slot];
    if (this.order.quantity > 1) {
      q = q.replace('pick it up', 'pick them up').replace('like it hot', 'like them hot');
      said = said.replace('pick it up', 'pick them up');
    }
    var text = prefix ? prefix + ' ' + q : q;
    var sayPrefix = extra && extra.spokenPrefix !== undefined ? extra.spokenPrefix : prefix;
    var spoken = sayPrefix ? sayPrefix + ' ' + said : said;
    return this.reply(text, Object.assign({ quick: this.quickFor(slot), spoken: spoken }, extra || {}));
  };

  /* Ask the next empty slot, or move to confirmation when nothing is missing. */
  Dialogue.prototype.continueFrom = function (prefix, extra) {
    var next = this.nextSlot();
    if (!next) return this.confirm(prefix, extra);
    return this.ask(next, prefix, extra);
  };

  Dialogue.prototype.confirm = function (prefix, extra) {
    this.phase = 'confirm';
    this.current = null;
    this.pending = null;
    var o = this.order, t = this.totals();
    var when = o.pickup.asap ? 'as soon as possible, around ' + formatTime(this.readyTime()) : 'at ' + formatTime(o.pickup.time);
    var pay = o.payment === 'card' ? 'by card at pickup' : 'with cash at pickup';
    var text = (prefix ? prefix + ' ' : '') + 'Here’s your order: ' + this.describeDrink() +
      ', ready ' + when + ', under the name ' + o.name + ', paying ' + pay +
      '. Your total is ' + money(t.total) + ' with tax. Should I place the order?';
    // Spoken the way a barista would read it back: every detail, in a natural rhythm.
    var spoken = (prefix ? prefix + ' ' : '') + 'So that’s ' + this.describeDrink() +
      ', ready ' + (o.pickup.asap ? 'around ' + formatTime(this.readyTime()) : 'at ' + formatTime(o.pickup.time)) +
      ', for ' + o.name + ', paying ' + (o.payment === 'card' ? 'by card' : 'with cash') +
      '. That comes to ' + money(t.total) + ' with tax. Shall I place the order?';
    return this.reply(text, Object.assign({
      quick: [{ label: 'Yes, place my order', value: 'Yes, place my order' }, { label: 'Change something', value: 'Change something' }],
      outcome: 'confirm', spoken: spoken
    }, extra || {}));
  };

  Dialogue.prototype.placeOrder = function () {
    this.phase = 'done';
    this.current = null;
    var number = 1000 + Math.floor(Math.random() * 9000);
    var ready = this.readyTime();
    this.placed = { number: number, ready: ready, placedAt: this.now(), name: this.order.name, plural: (this.order.quantity || 1) > 1 };
    var text = 'You’re all set, ' + this.order.name + '! Your order number is ' + number + '. ' +
      'Your ' + this.describeDrink().replace(/^an? /, '') + ' will be ready around ' + formatTime(ready) +
      ' at the pickup counter. Thanks for ordering with Bean & Brew!';
    if (this.nextOrder) {
      text += ' Ready to order ' + this.nextOrder.label + ' now?';
      var lbl = 'Yes, order ' + this.nextOrder.label.replace(/^your /, 'the ');
      return this.reply(text, { mood: 'happy', outcome: 'completed', quick: [{ label: lbl, value: 'Yes, next order' }, { label: 'No thanks', value: 'No thanks' }] });
    }
    return this.reply(text, { mood: 'happy', outcome: 'completed', quick: [{ label: 'Start a new order', value: 'Start a new order' }] });
  };

  function describeNext(r) {
    var v = r.values, words = [];
    if (v.size) words.push(BB.option('size', v.size).label.toLowerCase());
    if (v.temp === 'iced' && v.drink !== 'coldbrew') words.push('iced');
    words.push(BB.option('drink', v.drink).label.toLowerCase());
    var s = words.join(' ');
    return 'your ' + s;
  }

  /* ---------- public actions ---------- */

  Dialogue.prototype.start = function () {
    this.reset();
    return this.ask('drink', 'Hi, I’m BrewBot! I can take your pickup order for Bean & Brew. You can talk to me with the mic button or type your answers.',
      { outcome: 'greeting', spokenPrefix: 'Hi, I’m BrewBot! Just tap Talk and tell me what you’d like, or type if you prefer.' });
  };

  Dialogue.prototype.repeat = function () {
    if (!this.lastReply) return this.start();
    var r = Object.assign({}, this.lastReply, { isRepeat: true, outcome: 'repeat' });
    this.nudged = false;
    return r;
  };

  Dialogue.prototype.back = function () {
    if (this.phase === 'done') return this.reply('Your order has already been placed. Would you like to start a new one?', { quick: [{ label: 'Start a new order', value: 'Start a new order' }] });
    this.pending = null;
    if (!this.history.length) return this.ask(this.current || 'drink', 'This is the first question, so there’s nothing to go back to.', { outcome: 'back' });
    var slot = this.history.pop();
    var before = this.displayValue(slot);
    this.order[slot] = null;
    return this.ask(slot, 'Okay, going back. You had ' + lowerValue(slot, before) + ' for ' + BB.SLOT_LABELS[slot].toLowerCase() + '.', { outcome: 'back', short: true });
  };

  /* Change one slot (from an Edit link in the order panel, or "change the milk"). */
  Dialogue.prototype.startChange = function (slot) {
    if (this.phase === 'done') return this.reply('Your order has already been placed, so it can’t be changed here. You can start a new order.', { quick: [{ label: 'Start a new order', value: 'Start a new order' }] });
    this.pending = null;
    var before = this.isFilled(slot) ? this.displayValue(slot) : null;
    this.order[slot] = null;
    this.removeFromHistory(slot);
    var prefix = before ? 'Sure, let’s change the ' + BB.SLOT_LABELS[slot].toLowerCase() + '. Right now it’s ' + lowerValue(slot, before) + '.' : 'Sure.';
    return this.ask(slot, prefix, { outcome: 'change', short: true });
  };

  Dialogue.prototype.removeFromHistory = function (slot) {
    this.history = this.history.filter(function (s) { return s !== slot; });
  };

  Dialogue.prototype.help = function () {
    var slot = this.current;
    var options = slot ? this.quickFor(slot).map(function (q) { return q.value; }) : [];
    var text = 'You can answer by typing, tapping a button, or pressing the mic and talking. ';
    if (slot && options.length) text += 'For ' + BB.SLOT_LABELS[slot].toLowerCase() + ', your options are ' + joinList(options.map(function (o) { return o.toLowerCase(); })) + '. ';
    text += 'You can also say "change the milk", "go back", "repeat" or "start over" at any time.';
    var r = this.reply(text, { outcome: 'help', quick: slot ? this.quickFor(slot) : [] });
    return r;
  };

  /* Called by the app when nobody has answered for a while. Only nudges once per question. */
  Dialogue.prototype.nudge = function () {
    if (this.nudged || this.phase === 'done' || this.phase === 'welcome') return null;
    var r = this.reply('Still there? No rush. You can tap an option, type your answer, or press the mic to talk.', {
      quick: this.lastReply ? this.lastReply.quick : [], outcome: 'nudge', transient: true
    });
    this.nudged = true;
    return r;
  };

  /* Called by the app when voice input fails before any words arrive. */
  Dialogue.prototype.voiceProblem = function (kind) {
    var text;
    if (kind === 'no-speech') text = 'I didn’t hear anything. Press the mic and try again, or type your answer below.';
    else if (kind === 'not-allowed') text = 'I can’t use your microphone. You can allow it from the icon in the address bar, or just type your answers.';
    else if (kind === 'unsupported') text = 'Voice isn’t available in this browser. Chrome or Edge work best, but you can type everything here.';
    else text = 'Something went wrong with voice input. Please try the mic again, or type your answer.';
    var keep = this.lastReply ? this.lastReply.quick : [];
    var r = this.reply(text, { quick: keep, mood: 'confused', outcome: 'voice_error', transient: true });
    return r;
  };

  /* Save and restore the conversation, so a misheard voice answer can be undone. */
  Dialogue.prototype.snapshot = function () {
    return JSON.stringify({
      order: this.order, history: this.history, phase: this.phase, current: this.current,
      pending: this.pending, fails: this.fails, lastReply: this.lastReply
    });
  };

  Dialogue.prototype.restore = function (snap) {
    var s = JSON.parse(snap);
    if (s.order.pickup && s.order.pickup.time) s.order.pickup.time = new Date(s.order.pickup.time);
    this.order = s.order; this.history = s.history; this.phase = s.phase; this.current = s.current;
    this.pending = s.pending; this.fails = s.fails; this.lastReply = s.lastReply;
  };

  /* ---------- the main entry point ---------- */

  /*
   * handle(text, meta)
   *   meta.mode          'text' | 'voice' | 'button'
   *   meta.alternatives  other guesses from speech recognition
   *   meta.confidence    0..1 from speech recognition (0 = unknown)
   */
  /*
   * "…and then I also want a large mocha" while ordering a cappuccino.
   * Each order holds one kind of drink, so the second drink is saved as the
   * next order instead of silently replacing the first one (error prevention).
   * Returns { now: text for this order, next: text for the next order } or null.
   */
  var CUE_RE = /\b(and then|then|and also|also|plus|as well as|in addition|and another|another|and a second|a second|and an?)\b/gi;
  var CHANGE_WORDS = /\b(actually|instead|change|switch|make it|make that|rather|no wait|scratch that)\b/i;
  Dialogue.prototype.splitSecondDrink = function (raw) {
    if (this.phase !== 'asking' || CHANGE_WORDS.test(raw)) return null;
    var now = this.now(), m, self = this;
    CUE_RE.lastIndex = 0;
    while ((m = CUE_RE.exec(raw))) {
      var before = raw.slice(0, m.index), after = raw.slice(m.index);
      var second = BB.NLU.understand(after, 'drink', now).values.drink;
      if (!second) continue;
      var first = this.order.drink || BB.NLU.understand(before, this.current, now).values.drink;
      if (first && first !== second) return { now: before, next: after.replace(CUE_RE, ' ').trim() };
    }
    return null;
  };

  Dialogue.prototype.handle = function (text, meta) {
    meta = meta || {};
    var raw = String(text || '').trim();
    if (!raw) return this.ask(this.current || 'drink', 'I didn’t get an answer there.', { outcome: 'empty', short: true });

    var split = this.splitSecondDrink(raw);
    if (split) {
      var nextInfo = BB.NLU.understand(split.next, 'drink', this.now());
      var nextOrder = { text: split.next, label: describeNext(nextInfo) };
      var keep = BB.NLU.understand(split.now, this.current, this.now());
      var reply = this.isUseful(keep) ? this.handle(split.now, meta) : null;
      this.nextOrder = nextOrder;
      var note = 'I can take one kind of drink per order, so I’ll start ' + nextOrder.label + ' as a second order as soon as this one is placed.';
      if (!reply) return this.ask(this.current || this.nextSlot() || 'drink', 'Got it. ' + note, { outcome: 'ok', short: true });
      reply.text = note + ' ' + reply.text;
      if (reply.spoken) reply.spoken = note + ' ' + reply.spoken;
      return reply;
    }

    var now = this.now();
    var r = BB.NLU.understand(raw, this.current, now);

    // Speech recognition often has a second guess. If the first guess means
    // nothing to us but another one does, use the other one.
    if (meta.mode === 'voice' && meta.alternatives && !this.isUseful(r)) {
      for (var i = 0; i < meta.alternatives.length; i++) {
        var alt = BB.NLU.understand(meta.alternatives[i], this.current, now);
        if (this.isUseful(alt)) { r = alt; break; }
      }
    }

    // After the order is placed
    if (this.phase === 'done' && r.command !== 'slower' && r.command !== 'faster') {
      if (this.nextOrder && (r.yes || /\b(next|second|another|new)\b/.test(r.text) || r.values.drink) && !r.no) {
        var nx = this.nextOrder, prevNumber = this.placed ? this.placed.number : null;
        var keepName = this.order.name, keepPay = this.order.payment;
        this.start();
        this.nextOrder = null;
        // Same customer: keep their name and payment so they aren't asked twice (efficiency).
        if (keepName) { this.order.name = keepName; this.history.push('name'); }
        if (keepPay) { this.order.payment = keepPay; this.history.push('payment'); }
        var first = this.handle(nx.text, { mode: 'text' });
        first.text = first.text.replace(/^(Okay|Got it|Great|Perfect|Lovely|Sure thing|Nice choice)\.\s*/, '');
        if (first.spoken) first.spoken = first.spoken.replace(/^(Okay|Got it|Great|Perfect|Lovely|Sure thing|Nice choice)\.\s*/, '');
        var lead = 'Starting ' + nx.label + '.' + (prevNumber ? ' Your first order, number ' + prevNumber + ', is still on its way.' : '') +
          (keepName ? ' I’ve kept the name ' + keepName + ' and ' + (keepPay === 'card' ? 'card' : 'cash') + ' payment.' : '');
        first.text = lead + ' ' + first.text;
        if (first.spoken) first.spoken = lead + ' ' + first.spoken;
        first.outcome = 'restart';
        return first;
      }
      if (this.nextOrder && r.no) {
        this.nextOrder = null;
        return this.reply('No problem. Enjoy your drink!', { quick: [{ label: 'Start a new order', value: 'Start a new order' }] });
      }
      if (r.command === 'restart' || /\b(new|another|again|start)\b/.test(r.text) || r.yes) return this.start();
      return this.reply('Your order is already in. If you’d like another one, just say "new order".', { quick: [{ label: 'Start a new order', value: 'Start a new order' }] });
    }

    // Waiting on "are you sure you want to start over?"
    if (this.pending && this.pending.type === 'restart') {
      this.pending = null;
      if (r.yes) return this.ask('drink', this.resetKeepGreeting(), { outcome: 'restart' });
      return this.continueFrom('Okay, we’ll keep going.', { short: true });
    }

    // Waiting on "Most people go for a latte. Would you like that?"
    if (this.pending && this.pending.type === 'suggest') {
      var ps = this.pending;
      this.pending = null;
      if (r.yes && !this.isUseful(r)) {
        var take = BB.NLU.understand(ps.value, ps.slot, now);
        take.correction = true;
        return this.afterApply(this.apply(take), take, {});
      }
      if (r.no && !this.isUseful(r) && !r.unsupported.length) {
        if (this.phase === 'confirm') return this.confirm('No problem, I’ll keep it as it is.', { short: true });
        return this.ask(this.current || this.nextSlot() || 'drink', 'No problem.', { short: true });
      }
    }

    // Small talk, prices and suggestions: answer like a person, then get back to the order.
    if (!r.command && !this.isUseful(r) && !r.unsupported.length) {
      if (r.smalltalk) return this.smallTalk(r.smalltalk);
      if (r.recommend && this.phase === 'asking') return this.suggest();
    }
    if (r.priceQuestion && !r.command && this.phase !== 'done') return this.prices(r);
    if (r.refusePay) {
      return this.ask('payment', 'Payment happens at the counter when you pick up your drink, so nothing is charged now. I just need to know if you’ll use card or cash.', { outcome: 'clarify', short: true });
    }

    // Commands that work at any point
    if (r.command === 'restart') {
      if (!this.history.length && !this.anyFilled()) return this.start();
      this.pending = { type: 'restart' };
      return this.reply('Do you want to start over? This will clear everything you’ve picked so far.', {
        quick: [{ label: 'Yes, start over', value: 'Yes' }, { label: 'No, keep going', value: 'No' }], outcome: 'restart_check'
      });
    }
    if (r.command === 'pause') return this.reply('Sure, take your time. Press Resume when you’re ready.', { pause: true, outcome: 'pause', quick: [], transient: true });
    if (r.command === 'repeat') return this.repeat();
    if (r.command === 'slower' || r.command === 'faster') {
      var sp = r.command === 'slower' ? 'Sure, I’ll speak more slowly.' : 'Sure, I’ll speak a bit faster.';
      var ex = { speed: r.command, outcome: 'speed', short: true };
      if (this.phase === 'confirm') return this.confirm(sp, ex);
      if (this.phase === 'done') return this.reply(sp, Object.assign(ex, { quick: [{ label: 'Start a new order', value: 'Start a new order' }] }));
      return this.ask(this.current || 'drink', sp, ex);
    }
    if (r.command === 'back') return this.back();
    if (r.command === 'help' && !this.isUseful(r)) return this.help();

    // Sensitive information is never needed
    if (r.privacy) {
      var why = r.privacy === 'card' ? 'Please don’t share card numbers here. You’ll pay at the counter when you pick up.'
        : 'Thanks, but I don’t need your ' + (r.privacy === 'email' ? 'email' : r.privacy === 'address' ? 'address' : 'phone number') + '. All I need is a first name for the order.';
      if (this.phase === 'confirm') return this.confirm(why);
      return this.ask(this.current || 'drink', why, { outcome: 'privacy', short: true, mood: 'neutral' });
    }

    // Waiting on "did you mean medium or large?"
    if (this.pending && this.pending.type === 'choice') {
      var p = this.pending;
      var pick = r.values[p.slot];
      if (!pick && /\b(first|former)\b/.test(r.text)) pick = p.options[0];
      if (!pick && /\b(second|latter|last)\b/.test(r.text)) pick = p.options[1];
      if (pick) { r.values[p.slot] = pick; delete r.conflicts[p.slot]; }
      this.pending = null;
    }

    // Waiting on "what would you like to change?"
    if (this.pending && this.pending.type === 'pickField') {
      this.pending = null;
      var field = this.fieldFromText(r);
      if (field && !this.isUseful(r)) return this.startChange(field);
    }

    // Confirmation step
    if (this.phase === 'confirm') {
      if (this.isUseful(r) || r.unsupported.length || r.anotherDrink) {
        var res = this.apply(r);
        return this.afterApply(res, r, meta);
      }
      if (r.command === 'change' && r.changeSlot) return this.startChange(r.changeSlot);
      if (r.yes && !r.no) return this.placeOrder();
      if (r.no || r.command === 'change') return this.askWhatToChange();
      var f = this.fieldFromText(r);
      if (f) return this.startChange(f);
      return this.notUnderstood(r, meta);
    }

    // "change the milk" with no new value given
    if (r.command === 'change') {
      if (r.changeSlot && !this.hasValueFor(r, r.changeSlot)) return this.startChange(r.changeSlot);
      if (!r.changeSlot && !this.isUseful(r)) return this.askWhatToChange();
    }

    // Waiting on "do you want to change X to Y?"
    if (this.pending && this.pending.type === 'confirmChange') {
      var pc = this.pending;
      this.pending = null;
      if (r.yes && !this.isUseful(r)) {
        var forced = BB.NLU.understand(pc.text, null, now);
        forced.values = {}; forced.values[pc.slot] = pc.value; forced.extras = []; forced.time = null; forced.correction = true;
        return this.afterApply(this.apply(forced), forced, {});
      }
      if (r.no && !this.isUseful(r)) return this.continueFrom('Okay, I’ll keep it as ' + lowerValue(pc.slot, this.displayValue(pc.slot)) + '.', { short: true });
    }

    // A word that would change an EARLIER answer, said while answering a
    // different question, might be a mishearing. Unless the user clearly
    // asked for a change ("actually", "make it", "change"), check first.
    var risky = this.riskyOverwrites(r);
    if (risky.length && !r.correction && r.command !== 'change') {
      var answersCurrent = this.current && (this.hasValueFor(r, this.current) || (this.current === 'name'));
      var multi = Object.keys(r.values).length + (r.extras.length ? 1 : 0) >= 3;
      if (!multi) {
        risky.forEach(function (slot) { delete r.values[slot]; });
        var triedTime = this.current === 'pickup' && r.time && r.time.error && /\d|\b(minutes?|mins?|hours?|am|pm|noon|soon|now|o'?clock|half|quarter)\b/.test(r.text);
        if (!answersCurrent && !triedTime && !this.isUseful(r) && !r.unsupported.length) {
          var rs = risky[0];
          this.pending = { type: 'confirmChange', slot: rs, value: BB.NLU.understand(raw, null, now).values[rs], text: raw };
          var toLabel = BB.option(rs, this.pending.value) ? BB.option(rs, this.pending.value).label : String(this.pending.value);
          var heardPrefix = meta.mode === 'voice' ? 'I heard \u201c' + raw + '\u201d. ' : '';
          return this.reply(heardPrefix + 'Do you want to change the ' + BB.SLOT_LABELS[rs].toLowerCase() + ' from ' +
            lowerValue(rs, this.displayValue(rs)) + ' to ' + lowerValue(rs, toLabel) + '?', {
            quick: [{ label: 'Yes, change it', value: 'Yes' }, { label: 'No, keep it', value: 'No' }],
            outcome: 'clarify', heardCheck: meta.mode === 'voice' ? { text: raw } : null
          });
        }
      }
    }

    // Waiting on "I heard Omar. Is that right?"
    if (this.pending && this.pending.type === 'confirmName') {
      var pn = this.pending;
      this.pending = null;
      if (r.yes && !r.no) { this.setSlot('name', pn.name); return this.continueFrom('Thanks, ' + pn.name + '.'); }
      if (r.no || /\b(type|typing)\b/.test(r.text)) {
        return this.reply('No problem. Please type your first name in the box below.', { outcome: 'clarify', focusInput: true, quick: [] });
      }
      // Anything else is treated as a new attempt at the name ("Just Sam").
      var again = BB.NLU.parseName(raw);
      if (again && again.words <= 2 && !this.isUsefulOrderInfo(r)) {
        if (meta.mode === 'voice' && again.name !== pn.name) {
          this.pending = { type: 'confirmName', name: again.name };
          return this.reply('I heard ' + again.name + '. Is that right?', {
            outcome: 'clarify', quick: [{ label: 'Yes, that’s right', value: 'Yes' }, { label: 'No, I’ll type it', value: 'No, I will type it' }]
          });
        }
        this.setSlot('name', again.name);
        return this.continueFrom('Thanks, ' + again.name + '.');
      }
      if (this.current === 'name' && !this.isUsefulOrderInfo(r)) {
        this.pending = pn;
        return this.reply('Sorry, is your name ' + pn.name + '? Just say yes, or type your name below.', {
          outcome: 'clarify', quick: [{ label: 'Yes, that’s right', value: 'Yes' }, { label: 'No, I’ll type it', value: 'No, I will type it' }]
        });
      }
    }

    // A name given while BrewBot was asking something else.
    if (r.name && this.current !== 'name' && !this.isUsefulOrderInfo(r) && !(r.time && !r.time.error)) {
      if (meta.mode === 'voice') {
        this.pending = { type: 'confirmName', name: r.name };
        return this.reply('I heard the name ' + r.name + '. Is that right?', {
          outcome: 'clarify', quick: [{ label: 'Yes, that’s right', value: 'Yes' }, { label: 'No, I’ll type it', value: 'No, I will type it' }]
        });
      }
      this.setSlot('name', r.name);
      return this.continueFrom('Thanks, ' + r.name + '.');
    }

    // Name is free text, so it is handled on its own.
    if (this.current === 'name' && !this.isUsefulOrderInfo(r)) {
      var parsed = BB.NLU.parseName(raw);
      if (!parsed && (r.yes || r.no)) {
        return this.reply('Sorry, I still need a first name for the order. What should I put on it? Typing it works best.', {
          outcome: 'clarify', focusInput: true, quick: []
        });
      }
      if (meta.mode === 'voice') {
        // Speech often picks up nearby talking. If, after removing phrases like
        // "put ... as the name", more than two words are left, it is probably noise.
        if (!parsed || parsed.words > 2) {
          this.fails++;
          return this.reply('I heard \u201c' + raw + '\u201d, which sounds like background noise. Please type your first name below, or press Talk and say just your name.', {
            outcome: 'not_understood', mood: 'confused', heardCheck: { text: raw }, focusInput: true, quick: []
          });
        }
        this.pending = { type: 'confirmName', name: parsed.name };
        return this.reply('I heard ' + parsed.name + '. Is that right?', {
          outcome: 'clarify', quick: [{ label: 'Yes, that’s right', value: 'Yes' }, { label: 'No, I’ll type it', value: 'No, I will type it' }]
        });
      }
      if (!parsed) return this.notUnderstood(r, meta, 'Sorry, I didn’t catch a name.');
      this.setSlot('name', parsed.name);
      var note = parsed.hadLastName ? 'Thanks, ' + parsed.name + '. I’ll just use your first name.' : 'Thanks, ' + parsed.name + '.';
      return this.continueFrom(note);
    }

    var result = this.apply(r);
    return this.afterApply(result, r, meta);
  };

  Dialogue.prototype.resetKeepGreeting = function () {
    this.reset();
    this.phase = 'asking';
    return 'Okay, I’ve cleared your order. Let’s start again.';
  };

  Dialogue.prototype.anyFilled = function () {
    var self = this;
    return BB.SLOT_ORDER.some(function (s) { return self.isFilled(s); });
  };

  Dialogue.prototype.askWhatToChange = function () {
    this.pending = { type: 'pickField' };
    var self = this;
    var quick = BB.SLOT_ORDER.map(function (s) { return { label: BB.SLOT_LABELS[s], value: 'Change ' + BB.SLOT_LABELS[s].toLowerCase() }; });
    var text = 'No problem. What would you like to change? You can tap one of the options, or say something like "make it oat milk".';
    return this.reply(text, { quick: quick, outcome: 'change' });
  };

  Dialogue.prototype.fieldFromText = function (r) {
    var t = r.text;
    var map = [['drink', /\bdrink\b/], ['size', /\bsize\b/], ['temp', /\b(temp|temperature|hot or iced)\b/], ['milk', /\bmilk\b/],
      ['extras', /\b(extras?|add.?ons?|syrup)\b/], ['quantity', /\b(quantity|how many|number|amount)\b/],
      ['pickup', /\b(pickup|pick up|time|when)\b/], ['name', /\bname\b/], ['payment', /\b(pay|payment|paying)\b/]];
    for (var i = 0; i < map.length; i++) if (map[i][1].test(t)) return map[i][0];
    return r.changeSlot || null;
  };

  Dialogue.prototype.hasValueFor = function (r, slot) {
    if (slot === 'extras') return r.extras.length > 0;
    if (slot === 'pickup') return !!(r.time && !r.time.error);
    return !!r.values[slot];
  };

  /* Slots that already have a different value and are NOT the question being asked. */
  Dialogue.prototype.riskyOverwrites = function (r) {
    if (this.phase !== 'asking') return [];
    var self = this;
    return ['drink', 'size', 'temp', 'milk', 'payment', 'quantity'].filter(function (slot) {
      return r.values[slot] !== undefined && slot !== self.current && self.isFilled(slot) && self.order[slot] !== r.values[slot];
    });
  };

  Dialogue.prototype.isUsefulOrderInfo = function (r) {
    return BB.NLU.hasOrderInfo(r) && (Object.keys(r.values).length > 0 || r.extras.length > 0);
  };

  Dialogue.prototype.isUseful = function (r) {
    return BB.NLU.hasOrderInfo(r) || Object.keys(r.conflicts).length > 0;
  };

  Dialogue.prototype.setSlot = function (slot, value) {
    this.order[slot] = value;
    this.removeFromHistory(slot);
    this.history.push(slot);
  };

  /*
   * Save every value found in the message. Returns what happened so the
   * reply can mention it: which slots were set, which were changed, and
   * any notes (e.g. "cold brew only comes iced").
   */
  Dialogue.prototype.apply = function (r) {
    var self = this;
    var out = { set: [], changed: [], notes: [], problems: [] };
    var o = this.order;

    function put(slot, value) {
      var before = self.isFilled(slot) ? self.displayValue(slot) : null;
      var same = JSON.stringify(o[slot]) === JSON.stringify(value);
      self.setSlot(slot, value);
      if (before && !same) out.changed.push({ slot: slot, from: before, to: self.displayValue(slot) });
      else if (!before) out.set.push(slot);
    }

    ['drink', 'size', 'temp', 'milk', 'payment'].forEach(function (slot) {
      var v = r.values[slot];
      if (!v) return;
      if (slot === 'temp' && v === 'hot' && (r.values.drink || o.drink) === 'coldbrew') {
        out.problems.push('Cold brew only comes iced. If you’d like something hot, a latte or an americano would be great.');
        return;
      }
      put(slot, v);
      if (slot === 'drink' && v === 'coldbrew' && o.temp !== 'iced') {
        var hadHot = o.temp === 'hot';
        self.setSlot('temp', 'iced');
        out.notes.push(hadHot ? 'Cold brew only comes iced, so I’ve switched it to iced.' : 'Cold brew is always iced.');
      }
    });

    if (r.values.quantity !== undefined) {
      var q = r.values.quantity;
      if (q < 1) out.problems.push('The quantity needs to be at least 1.');
      else if (q > BB.SHOP.maxQuantity) out.problems.push('I can only take up to ' + BB.SHOP.maxQuantity + ' drinks in one order. For bigger orders please call the shop.');
      else put('quantity', q);
    }

    if (r.extras.length) {
      var list;
      if (r.extras[0] === 'none' || !this.isFilled('extras') || r.correction || this.current === 'extras') list = r.extras.slice();
      else list = o.extras.filter(function (e) { return e !== 'none'; }).concat(r.extras.filter(function (e) { return o.extras.indexOf(e) === -1; }));
      put('extras', list);
    }

    if (r.time) {
      if (r.time.error) {
        var timeWords = /\d|\b(minutes?|mins?|hours?|am|pm|noon|soon|now|o'?clock|half|quarter|asap)\b/.test(r.text);
        var otherInfo = Object.keys(r.values).length > 0 || r.extras.length > 0;
        if (timeWords || (this.current === 'pickup' && !otherInfo)) out.problems.push(this.timeProblem(r.time));
      } else {
        put('pickup', r.time.asap ? { asap: true } : { asap: false, time: r.time.time });
      }
    }
    return out;
  };

  /* True when every detail in the message matches what is already in the order. */
  Dialogue.prototype.repeatsOrder = function (r) {
    var o = this.order, self = this;
    var slots = Object.keys(r.values);
    if (!slots.length && !r.extras.length) return false;
    var same = slots.every(function (s) { return self.isFilled(s) && JSON.stringify(o[s]) === JSON.stringify(r.values[s]); });
    var extrasSame = !r.extras.length || (o.extras && r.extras.every(function (e) { return o.extras.indexOf(e) !== -1; }));
    return same && extrasSame && !r.unsupported.length;
  };

  /* Every time problem says what went wrong AND which times would work (Nielsen 9). */
  Dialogue.prototype.timeProblem = function (t) {
    var now = this.now();
    var earliest = new Date(now.getTime() + BB.SHOP.prepMinutes * 60000);
    var closing = new Date(now.getTime()); closing.setHours(BB.SHOP.closesAt, 0, 0, 0);
    var opening = new Date(now.getTime()); opening.setHours(BB.SHOP.opensAt, 0, 0, 0);
    var from = earliest < opening ? opening : earliest;
    var window = from <= closing
      ? ' Any time from ' + formatTime(from) + ' to ' + formatTime(closing) + ' works, or just say "as soon as possible".'
      : ' We’re closed for new orders today. We’re open from 7 am to 9 pm.';
    var heard = t.time ? formatTime(t.time) : '';
    if (t.error === 'too_soon') return 'That’s a bit too soon. Drinks take about ' + BB.SHOP.prepMinutes + ' minutes, so the earliest pickup is ' + formatTime(earliest) + '.';
    if (t.error === 'passed') return heard + ' has already passed today.' + window;
    if (t.error === 'closed') return (heard ? heard + ' is after we close at 9 pm.' : 'We close at 9 pm.') + window;
    if (t.error === 'not_open') return (heard ? heard + ' is before we open at 7 am.' : 'We open at 7 am.') + window;
    var ex = this.exampleTime();
    return 'Sorry, I didn’t catch the time. You can say "as soon as possible", "in 20 minutes"' + (ex ? ' or a time like "' + formatTime(ex) + '"' : '') + '.';
  };

  /* Decide what to say after applying the message. */
  Dialogue.prototype.afterApply = function (res, r, meta) {
    var self = this;
    var pieces = [];
    var changedSomething = res.set.length || res.changed.length;

    // What we don't sell
    var unsupportedMsg = '';
    if (r.unsupported.length) {
      var u = r.unsupported[0].item;
      unsupportedMsg = u.msg || ('Sorry, we don’t have ' + u.name + ', but ' + u.hint + '.');
    }
    var oneDrinkNote = r.anotherDrink ? 'Right now I can take one kind of drink per order. Once this one is placed, just say “new order” and I’ll take the next one.' : '';

    if (changedSomething) {
      res.changed.forEach(function (c) {
        pieces.push('I’ve changed the ' + BB.SLOT_LABELS[c.slot].toLowerCase() + ' from ' + lowerValue(c.slot, c.from) + ' to ' + lowerValue(c.slot, c.to) + '.');
      });
      if (res.set.length) {
        var names = res.set.filter(function (s) { return s !== 'pickup' && s !== 'payment' && s !== 'quantity'; })
          .map(function (s) { return self.displayValue(s).toLowerCase(); });
        var drinkParts = res.set.filter(function (s) { return ['drink', 'size', 'temp', 'milk', 'extras'].indexOf(s) !== -1; });
        if (res.set.length > 2 && !res.changed.length) pieces.push(this.ack().replace('Got it.', 'Okay.') + ' That’s ' + this.describeDrink() + '.');
        else if (this.order.drink && (drinkParts.indexOf('drink') !== -1 || drinkParts.length >= 2)) pieces.push(this.ack() + ' ' + capitalize(this.describeDrink()) + '.');
        else if (res.set.indexOf('quantity') !== -1 && res.set.length === 1) pieces.push(this.ack(true) + ' ' + this.order.quantity + (this.order.quantity === 1 ? ' drink.' : ' drinks.'));
        else if (res.set.indexOf('payment') !== -1 && res.set.length === 1) pieces.push(this.ack(true) + ' ' + (this.order.payment === 'card' ? 'Card' : 'Cash') + ' at pickup.');
        else if (res.set.indexOf('pickup') !== -1 && res.set.length === 1) pieces.push(this.ack(true) + ' Pickup ' + (this.order.pickup.asap ? 'as soon as possible, around ' + formatTime(this.readyTime()) : 'at ' + formatTime(this.order.pickup.time)) + '.');
        else if (names.length) pieces.push(this.ack() + ' ' + capitalize(joinList(names)) + '.');
        else pieces.push(this.ack());
      }
      if (r.availability && !r.unsupported.length) {
        if (pieces.length) pieces[0] = pieces[0].replace(/^(Got it|Great|Perfect|Lovely|Okay|Nice choice|Sure thing)\.\s*/, '');
        pieces.unshift('Yes, we do!');
      }
      res.notes.forEach(function (n) { pieces.push(n); });
      if (unsupportedMsg) pieces.push(unsupportedMsg);
      if (oneDrinkNote) pieces.push(oneDrinkNote);
      res.problems.forEach(function (p) { pieces.push(p); });
      this.fails = 0;
      var outcome = unsupportedMsg ? 'unsupported' : res.changed.length ? 'correction' : 'ok';
      // Something heard by voice with low confidence: let the user check it.
      var heard = (meta.mode === 'voice' && meta.confidence && meta.confidence < 0.5) ? { text: r.raw } : null;
      if (Object.keys(r.conflicts).length) return this.clarify(r, pieces.join(' '));
      if (r.vagueCoffee && !this.order.drink) return this.whichCoffee(pieces.join(' '));
      return this.continueFrom(pieces.join(' '), { outcome: outcome, heardCheck: heard, short: this.phase === 'confirm' });
    }

    // Nothing could be saved. Work out the most helpful reply.
    var conflictSlots = Object.keys(r.conflicts);
    if (conflictSlots.length) return this.clarify(r, unsupportedMsg);

    if (unsupportedMsg || oneDrinkNote) {
      unsupportedMsg = [unsupportedMsg, oneDrinkNote].filter(Boolean).join(' ');
      if (!r.unsupported.length) {
        if (this.phase === 'confirm') return this.confirm(unsupportedMsg, { outcome: 'unsupported' });
        return this.ask(this.current || this.nextSlot() || 'drink', unsupportedMsg, { outcome: 'unsupported', short: true });
      }
      this.fails++;
      var slot = r.unsupported[0].slot;
      var item = r.unsupported[0].item;
      // Offer the closest drink as a one-tap choice, like a barista would.
      if (item.offer && this.phase !== 'done') {
        this.offered = this.offered || {};
        if (this.offered[item.name]) unsupportedMsg = 'Sorry, we still don’t have ' + item.name + '.';
        this.offered[item.name] = true;
        this.pending = { type: 'suggest', slot: 'drink', value: item.offer };
        var yesLabel = 'Yes, ' + item.offerLabel;
        var rest = this.phase === 'confirm' ? [{ label: 'No, keep my order', value: 'No, keep my order' }]
          : this.quickFor(this.current || 'drink').slice(0, 4);
        return this.reply(unsupportedMsg + ' Would you like ' + item.offerLabel + ' instead?', {
          outcome: 'unsupported', quick: [{ label: yesLabel.charAt(0).toUpperCase() + yesLabel.slice(1), value: 'Yes' }].concat(rest)
        });
      }
      if (this.phase === 'confirm') return this.confirm(unsupportedMsg, { outcome: 'unsupported', mood: 'confused' });
      var re = slot === this.current
        ? this.ask(this.current, unsupportedMsg, { outcome: 'unsupported', mood: 'confused', short: true })
        : this.ask(this.current || 'drink', unsupportedMsg, { outcome: 'unsupported', mood: 'confused', short: true });
      return re;
    }

    // The user repeated something we already have ("No, I want the iced latte"): agree and move on.
    if (!res.problems.length && this.repeatsOrder(r)) {
      this.fails = 0;
      if (this.phase === 'confirm') return this.confirm('Yes, that’s already in your order.', { outcome: 'ok', short: true });
      return this.continueFrom('Yes, I’ve got ' + this.describeDrink() + '.', { outcome: 'ok', short: true });
    }

    if (res.problems.length) {
      this.fails++;
      var voice = meta.mode === 'voice';
      // A time we understood but can't use is named in the message itself, so no need to echo the sentence.
      var lead = voice && !(r.time && r.time.time) ? 'I heard \u201c' + r.raw + '\u201d. ' : '';
      return this.ask(this.current || this.nextSlot(), lead + res.problems.join(' '), {
        outcome: 'invalid', mood: 'confused', short: true, heardCheck: voice ? { text: r.raw } : null
      });
    }

    if (r.vagueCoffee && (this.current === 'drink' || !this.order.drink)) return this.whichCoffee('');

    return this.notUnderstood(r, meta);
  };

  /* "Hey, how's it going?" */
  Dialogue.prototype.smallTalk = function (kind) {
    var line = kind === 'howareyou' ? 'I’m doing well, thanks for asking!'
      : kind === 'thanks' ? 'You’re welcome!' : 'Hi there!';
    if (this.phase === 'confirm') return this.confirm(line, { outcome: 'smalltalk', short: true });
    return this.ask(this.current || this.nextSlot() || 'drink', line, { outcome: 'smalltalk', short: true });
  };

  /* What most people choose, offered as a yes/no suggestion. */
  var SUGGESTIONS = {
    drink: ['latte', 'Our most popular drink is the latte. Would you like one?'],
    size: ['medium', 'Most people go for a medium. Would you like that?'],
    temp: ['hot', 'Most people have it hot, but iced is great too. Shall I make it hot?'],
    milk: ['whole milk', 'Whole milk is the classic, and oat is the most popular dairy-free choice. Shall I go with whole milk?'],
    extras: ['vanilla', 'Vanilla syrup is the favourite add-on. Would you like it?'],
    quantity: ['1', 'Shall I make it just one?'],
    pickup: ['as soon as possible', 'Most people pick it up as soon as it’s ready, in about 10 minutes. Shall I do that?'],
    payment: ['card', 'Most people pay by card at pickup. Is that okay?']
  };
  Dialogue.prototype.suggest = function () {
    var slot = this.current || this.nextSlot() || 'drink';
    var s = SUGGESTIONS[slot];
    if (!s) return this.ask(slot, 'That one’s up to you!', { outcome: 'suggest', short: true });
    this.pending = { type: 'suggest', slot: slot, value: s[0] };
    return this.reply(s[1], {
      outcome: 'suggest', quick: [{ label: 'Yes, please', value: 'Yes' }].concat(this.quickFor(slot).slice(0, 4))
    });
  };

  /* "How much is a latte?" / "What's the difference between small and large?" */
  Dialogue.prototype.prices = function (r) {
    var drinkId = r.values.drink || this.order.drink;
    var d = drinkId ? BB.option('drink', drinkId) : null;
    var parts = [];
    if (d && !r.conflicts.size) parts.push('A small ' + d.label.toLowerCase() + ' is ' + money(d.price) + '.');
    else if (!r.conflicts.size) parts.push('Drinks start at ' + money(2.95) + ' for a small tea, and a small latte is ' + money(4.75) + '.');
    parts.push('Medium adds 60 cents and large adds ' + money(1.10) + '.');
    if (r.conflicts.size || /\bsize|small|medium|large\b/.test(r.text)) parts.push('Small is about 12 ounces, medium 16 and large 20.');
    if (/\b(milk|oat|almond)\b/.test(r.text) || this.current === 'milk') parts.push('Oat or almond milk is ' + money(0.70) + ' extra.');
    if (/\b(extra|syrup|shot|vanilla|caramel|whip)/.test(r.text) || this.current === 'extras') parts.push('Syrups are 60 cents, an extra shot is ' + money(1.00) + ' and whipped cream is 50 cents.');
    var line = parts.join(' ');
    if (this.phase === 'confirm') return this.confirm(line, { outcome: 'info', short: true });
    return this.ask(this.current || this.nextSlot() || 'drink', line, { outcome: 'info', short: true });
  };

  Dialogue.prototype.whichCoffee = function (prefix) {
    var ids = ['latte', 'cappuccino', 'americano', 'mocha', 'coldbrew'];
    this.pending = { type: 'choice', slot: 'drink', options: ids };
    this.phase = 'asking';
    this.current = 'drink';
    var coffees = ids.map(function (id) { var d = BB.option('drink', id); return { label: d.label, value: d.label }; });
    var iced = this.order.temp === 'iced';
    var lead = iced ? 'For an iced coffee, cold brew or an iced americano are the closest. ' : '';
    return this.reply((prefix ? prefix + ' ' : (iced ? '' : 'Sure! ')) + lead + 'Which kind of coffee would you like? We have a latte, cappuccino, americano, mocha or cold brew.', { quick: coffees, outcome: 'clarify' });
  };

  Dialogue.prototype.clarify = function (r, prefix) {
    var slot = Object.keys(r.conflicts)[0];
    var opts = r.conflicts[slot].slice(0, 3);
    var labels = opts.map(function (id) { return BB.option(slot, id).label; });
    this.pending = { type: 'choice', slot: slot, options: opts };
    if (this.phase !== 'confirm') { this.phase = 'asking'; this.current = slot; }
    var text = (prefix ? prefix + ' ' : '') + 'I heard both ' + joinList(labels.map(function (l) { return l.toLowerCase(); })) + '. Which one did you mean?';
    return this.reply(text, { quick: labels.map(function (l) { return { label: l, value: l }; }), outcome: 'clarify' });
  };

  Dialogue.prototype.notUnderstood = function (r, meta, lead) {
    this.fails++;
    if (this.phase === 'confirm') {
      var h = meta.mode === 'voice' ? 'I heard \u201c' + r.raw + '\u201d, but I’m not sure what you meant. ' : 'Sorry, I didn’t catch that. ';
      return this.confirm(h + 'Just say yes to place it, or tell me what to change.', {
        outcome: 'not_understood', mood: 'confused', short: true, heardCheck: meta.mode === 'voice' ? { text: r.raw } : null
      });
    }
    var slot = this.current || this.nextSlot() || 'drink';
    var heard = meta.mode === 'voice' ? 'I heard “' + r.raw + '”, but I’m not sure what you meant.' : (lead || 'Sorry, I didn’t understand that.');
    if (meta.mode === 'voice' && lead) heard = lead + ' I heard “' + r.raw + '”.';
    var tip = '';
    if (this.fails >= 3 && meta.mode === 'voice') tip = ' Voice seems to be having trouble, so you might find it easier to type or tap an option.';
    else if (this.fails >= 2) tip = ' You can tap one of the buttons below.';
    var r2 = this.ask(slot, heard + tip, {
      outcome: 'not_understood', mood: 'confused', short: true,
      heardCheck: meta.mode === 'voice' ? { text: r.raw } : null
    });
    return r2;
  };

  function lowerValue(slot, text) {
    if (slot === 'name') return text;
    if (slot === 'pickup') return text.replace('ASAP', 'as soon as possible');
    return text.toLowerCase();
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  Dialogue.formatTime = formatTime;
  Dialogue.money = money;
  return Dialogue;
})();
