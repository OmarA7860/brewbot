/*
 * drinkart.js
 * -----------
 * Small hand-drawn illustrations of each drink on the menu, in the same
 * cartoon style as the BrewBot avatar and the live drink preview.
 * Used in the Menu panel, on the drink buttons and on the welcome screen.
 *
 * Why (UX): people find a drink faster by its picture than by reading a
 * list of names (recognition rather than recall), and matching pictures
 * across the menu, the buttons and the preview keep the design consistent.
 * Pictures are never the only signal: every one sits next to its name and
 * price, and the drawings are hidden from screen readers.
 *
 * BB.DrinkArt.svg(drinkId, { iced: true|false }) returns SVG markup.
 */
window.BB = window.BB || {};

BB.DrinkArt = (function () {
  var INK = '#4a2e1f';
  var MUG = '#fffaf3';
  var FOAM = '#f6ead8';

  // Colours match the live drink preview (preview.js).
  var DRINKS = {
    latte:      { top: '#c9a07a', foam: true,  art: 'heart', band: '#c0732f' },
    cappuccino: { top: '#be946c', foam: 'dome', art: 'cocoa', band: '#8a5a3b' },
    americano:  { top: '#3b2214', crema: true, band: '#3b2214' },
    mocha:      { top: '#9a6a52', foam: true,  art: 'drizzle', band: '#7a3f2c' },
    coldbrew:   { top: '#2e1a10', iced: true },
    chai:       { top: '#d9ab79', foam: true,  art: 'spice', band: '#d9963f' },
    tea:        { top: '#b5651d', teabag: true, band: '#6f8f4e' }
  };
  var ICED_COLOUR = { latte: '#a87650', cappuccino: '#9a6c48', americano: '#3b2214', mocha: '#6a3a28', coldbrew: '#2e1a10', chai: '#bf8650', tea: '#b5651d' };

  function steam() {
    return '<g class="da-steam" fill="none" stroke="#c9b39d" stroke-width="3" stroke-linecap="round">' +
      '<path d="M46 26c-4-5 4-8 0-13"/><path d="M58 24c-4-5 4-8 0-13"/><path d="M70 26c-4-5 4-8 0-13"/></g>';
  }

  function hotMug(id, d) {
    var s = '';
    s += '<ellipse cx="58" cy="103" rx="40" ry="7" fill="#e8d9c6" stroke="' + INK + '" stroke-width="2.5"/>';
    s += '<path d="M86 50c15-1 16 25 0 26" fill="none" stroke="' + INK + '" stroke-width="7" stroke-linecap="round"/>';
    s += '<path d="M86 50c15-1 16 25 0 26" fill="none" stroke="' + MUG + '" stroke-width="2.5" stroke-linecap="round"/>';
    s += '<path d="M28 40h60v36a22 22 0 0 1-22 22H50a22 22 0 0 1-22-22z" fill="' + MUG + '" stroke="' + INK + '" stroke-width="3" stroke-linejoin="round"/>';
    s += '<rect x="28" y="62" width="60" height="8" fill="' + (d.band || '#c0732f') + '" opacity=".9"/>';
    // the drink's surface
    s += '<ellipse cx="58" cy="41" rx="28" ry="6.5" fill="' + d.top + '" stroke="' + INK + '" stroke-width="2.5"/>';
    if (d.crema) s += '<ellipse cx="58" cy="41" rx="20" ry="4" fill="none" stroke="#a0683e" stroke-width="2" opacity=".8"/>';
    if (d.foam === 'dome') s += '<path d="M31 41c2-13 52-13 54 0z" fill="' + FOAM + '" stroke="' + INK + '" stroke-width="2.5" stroke-linejoin="round"/>';
    else if (d.foam) s += '<ellipse cx="58" cy="41" rx="22" ry="4.5" fill="' + FOAM + '"/>';
    if (d.art === 'heart') s += '<path d="M58 44c-6-3-7-7-4-8 2-1 3 0 4 2 1-2 2-3 4-2 3 1 2 5-4 8z" fill="' + d.top + '"/>';
    if (d.art === 'cocoa') s += '<g fill="#7a4a2c"><circle cx="50" cy="35" r="1.3"/><circle cx="58" cy="33" r="1.3"/><circle cx="65" cy="36" r="1.3"/><circle cx="54" cy="38" r="1.1"/><circle cx="62" cy="38.5" r="1.1"/></g>';
    if (d.art === 'drizzle') s += '<path d="M42 41l5-3 5 3 5-3 5 3 5-3 5 3" fill="none" stroke="#5a2e1c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
    if (d.art === 'spice') s += '<g fill="#8a4a1c"><circle cx="49" cy="40" r="1.2"/><circle cx="56" cy="42" r="1.2"/><circle cx="63" cy="39.5" r="1.2"/><circle cx="68" cy="42" r="1"/></g>' +
      '<path d="M57 38l1.2 2.2 2.4.3-1.8 1.6.5 2.4-2.3-1.2-2.1 1.2.4-2.4-1.8-1.6 2.4-.3z" fill="#6b3a1a"/>';
    if (d.teabag) s += '<path d="M72 41c4-6 10-6 12 2" fill="none" stroke="#9c8a78" stroke-width="1.6"/>' +
      '<rect x="79" y="42" width="11" height="13" rx="2" fill="#f1e3c8" stroke="' + INK + '" stroke-width="2"/>' +
      '<rect x="81.5" y="45" width="6" height="3" rx="1" fill="#c0732f"/>';
    return s + steam();
  }

  function icedGlass(id) {
    var c = ICED_COLOUR[id] || '#7a4a35';
    var s = '';
    s += '<ellipse cx="58" cy="103" rx="34" ry="6" fill="#e8d9c6" stroke="' + INK + '" stroke-width="2.5"/>';
    // straw
    s += '<path d="M66 10l-8 46" stroke="' + INK + '" stroke-width="8" stroke-linecap="round"/>';
    s += '<path d="M66 10l-8 46" stroke="#e46b55" stroke-width="4.5" stroke-linecap="round"/>';
    // drink inside the glass
    s += '<path d="M36 44h44l-5 52H41z" fill="' + c + '"/>';
    if (id !== 'coldbrew' && id !== 'americano' && id !== 'tea') s += '<path d="M36 44h44l-1.6 17H37.6z" fill="#f3e6d3"/>';
    // ice cubes
    s += '<g fill="#ffffff" fill-opacity=".72" stroke="#ffffff" stroke-width="1.5">' +
      '<rect x="42" y="46" width="13" height="13" rx="3" transform="rotate(-10 48 52)"/>' +
      '<rect x="58" y="50" width="13" height="13" rx="3" transform="rotate(12 64 56)"/>' +
      '<rect x="47" y="64" width="12" height="12" rx="3" transform="rotate(6 53 70)"/></g>';
    // glass outline and shine
    s += '<path d="M33 32h50l-6 66H39z" fill="#eaf4f7" fill-opacity=".12" stroke="' + INK + '" stroke-width="3" stroke-linejoin="round"/>';
    s += '<path d="M39 38l3 52" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity=".7"/>';
    s += '<g fill="#bfe1ea"><circle cx="80" cy="60" r="1.8"/><circle cx="78" cy="72" r="1.4"/><circle cx="36" cy="70" r="1.5"/></g>';
    return s;
  }

  function svg(id, opts) {
    opts = opts || {};
    var d = DRINKS[id];
    if (!d) return '';
    var iced = d.iced || opts.iced;
    return '<svg class="drink-art" viewBox="0 0 116 116" aria-hidden="true" focusable="false">' +
      (iced ? icedGlass(id) : hotMug(id, d)) + '</svg>';
  }

  var DESCRIPTIONS = {
    latte: 'Espresso with steamed milk and a light layer of foam.',
    cappuccino: 'Espresso with less milk and a thick cap of foam.',
    americano: 'Espresso topped up with hot water. Bold and simple.',
    mocha: 'Espresso, chocolate and steamed milk.',
    coldbrew: 'Steeped cold for 12 hours. Smooth and strong, always iced.',
    chai: 'Spiced black tea with steamed milk.',
    tea: 'Green, black, Earl Grey or herbal.'
  };

  return { svg: svg, describe: function (id) { return DESCRIPTIONS[id] || ''; } };
})();
