/*
 * menu.js
 * -------
 * Everything BrewBot can offer: drinks, sizes, temperatures, milks, extras
 * and payment options, with prices and the different words people use for
 * each one. Keeping this in one place means the dialogue code never has a
 * menu item hard-coded in it, and the shop could change the menu here only.
 *
 * Each option has:
 *   id     internal value stored in the order
 *   label  how it is shown on screen and read aloud
 *   words  phrases that should be understood as this option (lower case)
 *   price  extra cost in dollars (drinks have a base price)
 */
window.BB = window.BB || {};

BB.SHOP = {
  name: 'Bean & Brew',
  opensAt: 7,          // 7:00 am
  closesAt: 21,        // 9:00 pm
  prepMinutes: 10,     // how long an order takes to make
  taxRate: 0.13,       // Ontario HST
  maxQuantity: 10
};

BB.MENU = {
  drink: [
    { id: 'latte',      label: 'Latte',      price: 4.75, words: ['latte', 'lattes', 'cafe latte', 'caffe latte', 'latté', 'lot a', 'lotte'] },
    { id: 'cappuccino', label: 'Cappuccino', price: 4.75, words: ['cappuccino', 'cappuccinos', 'capuccino', 'cappucino', 'cappuchino', 'capuchino', 'cappuccini'] },
    { id: 'americano',  label: 'Americano',  price: 3.75, words: ['americano', 'americanos', 'american o'] },
    { id: 'mocha',      label: 'Mocha',      price: 5.25, words: ['mocha', 'mochas', 'mocha latte', 'mocca', 'moka'] },
    { id: 'coldbrew',   label: 'Cold Brew',  price: 4.50, words: ['cold brew', 'cold brews', 'coldbrew', 'cold-brew'], icedOnly: true },
    { id: 'chai',       label: 'Chai Latte', price: 4.95, words: ['chai latte', 'chai lattes', 'chai tea latte', 'chai tea', 'chai', 'chais', 'chai-latte'] },
    { id: 'tea',        label: 'Tea',        price: 2.95, words: ['tea', 'teas', 'green tea', 'black tea', 'earl grey', 'herbal tea'] }
  ],
  size: [
    { id: 'small',  label: 'Small',  price: 0.00, words: ['small', 'smalls', 'little', 'smaller'] },
    { id: 'medium', label: 'Medium', price: 0.60, words: ['medium', 'mediums', 'regular', 'med', 'normal size'] },
    { id: 'large',  label: 'Large',  price: 1.10, words: ['large', 'larges', 'big', 'bigger', 'biggest'] }
  ],
  temp: [
    { id: 'hot',  label: 'Hot',  price: 0, words: ['hot', 'warm', 'steamed', 'heated'] },
    { id: 'iced', label: 'Iced', price: 0, words: ['iced', 'ice', 'on ice', 'over ice', 'cold', 'icy', 'chilled'] }
  ],
  milk: [
    { id: 'whole',  label: 'Whole milk',  price: 0.00, words: ['whole milk', 'whole', 'regular milk', 'normal milk', 'homo milk', 'full fat', 'dairy'] },
    { id: 'skim',   label: 'Skim milk',   price: 0.00, words: ['skim milk', 'skim', 'skimmed', 'nonfat', 'non fat', 'non-fat', 'fat free'] },
    { id: 'oat',    label: 'Oat milk',    price: 0.70, words: ['oat milk', 'oatmilk', 'oat', 'oats', 'oak milk', 'oatley', 'oatly'] },
    { id: 'almond', label: 'Almond milk', price: 0.70, words: ['almond milk', 'almond', 'almonds', 'almondmilk'] },
    { id: 'none',   label: 'No milk',     price: 0.00, words: ['no milk', 'without milk', 'black', 'no dairy', 'hold the milk', 'skip the milk', 'skip milk'] }
  ],
  extras: [
    { id: 'shot',    label: 'Extra shot',     price: 1.00, words: ['extra shot', 'another shot', 'double shot', 'extra espresso', 'add a shot', 'a shot', 'shot', 'double'] },
    { id: 'vanilla', label: 'Vanilla syrup',  price: 0.60, words: ['vanilla syrup', 'vanilla'] },
    { id: 'caramel', label: 'Caramel syrup',  price: 0.60, words: ['caramel syrup', 'caramel', 'carmel'] },
    { id: 'whip',    label: 'Whipped cream',  price: 0.50, words: ['whipped cream', 'whip cream', 'whipped', 'whip'] },
    { id: 'none',    label: 'No extras',      price: 0.00, words: ['no extras', 'no extra', 'nothing extra', 'without extras', 'no add ons', 'no add-ons', 'just plain', 'plain'] }
  ],
  payment: [
    { id: 'card', label: 'Card at pickup', price: 0, words: ['card', 'credit', 'debit', 'visa', 'mastercard', 'tap', 'apple pay', 'google pay', 'phone', 'mobile'] },
    { id: 'cash', label: 'Cash at pickup', price: 0, words: ['cash', 'money', 'coins', 'bills'] }
  ]
};

