'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixberry-test-'));
process.env.PIXBERRY_DB = path.join(dir, 'test.db');
process.env.PIXBERRY_BACKUP_DIR = path.join(dir, 'backups');
process.env.ADMIN_PASSWORD = 'admin-pass-123';
const CAFE = { lat: 12.9716, lng: 77.5946 };
execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'seed.js')], { env: { ...process.env, CAFE_LAT: String(CAFE.lat), CAFE_LNG: String(CAFE.lng) } });

const { createApp } = require('../server/index');
const { get } = require('../server/db');
const { distanceMeters, checkGeofence } = require('../server/util');

let base, server, token;
const tableToken = () => get(`SELECT qr_token FROM tables WHERE label = 'T1'`).qr_token;
const counterToken = () => get(`SELECT qr_token FROM tables WHERE kind = 'counter'`).qr_token;
// ~111 m per 0.001° latitude
const at = (dLatDeg, accuracy = 10) => ({ lat: CAFE.lat + dLatDeg, lng: CAFE.lng, accuracy });

async function call(method, url, body, auth = true) {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(auth && token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

test.before(async () => {
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin-pass-123' }, false);
  assert.equal(r.status, 200);
  token = r.body.token;
});
test.after(() => server.close());

test('haversine distance is accurate', () => {
  // 0.001° of latitude ≈ 111.2 m
  const d = distanceMeters(12.9716, 77.5946, 12.9726, 77.5946);
  assert.ok(Math.abs(d - 111.2) < 1, `got ${d}`);
  assert.equal(Math.round(distanceMeters(1, 1, 1, 1)), 0);
});

test('geofence decision rules', () => {
  const b = { geofence_enabled: 1, lat: CAFE.lat, lng: CAFE.lng, radius_m: 100, accuracy_tolerance_m: 30, max_accuracy_m: 300 };
  assert.equal(checkGeofence(b, at(0.0005)).allowed, true);                 // ~56 m
  assert.equal(checkGeofence(b, at(0.002)).allowed, false);                 // ~222 m
  assert.equal(checkGeofence(b, at(0.0011, 25)).allowed, true);             // ~122 m, within radius + accuracy slack (25)
  assert.equal(checkGeofence(b, at(0.0012, 200)).allowed, false);           // slack is capped at tolerance (30) → 133-30 > 100
  assert.equal(checkGeofence(b, at(0, 500)).code, 'low_accuracy');
  assert.equal(checkGeofence(b, null).code, 'location_required');
  assert.equal(checkGeofence(b, { lat: 'x', lng: 1 }).code, 'location_required');
  assert.equal(checkGeofence({ ...b, lat: null }, at(0)).code, 'not_configured');
  assert.equal(checkGeofence({ ...b, geofence_enabled: 0 }, null).allowed, true);
});

test('customer can view the menu from anywhere', async () => {
  const r = await call('GET', `/api/public/t/${tableToken()}`, null, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.table.label, 'T1');
  assert.equal(r.body.geofence.enabled, true);
  assert.equal(r.body.geofence.radius_m, 150);
  assert.ok(r.body.menu.length > 0);
  assert.equal(JSON.stringify(r.body).includes(String(CAFE.lat)), false, 'exact café coordinates are not exposed');
});

test('QR order is BLOCKED outside the radius and without location', async () => {
  const cap = get(`SELECT id FROM items WHERE name = 'Americano'`).id;
  const far = await call('POST', `/api/public/t/${tableToken()}/orders`, { items: [{ item_id: cap, qty: 1 }], location: at(0.01) }, false); // ~1.1 km
  assert.equal(far.status, 403);
  assert.equal(far.body.geofence.code, 'outside');
  assert.ok(far.body.geofence.distance_m > 1000);
  assert.match(far.body.error, /within 150 m/);
  const none = await call('POST', `/api/public/t/${tableToken()}/orders`, { items: [{ item_id: cap, qty: 1 }] }, false);
  assert.equal(none.status, 403);
  assert.equal(none.body.geofence.code, 'location_required');
  const loc = await call('POST', `/api/public/t/${tableToken()}/locate`, at(0.01), false);
  assert.equal(loc.body.allowed, false);
  assert.equal(get(`SELECT COUNT(*) n FROM orders`).n, 0, 'no order was created');
  // service requests are geofenced too
  const req = await call('POST', `/api/public/t/${tableToken()}/requests`, { type: 'waiter', location: at(0.01) }, false);
  assert.equal(req.status, 403);
});

let orderKey;
test('QR order is ACCEPTED inside the radius; prices come from the server', async () => {
  const cap = get(`SELECT id FROM items WHERE name = 'Cappuccino'`).id;
  const large = get(`SELECT id FROM item_variants WHERE item_id = ? AND name = 'Large'`, cap).id;
  const oat = get(`SELECT id FROM modifiers WHERE name = 'Oat milk'`).id;
  const loc = await call('POST', `/api/public/t/${tableToken()}/locate`, at(0.0005), false);
  assert.equal(loc.body.allowed, true);
  assert.equal(get(`SELECT status FROM tables WHERE label='T1'`).status, 'ordering');
  const r = await call('POST', `/api/public/t/${tableToken()}/orders`, {
    items: [{ item_id: cap, variant_id: large, modifier_ids: [oat], qty: 2, notes: 'less sugar', unit_price: 1 }],
    location: at(0.0005), client_ref: 'abc-1',
  }, false);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.order.items[0].unit_price, 24000); // 200 + 40 oat, ignores client price
  assert.equal(r.body.order.subtotal, 48000);
  assert.equal(r.body.order.tax, 2400); // 5% GST exclusive
  assert.equal(r.body.order.total, 50400);
  orderKey = r.body.order.key;
  // retry with same client_ref does not duplicate
  const again = await call('POST', `/api/public/t/${tableToken()}/orders`, { items: [{ item_id: cap, variant_id: large, qty: 2 }], location: at(0.0005), client_ref: 'abc-1' }, false);
  assert.equal(again.body.duplicate, true);
  assert.equal(get(`SELECT COUNT(*) n FROM orders`).n, 1);
  // stock deducted by recipe (Large: 18 g beans each)
  const used = get(`SELECT SUM(qty) q FROM stock_movements WHERE type='used' AND ingredient_id = (SELECT id FROM ingredients WHERE name='Coffee beans')`).q;
  assert.equal(used, -36);
});

test('second round from the same table joins the open order', async () => {
  const am = get(`SELECT id FROM items WHERE name = 'Americano'`).id;
  const r = await call('POST', `/api/public/t/${tableToken()}/orders`, { items: [{ item_id: am, qty: 1 }], location: at(0.0004), client_ref: 'abc-2' }, false);
  assert.equal(r.status, 201);
  assert.equal(r.body.order.key, orderKey);
  assert.equal(r.body.order.items.length, 2);
  assert.equal(r.body.order.items[1].kot, 2);
});

test('required options & sold out are enforced', async () => {
  const pan = get(`SELECT id FROM items WHERE name = 'Paneer tikka sandwich'`).id;
  const r = await call('POST', `/api/public/t/${tableToken()}/orders`, { items: [{ item_id: pan, qty: 1 }], location: at(0) }, false);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Spice level/);
  await call('POST', `/api/items/${pan}/sold-out`, { sold_out: true });
  const r2 = await call('POST', `/api/public/t/${tableToken()}/orders`, { items: [{ item_id: pan, qty: 1, modifier_ids: [get(`SELECT id FROM modifiers WHERE name='Mild'`).id] }], location: at(0) }, false);
  assert.equal(r2.status, 409);
});

