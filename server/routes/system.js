'use strict';
// Auth, settings, branches (incl. café location / geofence), notifications, messages, audit, backups.
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, insert, update, tableNames, db, DATA_DIR } = require('../db');
const U = require('../util');
const A = require('../auth');
const { crud, pick } = require('../crud');

const r = express.Router();
const BACKUP_DIR = process.env.PIXBERRY_BACKUP_DIR || path.join(DATA_DIR, '..', 'backups');

// ---------- Auth ----------
r.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw U.httpError(400, 'Username and password are required');
  A.checkThrottle(req, username);
  const u = get('SELECT * FROM users WHERE username = ?', String(username));
  if (!u || !u.active || !A.verifyPassword(password, u.password_hash)) {
    A.recordFail(req, username);
    U.audit(null, 'auth.failed', 'user', u?.id, { username });
    throw U.httpError(401, 'Incorrect username or password');
  }
  A.clearFails(req, username);
  const t = A.createSession(u.id);
  U.audit(u, 'auth.login', 'user', u.id);
  res.json({ token: t, user: A.userFromToken(t) });
});
r.post('/auth/logout', A.requireUser, (req, res) => { run('DELETE FROM sessions WHERE token = ?', req.sessionToken); res.json({ ok: true }); });
r.get('/auth/me', A.requireUser, (req, res) => {
  const att = get('SELECT * FROM attendance WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1', req.user.id);
  res.json({ user: req.user, clocked_in: att || null, branches: all('SELECT id, name FROM branches WHERE active = 1 ORDER BY id'), permissions: A.PERMISSIONS, cafe: U.getSetting('cafe'), currency: U.getSetting('currency') });
});
r.post('/auth/password', A.requireUser, (req, res) => {
  const { current, next } = req.body || {};
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!A.verifyPassword(current || '', u.password_hash)) throw U.httpError(400, 'Current password is incorrect');
  if (String(next || '').length < 8) throw U.httpError(400, 'New password must be at least 8 characters');
  run('UPDATE users SET password_hash = ? WHERE id = ?', A.hashPassword(next), u.id);
  run('DELETE FROM sessions WHERE user_id = ? AND token != ?', u.id, req.sessionToken);
  U.audit(req.user, 'auth.password_changed', 'user', u.id);
  res.json({ ok: true });
});

// ---------- Clock in / out ----------
r.post('/attendance/clock-in', A.requireUser, (req, res) => {
  if (get('SELECT id FROM attendance WHERE user_id = ? AND clock_out IS NULL', req.user.id)) throw U.httpError(409, 'Already clocked in');
  const id = insert('attendance', { user_id: req.user.id, branch_id: req.branchId, clock_in: U.nowIso() });
  U.audit(req.user, 'attendance.clock_in', 'attendance', id);
  res.json(get('SELECT * FROM attendance WHERE id = ?', id));
});
r.post('/attendance/clock-out', A.requireUser, (req, res) => {
  const a = get('SELECT * FROM attendance WHERE user_id = ? AND clock_out IS NULL ORDER BY id DESC LIMIT 1', req.user.id);
  if (!a) throw U.httpError(409, 'Not clocked in');
  run('UPDATE attendance SET clock_out = ? WHERE id = ?', U.nowIso(), a.id);
  U.audit(req.user, 'attendance.clock_out', 'attendance', a.id);
  res.json(get('SELECT * FROM attendance WHERE id = ?', a.id));
});

// ---------- Settings ----------
const SECRET_PATHS = [['messaging', 'whatsapp', 'token'], ['messaging', 'sms', 'token'], ['messaging', 'email', 'token']];
r.get('/settings', A.requireUser, (req, res) => {
  const s = U.allSettings();
  if (!A.can(req.user, 'settings.manage')) { delete s.messaging; delete s.permissions; }
  else for (const [a, b, c] of SECRET_PATHS) if (s[a]?.[b]?.[c]) s[a][b][c] = '••••••';
  s.role_permissions = A.rolePermissions();
  s.roles = A.ROLES;
  res.json(s);
});
r.put('/settings/:key', A.requirePerm('settings.manage'), (req, res) => {
  const key = req.params.key;
  if (!(key in U.DEFAULT_SETTINGS)) throw U.httpError(400, `Unknown setting: ${key}`);
  let value = req.body?.value;
  if (key === 'messaging') {
    const cur = U.getSetting('messaging');
    for (const ch of ['whatsapp', 'sms', 'email']) if (value?.[ch]?.token === '••••••') value[ch].token = cur[ch]?.token || '';
  }
  if (key === 'permissions') {
    const clean = {};
    for (const role of A.ROLES.filter(x => x !== 'admin')) clean[role] = (value?.[role] || []).filter(p => p in A.PERMISSIONS);
    value = clean;
  }
  if (key === 'tax' && value) { value.rate = Number(value.rate) || 0; if (!['inclusive', 'exclusive'].includes(value.mode)) value.mode = 'exclusive'; }
  if (key === 'timezone') { try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { throw U.httpError(400, 'Unknown timezone'); } }
  U.setSetting(key, value);
  U.audit(req.user, 'settings.update', 'settings', null, { key });
  res.json({ ok: true, value: U.getSetting(key) });
});

