/*
 * nlu.js  (natural language understanding)
 * ------
 * Turns what the user typed or said into structured information BrewBot
 * can act on. This is deliberately simple and rule based: it looks for menu
 * words, numbers, times and a short list of commands. No AI service is
 * used, so it is fast, predictable and easy to explain.
 *
 * The main function is BB.NLU.understand(text, currentSlot, now). It returns:
 *   values       slot values found, e.g. { size: 'large', milk: 'oat' }
 *   extras       list of extra ids found, e.g. ['vanilla', 'shot']
 *   conflicts    a slot heard with two different values, e.g. { size: ['medium','large'] }
 *   unsupported  items we don't sell that were mentioned
 *   command      'restart' | 'back' | 'repeat' | 'pause' | 'help' | 'change' | null
 *   changeSlot   which slot the user wants to change (with command 'change')
 *   yes / no     true when the message is a yes or no answer
 *   correction   true when words like "actually" or "instead" are used
 *   vagueCoffee  user said "coffee" without saying which kind
 *   privacy      user shared something sensitive (phone, email, card number)
 */
window.BB = window.BB || {};

BB.NLU = (function () {
  var NUMBER_WORDS = {
    'a': 1, 'an': 1, 'one': 1, 'single': 1, 'two': 2, 'couple': 2, 'pair': 2, 'three': 3, 'four': 4,
    'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
    'eleven': 11, 'twelve': 12, 'dozen': 12, 'fifteen': 15, 'twenty': 20
  };
  // Words speech recognition sometimes hears instead of numbers.
  // Only used when BrewBot has just asked "how many?".
  var SOUNDALIKE_NUMBERS = { 'to': 2, 'too': 2, 'for': 4, 'won': 1, 'fore': 4, 'tree': 3, 'free': 3 };

  /* Lower-case, tidy punctuation and spacing so matching is easier. */
  function normalize(text) {
    return (' ' + String(text || '').toLowerCase() + ' ')
      .replace(/[’`]/g, "'")
      .replace(/a\.m\./g, 'am').replace(/p\.m\./g, 'pm')
      .replace(/[!?,;"()]/g, ' ')
      .replace(/\.(\s|$)/g, ' ')
      .replace(/\s+/g, ' ');
  }

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /*
   * Build one list of every phrase we know (menu items AND unsupported
   * items), longest first. Matching longest phrases first means
   * "chai tea" is not also counted as "tea", and "whipped cream" is not
   * mistaken for the unsupported "cream".
   */
  var PHRASES = (function () {
    var list = [];
    Object.keys(BB.MENU).forEach(function (slot) {
      BB.MENU[slot].forEach(function (opt) {
        opt.words.forEach(function (w) { list.push({ phrase: w, slot: slot, id: opt.id }); });
      });
    });
    Object.keys(BB.UNSUPPORTED).forEach(function (slot) {
      BB.UNSUPPORTED[slot].forEach(function (item) {
        item.words.forEach(function (w) { list.push({ phrase: w, slot: slot, unsupported: item }); });
      });
    });
    list.sort(function (a, b) { return b.phrase.length - a.phrase.length; });
    list.forEach(function (p) {
      p.re = new RegExp('(^|[^a-z0-9%])' + escapeRegex(p.phrase) + '(?=$|[^a-z0-9%])', 'g');
    });
    return list;
  })();

  /* Find every known phrase in the text. Matched words are blanked out. */
  function findPhrases(text) {
    var found = [];
    var working = text;
    var withoutUnsupported = text;
    PHRASES.forEach(function (p) {
      p.re.lastIndex = 0;
      if (p.re.test(working)) {
        found.push(p);
        var blank = function (m, pre) { return pre + ' '.repeat(m.length - pre.length); };
        p.re.lastIndex = 0;
        working = working.replace(p.re, blank);
        if (p.unsupported) { p.re.lastIndex = 0; withoutUnsupported = withoutUnsupported.replace(p.re, blank); }
      }
    });
    return { found: found, rest: working.replace(/\s+/g, ' ').trim(), withoutUnsupported: withoutUnsupported.replace(/\s+/g, ' ') };
  }

  /* Turn "2", "two", "a couple" etc. into a number. */
  function toNumber(token, allowSoundalikes) {
    if (/^\d+$/.test(token)) return parseInt(token, 10);
    if (NUMBER_WORDS.hasOwnProperty(token)) return NUMBER_WORDS[token];
    if (allowSoundalikes && SOUNDALIKE_NUMBERS.hasOwnProperty(token)) return SOUNDALIKE_NUMBERS[token];
    return null;
  }

  /*
   * Quantity. If BrewBot just asked "how many", any number counts.
   * Otherwise only a number right before a drink-related word counts
   * ("two large lattes"), so times like "3 pm" are not read as quantities.
   */
  function findQuantity(text, currentSlot) {
    var tokens = text.trim().split(' ');
    if (currentSlot === 'quantity') {
      if (/\b(just (one|me|myself)|only one|for me|for myself|myself|just me|only me)\b/.test(text)) return 1;
      for (var i = 0; i < tokens.length; i++) {
        var n = toNumber(tokens[i], tokens.length <= 3);
        if (n !== null && !(tokens[i] === 'a' || tokens[i] === 'an')) return n;
      }
      return null;
    }
    var drinkish = /^(small|medium|large|big|regular|hot|iced|ice|cold|oat|almond|skim|whole|latte|lattes|cappuccinos?|americanos?|mochas?|cold|chai|teas?|vanilla|caramel|of|more|cups?|drinks?|coffees?)$/;
    for (var j = 0; j < tokens.length - 1; j++) {
      var q = toNumber(tokens[j], false);
      if ((tokens[j] === 'a' || tokens[j] === 'an') && /^(couple|pair|dozen)$/.test(tokens[j + 1])) continue;
      if (q !== null) {
        for (var k = j + 1; k <= Math.min(j + 3, tokens.length - 1); k++) {
          if (drinkish.test(tokens[k])) return q;
        }
      }
    }
    return null;
  }

  var COMMANDS = [
    { name: 'slower',  re: /\b(slow down|(talk|speak|go|say it) (a bit |a little |more )?slow(er|ly)?|slower( please)?|too fast|more slowly)\b/ },
    { name: 'faster',  re: /\b(speed up|(talk|speak|go) (a bit |a little )?faster|faster( please)?|too slow|more quickly)\b/ },
    { name: 'restart', re: /\b(start over|start again|restart|reset|new order|another order|cancel( my| the| this)? order|cancel( it| that)?\s*$|clear (it|everything|the order))\b/ },
    { name: 'pause',   re: /\b(pause|hold on|one sec(ond)?|give me a (sec|second|minute|moment)|wait a (sec|second|minute|moment)|just a (sec|second|minute|moment))\b/ },
    { name: 'repeat',  re: /\b(repeat|say (that|it) again|what did you say|pardon|come again|didn'?t hear( you)?|one more time)\b/ },
    { name: 'back',    re: /^\s*(go )?back\s*$|\b(go back|previous question|last question|undo)\b/ },
    { name: 'help',    re: /\b(help|what can i (say|order|get)|what do you have|what are (my|the) options|show (me )?(the )?menu)\b|^\s*(menu|options)\s*$/ }
  ];

  var CHANGE_RE = /\b(change|edit|update|switch|fix|modify)\b(?:\s+(?:the|my|it|that))?(?:\s+(drink|size|temp(?:erature)?|hot or iced|milk|extras?|add[- ]?ons?|quantity|number|amount|how many|pickup(?: time)?|time|name|payment|pay(?:ing)?))?/;
  var CHANGE_SLOT_MAP = {
    drink: 'drink', size: 'size', temp: 'temp', temperature: 'temp', 'hot or iced': 'temp', milk: 'milk',
    extra: 'extras', extras: 'extras', 'add-on': 'extras', 'add on': 'extras', 'addon': 'extras', 'add-ons': 'extras', 'add ons': 'extras', 'addons': 'extras',
    quantity: 'quantity', number: 'quantity', amount: 'quantity', 'how many': 'quantity',
    pickup: 'pickup', 'pickup time': 'pickup', time: 'pickup', name: 'name', payment: 'payment', pay: 'payment', paying: 'payment'
  };

  var YES_RE = /^\s*(yes|yeah|yea|yep|yup|ya|sure|correct|right|that'?s (right|correct|it)|that is (right|correct)|confirm(ed)?|looks (good|great|right)|perfect|place (it|the order|my order)|ok(ay)?|sounds (good|great)|do it|absolutely|go ahead|all good|exactly)\b/;
  var NO_RE = /^\s*(no|nope|nah|not quite|not really|wrong|that'?s (wrong|not right)|incorrect|negative)\b/;
  var CORRECTION_RE = /\b(actually|instead|make (it|that|them)|change (it|that) to|i meant|i mean|no wait|switch (it|that) to|rather|not .+ but)\b/;

  /* Phone numbers, emails, addresses or card numbers are not needed. */
  function detectPrivacy(raw) {
    var digits = String(raw).replace(/[^0-9]/g, '');
    if (/@[a-z0-9-]+\./i.test(raw)) return 'email';
    if (digits.length >= 12) return 'card';
    if (digits.length >= 7 && /(\d[\s-]?){7,}/.test(raw)) return 'phone';
    if (/\b\d+\s+[a-z]+\s+(street|st|avenue|ave|road|rd|drive|dr|blvd|crescent|cres)\b/i.test(raw)) return 'address';
    return null;
  }

  /*
   * Understand a pickup time.
   * Returns { asap: true } | { time: Date } | { error: 'too_soon'|'closed'|'not_open'|'unclear' }
   */
  function parseTime(text, now) {
    now = now || new Date();
    var t = normalize(text);
    if (/\b(asap|a s a p|as soon as (possible|you can)|right now|now|soon|right away|whenever|earliest|quick(ly)?|immediately|straight away|ready)\b/.test(t)) {
      return { asap: true };
    }
    var m = t.match(/\bin (?:about |around )?(\d+|a|an|half an?|one|two|five|ten|fifteen|twenty|thirty|forty|forty five|forty-five|sixty)\s*(minutes?|mins?|hours?|hrs?)\b/);
    if (m) {
      var word = m[1];
      var amount = /^\d+$/.test(word) ? parseInt(word, 10)
        : ({ 'a': 1, 'an': 1, 'one': 1, 'two': 2, 'five': 5, 'ten': 10, 'fifteen': 15, 'twenty': 20, 'thirty': 30, 'forty': 40, 'forty five': 45, 'forty-five': 45, 'sixty': 60 })[word];
      if (/^half/.test(word)) { amount = 30; m[2] = 'minutes'; }
      var minutes = /^h/.test(m[2]) ? amount * 60 : amount;
      return validateTime(new Date(now.getTime() + minutes * 60000), now);
    }
    if (/\bhalf an hour\b/.test(t)) return validateTime(new Date(now.getTime() + 30 * 60000), now);
    if (/\b(noon|midday|12 noon)\b/.test(t)) return validateTime(atTime(now, 12, 0), now);

    var hour = null, min = 0, ampm = null;
    var clock = t.match(/\b(\d{1,2})(?::|\s)(\d{2})\s*(am|pm)?\b/) || t.match(/\b(\d{1,2})\s*(am|pm)\b/) || t.match(/\b(?:at|by|around|for)\s+(\d{1,2})\b/);
    if (clock) {
      hour = parseInt(clock[1], 10);
      if (clock[2] && /^\d{2}$/.test(clock[2])) { min = parseInt(clock[2], 10); ampm = clock[3] || null; }
      else if (clock[2]) { ampm = clock[2]; }
    } else {
      var words = t.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?: (thirty|fifteen|forty five|forty-five|o'?clock))?\s*(am|pm)?\b/);
      if (words && (words[2] || words[3] || /\b(at|by|around)\b/.test(t))) {
        hour = NUMBER_WORDS[words[1]];
        min = words[2] === 'thirty' ? 30 : words[2] === 'fifteen' ? 15 : /forty/.test(words[2] || '') ? 45 : 0;
        ampm = words[3] || null;
      }
    }
    if (hour === null || hour > 23 || min > 59) return { error: 'unclear' };
    if (/half past/.test(t)) min = 30;
    if (/quarter past/.test(t)) min = 15;

    var candidate;
    if (ampm === 'pm' && hour < 12) candidate = atTime(now, hour + 12, min);
    else if (ampm === 'am' && hour === 12) candidate = atTime(now, 0, min);
    else if (ampm || hour > 12) candidate = atTime(now, hour, min);
    else {
      // No am/pm given: pick whichever of am/pm makes sense today.
      var am = atTime(now, hour === 12 ? 12 : hour, min);
      var pm = atTime(now, hour === 12 ? 12 : hour + 12, min);
      var earliest = new Date(now.getTime() + BB.SHOP.prepMinutes * 60000 - 60000);
      candidate = (am >= earliest && hour >= BB.SHOP.opensAt) ? am : pm;
    }
    return validateTime(candidate, now);
  }

  function atTime(now, h, m) {
    var d = new Date(now.getTime());
    d.setHours(h, m, 0, 0);
    return d;
  }

  function validateTime(d, now) {
    var earliest = new Date(now.getTime() + (BB.SHOP.prepMinutes - 1) * 60000);
    if (d < earliest) return { error: 'too_soon', time: d };
    if (d.getHours() < BB.SHOP.opensAt) return { error: 'not_open', time: d };
    if (d.getHours() > BB.SHOP.closesAt || (d.getHours() === BB.SHOP.closesAt && d.getMinutes() > 0)) return { error: 'closed', time: d };
    if (d.toDateString() !== now.toDateString()) return { error: 'closed', time: d };
    return { time: d };
  }

  /* Pull a first name out of answers like "it's Maya" or "my name is Maya Patel". */
  function parseName(raw) {
    var t = String(raw).trim().replace(/[.!?,]+$/g, '');
    t = t.replace(/^(hi|hey|hello)[, ]+/i, '')
      .replace(/^(my name is|my name's|name is|name's|it's|it is|i'm|i am|im|this is|call me|put it under|under|you can call me|the name is|for)\s+/i, '')
      .replace(/^(the name|name)\s+/i, '');
    var parts = t.split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    var first = parts[0].replace(/[^A-Za-zÀ-ÿ'-]/g, '');
    if (first.length < 2 || first.length > 20) return null;
    if (/^(no|yes|nope|yeah|okay|ok|what|why|um|uh|hmm|the|a|an|i|me|my|and|is)$/i.test(first)) return null;
    return {
      name: first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(),
      hadLastName: parts.length > 1 && /^[A-Za-z'-]+$/.test(parts[1])
    };
  }

  /*
   * Short answers that speech recognition often mishears. Only used when the
   * WHOLE answer is one of these (e.g. someone says "tea" and it hears "T").
   * Some only apply to the question being asked, so "hole" is "whole" only
   * when BrewBot asked about milk.
   */
  var SOUNDALIKES = {
    any: { 't': 'tea', 'tee': 'tea', 'tees': 'tea', 'tease': 'tea', 'ti': 'tea', 'chi': 'chai', 'shy': 'chai', 'chy': 'chai',
      'lottie': 'latte', 'lotty': 'latte', 'la tay': 'latte', 'la te': 'latte', 'mocker': 'mocha', 'moca': 'mocha', 'mocca': 'mocha',
      'americana': 'americano', 'cold blue': 'cold brew', 'coal brew': 'cold brew', 'cold bru': 'cold brew' },
    size: { 'mall': 'small', 'smoll': 'small', 'lodge': 'large', 'larch': 'large', 'barge': 'large', 'medium.': 'medium', 'median': 'medium' },
    temp: { 'hut': 'hot', 'hat': 'hot', 'heart': 'hot', 'eyes': 'iced', 'ist': 'iced', 'ice tea': 'iced', 'iced.': 'iced', 'nice': 'iced', 'i st': 'iced' },
    milk: { 'oath': 'oat', 'out': 'oat', 'oats': 'oat', 'oat meal': 'oat', 'oatmeal': 'oat', 'out milk': 'oat milk', 'old milk': 'oat milk',
      'all men': 'almond', 'all mint': 'almond', 'almonds': 'almond', 'skin': 'skim', 'skin milk': 'skim milk', 'hole': 'whole', 'hole milk': 'whole milk', 'whole meal': 'whole milk' },
    payment: { 'car': 'card', 'cart': 'card', 'cards': 'card', 'catch': 'cash', 'cache': 'cash' },
    quantity: { 'won': '1', 'to': '2', 'too': '2', 'for': '4', 'fore': '4', 'tree': '3', 'free': '3', 'sex': '6', 'ate': '8' }
  };

  function fixSoundalike(text, currentSlot) {
    var t = text.trim().replace(/\s+/g, ' ');
    if (currentSlot && SOUNDALIKES[currentSlot] && SOUNDALIKES[currentSlot][t]) return ' ' + SOUNDALIKES[currentSlot][t] + ' ';
    if ((currentSlot === 'drink' || !currentSlot) && SOUNDALIKES.any[t]) return ' ' + SOUNDALIKES.any[t] + ' ';
    if (currentSlot !== 'name' && currentSlot !== 'pickup' && SOUNDALIKES.any[t] && t.length > 2) return ' ' + SOUNDALIKES.any[t] + ' ';
    return text;
  }

  function understand(rawText, currentSlot, now) {
    var text = fixSoundalike(normalize(rawText), currentSlot);
    var result = {
      raw: rawText, text: text.trim(),
      values: {}, extras: [], conflicts: {}, unsupported: [],
      command: null, changeSlot: null, yes: false, no: false,
      correction: false, vagueCoffee: false, privacy: detectPrivacy(rawText),
      time: null
    };

    // Commands (start over, pause, repeat, back, help)
    for (var c = 0; c < COMMANDS.length; c++) {
      if (COMMANDS[c].re.test(text.trim())) { result.command = COMMANDS[c].name; break; }
    }
    var change = text.match(CHANGE_RE);
    if (change && !result.command) {
      result.command = 'change';
      result.changeSlot = change[2] ? CHANGE_SLOT_MAP[change[2].replace(/-/g, ' ').trim()] || CHANGE_SLOT_MAP[change[2]] || null : null;
    }
    result.yes = YES_RE.test(text);
    result.no = NO_RE.test(text) && !result.yes;
    result.correction = CORRECTION_RE.test(text);

    // Pickup time is only looked for when it is being asked about, or when
    // the message clearly contains a time ("at 3 pm", "in 20 minutes").
    var looksLikeTime = /\b(\d{1,2}(:\d{2})?\s*(am|pm)|in \d+ ?(min|minutes|hours?)|asap|as soon as possible|noon|half an hour)\b/.test(text);
    if (currentSlot === 'pickup' || looksLikeTime) {
      var time = parseTime(text, now);
      if (!time.error || currentSlot === 'pickup') result.time = time;
    }

    // Menu words
    var scan = findPhrases(text);
    scan.found.forEach(function (p) {
      if (p.unsupported) { result.unsupported.push({ slot: p.slot, item: p.unsupported }); return; }
      if (p.slot === 'extras') {
        if (result.extras.indexOf(p.id) === -1) result.extras.push(p.id);
        return;
      }
      if (p.slot === 'payment' && currentSlot !== 'payment' && !/\b(pay|paying)\b/.test(text)) return;
      var existing = result.values[p.slot];
      if (existing && existing !== p.id) {
        result.conflicts[p.slot] = (result.conflicts[p.slot] || [existing]).concat(p.id)
          .filter(function (v, i, a) { return a.indexOf(v) === i; });
      } else {
        result.values[p.slot] = p.id;
      }
    });
    Object.keys(result.conflicts).forEach(function (slot) { delete result.values[slot]; });

    // "none" / "no" means no milk or no extras when that is the question.
    var bareNo = /^\s*(no|none|nothing|nope|no thanks|no thank you|nah|that'?s (it|all)|i'?m good|all good|skip|neither)\s*$/.test(text);
    if (bareNo && currentSlot === 'milk') { result.values.milk = 'none'; result.no = false; }
    if (bareNo && currentSlot === 'extras') { result.extras = ['none']; result.no = false; }
    if (result.extras.length > 1) result.extras = result.extras.filter(function (e) { return e !== 'none'; });

    // "coffee" on its own does not say which drink
    if (!result.values.drink && !result.conflicts.drink && /\bcoffees?\b/.test(text)) result.vagueCoffee = true;

    var qty = findQuantity(scan.withoutUnsupported, currentSlot);
    if (qty !== null) result.values.quantity = qty;

    // Bare "change" or "back" inside a sentence with real values is a correction, not a command.
    if (result.command === 'change' && !result.changeSlot && Object.keys(result.values).length) {
      result.command = null; result.correction = true;
    }
    return result;
  }

  /* True if anything usable for the order was found. */
  function hasOrderInfo(r) {
    return Object.keys(r.values).length > 0 || r.extras.length > 0 || !!(r.time && !r.time.error);
  }

  return {
    understand: understand,
    parseTime: parseTime,
    parseName: parseName,
    hasOrderInfo: hasOrderInfo,
    normalize: normalize
  };
})();
