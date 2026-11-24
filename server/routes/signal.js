'use strict';
// Pixberry Signal — staff API for the counter display (/signal) and the staff phone app (/signal/app),
// plus the device API that Signal Cubes call with their own key.
const express = require('express');
const { get, run, insert, update } = require('../db');
const U = require('../util');
const A = require('../auth');
const S = require('../signal');

const r = express.Router();
const RESPOND = A.requirePerm('signal.respond', 'orders.create', 'tables.manage');
const MANAGE = A.requirePerm('tables.manage');
const changed = branch_id => U.emit('signal.updated', { branch_id });

function me(req) {
  const row = get('SELECT section_id, on_duty FROM signal_staff WHERE user_id = ?', req.user.id);
  return { user_id: req.user.id, name: req.user.name, section_id: row?.section_id ?? null, on_duty: !!row?.on_duty, can_manage: A.can(req.user, 'tables.manage') };
}

// Everything a screen needs in one call
r.get('/signal/board', RESPOND, (req, res) => {
  const devs = S.devices(req.branchId);
  res.json({
    now: U.nowIso(), settings: U.getSetting('signal'), me: me(req),
    requests: S.openRequests(req.branchId), tables: S.floor(req.branchId), staff: S.staff(req.branchId),
    sections: require('../db').all('SELECT id, name FROM sections WHERE branch_id = ? ORDER BY sort, name', req.branchId),
    device_problems: devs.filter(d => d.problems.length).length, stats: S.stats(req.branchId),
  });
});
r.get('/signal/stats', RESPOND, (req, res) => res.json(S.stats(req.branchId)));
r.get('/signal/devices', RESPOND, (req, res) => res.json(S.devices(req.branchId)));

r.post('/signal/requests/:id/claim', RESPOND, (req, res) => {
  const out = S.claim(Number(req.params.id), req.user, req.branchId);
  U.audit(req.user, 'signal.claim', 'service_requests', out.id);
  changed(req.branchId);
  res.json(out);
});
r.post('/signal/requests/:id/done', RESPOND, (req, res) => {
  const out = S.resolve(Number(req.params.id), req.user, req.branchId);
  U.audit(req.user, 'signal.done', 'service_requests', out.id);
  changed(req.branchId);
  U.emit('table.updated', { branch_id: req.branchId });
  res.json(out);
});

// The signed-in person's shift: on duty and which section (zone) they look after
r.get('/signal/me', A.requireUser, (req, res) => res.json(me(req)));
r.put('/signal/me', RESPOND, (req, res) => {
  const cur = me(req), b = req.body || {};
  let section = b.section_id !== undefined ? (Number(b.section_id) || null) : cur.section_id;
  if (section && !get('SELECT id FROM sections WHERE id = ? AND branch_id = ?', section, req.branchId)) throw U.httpError(400, 'Unknown section');
  const onDuty = b.on_duty !== undefined ? !!b.on_duty : cur.on_duty;
  run(`INSERT INTO signal_staff (user_id, section_id, on_duty, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET section_id = excluded.section_id, on_duty = excluded.on_duty, updated_at = excluded.updated_at`, req.user.id, section, onDuty ? 1 : 0, U.nowIso());
  changed(req.branchId);
  res.json(me(req));
});

// Phone alerts (Web Push for the installed web app, FCM for the store app)
const Push = require('../push');
r.get('/signal/push/key', A.requireUser, (req, res) => res.json({ publicKey: Push.vapid().publicKey }));
r.post('/signal/push/subscribe', RESPOND, (req, res) => {
  const b = req.body || {};
  res.json(Push.subscribe(req.user.id, b.kind, b.kind === 'fcm' ? b.token : b.subscription));
});
r.post('/signal/push/unsubscribe', A.requireUser, (req, res) => res.json({ removed: Push.unsubscribe(req.user.id, req.body?.endpoint) }));
r.post('/signal/push/test', RESPOND, async (req, res) => {
  res.json(await Push.sendToUsers([req.user.id], { title: 'Pixberry Signal', body: 'Alerts are working on this phone.', tag: 'test' }));
});

// Display settings: evening (candle) mode, counter chime, display language, escalation timings
r.put('/signal/settings', MANAGE, (req, res) => {
  const cur = U.getSetting('signal'), b = req.body || {};
  const next = { ...cur };
  if (b.evening_mode !== undefined) next.evening_mode = !!b.evening_mode;
  if (b.chime !== undefined) next.chime = !!b.chime;
  if (b.language !== undefined) { if (!['en', 'ml'].includes(b.language)) throw U.httpError(400, 'Language must be en or ml'); next.language = b.language; }
  for (const k of ['escalate_after_s', 'manager_after_s']) if (b[k] !== undefined) {
    const v = parseInt(b[k], 10);
    if (!(v >= 30 && v <= 3600)) throw U.httpError(400, 'Escalation times must be between 30 and 3600 seconds');
    next[k] = v;
  }
  if (next.manager_after_s <= next.escalate_after_s) throw U.httpError(400, 'The manager alert must come after the floor alert');
  U.setSetting('signal', next);
  U.audit(req.user, 'signal.settings', 'settings', null, next);
  changed(req.branchId);
  res.json(next);
});

