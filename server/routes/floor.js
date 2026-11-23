'use strict';
// Tables, floor sections, QR codes, reservations and waitlist.
const express = require('express');
const QRCode = require('qrcode');
const { all, get, run, insert, update, tx } = require('../db');
const U = require('../util');
const A = require('../auth');
const O = require('../orders');
const { crud } = require('../crud');

const r = express.Router();

crud(r, '/sections', { table: 'sections', perm: 'tables.manage', readPerm: 'any', branchScoped: true, order: 'sort, name', fields: { branch_id: 'int', name: 'str:required', sort: 'int' }, auditFields: ['name'] });

r.get('/tables', A.requireUser, (req, res) => {
  const rows = all(`SELECT t.*, s.name AS section_name,
      o.id AS order_id, o.number AS order_number, o.total AS order_total, o.paid AS order_paid, o.created_at AS order_created_at, o.status AS order_status,
      (SELECT COUNT(*) FROM service_requests sr WHERE sr.table_id = t.id AND sr.status = 'open') AS open_requests,
      (SELECT label FROM tables m WHERE m.id = t.merged_into) AS merged_into_label
    FROM tables t LEFT JOIN sections s ON s.id = t.section_id
    LEFT JOIN orders o ON o.id = (SELECT id FROM orders WHERE table_id = t.id AND status IN ('open','billed') ORDER BY id LIMIT 1)
    WHERE t.branch_id = ? AND t.active = 1 ORDER BY s.sort, t.sort, t.label`, req.branchId);
  res.json(rows.map(({ qr_token, ...t }) => (A.can(req.user, 'tables.manage') ? { ...t, qr_token } : t)));
});
r.post('/tables', A.requirePerm('tables.manage'), (req, res) => {
  const b = req.body || {};
  const count = Math.max(1, Math.min(100, parseInt(b.count, 10) || 1));
  const ids = tx(() => {
    const out = [];
    const start = parseInt(b.start, 10);
    for (let i = 0; i < count; i++) {
      const label = count > 1 ? `${b.prefix ?? 'T'}${(Number.isFinite(start) ? start : 1) + i}` : String(b.label || '').trim();
      if (!label) throw U.httpError(400, 'Table label is required');
      out.push(insert('tables', { branch_id: req.branchId, section_id: b.section_id || null, label, seats: parseInt(b.seats, 10) || 4, kind: b.kind === 'counter' ? 'counter' : 'table', qr_token: U.token(12), sort: parseInt(b.sort, 10) || 0 }));
    }
    return out;
  });
  U.audit(req.user, 'tables.create', 'tables', ids[0], { count });
  U.emit('table.updated', { branch_id: req.branchId });
  res.status(201).json(ids.map(id => get('SELECT * FROM tables WHERE id = ?', id)));
});
r.put('/tables/:id', A.requirePerm('tables.manage'), (req, res) => {
  const t = get('SELECT * FROM tables WHERE id = ? AND branch_id = ?', req.params.id, req.branchId);
  if (!t) throw U.httpError(404, 'Table not found');
  const patch = {};
  if (req.body.label != null) patch.label = String(req.body.label).trim() || t.label;
  if (req.body.seats != null) patch.seats = parseInt(req.body.seats, 10) || t.seats;
  if (req.body.section_id !== undefined) patch.section_id = req.body.section_id || null;
  if (req.body.kind) patch.kind = req.body.kind === 'counter' ? 'counter' : 'table';
  if (req.body.sort != null) patch.sort = parseInt(req.body.sort, 10) || 0;
  if (req.body.status) {
    if (!['available', 'ordering', 'occupied', 'bill_requested', 'cleaning'].includes(req.body.status)) throw U.httpError(400, 'Invalid status');
    if (req.body.status === 'available' && O.activeOrderForTable(t.id)) throw U.httpError(409, 'Settle the open order before marking the table available');
    patch.status = req.body.status;
  }
  update('tables', t.id, patch);
  U.audit(req.user, 'tables.update', 'tables', t.id, patch);
  U.emit('table.updated', { table_id: t.id, branch_id: req.branchId });
  res.json(get('SELECT * FROM tables WHERE id = ?', t.id));
});
r.post('/tables/:id/regenerate-qr', A.requirePerm('tables.manage'), (req, res) => {
  const t = get('SELECT * FROM tables WHERE id = ? AND branch_id = ?', req.params.id, req.branchId);
  if (!t) throw U.httpError(404, 'Table not found');
  update('tables', t.id, { qr_token: U.token(12) });
  U.audit(req.user, 'tables.regenerate_qr', 'tables', t.id, { label: t.label });
  res.json(get('SELECT * FROM tables WHERE id = ?', t.id));
});
r.delete('/tables/:id', A.requirePerm('tables.manage'), (req, res) => {
  const t = get('SELECT * FROM tables WHERE id = ? AND branch_id = ?', req.params.id, req.branchId);
  if (!t) throw U.httpError(404, 'Table not found');
  if (O.activeOrderForTable(t.id)) throw U.httpError(409, 'Table has an open order');
  update('tables', t.id, { active: 0, qr_token: U.token(12) }); // old QR stops working
  U.audit(req.user, 'tables.delete', 'tables', t.id, { label: t.label });
  res.json({ ok: true });
});
// Combine tables (seat a big group): child tables point at the main table; QR scans on any of them join the main order
r.post('/tables/:id/merge', A.requirePerm('orders.transfer', 'tables.manage'), (req, res) => {
  const main = get('SELECT * FROM tables WHERE id = ? AND branch_id = ?', req.params.id, req.branchId);
  if (!main) throw U.httpError(404, 'Table not found');
  const ids = (req.body?.table_ids || []).map(Number).filter(id => id !== main.id);
  tx(() => {
    for (const id of ids) {
      const t = get('SELECT * FROM tables WHERE id = ? AND branch_id = ?', id, req.branchId);
      if (!t) continue;
      const o = O.activeOrderForTable(t.id);
      const mo = O.activeOrderForTable(main.id);
      if (o && mo) { // combine orders as well
        run('UPDATE order_items SET order_id = ? WHERE order_id = ?', mo.id, o.id);
        run('UPDATE payments SET order_id = ? WHERE order_id = ?', mo.id, o.id);
        run('UPDATE orders SET paid = paid + ?, refunded = refunded + ? WHERE id = ?', o.paid, o.refunded, mo.id);
        run(`UPDATE orders SET status = 'merged', paid = 0, refunded = 0, closed_at = ? WHERE id = ?`, U.nowIso(), o.id);
        O.recalc(mo.id);
      } else if (o) run('UPDATE orders SET table_id = ? WHERE id = ?', main.id, o.id);
      run(`UPDATE tables SET merged_into = ?, status = 'occupied' WHERE id = ?`, main.id, t.id);
    }
    if (main.status === 'available') run(`UPDATE tables SET status = 'occupied' WHERE id = ?`, main.id);
  });
  U.audit(req.user, 'tables.merge', 'tables', main.id, { tables: ids });
  U.emit('table.updated', { branch_id: req.branchId });
  res.json({ ok: true });
});
r.post('/tables/:id/unmerge', A.requirePerm('orders.transfer', 'tables.manage'), (req, res) => {
  const t = get('SELECT * FROM tables WHERE id = ? AND branch_id = ?', req.params.id, req.branchId);
  if (!t) throw U.httpError(404, 'Table not found');
  // splitting a table: un-merge this table (or all children if it is the main one)
  if (t.merged_into) run(`UPDATE tables SET merged_into = NULL, status = 'available' WHERE id = ?`, t.id);
  else run(`UPDATE tables SET merged_into = NULL, status = 'available' WHERE merged_into = ?`, t.id);
  U.audit(req.user, 'tables.unmerge', 'tables', t.id);
  U.emit('table.updated', { branch_id: req.branchId });
  res.json({ ok: true });
});

