/*
 * preview.js
 * ----------
 * The live drink preview: a cartoon glass mug in the order panel that
 * "builds" the drink as the user answers.
 *
 *   drink     -> colour of the coffee or tea
 *   size      -> how big the mug is
 *   hot/iced  -> steam, or ice cubes + straw + condensation
 *   milk      -> a milky layer (iced: layered; hot: blended with foam)
 *   extras    -> extra shot (dark band), vanilla / caramel drizzle, whipped cream
 *   quantity  -> a "x2" badge
 *
 * Why (UX): people recognise a picture of their drink faster than they read
 * a list (recognition rather than recall), and every answer gets an instant,
 * visible result (feedback, visibility of system status). It also catches
 * mistakes early: an iced drink you wanted hot is obvious at a glance
 * (error prevention). The picture never carries meaning on its own: the
 * caption under it says the same thing in words, and the drawing has a text
 * description for screen readers.
 *
 * The SVG lives in index.html; this file only switches its parts on and off
 * and sets colours, so CSS transitions can animate each change.
 */
window.BB = window.BB || {};

BB.Preview = (function () {
  // Colours for each drink: base = the coffee/tea, mixed = blended with milk (hot)
  var DRINK = {
    latte:      { base: '#8a5a3b', mixed: '#c9a07a', foam: 'thin' },
    cappuccino: { base: '#7a4a2c', mixed: '#be946c', foam: 'thick' },
    americano:  { base: '#3b2214', mixed: '#8e6648', foam: 'none' },
    mocha:      { base: '#5a2e1c', mixed: '#9a6a52', foam: 'thin' },
    coldbrew:   { base: '#2e1a10', mixed: '#8a6448', foam: 'none' },
    chai:       { base: '#b9773d', mixed: '#d9ab79', foam: 'thin', spice: true },
    tea:        { base: '#b5651d', mixed: '#d6a06a', foam: 'none' }
  };
  var MILK = { whole: '#fbf6ee', skim: '#eef3f6', oat: '#efe1c6', almond: '#ecd8bd' };
  var SIZE = { small: 0.8, medium: 0.9, large: 1 };

  var el = {};

  function $(id) { return document.getElementById(id); }

  function init() {
    ['pvSvg', 'pvCup', 'pvLiquid', 'pvCoffee', 'pvMilkLayer', 'pvSwirl', 'pvFoam', 'pvShot', 'pvSurface',
     'pvIce', 'pvStraw', 'pvDrops', 'pvSteam', 'pvWhip', 'pvDrizzleA', 'pvDrizzleB', 'pvSpice', 'pvBadge', 'pvBadgeText',
     'pvEmpty', 'pvTitle', 'pvDetails', 'pvTodo', 'pvOutline'].forEach(function (id) { el[id] = $(id); });
    return !!el.pvSvg;
  }

  function show(node, on) { if (node) node.classList.toggle('on', !!on); }
  function fill(node, colour) { if (node) node.style.fill = colour; }

  /* Update the drawing and caption from the current order. */
  function update(order) {
    if (!el.pvSvg && !init()) return;
    var d = order.drink ? DRINK[order.drink] : null;
    var iced = order.temp === 'iced';
    var hot = order.temp === 'hot';
    var milk = order.milk && order.milk !== 'none' ? order.milk : null;
    var extras = order.extras || [];
    var hasWhip = extras.indexOf('whip') !== -1;

    el.pvSvg.classList.toggle('has-drink', !!d);
    show(el.pvEmpty, !d);
    el.pvOutline.classList.toggle('dashed', !d);

    // size: the whole mug grows or shrinks
    var scale = SIZE[order.size] || 0.9;
    el.pvCup.style.transform = 'scale(' + scale + ')';

    if (d) {
      var layered = iced && milk;                // iced + milk: a milk layer on top of coffee
      var blended = !iced && milk;               // hot (or not chosen yet) + milk: mixed colour
      fill(el.pvCoffee, blended ? d.mixed : d.base);
      fill(el.pvMilkLayer, milk ? MILK[milk] : '#fff');
      show(el.pvMilkLayer, layered);
      if (el.pvSwirl) el.pvSwirl.style.stroke = milk ? MILK[milk] : '#fff';
      show(el.pvSwirl, layered);
      // foam on hot milky drinks; a thick cap on cappuccino
      var foam = hot && milk && d.foam !== 'none';
      show(el.pvFoam, foam);
      el.pvFoam.classList.toggle('thick', d.foam === 'thick');
      fill(el.pvSurface, blended ? d.mixed : (layered ? MILK[milk] : d.base));
      show(el.pvSpice, d.spice && hot && milk);
    } else {
      [el.pvMilkLayer, el.pvSwirl, el.pvFoam, el.pvSpice].forEach(function (n) { show(n, false); });
    }

    show(el.pvShot, d && extras.indexOf('shot') !== -1);
    show(el.pvIce, d && iced);
    show(el.pvStraw, iced);
    show(el.pvDrops, iced);
    show(el.pvSteam, hot);
    el.pvSteam.classList.toggle('high', hasWhip);
    show(el.pvWhip, d && hasWhip);

    // drizzle: caramel and/or vanilla, on the whipped cream if there is some
    var drizzles = extras.filter(function (e) { return e === 'caramel' || e === 'vanilla'; });
    [el.pvDrizzleA, el.pvDrizzleB].forEach(function (node, i) {
      var kind = drizzles[i];
      show(node, d && !!kind);
      if (kind) node.style.stroke = kind === 'caramel' ? '#c9792f' : '#f0d27e';
      node.classList.toggle('on-whip', hasWhip);
    });

    var qty = order.quantity || 1;
    show(el.pvBadge, order.quantity > 1);
    el.pvBadgeText.textContent = '×' + qty;

    caption(order);
  }

  function caption(order) {
    var title, details = [], todo = [];
    if (!order.drink) {
      title = 'Your drink will appear here';
    } else {
      var parts = [];
      if (order.size) parts.push(BB.option('size', order.size).label);
      if (order.temp && order.drink !== 'coldbrew') parts.push(order.temp === 'iced' ? 'iced' : 'hot');
      parts.push(BB.option('drink', order.drink).label.toLowerCase());
      title = (order.quantity > 1 ? order.quantity + ' × ' : '') + parts.join(' ');
      title = title.charAt(0).toUpperCase() + title.slice(1);
      if (order.milk) details.push(BB.option('milk', order.milk).label);
      (order.extras || []).forEach(function (e) { details.push(BB.option('extras', e).label); });
    }
    ['size', 'temp', 'milk', 'extras'].forEach(function (s) {
      var v = order[s];
      if (v === null || v === undefined || (Array.isArray(v) && !v.length)) todo.push(BB.SLOT_LABELS[s].toLowerCase());
    });
    el.pvTitle.textContent = title;
    el.pvDetails.textContent = details.join(' · ');
    el.pvDetails.hidden = !details.length;
    el.pvTodo.textContent = order.drink && todo.length ? 'Still to choose: ' + todo.join(', ') : '';
    el.pvTodo.hidden = !(order.drink && todo.length);
    // the drawing's text description for screen readers
    el.pvSvg.setAttribute('aria-label', 'Drink preview: ' + title + (details.length ? ', ' + details.join(', ') : ''));
  }

  return { update: update };
})();