// Pair a cube (or hub). The key is returned once; the device sends it in X-Device-Key.
r.post('/signal/devices', MANAGE, (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'hub' ? 'hub' : 'cube';
  const tableId = b.table_id ? Number(b.table_id) : null;
  if (tableId && !get(`SELECT id FROM tables WHERE id = ? AND branch_id = ? AND active = 1`, tableId, req.branchId)) throw U.httpError(400, 'Unknown table');
  const key = `pbd_${U.token(24)}`;
  const id = insert('signal_devices', { branch_id: req.branchId, kind, name: String(b.name || '').slice(0, 60), table_id: tableId, key_hash: S.hashKey(key) });
  U.audit(req.user, 'signal.device_paired', 'signal_devices', id, { kind, table_id: tableId });
  changed(req.branchId);
  res.status(201).json({ device: S.devices(req.branchId).find(d => d.id === id), key });
});
r.put('/signal/devices/:id', MANAGE, (req, res) => {
  const d = get('SELECT * FROM signal_devices WHERE id = ? AND branch_id = ? AND active = 1', req.params.id, req.branchId);
  if (!d) throw U.httpError(404, 'Device not found');
  const patch = {};
  if (req.body?.name !== undefined) patch.name = String(req.body.name || '').slice(0, 60);
  if (req.body?.table_id !== undefined) {
    const t = req.body.table_id ? Number(req.body.table_id) : null;
    if (t && !get(`SELECT id FROM tables WHERE id = ? AND branch_id = ? AND active = 1`, t, req.branchId)) throw U.httpError(400, 'Unknown table');
    patch.table_id = t;
  }
  update('signal_devices', d.id, patch);
  U.audit(req.user, 'signal.device_updated', 'signal_devices', d.id, patch);
  changed(req.branchId);
  res.json(S.devices(req.branchId).find(x => x.id === d.id));
});
r.delete('/signal/devices/:id', MANAGE, (req, res) => {
  const d = get('SELECT * FROM signal_devices WHERE id = ? AND branch_id = ? AND active = 1', req.params.id, req.branchId);
  if (!d) throw U.httpError(404, 'Device not found');
  run('UPDATE signal_devices SET active = 0 WHERE id = ?', d.id); // its key stops working
  S.cancelCubeRequests(d.id);
  U.audit(req.user, 'signal.device_removed', 'signal_devices', d.id);
  changed(req.branchId);
  res.json({ ok: true });
});

// ---------- Device API (no staff login; each device has its own key) ----------
const device = express.Router();
const hits = new Map();
device.use((req, _res, next) => {
  const key = req.get('x-device-key');
  const d = key ? get('SELECT * FROM signal_devices WHERE key_hash = ? AND active = 1', S.hashKey(key)) : null;
  if (!d) return next(U.httpError(401, 'Unknown or removed device'));
  const now = Date.now(), h = (hits.get(d.id) || []).filter(t => now - t < 60e3);
  if (h.length >= 60) return next(U.httpError(429, 'Too many requests from this device'));
  h.push(now); hits.set(d.id, h);
  req.device = d;
  next();
});
function seen(d, body = {}) {
  const patch = { last_seen: U.nowIso() };
  if (body.battery != null && Number.isFinite(Number(body.battery))) patch.battery = Math.max(0, Math.min(100, Math.round(Number(body.battery))));
  if (body.on_coaster != null) patch.on_coaster = body.on_coaster ? 1 : 0;
  if (body.rssi != null && Number.isFinite(Number(body.rssi))) patch.rssi = Math.round(Number(body.rssi));
  if (body.firmware != null) patch.firmware = String(body.firmware).slice(0, 32);
  update('signal_devices', d.id, patch);
}
// Battery / coaster / signal report every few minutes; returns what the light should do
device.post('/heartbeat', (req, res) => {
  seen(req.device, req.body);
  const d = get('SELECT * FROM signal_devices WHERE id = ?', req.device.id);
  const health = S.deviceHealth(d);
  if (health.problems.length) changed(d.branch_id);
  res.json(S.cubeState(d));
});
// The cube settled on a face for one second
device.post('/face', (req, res) => {
  const d = req.device;
  if (d.kind !== 'cube') throw U.httpError(400, 'Only cubes send faces');
  const face = String(req.body?.face || '');
  if (!(face in S.FACES)) throw U.httpError(400, `Face must be one of: ${Object.keys(S.FACES).join(', ')}`);
  seen(d, req.body);
  run('UPDATE signal_devices SET face = ? WHERE id = ?', face, d.id);
  const type = S.FACES[face];
  if (!d.table_id) throw U.httpError(409, 'This cube is not assigned to a table yet');
  const table = get('SELECT * FROM tables WHERE id = ?', d.table_id);
  const target = table.merged_into ? get('SELECT * FROM tables WHERE id = ?', table.merged_into) || table : table;
  S.cancelCubeRequests(d.id, type); // flipping to another face replaces the unanswered request
  if (type) S.createRequest({ branchId: d.branch_id, table: target, type, source: 'cube', deviceId: d.id });
  changed(d.branch_id);
  U.emit('table.updated', { table_id: target.id, branch_id: d.branch_id });
  res.json(S.cubeState({ ...d, table_id: target.id }));
});
// Two quick shakes: cancel
device.post('/cancel', (req, res) => {
  seen(req.device, req.body);
  const n = S.cancelCubeRequests(req.device.id);
  run(`UPDATE signal_devices SET face = 'rest' WHERE id = ?`, req.device.id);
  if (n) changed(req.device.branch_id);
  res.json({ cancelled: n, ...S.cubeState(req.device) });
});

module.exports = { router: r, device };
