'use strict';
// Staff accounts, attendance & shifts, customers & loyalty, coupons, feedback.
const express = require('express');
const { all, get, run, insert, update, tx } = require('../db');
const U = require('../util');
const A = require('../auth');
const { crud } = require('../crud');

const r = express.Router();

// ---------- Staff ----------
r.get('/staff', A.requirePerm('staff.manage'), (_req, res) => {
  res.json(all(`SELECT u.id, u.name, u.username, u.role, u.phone, u.branch_id, u.active, u.created_at, b.name AS branch_name,
    (SELECT clock_in FROM attendance a WHERE a.user_id = u.id AND a.clock_out IS NULL ORDER BY id DESC LIMIT 1) AS clocked_in_at
    FROM users u LEFT JOIN branches b ON b.id = u.branch_id ORDER BY u.active DESC, u.name`));
});
r.post('/staff', A.requirePerm('staff.manage'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.username) throw U.httpError(400, 'Name and username are required');
  if (String(b.password || '').length < 8) throw U.httpError(400, 'Password must be at least 8 characters');
  if (!A.ROLES.includes(b.role)) throw U.httpError(400, 'Invalid role');
  if (b.role === 'admin' && req.user.role !== 'admin') throw U.httpError(403, 'Only an admin can create admins');
  if (get('SELECT id FROM users WHERE username = ?', b.username)) throw U.httpError(409, 'Username already taken');
  const id = insert('users', { name: b.name, username: String(b.username).trim(), password_hash: A.hashPassword(b.password), role: b.role, phone: b.phone || '', branch_id: b.branch_id || null });
  U.audit(req.user, 'staff.create', 'user', id, { username: b.username, role: b.role });
  res.status(201).json(get('SELECT id, name, username, role, phone, branch_id, active FROM users WHERE id = ?', id));
});
r.put('/staff/:id', A.requirePerm('staff.manage'), (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!u) throw U.httpError(404, 'Not found');
  const b = req.body || {};
  if ((u.role === 'admin' || b.role === 'admin') && req.user.role !== 'admin') throw U.httpError(403, 'Only an admin can change admin accounts');
  const patch = {};
  for (const k of ['name', 'phone']) if (b[k] != null) patch[k] = String(b[k]);
  if (b.role) { if (!A.ROLES.includes(b.role)) throw U.httpError(400, 'Invalid role'); patch.role = b.role; }
  if (b.branch_id !== undefined) patch.branch_id = b.branch_id || null;
  if (b.active != null) patch.active = b.active ? 1 : 0;
  if (b.password) { if (String(b.password).length < 8) throw U.httpError(400, 'Password must be at least 8 characters'); patch.password_hash = A.hashPassword(b.password); }
  if (u.id === req.user.id && (patch.active === 0 || (patch.role && patch.role !== u.role))) throw U.httpError(400, "You can't deactivate yourself or change your own role");
  if (u.role === 'admin' && (patch.active === 0 || (patch.role && patch.role !== 'admin')) && get(`SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1`).n <= 1) throw U.httpError(400, 'Keep at least one active admin');
  update('users', u.id, patch);
  if (patch.password_hash || patch.active === 0) run('DELETE FROM sessions WHERE user_id = ?', u.id);
  U.audit(req.user, 'staff.update', 'user', u.id, Object.keys(patch).filter(k => k !== 'password_hash').concat(patch.password_hash ? ['password'] : []));
  res.json(get('SELECT id, name, username, role, phone, branch_id, active FROM users WHERE id = ?', u.id));
});
// Activity: orders created, payments taken, audit trail for one staff member
r.get('/staff/:id/activity', A.requirePerm('staff.manage', 'audit.view'), (req, res) => {
  const id = Number(req.params.id);
  res.json({
    audit: all('SELECT * FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 200', id),
    orders: get(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM orders WHERE created_by = ? AND status = 'paid'`, id),
    payments: all(`SELECT method, kind, COUNT(*) AS n, SUM(amount) AS amount FROM payments WHERE created_by = ? GROUP BY method, kind`, id),
    attendance: all('SELECT * FROM attendance WHERE user_id = ? ORDER BY id DESC LIMIT 60', id),
  });
});

// ---------- Attendance & shifts ----------
r.get('/attendance', A.requirePerm('staff.manage'), (req, res) => {
  const from = req.query.from || new Date(Date.now() - 14 * 86400e3).toISOString();
  res.json(all(`SELECT a.*, u.name AS user_name, u.role,
      ROUND((julianday(COALESCE(a.clock_out, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(a.clock_in)) * 24, 2) AS hours
    FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.clock_in >= ? ${req.query.user_id ? 'AND a.user_id = ?' : ''} ORDER BY a.id DESC`, ...[from].concat(req.query.user_id ? [req.query.user_id] : [])));
});
r.put('/attendance/:id', A.requirePerm('staff.manage'), (req, res) => {
  const a = get('SELECT * FROM attendance WHERE id = ?', req.params.id);
  if (!a) throw U.httpError(404, 'Not found');
  const patch = {};
  if (req.body.clock_in) patch.clock_in = new Date(req.body.clock_in).toISOString();
  if (req.body.clock_out) patch.clock_out = new Date(req.body.clock_out).toISOString();
  if (req.body.notes != null) patch.notes = String(req.body.notes);
  update('attendance', a.id, patch);
  U.audit(req.user, 'attendance.edit', 'attendance', a.id, patch);
  res.json(get('SELECT * FROM attendance WHERE id = ?', a.id));
});
crud(r, '/shifts', { table: 'shifts', perm: 'staff.manage', readPerm: 'any', branchScoped: true, filters: ['user_id', 'date'], order: 'date DESC, start_time',
  select: 'SELECT s.*, u.name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id', alias: 's',
  fields: { branch_id: 'int', user_id: 'int:required', date: 'date:required', start_time: 'time:required', end_time: 'time:required', notes: 'str' } });

// ---------- Customers & loyalty ----------
crud(r, '/customers', {
  table: 'customers', perm: 'customers.manage', order: 'id DESC', search: ['name', 'phone', 'email'],
  select: `SELECT c.*, (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid') AS visits,
           (SELECT COALESCE(SUM(total),0) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid') AS spent,
           (SELECT MAX(created_at) FROM orders o WHERE o.customer_id = c.id) AS last_visit FROM customers c`,
  fields: { name: 'str', phone: 'str:required', email: 'str', consent: 'bool', preferences: 'str' },
  beforeSave(d, _req, before) {
    if (d.phone) d.phone = d.phone.replace(/[^\d+]/g, '');
    if (d.consent && !before?.consent) d.consent_at = U.nowIso();
  },
  auditFields: ['phone'],
});
r.get('/customers/:id/history', A.requirePerm('customers.manage'), (req, res) => {
  res.json({
    orders: all(`SELECT id, number, type, status, total, created_at, invoice_no FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 100`, req.params.id),
    favourites: all(`SELECT oi.name, SUM(oi.qty) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.customer_id = ? AND oi.kds_status != 'cancelled' GROUP BY oi.name ORDER BY qty DESC LIMIT 5`, req.params.id),
    loyalty: all('SELECT * FROM loyalty_txns WHERE customer_id = ? ORDER BY id DESC LIMIT 100', req.params.id),
    feedback: all('SELECT * FROM feedback WHERE customer_id = ? ORDER BY id DESC', req.params.id),
  });
});
// Adjust or redeem points. Redeeming on an order applies a flat discount worth points × point_value.
r.post('/customers/:id/points', A.requirePerm('customers.manage'), (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', req.params.id);
  if (!c) throw U.httpError(404, 'Not found');
  const pts = parseInt(req.body?.points, 10);
  if (!pts) throw U.httpError(400, 'Points required');
  if (c.points + pts < 0) throw U.httpError(400, `Customer only has ${c.points} points`);
  const orderId = req.body?.order_id ? Number(req.body.order_id) : null;
  tx(() => {
    if (orderId && pts < 0) {
      const o = get(`SELECT * FROM orders WHERE id = ? AND status IN ('open','billed')`, orderId);
      if (!o) throw U.httpError(400, 'Order not open');
      if (!A.can(req.user, 'orders.discount')) throw U.httpError(403, 'Redeeming on an order needs discount permission');
      const value = -pts * (U.getSetting('loyalty').point_value || 100);
      update('orders', o.id, { discount_type: 'flat', discount_value: (o.discount_type === 'flat' ? o.discount_value : 0) + value, coupon_code: null, customer_id: c.id });
      require('../orders').recalc(o.id);
    }
    insert('loyalty_txns', { customer_id: c.id, order_id: orderId, points: pts, reason: req.body?.reason || (pts < 0 ? 'Redeemed' : 'Adjusted') });
    run('UPDATE customers SET points = points + ? WHERE id = ?', pts, c.id);
  });
  U.audit(req.user, 'customers.points', 'customers', c.id, { points: pts, order_id: orderId });
  res.json(get('SELECT * FROM customers WHERE id = ?', c.id));
});
r.post('/customers/:id/message', A.requirePerm('customers.manage'), (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', req.params.id);
  if (!c) throw U.httpError(404, 'Not found');
  if (!c.consent) throw U.httpError(400, 'This customer has not consented to messages');
  U.messageCustomer({ phone: c.phone, email: c.email }, String(req.body?.body || '').slice(0, 1000), req.body?.subject || '');
  U.audit(req.user, 'customers.message', 'customers', c.id);
  res.json({ ok: true });
});

crud(r, '/coupons', { table: 'coupons', perm: 'customers.manage', readPerm: ['customers.manage', 'orders.discount'], order: 'active DESC, id DESC', auditFields: ['code', 'type', 'value'],
  fields: { code: 'str:required', description: 'str', type: 'str', value: 'int:required', min_order: 'money', max_discount: 'money', max_uses: 'int', expires_at: 'date', active: 'bool' },
  beforeSave(d) { if (d.code) d.code = d.code.trim().toUpperCase(); if (d.type && !['percent', 'flat'].includes(d.type)) throw U.httpError(400, 'Type must be percent or flat'); } });

r.get('/feedback', A.requirePerm('customers.manage', 'reports.view'), (_req, res) => {
  res.json({
    items: all(`SELECT f.*, o.number, o.invoice_no, c.name AS customer_name, c.phone FROM feedback f LEFT JOIN orders o ON o.id = f.order_id LEFT JOIN customers c ON c.id = f.customer_id ORDER BY f.id DESC LIMIT 300`),
    summary: get('SELECT COUNT(*) AS n, ROUND(AVG(rating), 2) AS avg FROM feedback'),
  });
});

module.exports = { router: r };