test('admin can change the café location and radius', async () => {
  const b = get('SELECT * FROM branches LIMIT 1');
  const bad = await call('PUT', `/api/branches/${b.id}`, { radius_m: 2 });
  assert.equal(bad.status, 400);
  const ok = await call('PUT', `/api/branches/${b.id}`, { radius_m: 2000 });
  assert.equal(ok.status, 200);
  const t = await call('POST', `/api/branches/${b.id}/geofence-test`, at(0.01));
  assert.equal(t.body.allowed, true);
  await call('PUT', `/api/branches/${b.id}`, { radius_m: 150 });
  // non-admin cannot change it
  const login = await call('POST', '/api/auth/login', { username: 'cashier', password: 'pixberry123' }, false);
  const res = await fetch(`${base}/api/branches/${b.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.body.token}` }, body: JSON.stringify({ radius_m: 5000 }) });
  assert.equal(res.status, 403);
});

test('counter QR takeaway order needs a name and gets a pickup code', async () => {
  const am = get(`SELECT id FROM items WHERE name = 'Cappuccino'`).id;
  const v = get(`SELECT id FROM item_variants WHERE item_id = ? AND name='Regular'`, am).id;
  const noName = await call('POST', `/api/public/t/${counterToken()}/orders`, { type: 'pickup', items: [{ item_id: am, variant_id: v }], location: at(0) }, false);
  assert.equal(noName.status, 400);
  const r = await call('POST', `/api/public/t/${counterToken()}/orders`, { type: 'pickup', customer: { name: 'Neha', phone: '9999988888', consent: true }, items: [{ item_id: am, variant_id: v }], location: at(0) }, false);
  assert.equal(r.status, 201);
  assert.equal(r.body.order.items[0].unit_price, 15000); // takeaway price
  assert.match(r.body.order.pickup_code, /^\d{4}$/);
  assert.ok(get(`SELECT id FROM customers WHERE phone = '9999988888'`));
});