// QR code images
function orderUrl(req, t) { return `${(U.getSetting('public_url') || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/order/${t.qr_token}`; }
r.get('/tables/:id/qr.:fmt', A.requirePerm('tables.manage'), async (req, res) => {
  const t = get('SELECT * FROM tables WHERE id = ?', req.params.id);
  if (!t) throw U.httpError(404, 'Table not found');
  const url = orderUrl(req, t);
  if (req.params.fmt === 'svg') { res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })); return; }
  res.type('image/png').send(await QRCode.toBuffer(url, { margin: 1, width: 600, errorCorrectionLevel: 'M' }));
});
// Printable sheet with all QR cards
r.get('/qr-sheet', A.requirePerm('tables.manage'), async (req, res) => {
  const cafe = U.getSetting('cafe');
  const ids = req.query.ids ? String(req.query.ids).split(',').map(Number) : null;
  const tables = all('SELECT * FROM tables WHERE branch_id = ? AND active = 1 ORDER BY sort, label', req.branchId).filter(t => !ids || ids.includes(t.id));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cards = await Promise.all(tables.map(async t => `<div class="card">${cafe.logo_url ? `<img class="logo" src="${esc(cafe.logo_url)}" alt="">` : ''}<h2>${esc(cafe.name)}</h2>
      ${await QRCode.toString(orderUrl(req, t), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })}
      <div class="label">${t.kind === 'counter' ? 'Takeaway & pickup' : `Table ${esc(t.label)}`}</div><div class="cta">Scan to view menu &amp; order</div></div>`));
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>QR codes — ${esc(cafe.name)}</title><style>
    body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#fff;color:#1d1b20}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px}
    .card{border:2px solid #6b2fa0;border-radius:16px;padding:16px;text-align:center;break-inside:avoid}.card svg{width:100%;height:auto}.logo{max-height:40px}
    h2{margin:4px 0 8px;font-size:18px;color:#6b2fa0}.label{font-size:22px;font-weight:700;margin-top:8px}.cta{font-size:13px;color:#555}
    @media print{.noprint{display:none}body{padding:0}}</style></head><body><p class="noprint"><button onclick="print()">Print</button></p><div class="grid">${cards.join('')}</div></body></html>`);
});

// ---------- Reservations ----------
crud(r, '/reservations', {
  table: 'reservations', perm: 'reservations.manage', branchScoped: true, filters: ['date', 'status'], order: 'date, time',
  select: 'SELECT r.*, t.label AS table_label FROM reservations r LEFT JOIN tables t ON t.id = r.table_id', alias: 'r', search: ['r.name', 'r.phone'],
  fields: { branch_id: 'int', name: 'str:required', phone: 'str', email: 'str', guests: 'int:required', date: 'date:required', time: 'time:required', table_id: 'int', status: 'str', notes: 'str' },
  auditFields: ['name', 'date', 'time', 'guests', 'status'],
  beforeSave(d, req, before) {
    if (d.status && !['booked', 'arrived', 'seated', 'cancelled', 'no_show'].includes(d.status)) throw U.httpError(400, 'Invalid status');
    if (d.status === 'seated' && (d.table_id || before?.table_id)) run(`UPDATE tables SET status = 'occupied' WHERE id = ? AND status IN ('available','ordering')`, d.table_id || before.table_id);
  },
  onChange(id, req) {
    const rv = get('SELECT * FROM reservations WHERE id = ?', id);
    const sendConfirm = req.method === 'POST' || req.body?.send_confirmation;
    if (sendConfirm && rv.status === 'booked' && (rv.phone || rv.email)) {
      U.messageCustomer({ phone: rv.phone, email: rv.email }, `${U.getSetting('cafe').name}: your table for ${rv.guests} on ${rv.date} at ${rv.time} is confirmed. See you soon!`, 'Reservation confirmed');
    }
  },
});
r.post('/reservations/:id/remind', A.requirePerm('reservations.manage'), (req, res) => {
  const rv = get('SELECT * FROM reservations WHERE id = ?', req.params.id);
  if (!rv) throw U.httpError(404, 'Not found');
  U.messageCustomer({ phone: rv.phone, email: rv.email }, `Reminder from ${U.getSetting('cafe').name}: table for ${rv.guests} on ${rv.date} at ${rv.time}.`, 'Reservation reminder');
  res.json({ ok: true });
});

// ---------- Waitlist ----------
crud(r, '/waitlist', {
  table: 'waitlist', perm: 'reservations.manage', branchScoped: true, filters: ['status'], order: `status = 'waiting' DESC, id`,
  fields: { branch_id: 'int', name: 'str:required', phone: 'str', guests: 'int:required', quoted_minutes: 'int', status: 'str', notes: 'str' },
  auditFields: ['name', 'guests', 'status'],
});
r.post('/waitlist/:id/notify', A.requirePerm('reservations.manage'), (req, res) => {
  const w = get('SELECT * FROM waitlist WHERE id = ?', req.params.id);
  if (!w) throw U.httpError(404, 'Not found');
  U.messageCustomer({ phone: w.phone }, `${U.getSetting('cafe').name}: ${w.name}, your table is ready! Please come to the host stand.`, 'Table ready');
  res.json({ ok: true });
});

module.exports = { router: r };
