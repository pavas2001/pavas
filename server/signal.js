'use strict';
// Pixberry Signal — table requests from Signal Cubes and QR, answered on the counter display and the staff app.
const crypto = require('node:crypto');
const { all, get, run, insert, tx } = require('./db');
const U = require('./util');
const O = require('./orders');
const Push = require('./push');

// Request types. 'waiter' is shown to people as "Service".
const TYPES = ['waiter', 'bill', 'water', 'order', 'togo', 'other'];
// Cube faces → request type. 'rest' (the Candle face) sends nothing and cancels the cube's open request.
const FACES = { service: 'waiter', bill: 'bill', water: 'water', order: 'order', togo: 'togo', rest: null };
const LABELS = { waiter: 'Service', bill: 'Bill', water: 'Water', order: 'Ready to order', togo: 'To go', other: 'Help' };
const WHAT = { waiter: 'is calling a waiter', bill: 'asked for the bill', water: 'asked for water', order: 'is ready to order', togo: 'wants a box to take away', other: 'needs help' };

const hashKey = k => crypto.createHash('sha256').update(String(k)).digest('hex');

/** Start of the café's local day, as a UTC ISO string. */
function todayStartIso() {
  const d = U.localParts().date;
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - U.tzOffsetMinutes() * 60e3).toISOString();
}
const secondsSince = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

/**
 * Create a table request (or return the open one of the same type). Used by the QR page, cubes and staff.
 * For 'bill' with an open order, the order is marked billed and the table "bill requested".
 */
function createRequest({ branchId, table, type, source = 'qr', deviceId = null, note = '' }) {
  if (!TYPES.includes(type)) throw U.httpError(400, 'Unknown request type');
  return tx(() => {
    const existing = get(`SELECT id FROM service_requests WHERE table_id = ? AND type = ? AND status = 'open'`, table.id, type);
    const active = O.activeOrderForTable(table.id);
    if (type === 'bill' && active) {
      run(`UPDATE orders SET status = 'billed' WHERE id = ? AND status = 'open'`, active.id);
      run(`UPDATE tables SET status = 'bill_requested' WHERE id = ?`, table.id);
    }
    if (existing) return { id: existing.id, already: true };
    const id = insert('service_requests', { branch_id: branchId, table_id: table.id, order_id: active?.id ?? null, type, source, device_id: deviceId, note: String(note || '').slice(0, 200) });
    U.notify({ branch_id: branchId, audience: 'staff', type: `request_${type}`, message: `${table.label} ${WHAT[type]}${note ? `: ${String(note).slice(0, 80)}` : ''}`, ref: `table:${table.id}` });
    Push.notifyRequest({ branchId, tableLabel: table.label, sectionId: table.section_id ?? null, label: LABELS[type], requestId: id });
    return { id, already: false };
  });
}

/** Cancel a cube's unanswered requests (Candle face, a shake, or flipping to another face). */
function cancelCubeRequests(deviceId, exceptType = null) {
  return run(`UPDATE service_requests SET status = 'cancelled', resolved_at = ? WHERE device_id = ? AND status = 'open' AND claimed_by IS NULL${exceptType ? ' AND type != ?' : ''}`,
    U.nowIso(), deviceId, ...(exceptType ? [exceptType] : [])).changes;
}

function claim(id, user, branchId) {
  const r = get(`SELECT * FROM service_requests WHERE id = ? AND branch_id = ?`, id, branchId);
  if (!r) throw U.httpError(404, 'Request not found');
  if (r.status !== 'open') throw U.httpError(409, 'This request is already finished');
  if (r.claimed_by && r.claimed_by !== user.id) {
    const who = get('SELECT name FROM users WHERE id = ?', r.claimed_by)?.name || 'someone';
    throw U.httpError(409, `${who} is already on the way`);
  }
  run(`UPDATE service_requests SET claimed_by = ?, claimed_at = COALESCE(claimed_at, ?) WHERE id = ?`, user.id, U.nowIso(), id);
  return get('SELECT * FROM service_requests WHERE id = ?', id);
}
function resolve(id, user, branchId) {
  const r = get(`SELECT * FROM service_requests WHERE id = ? AND branch_id = ?`, id, branchId);
  if (!r) throw U.httpError(404, 'Request not found');
  if (r.status !== 'open') return r;
  const now = U.nowIso();
  run(`UPDATE service_requests SET status = 'done', resolved_at = ?, resolved_by = ?, claimed_by = COALESCE(claimed_by, ?), claimed_at = COALESCE(claimed_at, ?) WHERE id = ?`, now, user?.id ?? null, user?.id ?? null, now, id);
  return get('SELECT * FROM service_requests WHERE id = ?', id);
}

