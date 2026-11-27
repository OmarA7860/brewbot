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

  /* Every single word that appears in a menu or "we don't have" phrase. */
  var KNOWN_WORDS = (function () {
    var set = {};
    PHRASES.forEach(function (p) { p.phrase.split(/\s+/).forEach(function (w) { set[w] = true; }); });
    ('a an the my your one two three four five six seven eight nine ten some any another same usual nice good normal plain simple ' +
     'just like want get have of and or with me i please that this can could would i\'d i\'ll it is my our big hot iced ice cold ' +
     'warm medium small large regular extra double single quick tall fancy special fresh new favourite favorite ' +
     'skinny light sweet sweetened unsweetened strong weak half whole morning afternoon second first last more less make made ' +
     'do you guys have sell is there them those these what which how much 2 3 4 5 6 7 8 9 10 1').split(' ').forEach(function (w) { set[w] = true; });
    return set;
  })();
  var DRINK_HINTS = {
    latte: 'we have lattes with vanilla or caramel syrup', lattes: 'we have lattes with vanilla or caramel syrup',
    tea: 'we have green tea, black tea, earl grey and herbal tea', teas: 'we have green tea, black tea, earl grey and herbal tea',
    coffee: 'we have lattes, cappuccinos, americanos, mochas and cold brew', cappuccino: 'we have regular cappuccinos',
    americano: 'we have regular americanos', mocha: 'we have regular mochas', chai: 'we have a chai latte'
  };
  function findUnknownDrink(text) {
    var re = /\b([a-z][a-z']+) (lattes?|teas?|coffee|cappuccino|americano|mocha)\b/g, m;
    while ((m = re.exec(text))) {
      if (KNOWN_WORDS[m[1]] || /ing$|ed$/.test(m[1]) && KNOWN_WORDS[m[1].replace(/(ing|ed)$/, '')]) continue;
      var label = m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2].replace(/s$/, '');
      return { phrase: m[0], item: { name: /^[aeiou]/i.test(label) ? 'an ' + label : 'a ' + label, hint: DRINK_HINTS[m[2]] || 'we have lattes, cappuccinos, americanos, mochas, cold brew, chai lattes and tea',
        offer: /latte/.test(m[2]) ? 'latte' : null, offerLabel: /latte/.test(m[2]) ? 'a regular latte' : null } };
    }
    return null;
  }

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
    if (hour === null) {
      // Speech often writes 9:35 as "935" (or "1130").
      var compact = t.match(/^\s*(?:(?:at|around|by|for|maybe|um|uh|like)\s+)*(\d{1,2})(\d{2})\s*(am|pm)?\s*$/) ||
        t.match(/\b(?:at|around|by)\s+(\d{1,2})(\d{2})\s*(am|pm)?\b/);
      if (compact) { hour = parseInt(compact[1], 10); min = parseInt(compact[2], 10); ampm = compact[3] || null; }
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
    if (d < now) return { error: 'passed', time: d };
    if (d < earliest) return { error: 'too_soon', time: d };
    if (d.getHours() < BB.SHOP.opensAt) return { error: 'not_open', time: d };
    if (d.getHours() > BB.SHOP.closesAt || (d.getHours() === BB.SHOP.closesAt && d.getMinutes() > 0)) return { error: 'closed', time: d };
    if (d.toDateString() !== now.toDateString()) return { error: 'closed', time: d };
    return { time: d };
  }

  /*
   * Pull a first name out of answers like "it's Maya", "my name is Maya Patel",
   * "put Sam as the first name" or "just Sam". Returns null for words that
   * are clearly not a name ("that's correct", "yes").
   */
  var NOT_A_NAME = /^(no|yes|yeah|yep|nope|okay|ok|sure|right|correct|that's|thats|that|this|it|it's|its|what|why|how|um|uh|hmm|the|a|an|i|me|my|and|is|just|put|please|thanks|thank|hello|hi|hey|can|could|would|i'd|i'll|we|you|they|he|she|name|first|sorry|wait|so|well|like|um|oh|for|under|as|to|be|do|not)$/i;
  function parseName(raw) {
    var t = String(raw).trim().replace(/[.!?,]+$/g, '').replace(/\s+/g, ' ');
    // "I've been watching YouTube, put the name Samantha": keep what comes after the LAST name cue.
    var cue = /\b(put the name|put down the name|the name is|name is|name's|my name is|call me|put it under|under the name|put down|put)\s+/gi, m, last = -1;
    while ((m = cue.exec(t))) last = cue.lastIndex;
    if (last > 0 && last < t.length) t = t.slice(last);
    t = t.replace(/^((hi|hey|hello|um|uh|so|okay|ok|oh|yeah|sure)[, ]+)+/i, '');
    // endings: "... as the first name", "... for the name", "... please"
    t = t.replace(/\s+(as|for|on|under)\s+(the|my|your|our)?\s*(first\s+)?name\b.*$/i, '')
      .replace(/\s+(on it|on the order|for the order|on the cup|please|thanks|thank you)$/i, '');
    // beginnings: "put", "just", "my name is", "can you put it under" ...
    var LEAD = /^(can you|could you|you can|please|just|only|put|write|use|make it|name it|call it|put down|put it under|put it down as|it's under|it is under|under|it's for|it is for|for|my first name is|first name is|my first name's|my name is|my name's|name is|name's|the name is|the name's|it's|it is|i'm|i am|im|this is|call me|you can call me|the name|name|first name|down as|as|it)\s+/i;
    for (var i = 0; i < 4 && LEAD.test(t); i++) t = t.replace(LEAD, '');
    var parts = t.split(/\s+/).filter(Boolean).map(function (p) { return p.replace(/[^A-Za-zÀ-ÿ'-]/g, ''); }).filter(Boolean);
    // "Sam Sam" (heard twice) is one name
    parts = parts.filter(function (p, i) { return i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase(); });
    if (!parts.length) return null;
    var first = parts[0];
    if (first.length < 2 || first.length > 20 || NOT_A_NAME.test(first)) return null;
    var lower = ' ' + first.toLowerCase() + ' ';
    if (PHRASES.some(function (p) { p.re.lastIndex = 0; return p.phrase.indexOf(' ') === -1 && p.re.test(lower); })) return null;
    return {
      name: first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(),
      hadLastName: parts.length > 1 && /^[A-Za-z'-]+$/.test(parts[1]) && !NOT_A_NAME.test(parts[1]),
      words: parts.length
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

  /* Phrases that mean something different from their separate words. */
  function rephrase(t) {
    return t
      // common mishearings of "Spanish latte"
      .replace(/\bspanish (law|laws|lot|lotte|lottie|lotty|la tay|late|lady|light)\b/g, 'spanish latte')
      // "a shot / pump / splash of vanilla" is syrup, not an extra espresso shot
      .replace(/\b(?:an? |one |two |a couple of |some )?(?:shots?|pumps?|splash(?:es)?|dash(?:es)?|squirts?) of (vanilla|caramel)(?: syrup)?\b/g, ' $1 syrup ')
      // "a shot of espresso" is an extra shot
      .replace(/\b(?:an? |one )?(?:shots?) of espresso\b/g, ' extra shot ');
  }

  /*
   * Typos ("cofeee", "vanills", "lstte", "dyrup"): a word that isn't known is
   * replaced by a menu word that is one or two letters away. Names are never
   * changed, and short words are left alone so "hat" doesn't become "hot".
   */
  var VOCAB = (function () {
    var set = {};
    PHRASES.forEach(function (p) { p.phrase.split(/\s+/).forEach(function (w) { if (/^[a-z]{4,}$/.test(w)) set[w] = true; }); });
    'coffee syrup with milk please large medium small iced cappuccino americano'.split(' ').forEach(function (w) { set[w] = true; });
    return Object.keys(set);
  })();
  var COMMON = /^(back|help|stop|menu|undo|redo|over|again|wait|hold|done|pause|start|reset|restart|slow|slower|fast|faster|repeat|cancel|skip|next|plain|cool|fine|same|both|either|neither|first|second|last|call|take|keep|hard|easy|best|most|love|mine|ours|work|home|late|early|hello|black|blank|bake|lack|track|bank|park|mark|mike|told|tell|said|says|went|gone|come|came|look|went|play|play|game|food|free|full|half|zero|four|five|nine|eight|seven|three|twelve|eleven|twenty|thirty|forty|fifty|hundred|dollar|dollars|cents|price|prices|cost|order|orders|drink|drinks|coffee|coffees|cream|sugar|honey|water|juice|thing|things|stuff|other|another|every|everything|nothing|something|anything|which|where|while|whole|watch|watching|youtube|phone|music|video|people|person|friend|guys|they're|we're|you're|it's|i'm|i've|can't|don't|won't|isn't|aren't|wasn't|weren't|with|have|give|want|would|could|like|please|thanks|that|this|what|when|just|make|order|their|there|they|them|then|than|from|your|some|more|less|much|many|time|name|pick|will|only|also|okay|yeah|sure|cash|card|none|actually|instead|change|minutes|hour|hours|soon|possible|thank|right|wrong|good|great|nice|maybe|well|about|around|after|before|today|tonight|morning|later|now|here|still|need|know|think|guess|really|sorry)$/;
  function distance(a, b) {
    var d = [], i, j;
    for (i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (j = 0; j <= b.length; j++) d[0][j] = j;
    for (i = 1; i <= a.length; i++) for (j = 1; j <= b.length; j++) {
      var cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  }
  function fixTypos(text, currentSlot) {
    if (currentSlot === 'name') return text;
    return text.replace(/[a-z]{4,}/g, function (w) {
      if (COMMON.test(w) || VOCAB.indexOf(w) !== -1 || KNOWN_WORDS[w]) return w;
      var best = null, bestD = 9;
      VOCAB.forEach(function (v) {
        if (Math.abs(v.length - w.length) > 2) return;
        var dd = distance(w, v);
        if (dd < bestD) { bestD = dd; best = v; }
      });
      var limit = w.length >= 7 ? 2 : 1;
      return best && bestD <= limit ? best : w;
    });
  }

  function understand(rawText, currentSlot, now) {
    var text = rephrase(fixSoundalike(' ' + fixTypos(normalize(rawText), currentSlot) + ' ', currentSlot));
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
    var looksLikeTime = /\b(\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}:\d{2}|in \d+ ?(min|minutes|hours?)|in (a|an|half an?|ten|fifteen|twenty|thirty) (minutes?|hour)|asap|as soon as possible|noon|half an hour|pick (it|them) up (at|in|around))\b/.test(text);
    // A bare "935" while being asked how many is a time (9:35), not 935 drinks.
    var bareClock = currentSlot === 'quantity' && /^\s*\d{3,4}\s*$/.test(text) && parseInt(text, 10) > BB.SHOP.maxQuantity * 10;
    if (currentSlot === 'pickup' || looksLikeTime || bareClock) {
      var time = parseTime(text, now);
      if (!time.error || currentSlot === 'pickup' || ((looksLikeTime || bareClock) && time.error !== 'unclear')) result.time = time;
    }

    // Drinks we've never heard of ("pistachio rose latte", "Amazon latte"):
    // say we don't have them instead of quietly ordering a plain latte.
    var generic = (currentSlot === 'pickup' || currentSlot === 'name' || currentSlot === 'quantity') && !/\b(do|does) (you|u)\b/.test(text) ? null : findUnknownDrink(text);
    if (generic) {
      result.unsupported.push({ slot: 'drink', item: generic.item });
      text = text.replace(generic.phrase, ' ');
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

    // Numbers that are part of a time ("in 20 minutes", "at 3:30", "3 pm") are not quantities.
    var noTimes = scan.withoutUnsupported
      .replace(/\b(in|for|about|around)?\s*\d+\s*(minutes?|mins?|hours?|hrs?)\b/g, ' ')
      .replace(/\b\d{1,2}(:\d{2})\s*(am|pm)?\b/g, ' ').replace(/\b\d{1,2}\s*(am|pm)\b/g, ' ')
      .replace(/\b(at|by|around)\s+\d{1,4}\b/g, ' ');
    var qty = bareClock ? null : findQuantity(noTimes, currentSlot);
    var articleOnly = qty === 1 && !/\b(one|1|single|just one|only one)\b/.test(text);
    if (qty !== null && !(articleOnly && (result.unsupported.length || !result.values.drink)) && !(articleOnly && currentSlot && currentSlot !== 'drink' && currentSlot !== 'quantity')) {
      result.values.quantity = qty;
    }

    // Talk around the order: small talk, price questions and asking for a suggestion.
    result.smalltalk = /^\s*(hi|hey|hello|hiya|good (morning|afternoon|evening)|yo|sup)\b.*\b(how are you|how's it going|hows it going|how are things|how you doing|how is your day|what's up|whats up)\b|^\s*(how are you|how's it going|hows it going|how you doing|what's up|whats up)\b/.test(text) ? 'howareyou'
      : /^\s*(hi|hey|hello|hiya|good (morning|afternoon|evening))\s*(there|brewbot|bot)?\s*$/.test(text) ? 'hello'
      : /^\s*(thanks|thank you|thx|cheers|ty)\b/.test(text) && !Object.keys(result.values).length ? 'thanks' : null;
    result.priceQuestion = /\b(how much|price|prices|cost|costs|expensive|cheap|cheapest|difference between|what's the difference|whats the difference)\b/.test(text);
    result.recommend = /\b(recommend|recommendation|suggest|suggestion|surprise me|what'?s (good|popular|best)|whats (good|popular|best)|most popular|what do (people|most people) (get|order)|your favou?rite|you pick|you choose|dealer'?s choice|up to you|(i )?don'?t (really )?know|not (really )?sure|no idea|can'?t decide|dunno|whatever you (think|recommend))\b/.test(text);

    // "No payment" / "I won't pay": explain instead of "didn't understand"
    result.refusePay = currentSlot === 'payment' && /\b(no|not|won'?t|don'?t|never|without)\b.*\b(pay|paying|payment)\b|\bfor free\b|\bfree\b/.test(text) && !result.values.payment;

    // "Do you have ...?" questions
    var avail = text.match(/\b(?:do|does|d'?) ?(?:you|u|ya|y'all)(?: guys| all)? (?:have|sell|make|serve|do|got|carry)\s+(?:an? |any |some |the )?([a-z' ]{2,40}?)\s*$/);
    if (avail) {
      result.availability = true;
      var known = Object.keys(result.values).length || result.extras.length;
      if (!known && !result.unsupported.length && !result.conflicts.drink) {
        var thing = avail[1].trim().replace(/\b(here|today|right now|please|guys)\b/g, '').trim();
        if (thing && thing.split(' ').length <= 4) {
          result.unsupported.push({ slot: 'drink', item: { name: thing.length <= 3 ? thing.toUpperCase() : thing, hint: 'we make lattes, cappuccinos, americanos, mochas, cold brew, chai lattes and tea' } });
        }
      }
    }

    // A name given while answering something else ("put Sam as the name")
    if (currentSlot !== 'name' && /\b(my name is|my name's|my first name is|as the (first )?name|as my (first )?name|for the name|under the name|name it|call me|the name is|the name's)\b/.test(text)) {
      var nm = parseName(rawText);
      if (nm && nm.words <= 2) result.name = nm.name;
    }

    // Asking for a second, different drink (we take one kind of drink per order)
    result.anotherDrink = /\b(another|second|2nd|different|separate|other) (drink|coffee|latte|tea|one|item|order of)\b|\badd (a|one) (drink|coffee)\b/.test(text) &&
      result.command !== 'restart';

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
