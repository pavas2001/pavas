'use strict';
// Pixberry Signal: cubes, counter display / staff app API, escalation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixberry-signal-'));
process.env.PIXBERRY_DB = path.join(dir, 'test.db');
process.env.PIXBERRY_BACKUP_DIR = path.join(dir, 'backups');
process.env.ADMIN_PASSWORD = 'admin-pass-123';
const CAFE = { lat: 12.9716, lng: 77.5946 };
execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'seed.js')], { env: { ...process.env, CAFE_LAT: String(CAFE.lat), CAFE_LNG: String(CAFE.lng) } });

const { createApp } = require('../server/index');
const { get, run } = require('../server/db');
const S = require('../server/signal');

let base, server;
const tokens = {};
const tableId = label => get('SELECT id FROM tables WHERE label = ?', label).id;

async function call(method, url, body, { as = 'admin', key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-device-key'] = key;
  else if (as && tokens[as]) headers.authorization = `Bearer ${tokens[as]}`;
  const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

test.before(async () => {
  server = createApp().listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const [u, p] of [['admin', 'admin-pass-123'], ['waiter', 'pixberry123'], ['cashier', 'pixberry123']]) {
    const r = await call('POST', '/api/auth/login', { username: u, password: p }, { as: null });
    assert.equal(r.status, 200, `login ${u}`);
    tokens[u] = r.body.token;
  }
});
test.after(() => server.close());

let key, deviceId;

test('pairing a cube returns a key once and lists the device', async () => {
  const r = await call('POST', '/api/signal/devices', { kind: 'cube', table_id: tableId('T2'), name: 'Test cube' });
  assert.equal(r.status, 201);
  assert.match(r.body.key, /^pbd_/);
  key = r.body.key; deviceId = r.body.device.id;
  assert.equal(r.body.device.table_label, 'T2');
  const list = await call('GET', '/api/signal/devices');
  assert.ok(list.body.some(d => d.id === deviceId));
  assert.ok(!JSON.stringify(list.body).includes(key), 'key is never returned again');
  // waiters can see devices but not pair them
  assert.equal((await call('POST', '/api/signal/devices', { table_id: tableId('T3') }, { as: 'waiter' })).status, 403);
});

test('device API rejects unknown keys', async () => {
  assert.equal((await call('POST', '/api/device/face', { face: 'water' }, { key: 'pbd_nope' })).status, 401);
  assert.equal((await call('POST', '/api/device/face', { face: 'water' })).status, 401);
  assert.equal((await call('POST', '/api/device/face', { face: 'juggle' }, { key })).status, 400);
});

test('flipping the cube creates a request; flipping again replaces it', async () => {
  const w = await call('POST', '/api/device/face', { face: 'water', battery: 77 }, { key });
  assert.equal(w.status, 200);
  assert.equal(w.body.light, 'request');
  assert.equal(w.body.request.type, 'water');
  assert.equal(w.body.table, 'T2');

  let board = await call('GET', '/api/signal/board', null, { as: 'waiter' });
  assert.equal(board.status, 200);
  const mine = board.body.requests.filter(r => r.table_label === 'T2');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].source, 'cube');
  assert.equal(board.body.tables.find(t => t.label === 'T2').request_type, 'water');

  // the same face again does not duplicate
  await call('POST', '/api/device/face', { face: 'water' }, { key });
  // flipping to Bill replaces the unanswered Water request
  const b = await call('POST', '/api/device/face', { face: 'bill' }, { key });
  assert.equal(b.body.request.type, 'bill');
  board = await call('GET', '/api/signal/board');
  const t2 = board.body.requests.filter(r => r.table_label === 'T2');
  assert.deepEqual(t2.map(r => r.type), ['bill']);
  assert.equal(get('SELECT battery FROM signal_devices WHERE id = ?', deviceId).battery, 77);
});

test('claim → cube shows acknowledged; others cannot claim; done clears it', async () => {
  const id = get(`SELECT id FROM service_requests WHERE device_id = ? AND status = 'open'`, deviceId).id;
  const c = await call('POST', `/api/signal/requests/${id}/claim`, null, { as: 'waiter' });
  assert.equal(c.status, 200);
  assert.ok(c.body.claimed_by);
  const hb = await call('POST', '/api/device/heartbeat', { battery: 70 }, { key });
  assert.equal(hb.body.light, 'acknowledged');
  assert.equal(hb.body.request.acknowledged, true);

  const other = await call('POST', `/api/signal/requests/${id}/claim`, null, { as: 'cashier' });
  assert.equal(other.status, 409);
  assert.match(other.body.error, /Priya Waiter is already on the way/);

  // a claimed request is not cancelled by flipping the cube
  await call('POST', '/api/device/face', { face: 'water' }, { key });
  assert.equal(get('SELECT status FROM service_requests WHERE id = ?', id).status, 'open');

  const d = await call('POST', `/api/signal/requests/${id}/done`, null, { as: 'waiter' });
  assert.equal(d.status, 200);
  assert.equal(d.body.status, 'done');
  const stats = (await call('GET', '/api/signal/stats')).body;
  assert.ok(stats.total >= 1);
  assert.ok(stats.by_staff.some(x => x.name === 'Priya Waiter'));
});