function openRequests(branchId) {
  const cfg = U.getSetting('signal');
  return all(`SELECT sr.id, sr.type, sr.source, sr.note, sr.table_id, sr.created_at, sr.claimed_by, sr.claimed_at, sr.escalation,
      t.label AS table_label, t.section_id, s.name AS section_name, u.name AS claimed_by_name
    FROM service_requests sr LEFT JOIN tables t ON t.id = sr.table_id LEFT JOIN sections s ON s.id = t.section_id LEFT JOIN users u ON u.id = sr.claimed_by
    WHERE sr.branch_id = ? AND sr.status = 'open' ORDER BY sr.created_at`, branchId)
    .map(r => ({ ...r, label: LABELS[r.type] || r.type, age_s: secondsSince(r.created_at), late: !r.claimed_by && secondsSince(r.created_at) >= cfg.escalate_after_s }));
}

function floor(branchId) {
  const reqs = all(`SELECT table_id, type, claimed_by FROM service_requests WHERE branch_id = ? AND status = 'open' ORDER BY created_at`, branchId);
  return all(`SELECT t.id, t.label, t.seats, t.kind, t.status, t.section_id, s.name AS section_name,
      o.id AS order_id, o.total AS order_total, o.created_at AS order_created_at,
      d.id AS device_id, d.battery, d.on_coaster, d.last_seen
    FROM tables t LEFT JOIN sections s ON s.id = t.section_id
    LEFT JOIN orders o ON o.id = (SELECT id FROM orders WHERE table_id = t.id AND status IN ('open','billed') ORDER BY id LIMIT 1)
    LEFT JOIN signal_devices d ON d.id = (SELECT id FROM signal_devices WHERE table_id = t.id AND active = 1 AND kind = 'cube' ORDER BY id LIMIT 1)
    WHERE t.branch_id = ? AND t.active = 1 AND t.kind = 'table' ORDER BY s.sort, t.sort, t.label`, branchId)
    .map(t => {
      const r = reqs.find(x => x.table_id === t.id);
      return { ...t, request_type: r?.type || null, request_claimed: !!r?.claimed_by, seated_min: t.order_created_at ? Math.floor(secondsSince(t.order_created_at) / 60) : null };
    });
}

function deviceHealth(d) {
  const offline = !d.last_seen || secondsSince(d.last_seen) > 600;
  const problems = [];
  if (offline) problems.push('offline');
  if (d.kind === 'cube' && d.on_coaster === 0) problems.push('off_coaster');
  if (d.battery != null && d.battery < 25) problems.push('low_battery');
  return { offline, problems };
}
function devices(branchId) {
  return all(`SELECT d.id, d.kind, d.name, d.table_id, t.label AS table_label, d.face, d.battery, d.on_coaster, d.rssi, d.firmware, d.last_seen, d.created_at
    FROM signal_devices d LEFT JOIN tables t ON t.id = d.table_id WHERE d.branch_id = ? AND d.active = 1 ORDER BY d.kind, t.sort, t.label, d.id`, branchId)
    .map(d => ({ ...d, ...deviceHealth(d) }))
    .sort((a, b) => b.problems.length - a.problems.length);
}

function staff(branchId) {
  return all(`SELECT u.id, u.name, u.role, ss.section_id, s.name AS section_name, COALESCE(ss.on_duty, 0) AS on_duty,
      (SELECT COUNT(*) FROM service_requests sr WHERE sr.claimed_by = u.id AND sr.status = 'open') AS open_claims
    FROM users u LEFT JOIN signal_staff ss ON ss.user_id = u.id LEFT JOIN sections s ON s.id = ss.section_id
    WHERE u.active = 1 AND (u.branch_id IS NULL OR u.branch_id = ?) AND COALESCE(ss.on_duty, 0) = 1 ORDER BY u.name`, branchId);
}

