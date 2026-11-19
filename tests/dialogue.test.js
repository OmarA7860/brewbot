/*
 * Automated checks for the conversation logic (no browser needed).
 * Run with:  node tests/dialogue.test.js
 * Each scenario matches one of the "Minimum Conversation Test Cases"
 * in the project outline, plus a few extra edge cases.
 */
global.window = global;
require('../js/menu.js');
require('../js/nlu.js');
require('../js/dialogue.js');

var FIXED_NOW = new Date(2026, 10, 27, 14, 20, 0); // Nov 27, 2:20 pm
var passed = 0, failed = 0;

function run(name, steps, checks) {
  var d = new BB.Dialogue({ now: function () { return FIXED_NOW; } });
  var log = [];
  var r = d.start();
  log.push('BOT: ' + r.text);
  steps.forEach(function (s) {
    var input = typeof s === 'string' ? { text: s, mode: 'text' } : s;
    log.push('USER (' + input.mode + '): ' + input.text);
    r = input.action ? d[input.action](input.arg) : d.handle(input.text, input);
    log.push('BOT [' + r.outcome + ']: ' + r.text);
  });
  var problems = checks(d, r);
  if (problems.length) {
    failed++;
    console.log('\nFAIL  ' + name + '\n  ' + problems.join('\n  ') + '\n  ' + log.join('\n  '));
  } else {
    passed++;
    console.log('\nPASS  ' + name + '\n  ' + log.join('\n  '));
  }
}

function expect(cond, msg, list) { if (!cond) list.push(msg); }

// 1. Normal completion
run('Normal completion', ['Latte', 'Medium', 'Hot', 'Oat milk', 'Vanilla syrup', '1', 'As soon as possible', 'Maya', 'Card at pickup', 'Yes, place my order'], function (d, r) {
  var p = [];
  expect(d.phase === 'done', 'order should be placed', p);
  expect(r.outcome === 'completed', 'last outcome should be completed', p);
  expect(d.order.milk === 'oat' && d.order.extras[0] === 'vanilla', 'milk/extras saved', p);
  return p;
});

// 2. Several answers at once
run('Several details in one sentence', ['Two large iced oat lattes with vanilla please'], function (d, r) {
  var p = [];
  expect(d.order.quantity === 2 && d.order.size === 'large' && d.order.temp === 'iced' && d.order.milk === 'oat' && d.order.drink === 'latte', 'all five slots filled', p);
  expect(d.current === 'pickup', 'should ask pickup next, got ' + d.current, p);
  return p;
});

// 3. Missing information
run('Missing information', ['I want a latte'], function (d, r) {
  var p = [];
  expect(d.order.drink === 'latte', 'drink saved', p);
  expect(d.current === 'size', 'should ask for size', p);
  return p;
});

// 4. Invalid answer
run('Invalid answer (not on menu)', ['Can I get a hot chocolate'], function (d, r) {
  var p = [];
  expect(r.outcome === 'unsupported', 'should be unsupported, got ' + r.outcome, p);
  expect(/mocha/i.test(r.text), 'should suggest mocha', p);
  expect(d.current === 'drink', 'still asking drink', p);
  return p;
});
run('Invalid size', ['Latte', 'extra large'], function (d, r) {
  var p = [];
  expect(r.outcome === 'unsupported' && /large is our biggest/i.test(r.text), 'explain sizes', p);
  return p;
});
run('Invalid milk', ['Latte', 'Large', 'Hot', 'soy milk'], function (d, r) {
  var p = [];
  expect(/oat or almond/i.test(r.text), 'suggest oat or almond', p);
  return p;
});
run('Quantity too high', ['Latte', 'Large', 'Hot', 'Whole', 'No extras', '25'], function (d, r) {
  var p = [];
  expect(/up to 10/.test(r.text) && d.current === 'quantity', 'limit explained', p);
  return p;
});

// 5. Ambiguous answer
run('Ambiguous size', ['Latte', 'medium large'], function (d, r) {
  var p = [];
  expect(r.outcome === 'clarify' && /medium and large/i.test(r.text), 'asks medium or large', p);
  return p;
});
run('Ambiguous size, then choose', ['Latte', 'medium or large', 'large'], function (d, r) {
  var p = [];
  expect(d.order.size === 'large' && d.current === 'temp', 'large saved, next temp', p);
  return p;
});
run('Vague "coffee"', ['just a coffee'], function (d, r) {
  var p = [];
  expect(r.outcome === 'clarify' && /which kind of coffee/i.test(r.text), 'asks which coffee', p);
  return p;
});
run('Vague "iced coffee"', ['an iced coffee please'], function (d, r) {
  var p = [];
  expect(d.order.temp === 'iced' && /which kind of coffee/i.test(r.text), 'keeps iced and asks which coffee', p);
  return p;
});