test('kitchen → bill → split → pay → table cleaning → loyalty', async () => {
  const o = get('SELECT * FROM orders WHERE public_key = ?', orderKey);
  const kds = await call('GET', '/api/kds');
  assert.ok(kds.body.tickets.some(t => t.order_id === o.id));
  const ids = kds.body.tickets.filter(t => t.order_id === o.id).flatMap(t => t.items.map(i => i.id));
  assert.equal((await call('POST', '/api/kds/items/status', { item_ids: ids, status: 'ready' })).status, 200);
  const prog = await call('GET', `/api/public/orders/${orderKey}`, null, false);
  assert.equal(prog.body.progress, 'ready');
  const bill = await call('POST', `/api/public/t/${tableToken()}/requests`, { type: 'bill', location: at(0) }, false);
  assert.equal(bill.status, 200);
  assert.equal(get(`SELECT status FROM tables WHERE label='T1'`).status, 'bill_requested');
  const disc = await call('POST', `/api/orders/${o.id}/discount`, { coupon_code: 'welcome10' });
  assert.equal(disc.status, 200);
  assert.equal(disc.body.discount, 6100); // 10% of 610
  const split = await call('GET', `/api/orders/${o.id}/split?ways=3`);
  assert.equal(split.body.shares.reduce((a, b) => a + b, 0), disc.body.balance);
  const p1 = await call('POST', `/api/orders/${o.id}/payments`, { method: 'upi', amount: split.body.shares[0] });
  assert.equal(p1.body.order.status, 'billed');
  const p2 = await call('POST', `/api/orders/${o.id}/payments`, { method: 'cash', amount: 100000 });
  assert.equal(p2.body.order.status, 'paid');
  assert.ok(p2.body.change > 0);
  assert.match(p2.body.order.invoice_no, /^PB-\d{4}-000001$/);
  assert.equal(get(`SELECT status FROM tables WHERE label='T1'`).status, 'cleaning');
  const ready = await call('PUT', `/api/tables/${o.table_id}`, { status: 'available' });
  assert.equal(ready.status, 200);
  const rc = await fetch(`${base}/r/${orderKey}`);
  assert.match(await rc.text(), /PAID/);
});