/*
 * Things people often ask for that the shop does NOT have. When one of these
 * is heard, BrewBot explains what it can offer instead of just saying
 * "I didn't understand". 'hint' is the suggestion it gives.
 */
BB.UNSUPPORTED = {
  drink: [
    { words: ['hot chocolate', 'hot cocoa', 'cocoa'], name: 'hot chocolate', hint: 'a mocha is the closest thing we have' },
    { words: ['frappuccino', 'frappe', 'frappé', 'frap', 'blended coffee'], name: 'blended drinks', hint: 'an iced latte or a cold brew might do the trick' },
    { words: ['matcha'], name: 'matcha', hint: 'we do have green tea' },
    { words: ['espresso', 'espressos'], name: 'straight espresso', hint: 'an americano is espresso with hot water' },
    { words: ['macchiato', 'flat white', 'cortado'], name: 'that drink', hint: 'a latte is the closest option' },
    { words: ['smoothie', 'juice', 'lemonade', 'pop', 'soda', 'milkshake', 'water'], name: 'that', hint: 'we only make coffee and tea drinks' },
    { words: ['muffin', 'bagel', 'croissant', 'cookie', 'sandwich', 'donut', 'doughnut', 'cake', 'food', 'scone'], name: 'food', hint: 'I can only take drink orders for now' }
  ],
  size: [
    { words: ['extra large', 'extra-large', 'xl', 'huge', 'venti', 'jumbo'], name: 'that size', hint: 'large is our biggest size' },
    { words: ['extra small', 'tiny', 'tall', 'short'], name: 'that size', hint: 'small is our smallest size' },
    { words: ['grande'], name: 'grande', hint: 'medium is about the same' }
  ],
  milk: [
    { words: ['soy', 'soy milk', 'soya'], name: 'soy milk', hint: 'oat or almond are our non-dairy options' },
    { words: ['coconut', 'coconut milk'], name: 'coconut milk', hint: 'oat or almond are our non-dairy options' },
    { words: ['lactose free', 'lactose-free'], name: 'lactose-free milk', hint: 'oat or almond milk are both dairy-free' },
    { words: ['2%', '2 percent', 'two percent', '1%', 'one percent', 'half and half', 'cream', 'creamer'], name: 'that', hint: 'whole or skim are our dairy options' }
  ],
  extras: [
    { words: ['hazelnut', 'pumpkin spice', 'peppermint', 'chocolate syrup', 'mocha syrup', 'cinnamon', 'sprinkles', 'honey', 'maple'], name: 'that flavour', hint: 'we have vanilla or caramel syrup' },
    { words: ['sugar', 'sweetener', 'splenda', 'stevia'], name: 'sugar', hint: 'sugar and sweetener are at the self-serve counter, free' }
  ]
};

/* Questions asked, in this order. Each one fills one slot of the order. */
BB.SLOT_ORDER = ['drink', 'size', 'temp', 'milk', 'extras', 'quantity', 'pickup', 'name', 'payment'];

BB.SLOT_LABELS = {
  drink: 'Drink',
  size: 'Size',
  temp: 'Hot or iced',
  milk: 'Milk',
  extras: 'Extras',
  quantity: 'Quantity',
  pickup: 'Pickup time',
  name: 'Name',
  payment: 'Payment'
};

/* Find a menu option object by slot and id, e.g. BB.option('milk', 'oat'). */
BB.option = function (slot, id) {
  return (BB.MENU[slot] || []).find(function (o) { return o.id === id; }) || null;
};