test('Candle face and shake cancel the cube request', async () => {
  await call('POST', '/api/device/face', { face: 'togo' }, { key });
  const rest = await call('POST', '/api/device/face', { face: 'rest' }, { key });
  assert.equal(rest.body.request?.type === 'togo', false);
  assert.equal(get(`SELECT COUNT(*) AS n FROM service_requests WHERE device_id = ? AND type = 'togo' AND status = 'open'`, deviceId).n, 0);

  await call('POST', '/api/device/face', { face: 'service' }, { key });
  const c = await call('POST', '/api/device/cancel', {}, { key });
  assert.equal(c.status, 200);
  assert.ok(c.body.cancelled >= 1);
  assert.equal(get(`SELECT COUNT(*) AS n FROM service_requests WHERE device_id = ? AND type = 'waiter' AND status = 'open'`, deviceId).n, 0);
});

test('QR requests accept the new types and stay location-checked', async () => {
  const tok = get(`SELECT qr_token FROM tables WHERE label = 'T5'`).qr_token;
  const far = await call('POST', `/api/public/t/${tok}/requests`, { type: 'togo', location: { lat: CAFE.lat + 0.01, lng: CAFE.lng, accuracy: 10 } }, { as: null });
  assert.equal(far.status, 403);
  const ok = await call('POST', `/api/public/t/${tok}/requests`, { type: 'togo', location: { lat: CAFE.lat, lng: CAFE.lng, accuracy: 10 } }, { as: null });
  assert.equal(ok.status, 200);
  const r = get(`SELECT * FROM service_requests WHERE table_id = ? AND type = 'togo' AND status = 'open'`, tableId('T5'));
  assert.equal(r.source, 'qr');
});

test('unanswered requests escalate to the floor, then the manager', () => {
  const t = { id: tableId('T7'), label: 'T7' };
  const { id } = S.createRequest({ branchId: get('SELECT id FROM branches LIMIT 1').id, table: t, type: 'water', source: 'staff' });
  run('UPDATE service_requests SET created_at = ? WHERE id = ?', new Date(Date.now() - 150e3).toISOString(), id);
  S.escalate();
  assert.equal(get('SELECT escalation FROM service_requests WHERE id = ?', id).escalation, 1);
  run('UPDATE service_requests SET created_at = ? WHERE id = ?', new Date(Date.now() - 300e3).toISOString(), id);
  S.escalate();
  assert.equal(get('SELECT escalation FROM service_requests WHERE id = ?', id).escalation, 2);
  assert.ok(get(`SELECT id FROM notifications WHERE audience = 'manager' AND type = 'request_late' AND ref = ?`, `request:${id}`));
  S.escalate(); // nothing more to do
  assert.equal(get(`SELECT COUNT(*) AS n FROM notifications WHERE ref = ?`, `request:${id}`).n, 2);
});

test('shift and display settings', async () => {
  const sec = get(`SELECT id FROM sections WHERE name = 'Patio'`).id;
  const m = await call('PUT', '/api/signal/me', { on_duty: true, section_id: sec }, { as: 'waiter' });
  assert.equal(m.status, 200);
  assert.equal(m.body.on_duty, true);
  assert.equal(m.body.section_id, sec);
  const board = await call('GET', '/api/signal/board');
  assert.ok(board.body.staff.some(s => s.name === 'Priya Waiter' && s.section_name === 'Patio'));

  assert.equal((await call('PUT', '/api/signal/settings', { language: 'ml' }, { as: 'waiter' })).status, 403);
  assert.equal((await call('PUT', '/api/signal/settings', { escalate_after_s: 300, manager_after_s: 200 })).status, 400);
  assert.equal((await call('PUT', '/api/signal/settings', { language: 'fr' })).status, 400);
  const s = await call('PUT', '/api/signal/settings', { language: 'ml', evening_mode: true });
  assert.equal(s.status, 200);
  assert.equal(s.body.language, 'ml');
  const hb = await call('POST', '/api/device/heartbeat', {}, { key });
  assert.equal(hb.body.evening_mode, true);
  assert.equal(hb.body.light, 'candle');
});

test('removing a cube stops its key working', async () => {
  assert.equal((await call('DELETE', `/api/signal/devices/${deviceId}`)).status, 200);
  assert.equal((await call('POST', '/api/device/heartbeat', {}, { key })).status, 401);
});

test('screens are served', async () => {
  for (const p of ['/signal', '/signal/app', '/signal/display.js', '/signal/app.js', '/signal/common.js']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
});