test('POS order, cancel item restores stock, refund & reports', async () => {
  const t2 = get(`SELECT id FROM tables WHERE label = 'T2'`).id;
  const shake = get(`SELECT id FROM items WHERE name = 'Chocolate milkshake'`).id;
  const r = await call('POST', '/api/orders', { type: 'dine_in', table_id: t2, items: [{ item_id: shake, qty: 2 }] });
  assert.equal(r.status, 201);
  const before = get(`SELECT SUM(qty) q FROM stock_movements WHERE ingredient_id = (SELECT id FROM ingredients WHERE name='Milk')`).q;
  const c = await call('POST', `/api/orders/${r.body.id}/items/${r.body.items[0].id}/cancel`, { reason: 'customer changed mind' });
  assert.equal(c.body.total, 0);
  const after = get(`SELECT SUM(qty) q FROM stock_movements WHERE ingredient_id = (SELECT id FROM ingredients WHERE name='Milk')`).q;
  assert.equal(after - before, 500);
  await call('POST', `/api/orders/${r.body.id}/items`, { items: [{ item_id: shake, qty: 1 }] });
  const p = await call('POST', `/api/orders/${r.body.id}/payments`, { method: 'card', amount: 18900 });
  assert.equal(p.body.order.status, 'paid', JSON.stringify(p.body));
  const ref = await call('POST', `/api/orders/${r.body.id}/refund`, { amount: 5000, method: 'card', reason: 'cold' });
  assert.equal(ref.body.refunded, 5000);
  const s = await call('GET', '/api/reports/summary');
  assert.equal(s.body.orders, 2);
  assert.equal(s.body.refunds, 5000);
  const items = await call('GET', '/api/reports/items');
  assert.ok(items.body.best.length >= 2);
  const csv = await fetch(`${base}/api/reports/export/orders.csv`, { headers: { authorization: `Bearer ${token}` } });
  assert.match(await csv.text(), /invoice_no,order_no/);
  const dash = await call('GET', '/api/dashboard');
  assert.equal(dash.status, 200);
  const cost = await call('GET', '/api/costing');
  assert.ok(cost.body.items.find(i => i.name === 'Cappuccino' && i.variant === 'Large').cost > 0);
});

test('permissions: kitchen cannot take payments; cashier cannot refund', async () => {
  const k = await call('POST', '/api/auth/login', { username: 'kitchen', password: 'pixberry123' }, false);
  const o = get(`SELECT id FROM orders LIMIT 1`).id;
  const res = await fetch(`${base}/api/orders/${o}/payments`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k.body.token}` }, body: '{"method":"cash","amount":100}' });
  assert.equal(res.status, 403);
  const c = await call('POST', '/api/auth/login', { username: 'cashier', password: 'pixberry123' }, false);
  const res2 = await fetch(`${base}/api/orders/${o}/refund`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${c.body.token}` }, body: '{"amount":100,"reason":"x"}' });
  assert.equal(res2.status, 403);
});

test('purchasing: receive PO adds stock and updates cost', async () => {
  const sup = get('SELECT id FROM suppliers LIMIT 1').id;
  const beans = get(`SELECT id FROM ingredients WHERE name='Coffee beans'`).id;
  const po = await call('POST', '/api/purchase-orders', { supplier_id: sup, status: 'ordered', lines: [{ ingredient_id: beans, qty: 1000, unit_cost: 150 }] });
  assert.equal(po.status, 201);
  const rec = await call('POST', `/api/purchase-orders/${po.body.id}/receive`, { invoice_no: 'INV-9', lines: [{ id: po.body.lines[0].id, received_qty: 1000, batch_no: 'B1', expiry_date: '2027-01-01' }] });
  assert.equal(rec.body.status, 'received');
  assert.equal(get('SELECT cost_per_unit c FROM ingredients WHERE id = ?', beans).c, 150);
});

test('backup and export', async () => {
  const b = await call('POST', '/api/backups');
  assert.match(b.body.file, /\.db$/);
  const e = await call('GET', '/api/export/all.json');
  assert.ok(e.body.tables.orders.length > 0);
  assert.equal(e.body.tables.users[0].password_hash, undefined);
});