// 6. Correction without restarting
run('Correction mid-order', ['Latte', 'Large', 'Iced', 'Oat milk', 'actually make it almond milk'], function (d, r) {
  var p = [];
  expect(d.order.milk === 'almond', 'milk changed', p);
  expect(r.outcome === 'correction' && /from oat milk to almond milk/i.test(r.text), 'change acknowledged', p);
  expect(d.order.size === 'large' && d.order.drink === 'latte', 'other answers kept', p);
  expect(d.current === 'extras', 'continues where it was', p);
  return p;
});
run('Change from confirmation', ['Two large iced oat lattes', 'No extras', 'ASAP', 'Maya', 'Cash', 'No', 'Change size', 'Medium'], function (d, r) {
  var p = [];
  expect(d.order.size === 'medium' && d.phase === 'confirm', 'size changed and back at confirm', p);
  return p;
});
run('Change via Edit link', ['Latte', 'Large', 'Hot', 'Whole', 'No extras', { action: 'startChange', arg: 'size', text: '(Edit size)' }, 'Small'], function (d, r) {
  var p = [];
  expect(d.order.size === 'small' && d.current === 'quantity', 'size changed, resumes at quantity', p);
  return p;
});
run('Go back', ['Latte', 'Large', 'back'], function (d, r) {
  var p = [];
  expect(d.current === 'size' && d.order.size === null, 'back to size', p);
  return p;
});

// 7. Voice recognition problem
run('Voice: misheard text', [{ text: 'lots of plates', mode: 'voice', confidence: 0.4 }], function (d, r) {
  var p = [];
  expect(r.outcome === 'not_understood' && r.heardCheck, 'shows what was heard with retry', p);
  expect(/I heard/.test(r.text), 'says what it heard', p);
  return p;
});
run('Voice: second guess used', [{ text: 'a lot day', mode: 'voice', alternatives: ['a latte'] }], function (d, r) {
  var p = [];
  expect(d.order.drink === 'latte', 'uses alternative', p);
  return p;
});
run('Voice: nothing heard', [{ action: 'voiceProblem', arg: 'no-speech', text: '(silence)' }], function (d, r) {
  var p = [];
  expect(/didn.t hear anything/.test(r.text), 'no speech message', p);
  return p;
});

// 8. Final confirmation
run('Final confirmation summary', ['Two large iced oat lattes with vanilla', 'in 20 minutes', 'my name is Maya Patel', 'card'], function (d, r) {
  var p = [];
  expect(d.phase === 'confirm', 'at confirmation', p);
  expect(/2 large iced lattes with oat milk and vanilla syrup/.test(r.text), 'summary has drink: ' + r.text, p);
  expect(/2:40 pm/.test(r.text) && /Maya/.test(r.text) && /card/.test(r.text) && /\$/.test(r.text), 'summary has time, name, payment, total', p);
  expect(d.order.name === 'Maya', 'first name only', p);
  return p;
});

// Extra edge cases
run('Cold brew is always iced', ['cold brew'], function (d, r) {
  var p = [];
  expect(d.order.temp === 'iced' && d.current === 'size', 'auto iced', p);
  return p;
});
run('Pickup too soon', ['Latte', 'Small', 'Hot', 'Whole', 'No extras', '1', 'at 2:25 pm'], function (d, r) {
  var p = [];
  expect(/too soon/.test(r.text) && d.current === 'pickup', 'too soon explained', p);
  return p;
});
run('Pickup after closing', ['Latte', 'Small', 'Hot', 'Whole', 'No extras', '1', '10 pm'], function (d, r) {
  var p = [];
  expect(/close at 9/.test(r.text), 'closing time explained', p);
  return p;
});
run('Privacy: card number', ['Latte', 'Small', 'Hot', 'Whole', 'No extras', '1', 'ASAP', 'Sam', '4520 1234 5678 9012'], function (d, r) {
  var p = [];
  expect(/don.t share card numbers/.test(r.text) && d.order.payment === null, 'card number refused', p);
  return p;
});
run('Privacy: phone number for name', ['Latte', 'Small', 'Hot', 'Whole', 'No extras', '1', 'ASAP', '905 555 1234'], function (d, r) {
  var p = [];
  expect(/don.t need your phone/.test(r.text) && d.order.name === null, 'phone refused', p);
  return p;
});
run('Start over asks first', ['Latte', 'Large', 'start over', 'yes'], function (d, r) {
  var p = [];
  expect(d.order.drink === null && d.current === 'drink', 'cleared', p);
  return p;
});
run('Not understood twice gives buttons tip', ['blah', 'qwerty'], function (d, r) {
  var p = [];
  expect(/tap one of the buttons/.test(r.text), 'tip after 2 fails', p);
  return p;
});
run('Add extra later', ['Latte', 'Large', 'Hot', 'Whole', 'Vanilla', '1', 'add whipped cream too'], function (d, r) {
  var p = [];
  expect(d.order.extras.join() === 'vanilla,whip', 'extras merged: ' + d.order.extras, p);
  return p;
});
run('Help', ['Latte', 'help'], function (d, r) {
  var p = [];
  expect(r.outcome === 'help' && /small, medium and large/i.test(r.text), 'help lists options', p);
  return p;
});