// ---------- Branches (multi-branch + café location for the QR geofence) ----------
const branchFields = {
  name: 'str:required', address: 'str', phone: 'str',
  lat: 'real', lng: 'real', radius_m: 'int', geofence_enabled: 'bool', accuracy_tolerance_m: 'int', max_accuracy_m: 'int', active: 'bool',
};
crud(r, '/branches', {
  table: 'branches', perm: 'settings.manage', readPerm: 'any', fields: branchFields, order: 'id', noDelete: true,
  auditFields: ['name', 'lat', 'lng', 'radius_m', 'geofence_enabled'],
  beforeSave(d) {
    if (d.lat != null && (d.lat < -90 || d.lat > 90)) throw U.httpError(400, 'Latitude must be between -90 and 90');
    if (d.lng != null && (d.lng < -180 || d.lng > 180)) throw U.httpError(400, 'Longitude must be between -180 and 180');
    if (d.radius_m != null && (d.radius_m < 10 || d.radius_m > 50000)) throw U.httpError(400, 'Radius must be between 10 m and 50 km');
    if (d.accuracy_tolerance_m != null && (d.accuracy_tolerance_m < 0 || d.accuracy_tolerance_m > 500)) throw U.httpError(400, 'Accuracy tolerance must be 0–500 m');
    if (d.max_accuracy_m != null && (d.max_accuracy_m < 20 || d.max_accuracy_m > 10000)) throw U.httpError(400, 'Max accuracy must be 20–10000 m');
  },
  onChange(id) {
    // every branch needs a default stock location
    if (!get('SELECT id FROM stock_locations WHERE branch_id = ?', id)) insert('stock_locations', { branch_id: id, name: 'Main store', is_default: 1 });
  },
});
// Test the geofence from the admin screen: "would an order from here be accepted?"
r.post('/branches/:id/geofence-test', A.requirePerm('settings.manage'), (req, res) => {
  const b = get('SELECT * FROM branches WHERE id = ?', req.params.id);
  if (!b) throw U.httpError(404, 'Branch not found');
  res.json(U.checkGeofence(b, req.body));
});

// ---------- Notifications ----------
r.get('/notifications', A.requireUser, (req, res) => {
  const aud = ['staff'];
  if (A.can(req.user, 'kds.view')) aud.push('kitchen');
  if (A.can(req.user, 'reports.view') || A.can(req.user, 'inventory.manage')) aud.push('manager');
  res.json(all(`SELECT * FROM notifications WHERE audience IN (${aud.map(() => '?').join(',')}) AND (branch_id IS NULL OR branch_id = ?) ORDER BY id DESC LIMIT 100`, ...aud, req.branchId));
});
r.post('/notifications/read-all', A.requireUser, (req, res) => { run('UPDATE notifications SET is_read = 1 WHERE branch_id IS NULL OR branch_id = ?', req.branchId); res.json({ ok: true }); });
r.post('/notifications/:id/read', A.requireUser, (req, res) => { run('UPDATE notifications SET is_read = 1 WHERE id = ?', req.params.id); res.json({ ok: true }); });

r.get('/outbox', A.requirePerm('settings.manage', 'customers.manage'), (_req, res) => res.json(all('SELECT * FROM outbox ORDER BY id DESC LIMIT 200')));
r.post('/outbox/send', A.requirePerm('customers.manage', 'payments.take'), (req, res) => {
  const { channel, to, body, subject } = req.body || {};
  if (!['whatsapp', 'sms', 'email'].includes(channel) || !to || !body) throw U.httpError(400, 'channel, to and body are required');
  const id = U.queueMessage(channel, String(to), String(body).slice(0, 2000), subject || '');
  U.audit(req.user, 'message.send', 'outbox', id, { channel, to });
  res.json(get('SELECT * FROM outbox WHERE id = ?', id));
});

// ---------- Audit ----------
r.get('/audit', A.requirePerm('audit.view', 'staff.manage'), (req, res) => {
  const where = [], p = [];
  if (req.query.user_id) { where.push('user_id = ?'); p.push(req.query.user_id); }
  if (req.query.entity) { where.push('entity = ?'); p.push(req.query.entity); }
  if (req.query.entity_id) { where.push('entity_id = ?'); p.push(req.query.entity_id); }
  if (req.query.q) { where.push('(action LIKE ? OR details LIKE ?)'); p.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  res.json(all(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Math.min(Number(req.query.limit) || 300, 2000)}`, ...p));
});

// ---------- Backup & export ----------
function backupNow(tag = 'manual') {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `pixberry-${tag}-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const keep = (U.getSetting('backup')?.keep_days || 14) * 86400e3;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    const fp = path.join(BACKUP_DIR, f);
    if (f.endsWith('.db') && Date.now() - fs.statSync(fp).mtimeMs > keep) fs.unlinkSync(fp);
  }
  return path.basename(file);
}
r.get('/backups', A.requirePerm('settings.manage'), (_req, res) => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  res.json(fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).map(f => ({ file: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size, at: fs.statSync(path.join(BACKUP_DIR, f)).mtime })).sort((a, b) => b.at - a.at));
});
r.post('/backups', A.requirePerm('settings.manage'), (req, res) => {
  const f = backupNow('manual');
  U.audit(req.user, 'backup.create', 'backup', null, { file: f });
  res.json({ file: f });
});
r.get('/backups/:file', A.requirePerm('settings.manage'), (req, res) => {
  const f = path.basename(req.params.file);
  const fp = path.join(BACKUP_DIR, f);
  if (!f.endsWith('.db') || !fs.existsSync(fp)) throw U.httpError(404, 'Backup not found');
  res.download(fp);
});
r.get('/export/all.json', A.requirePerm('settings.manage'), (req, res) => {
  const out = { exported_at: U.nowIso(), app: 'pixberry-erp', tables: {} };
  for (const t of tableNames()) if (!['sessions'].includes(t)) out.tables[t] = all(`SELECT * FROM ${t}`).map(row => t === 'users' ? { ...row, password_hash: undefined } : row);
  U.audit(req.user, 'export.all', 'export', null);
  res.setHeader('content-disposition', `attachment; filename="pixberry-export-${U.localParts().date}.json"`);
  res.json(out);
});

module.exports = { router: r, backupNow, BACKUP_DIR };
