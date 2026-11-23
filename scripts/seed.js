'use strict';
// Seeds a demo café. Run on an empty database: `npm run seed` (use --force to seed anyway).
const { get, insert, run, tx } = require('../server/db');
const { setSetting, getSetting, token } = require('../server/util');
const { hashPassword } = require('../server/auth');
const { bootstrap } = require('../server/index');

const force = process.argv.includes('--force');
if (get('SELECT COUNT(*) AS n FROM items').n > 0 && !force) {
  console.log('Database already has menu items — not seeding. Use `npm run seed -- --force` to add demo data anyway.');
  process.exit(0);
}
const lat = Number(process.env.CAFE_LAT || 12.9716), lng = Number(process.env.CAFE_LNG || 77.5946);
const demoPw = process.env.DEMO_PASSWORD || 'pixberry123';

let adminPw = null;
tx(() => {
  adminPw = bootstrap();
  setSetting('cafe', { ...getSetting('cafe'), name: 'Pixberry Café', address: '12 MG Road, Bengaluru 560001', phone: '+91 98765 43210', email: 'hello@pixberry.example', gstin: '29ABCDE1234F1Z5' });
  const branch = get('SELECT * FROM branches ORDER BY id LIMIT 1');
  run('UPDATE branches SET name = ?, address = ?, lat = ?, lng = ?, radius_m = 150, geofence_enabled = 1 WHERE id = ?', 'MG Road', '12 MG Road, Bengaluru', lat, lng, branch.id);
  const B = branch.id;

  const users = [['Asha Manager', 'manager', 'manager'], ['Ravi Cashier', 'cashier', 'cashier'], ['Chef Meera', 'kitchen', 'kitchen']];
  for (const [name, username, role] of users) if (!get('SELECT id FROM users WHERE username = ?', username)) insert('users', { name, username, role, password_hash: hashPassword(demoPw), branch_id: B });

  const st = Object.fromEntries(['Hot kitchen', 'Drinks bar', 'Desserts'].map((n, i) => [n, insert('stations', { name: n, sort: i })]));
  const sec = Object.fromEntries(['Indoor', 'Patio'].map((n, i) => [n, insert('sections', { branch_id: B, name: n, sort: i })]));
  for (let i = 1; i <= 8; i++) insert('tables', { branch_id: B, section_id: i <= 6 ? sec.Indoor : sec.Patio, label: `T${i}`, seats: i % 3 === 0 ? 6 : 4, qr_token: token(12), sort: i });
  insert('tables', { branch_id: B, label: 'Counter', kind: 'counter', seats: 0, qr_token: token(12), sort: 99 });

  const cat = {};
  [['Breakfast', 'Served 7–11:30', '07:00', '11:30'], ['Coffee', 'Single-origin espresso & brews'], ['Cold drinks'], ['Sandwiches & bowls'], ['Desserts']]
    .forEach(([name, description = '', f = null, t = null], i) => { cat[name] = insert('categories', { name, description, sort: i, available_from: f, available_to: t }); });

  const sup = insert('suppliers', { name: 'Hill Estate Coffee Co.', contact_person: 'Kiran', phone: '+91 90000 11111', email: 'orders@hillestate.example' });
  const sup2 = insert('suppliers', { name: 'Fresh Farms Dairy', contact_person: 'Lakshmi', phone: '+91 90000 22222' });
  const ing = {};
  for (const [name, unit, cost, low, kind, s] of [
    ['Coffee beans', 'g', 120, 1000, 'ingredient', sup], ['Milk', 'ml', 6, 5000, 'ingredient', sup2], ['Sugar', 'g', 5, 500, 'ingredient', null],
    ['Bread', 'slice', 500, 40, 'ingredient', null], ['Paneer', 'g', 45, 500, 'ingredient', sup2], ['Eggs', 'pc', 700, 24, 'ingredient', sup2],
    ['Chocolate', 'g', 90, 300, 'ingredient', null], ['Ice cream', 'g', 40, 1000, 'ingredient', sup2], ['Takeaway cup', 'pc', 400, 100, 'packaging', null], ['Napkins', 'pc', 50, 200, 'supply', null],
  ]) ing[name] = insert('ingredients', { name, unit, cost_per_unit: cost, low_stock_level: low, kind, preferred_supplier_id: s });
  const loc = get('SELECT id FROM stock_locations WHERE branch_id = ? ORDER BY is_default DESC LIMIT 1', B).id;
  for (const [n, q] of [['Coffee beans', 5000], ['Milk', 20000], ['Sugar', 3000], ['Bread', 120], ['Paneer', 2000], ['Eggs', 90], ['Chocolate', 1500], ['Ice cream', 4000], ['Takeaway cup', 300], ['Napkins', 1000]])
    insert('stock_movements', { ingredient_id: ing[n], location_id: loc, type: 'received', qty: q, unit_cost: get('SELECT cost_per_unit c FROM ingredients WHERE id = ?', ing[n]).c, reference: 'Opening stock' });

  const item = (c, name, price, extra = {}) => insert('items', { category_id: cat[c], name, price: price * 100, ...extra });
  const recipe = (itemId, lines, variant_id = null) => lines.forEach(([n, q]) => insert('recipe_lines', { item_id: itemId, variant_id, ingredient_id: ing[n], qty: q }));

  const masala = item('Breakfast', 'Masala omelette toast', 149, { description: 'Two-egg omelette with onion, chilli & coriander on toast', diet: 'egg', station_id: st['Hot kitchen'], featured: 1, available_from: '07:00', available_to: '11:30' });
  recipe(masala, [['Eggs', 2], ['Bread', 2]]);
  const poha = item('Breakfast', 'Kanda poha', 99, { description: 'Flattened rice, peanuts, curry leaves, lemon', station_id: st['Hot kitchen'] });

  const cap = item('Coffee', 'Cappuccino', 160, { description: 'Double shot, velvety milk foam', station_id: st['Drinks bar'], featured: 1, recommended: 1, takeaway_price: 150 * 100 });
  const vR = insert('item_variants', { item_id: cap, name: 'Regular', price: 160 * 100, takeaway_price: 150 * 100, sort: 0 });
  const vL = insert('item_variants', { item_id: cap, name: 'Large', price: 200 * 100, takeaway_price: 190 * 100, sort: 1 });
  recipe(cap, [['Coffee beans', 18], ['Milk', 150]], vR); recipe(cap, [['Coffee beans', 18], ['Milk', 240]], vL);
  const g1 = insert('modifier_groups', { item_id: cap, name: 'Milk', min_select: 0, max_select: 1 });
  [['Oat milk', 40], ['Almond milk', 50]].forEach(([n, p], i) => insert('modifiers', { group_id: g1, name: n, price: p * 100, sort: i }));
  const g2 = insert('modifier_groups', { item_id: cap, name: 'Extras', min_select: 0, max_select: 3 });
  [['Extra shot', 40], ['Hazelnut syrup', 30], ['Less sugar', 0]].forEach(([n, p], i) => insert('modifiers', { group_id: g2, name: n, price: p * 100, sort: i }));
  const fc = item('Coffee', 'South Indian filter coffee', 90, { description: 'Chicory blend, brass tumbler', station_id: st['Drinks bar'], recommended: 1 });
  recipe(fc, [['Coffee beans', 12], ['Milk', 120], ['Sugar', 10]]);
  const am = item('Coffee', 'Americano', 130, { station_id: st['Drinks bar'] }); recipe(am, [['Coffee beans', 18]]);

  const cold = item('Cold drinks', 'Cold brew', 190, { description: '18-hour steep, served over ice', station_id: st['Drinks bar'], diet: 'vegan' }); recipe(cold, [['Coffee beans', 25]]);
  const shake = item('Cold drinks', 'Chocolate milkshake', 180, { station_id: st['Drinks bar'] }); recipe(shake, [['Milk', 250], ['Chocolate', 30], ['Ice cream', 60]]);
  item('Cold drinks', 'Fresh lime soda', 90, { station_id: st['Drinks bar'], diet: 'vegan' });

  const pan = item('Sandwiches & bowls', 'Paneer tikka sandwich', 220, { description: 'Grilled paneer, mint chutney, sourdough', station_id: st['Hot kitchen'], featured: 1 });
  recipe(pan, [['Paneer', 80], ['Bread', 2]]);
  const g3 = insert('modifier_groups', { item_id: pan, name: 'Spice level', min_select: 1, max_select: 1 });
  [['Mild', 0], ['Medium', 0], ['Spicy', 0]].forEach(([n, p], i) => insert('modifiers', { group_id: g3, name: n, price: p, sort: i }));
  const chick = item('Sandwiches & bowls', 'Chicken pesto bowl', 290, { diet: 'nonveg', station_id: st['Hot kitchen'] });
  item('Sandwiches & bowls', 'Breakfast combo', 249, { description: 'Masala omelette toast + filter coffee', is_combo: 1, combo_items: 'Masala omelette toast, Filter coffee', diet: 'egg', station_id: st['Hot kitchen'] });

  const brownie = item('Desserts', 'Walnut brownie', 140, { description: 'Warm, with a scoop of vanilla', station_id: st.Desserts, recommended: 1 }); recipe(brownie, [['Chocolate', 40], ['Ice cream', 60]]);
  item('Desserts', 'Blueberry cheesecake', 210, { station_id: st.Desserts });

  insert('coupons', { code: 'WELCOME10', description: '10% off your first visit', type: 'percent', value: 10, max_discount: 10000, active: 1 });
  insert('coupons', { code: 'FLAT50', description: '₹50 off orders above ₹400', type: 'flat', value: 5000, min_order: 40000, active: 1 });
  void poha; void chick;
});

console.log('Seeded demo café "Pixberry Café".');
console.log(`  Café location set to ${lat}, ${lng} with a 150 m ordering radius (override with CAFE_LAT / CAFE_LNG).`);
console.log(`  Demo staff logins (password "${demoPw}"): manager, cashier, kitchen`);
console.log(adminPw ? `  Admin login: "admin" / "${adminPw}" — change it after signing in.` : '  Admin login: "admin" — password from first start (or ADMIN_PASSWORD).');