function stats(branchId) {
  const since = todayStartIso();
  const rows = all(`SELECT sr.type, sr.status, sr.created_at, sr.claimed_at, sr.resolved_at, sr.escalation, sr.resolved_by, u.name AS resolved_by_name
    FROM service_requests sr LEFT JOIN users u ON u.id = sr.resolved_by WHERE sr.branch_id = ? AND sr.created_at >= ? AND sr.status != 'cancelled'`, branchId, since);
  const by_type = Object.fromEntries(TYPES.filter(t => t !== 'other').map(t => [t, 0]));
  const by_staff = {};
  const times = [];
  for (const r of rows) {
    by_type[r.type] = (by_type[r.type] || 0) + 1;
    const first = r.claimed_at || r.resolved_at;
    if (first) times.push(Math.max(0, (Date.parse(first) - Date.parse(r.created_at)) / 1000));
    if (r.resolved_by_name) by_staff[r.resolved_by_name] = (by_staff[r.resolved_by_name] || 0) + 1;
  }
  return {
    total: rows.length, open: rows.filter(r => r.status === 'open').length,
    late: rows.filter(r => r.escalation > 0).length,
    avg_response_s: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    fastest_s: times.length ? Math.round(Math.min(...times)) : null,
    by_type, by_staff: Object.entries(by_staff).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
  };
}

/** What a cube should show: its own request and whether someone is on the way. */
function cubeState(device) {
  const cfg = U.getSetting('signal');
  const r = device.table_id ? get(`SELECT id, type, claimed_by, created_at FROM service_requests WHERE table_id = ? AND status = 'open' ORDER BY created_at LIMIT 1`, device.table_id) : null;
  const t = device.table_id ? get('SELECT label FROM tables WHERE id = ?', device.table_id) : null;
  return {
    table: t?.label || null,
    request: r ? { id: r.id, type: r.type, acknowledged: !!r.claimed_by, late: !r.claimed_by && secondsSince(r.created_at) >= cfg.escalate_after_s } : null,
    // light: off | request (steady) | acknowledged (slow breathe) | late (pulse) | candle (evening flicker)
    light: r ? (r.claimed_by ? 'acknowledged' : secondsSince(r.created_at) >= cfg.escalate_after_s ? 'late' : 'request') : (cfg.evening_mode ? 'candle' : 'off'),
    evening_mode: !!cfg.evening_mode,
  };
}

/** Escalate unanswered requests: first to the whole floor, then to the manager. Called by a background job. */
function escalate() {
  const cfg = U.getSetting('signal');
  const now = Date.now();
  let changed = 0;
  for (const r of all(`SELECT sr.id, sr.branch_id, sr.type, sr.created_at, sr.escalation, t.label, t.section_id FROM service_requests sr LEFT JOIN tables t ON t.id = sr.table_id
                       WHERE sr.status = 'open' AND sr.claimed_by IS NULL AND sr.escalation < 2`)) {
    const age = (now - Date.parse(r.created_at)) / 1000;
    const level = age >= cfg.manager_after_s ? 2 : age >= cfg.escalate_after_s ? 1 : 0;
    if (level <= r.escalation) continue;
    run('UPDATE service_requests SET escalation = ? WHERE id = ?', level, r.id);
    const mins = Math.floor(age / 60);
    if (level >= 1 && r.escalation < 1) U.notify({ branch_id: r.branch_id, audience: 'staff', type: 'request_late', message: `Late: ${r.label || 'A table'} · ${LABELS[r.type]} waiting ${mins} min`, ref: `request:${r.id}` });
    if (level >= 2) U.notify({ branch_id: r.branch_id, audience: 'manager', type: 'request_late', message: `${r.label || 'A table'} has waited ${mins} min for ${LABELS[r.type].toLowerCase()} and nobody has answered`, ref: `request:${r.id}` });
    Push.notifyRequest({ branchId: r.branch_id, tableLabel: r.label || 'A table', sectionId: r.section_id, label: LABELS[r.type], requestId: r.id, level, minutes: mins });
    U.emit('signal.updated', { branch_id: r.branch_id });
    changed++;
  }
  return changed;
}

module.exports = { TYPES, FACES, LABELS, hashKey, createRequest, cancelCubeRequests, claim, resolve, openRequests, floor, devices, deviceHealth, staff, stats, cubeState, escalate, todayStartIso };