run('Stray word does not silently change an earlier answer', ['Latte', 'Large', 'Iced', 'Oat', 'No extras', '2', { text: 'tea', mode: 'voice' }], function (d, r) {
  var p = [];
  expect(d.order.drink === 'latte' && /change the drink from latte to tea/.test(r.text), 'asks before changing', p);
  return p;
});
run('...and changes it when the user says yes', ['Latte', 'Large', 'Iced', 'Oat', 'No extras', '2', { text: 'tea', mode: 'voice' }, 'yes'], function (d, r) {
  var p = [];
  expect(d.order.drink === 'tea' && d.current === 'pickup', 'changed after yes', p);
  return p;
});
run('Misheard time stays on the time question', ['Two large iced oat lattes', 'No extras', { text: 'in tree tea minutes', mode: 'voice', confidence: 0.4 }], function (d, r) {
  var p = [];
  expect(d.order.drink === 'latte' && /I heard/.test(r.text) && /catch the time/.test(r.text) && r.heardCheck, 'time problem with heard text', p);
  return p;
});

// Fixes from hands-on testing by our group
run('Speech hears "tea" as the letter T', [{ text: 'T.', mode: 'voice' }], function (d, r) {
  var p = [];
  expect(d.order.drink === 'tea', 'T. understood as tea, got ' + d.order.drink, p);
  return p;
});
run('Quantity buttons go up to 10', ['Latte', 'Large', 'Hot', 'Whole', 'No extras'], function (d, r) {
  var p = [];
  expect(r.quick.length === 10 && r.quick[9].value === '10', 'ten quantity buttons', p);
  return p;
});
run('Pickup example time follows the clock', ['Latte', 'Large', 'Hot', 'Whole', 'No extras', '1'], function (d, r) {
  var p = [];
  expect(/like 3:00 pm/.test(r.text) && !/3:30/.test(r.text), 'example is about 40 min ahead: ' + r.text, p);
  expect(r.quick.some(function (q) { return q.value === 'At 3:00 pm'; }), 'example time has a button', p);
  return p;
});
run('Name by voice is confirmed first', ['Latte', 'Large', 'Hot', 'Whole', 'No extras', '1', 'ASAP', { text: 'Omar', mode: 'voice' }], function (d, r) {
  var p = [];
  expect(d.order.name === null && /I heard Omar. Is that right/.test(r.text), 'asks to confirm', p);
  return p;
});
run('...and saved after yes', ['Latte', 'Large', 'Hot', 'Whole', 'No extras', '1', 'ASAP', { text: 'Omar', mode: 'voice' }, 'Yes'], function (d, r) {
  var p = [];
  expect(d.order.name === 'Omar' && d.current === 'payment', 'name saved', p);
  return p;
});
run('...or typed after no', ['Latte', 'Large', 'Hot', 'Whole', 'No extras', '1', 'ASAP', { text: 'Omar', mode: 'voice' }, 'No, I will type it', 'Omer'], function (d, r) {
  var p = [];
  expect(d.order.name === 'Omer', 'typed name saved: ' + d.order.name, p);
  return p;
});
run('Background noise is not taken as a name', ['Latte', 'Large', 'Hot', 'Whole', 'No extras', '1', 'ASAP', { text: 'yeah so then he said we should go', mode: 'voice' }], function (d, r) {
  var p = [];
  expect(d.order.name === null && /background noise/.test(r.text) && r.focusInput, 'noise caught', p);
  return p;
});

run('Voice speed by voice command', ['Latte', 'slow down please'], function (d, r) {
  var p = [];
  expect(r.speed === 'slower' && r.outcome === 'speed' && d.current === 'size', 'slower and keeps asking size', p);
  return p;
});
run('Order placed records the time for the tracker', ['Latte', 'Small', 'Hot', 'Whole', 'No extras', '1', 'ASAP', 'Sam', 'Cash', 'yes'], function (d, r) {
  var p = [];
  expect(d.placed && d.placed.placedAt && d.placed.ready - d.placed.placedAt === 10 * 60000, 'ready 10 min after placing', p);
  return p;
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
