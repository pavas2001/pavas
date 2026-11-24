'use strict';
// POS & billing, order management, kitchen display, service requests, receipts.
const express = require('express');
const { all, get, run, insert, update, tx } = require('../db');
const U = require('../util');
const A = require('../auth');
const O = require('../orders');

const r = express.Router();

function mustOrder(id) { const o = O.getOrder(Number(id)); if (!o) throw U.httpError(404, 'Order not found'); return o; }
function mustActive(o) { if (!O.ACTIVE.includes(o.status)) throw U.httpError(409, `Order #${o.number} is ${o.status}`); return o; }

// ---------- Orders ----------
r.get('/orders', A.requirePerm('orders.create', 'payments.take', 'reports.view'), (req, res) => {
  const where = ['o.branch_id = ?'], p = [req.branchId];
  if (req.query.status === 'active') where.push(`o.status IN ('open','billed')`);
  else if (req.query.status) { where.push('o.status = ?'); p.push(req.query.status); }
  if (req.query.type) { where.push('o.type = ?'); p.push(req.query.type); }
  if (req.query.table_id) { where.push('o.table_id = ?'); p.push(req.query.table_id); }
  if (req.query.from) { where.push('o.created_at >= ?'); p.push(req.query.from); }
  if (req.query.to) { where.push('o.created_at < ?'); p.push(req.query.to); }
  if (req.query.created_by) { where.push('o.created_by = ?'); p.push(req.query.created_by); }
  if (req.query.q) { where.push('(CAST(o.number AS TEXT) = ? OR o.invoice_no LIKE ? OR o.customer_name LIKE ? OR o.customer_phone LIKE ?)'); p.push(req.query.q, `%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`); }
  res.json(all(`SELECT o.id, o.number, o.type, o.source, o.status, o.total, o.paid, o.refunded, o.created_at, o.closed_at, o.invoice_no, o.customer_name, o.customer_phone, o.pickup_code, o.table_id,
                t.label AS table_label, u.name AS created_by_name,
                (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.kds_status != 'cancelled') AS item_count
                FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN users u ON u.id = o.created_by
                WHERE ${where.join(' AND ')} ORDER BY o.id DESC LIMIT ${Math.min(Number(req.query.limit) || 200, 2000)}`, ...p));
});
r.get('/orders/:id', A.requirePerm('orders.create', 'payments.take', 'reports.view', 'kds.view'), (req, res) => res.json(mustOrder(req.params.id)));

r.post('/orders', A.requirePerm('orders.create'), (req, res) => {
  const b = req.body || {};
  if (b.client_ref) { const dup = get('SELECT id FROM orders WHERE client_ref = ?', String(b.client_ref)); if (dup) return res.json(O.getOrder(dup.id)); }
  const order = tx(() => {
    let table_id = b.table_id ? Number(b.table_id) : null;
    if (b.type === 'dine_in' || !b.type) {
      if (!table_id) throw U.httpError(400, 'Choose a table for a dine-in order');
      const t = get('SELECT * FROM tables WHERE id = ? AND branch_id = ?', table_id, req.branchId);
      if (!t) throw U.httpError(400, 'Table not found in this branch');
      if (t.merged_into) table_id = t.merged_into;
      const existing = O.activeOrderForTable(table_id);
      if (existing) return b.items?.length ? O.addItems(existing.id, b.items, { user: req.user }) : O.getOrder(existing.id);
    } else table_id = null;
    (b.items || []).forEach(l => O.priceLine(l, b.type || 'dine_in'));
    const o = O.createOrder({ branch_id: req.branchId, type: b.type || 'dine_in', source: 'pos', table_id, customer: b.customer || {}, user: req.user, notes: b.notes || '', client_ref: b.client_ref ? String(b.client_ref) : null });
    U.audit(req.user, 'order.create', 'order', o.id, { number: o.number, type: o.type, table: o.table_label });
    return b.items?.length ? O.addItems(o.id, b.items, { user: req.user }) : o;
  });
  U.emit('order.created', { order_id: order.id, branch_id: req.branchId });
  res.status(201).json(order);
});
r.post('/orders/:id/items', A.requirePerm('orders.create'), (req, res) => res.json(O.addItems(mustOrder(req.params.id).id, req.body?.items, { user: req.user })));

// Edit an item line (qty / notes). Reducing qty or removing needs orders.cancel once sent to kitchen.
r.put('/orders/:id/items/:itemId', A.requirePerm('orders.edit'), (req, res) => {
  const o = mustActive(mustOrder(req.params.id));
  const it = o.items.find(i => i.id === Number(req.params.itemId));
  if (!it || it.kds_status === 'cancelled') throw U.httpError(404, 'Item not found');
  const qty = req.body.qty != null ? Math.max(1, Math.min(99, parseInt(req.body.qty, 10))) : it.qty;
  if (qty < it.qty && it.kds_status !== 'new' && !A.can(req.user, 'orders.cancel')) throw U.httpError(403, 'Reducing an item already in preparation needs cancel permission');
  tx(() => {
    run('UPDATE order_items SET qty = ?, notes = ? WHERE id = ?', qty, req.body.notes != null ? String(req.body.notes).slice(0, 200) : it.notes, it.id);
    O.recalc(o.id);
  });
  U.audit(req.user, 'order.edit_item', 'order', o.id, { item: it.name, qty: [it.qty, qty] });
  U.emit('order.updated', { order_id: o.id, branch_id: o.branch_id });
  res.json(O.getOrder(o.id));
});
r.post('/orders/:id/items/:itemId/cancel', A.requirePerm('orders.cancel'), (req, res) => {
  const o = mustOrder(req.params.id);
  if (!o.items.some(i => i.id === Number(req.params.itemId))) throw U.httpError(404, 'Item not found');
  res.json(O.cancelItem(Number(req.params.itemId), req.body?.reason, req.user));
});
r.post('/orders/:id/cancel', A.requirePerm('orders.cancel'), (req, res) => res.json(O.cancelOrder(mustOrder(req.params.id).id, req.body?.reason, req.user)));

r.put('/orders/:id', A.requirePerm('orders.edit'), (req, res) => {
  const o = mustActive(mustOrder(req.params.id));
  const patch = {};
  for (const k of ['customer_name', 'customer_phone', 'notes']) if (req.body[k] != null) patch[k] = String(req.body[k]).slice(0, 300);
  if (req.body.type && ['dine_in', 'takeaway', 'pickup'].includes(req.body.type)) patch.type = req.body.type;
  if (patch.customer_phone) patch.customer_id = O.upsertCustomer({ name: patch.customer_name || o.customer_name, phone: patch.customer_phone, consent: !!req.body.consent });
  update('orders', o.id, patch);
  O.recalc(o.id);
  U.audit(req.user, 'order.update', 'order', o.id, Object.keys(patch));
  res.json(O.getOrder(o.id));
});

// Discount / coupon
r.post('/orders/:id/discount', A.requirePerm('orders.discount'), (req, res) => {
  const o = mustActive(mustOrder(req.params.id));
  const { type, value, coupon_code } = req.body || {};
  if (coupon_code) {
    O.couponDiscount(coupon_code, o.subtotal); // validates; throws with a clear message
    update('orders', o.id, { coupon_code: get('SELECT code FROM coupons WHERE code = ?', coupon_code).code, discount_type: null, discount_value: 0 });
  } else if (type === 'percent' || type === 'flat') {
    const v = Math.round(Number(value) || 0);
    if (v < 0 || (type === 'percent' && v > 100)) throw U.httpError(400, 'Invalid discount');
    update('orders', o.id, { discount_type: type, discount_value: v, coupon_code: null });
  } else update('orders', o.id, { discount_type: null, discount_value: 0, coupon_code: null });
  O.recalc(o.id);
  const after = O.getOrder(o.id);
  U.audit(req.user, 'order.discount', 'order', o.id, { type, value, coupon_code, discount: after.discount });
  res.json(after);
});

// Mark as billed (bill printed / requested)
r.post('/orders/:id/bill', A.requirePerm('orders.create', 'payments.take'), (req, res) => {
  const o = mustActive(mustOrder(req.params.id));
  run(`UPDATE orders SET status = 'billed' WHERE id = ?`, o.id);
  if (o.table_id) run(`UPDATE tables SET status = 'bill_requested' WHERE id = ?`, o.table_id);
  U.emit('order.updated', { order_id: o.id, branch_id: o.branch_id });
  res.json(O.getOrder(o.id));
});

// Payments (partial payments supported; order closes automatically when fully paid)
r.post('/orders/:id/payments', A.requirePerm('payments.take'), (req, res) => {
  const o = mustOrder(req.params.id);
  res.json(O.addPayment(o.id, req.body || {}, req.user));
});
r.post('/orders/:id/refund', A.requirePerm('orders.refund'), (req, res) => res.json(O.refund(mustOrder(req.params.id).id, req.body || {}, req.user)));

// Split by amount: suggest equal shares of the balance (each share is then taken as a partial payment)
r.get('/orders/:id/split', A.requirePerm('payments.take'), (req, res) => {
  const o = mustOrder(req.params.id);
  const n = Math.max(2, Math.min(20, parseInt(req.query.ways, 10) || 2));
  const share = Math.floor(o.balance / n);
  res.json({ ways: n, balance: o.balance, shares: Array.from({ length: n }, (_, i) => i === n - 1 ? o.balance - share * (n - 1) : share) });
});
// Split by item: move selected items (optionally partial qty) to a new order on the same table
r.post('/orders/:id/split-items', A.requirePerm('orders.transfer'), (req, res) => {
  const o = mustActive(mustOrder(req.params.id));
  const lines = (req.body?.lines || []).map(l => ({ id: Number(l.id), qty: parseInt(l.qty, 10) }));
  if (!lines.length) throw U.httpError(400, 'Choose items to split');
  if (o.paid > 0) throw U.httpError(409, 'Split before taking payments');
  const out = tx(() => {
    const neu = O.createOrder({ branch_id: o.branch_id, type: o.type, source: o.source, table_id: null, user: req.user, notes: `Split from #${o.number}` });
    run('UPDATE orders SET table_id = ? WHERE id = ?', o.table_id, neu.id);
    for (const l of lines) {
      const it = o.items.find(i => i.id === l.id && i.kds_status !== 'cancelled');
      if (!it) throw U.httpError(400, 'Item not found on order');
      const q = Math.max(1, Math.min(it.qty, l.qty || it.qty));
      if (q === it.qty) run('UPDATE order_items SET order_id = ? WHERE id = ?', neu.id, it.id);
      else {
        run('UPDATE order_items SET qty = qty - ? WHERE id = ?', q, it.id);
        const { id, order_id, station_name, ...rest } = it;
        insert('order_items', { ...rest, modifiers: JSON.stringify(it.modifiers), order_id: neu.id, qty: q });
      }
    }
    O.recalc(o.id); O.recalc(neu.id);
    U.audit(req.user, 'order.split_items', 'order', o.id, { new_order: neu.id });
    return { from: O.getOrder(o.id), to: O.getOrder(neu.id) };
  });
  U.emit('order.updated', { order_id: o.id, branch_id: o.branch_id });
  res.json(out);
});
// Combine: move all items & payments of another active order into this one
r.post('/orders/:id/combine', A.requirePerm('orders.transfer'), (req, res) => {
  const target = mustActive(mustOrder(req.params.id));
  const src = mustActive(mustOrder(req.body?.order_id));
  if (src.id === target.id) throw U.httpError(400, 'Choose a different order');
  tx(() => {
    run('UPDATE order_items SET order_id = ? WHERE order_id = ?', target.id, src.id);
    run('UPDATE payments SET order_id = ? WHERE order_id = ?', target.id, src.id);
    run('UPDATE orders SET paid = paid + ?, refunded = refunded + ? WHERE id = ?', src.paid, src.refunded, target.id);
    run(`UPDATE orders SET status = 'merged', paid = 0, refunded = 0, closed_at = ?, notes = TRIM(notes || ' Merged into #' || ?) WHERE id = ?`, U.nowIso(), target.number, src.id);
    if (src.table_id && src.table_id !== target.table_id && !O.activeOrderForTable(src.table_id)) run(`UPDATE tables SET status = 'cleaning' WHERE id = ?`, src.table_id);
    O.recalc(target.id);
  });
  U.audit(req.user, 'order.combine', 'order', target.id, { merged: src.number });
  U.emit('order.updated', { order_id: target.id, branch_id: target.branch_id });
  res.json(O.getOrder(target.id));
});
// Transfer to another table
r.post('/orders/:id/transfer', A.requirePerm('orders.transfer'), (req, res) => {
  const o = mustActive(mustOrder(req.params.id));
  const t = get('SELECT * FROM tables WHERE id = ? AND branch_id = ?', req.body?.table_id, o.branch_id);
  if (!t) throw U.httpError(400, 'Table not found');
  const there = O.activeOrderForTable(t.id);
  if (there && there.id !== o.id) throw U.httpError(409, `${t.label} already has order #${there.number}. Use "combine" instead.`);
  tx(() => {
    run(`UPDATE orders SET table_id = ?, type = 'dine_in' WHERE id = ?`, t.id, o.id);
    run(`UPDATE tables SET status = 'occupied' WHERE id = ?`, t.id);
    if (o.table_id && !O.activeOrderForTable(o.table_id)) run(`UPDATE tables SET status = 'cleaning' WHERE id = ?`, o.table_id);
    O.recalc(o.id);
  });
  U.audit(req.user, 'order.transfer', 'order', o.id, { from: o.table_label, to: t.label });
  U.emit('order.updated', { order_id: o.id, branch_id: o.branch_id });
  res.json(O.getOrder(o.id));
});
// Share bill / receipt by WhatsApp, SMS or email
r.post('/orders/:id/send-receipt', A.requirePerm('payments.take', 'orders.create'), (req, res) => {
  const o = mustOrder(req.params.id);
  const { channel = 'whatsapp', to } = req.body || {};
  const recipient = to || o.customer_phone;
  if (!recipient) throw U.httpError(400, 'Enter a phone number or email');
  const base = U.getSetting('public_url') || `${req.protocol}://${req.get('host')}`;
  const id = U.queueMessage(channel, recipient, `${U.getSetting('cafe').name} — ${o.invoice_no ? `Bill ${o.invoice_no}` : `Order #${o.number}`}: ${U.money(o.total)}. View: ${base}/r/${o.public_key}`, 'Your bill');
  U.audit(req.user, 'order.send_receipt', 'order', o.id, { channel, to: recipient });
  res.json(get('SELECT * FROM outbox WHERE id = ?', id));
});

// ---------- Kitchen display ----------
r.get('/kds', A.requirePerm('kds.view'), (req, res) => {
  const station = req.query.station_id ? Number(req.query.station_id) : null;
  const showServed = req.query.history === '1';
  const statuses = showServed ? `('served')` : `('new','preparing','ready')`;
  const rows = all(`SELECT oi.*, o.number, o.type, o.source, o.pickup_code, o.customer_name, o.notes AS order_notes, o.created_at AS order_created_at, t.label AS table_label, s.name AS station_name
                    FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN stations s ON s.id = oi.station_id
                    WHERE o.branch_id = ? AND oi.kds_status IN ${statuses} ${station ? 'AND oi.station_id = ?' : ''}
                    ${showServed ? `AND oi.status_at >= datetime('now','-12 hours')` : ''}
                    ORDER BY oi.created_at, oi.id`, ...[req.branchId].concat(station ? [station] : []));
  // group into tickets (order + KOT round)
  const tickets = new Map();
  for (const x of rows) {
    const k = `${x.order_id}:${x.kot}`;
    if (!tickets.has(k)) tickets.set(k, { key: k, order_id: x.order_id, kot: x.kot, number: x.number, type: x.type, source: x.source, table: x.table_label, pickup_code: x.pickup_code, customer_name: x.customer_name, order_notes: x.order_notes, created_at: x.created_at, items: [] });
    tickets.get(k).items.push({ id: x.id, name: x.name, variant: x.variant_name, modifiers: JSON.parse(x.modifiers || '[]').map(m => m.name), qty: x.qty, notes: x.notes, status: x.kds_status, station: x.station_name, status_at: x.status_at });
  }
  const delay = U.getSetting('kds').delay_minutes;
  const out = [...tickets.values()].map(t => {
    const st = ['new', 'preparing', 'ready', 'served'];
    t.status = st[Math.min(...t.items.map(i => st.indexOf(i.status)))];
    t.age_min = Math.floor((Date.now() - Date.parse(t.created_at)) / 60000);
    t.delayed = !showServed && t.status !== 'ready' && t.age_min >= delay;
    return t;
  });
  if (showServed) out.reverse();
  res.json({ tickets: out, delay_minutes: delay, labels: U.getSetting('order_status_labels') });
});
const KDS_NEXT = { new: 'preparing', preparing: 'ready', ready: 'served' };
r.post('/kds/items/status', A.requirePerm('kds.view'), (req, res) => {
  const ids = (req.body?.item_ids || []).map(Number);
  const status = req.body?.status;
  if (!['new', 'preparing', 'ready', 'served'].includes(status)) throw U.httpError(400, 'Invalid status');
  if (!ids.length) throw U.httpError(400, 'No items');
  const touched = new Set();
  tx(() => {
    for (const id of ids) {
      const it = get(`SELECT oi.*, o.branch_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ?`, id);
      if (!it || it.kds_status === 'cancelled' || it.branch_id !== req.branchId) continue;
      run('UPDATE order_items SET kds_status = ?, status_at = ? WHERE id = ?', status, U.nowIso(), id);
      touched.add(it.order_id);
    }
  });
  for (const oid of touched) {
    const o = O.getOrder(oid);
    const live = o.items.filter(i => i.kds_status !== 'cancelled');
    U.emit('order.updated', { order_id: oid, branch_id: o.branch_id });
    if (status === 'ready') {
      const where = o.table_label || (o.pickup_code ? `pickup ${o.pickup_code}` : o.type);
      U.notify({ branch_id: o.branch_id, audience: 'staff', type: 'order_ready', message: `Order #${o.number} (${where}) is ready to serve`, ref: `order:${oid}` });
      if (live.every(i => ['ready', 'served'].includes(i.kds_status)) && o.customer_phone && U.getSetting('notifications').customer_ready !== false) {
        U.messageCustomer({ phone: o.customer_phone }, `${U.getSetting('cafe').name}: your order #${o.number} is ready${o.pickup_code ? ` — pickup code ${o.pickup_code}` : ''}.`, 'Order ready');
      }
    }
    U.audit(req.user, `kds.${status}`, 'order', oid, { items: ids.length });
  }
  res.json({ ok: true, next: KDS_NEXT[status] || null });
});

// ---------- Service requests ----------
r.get('/service-requests', A.requirePerm('orders.create', 'tables.manage'), (req, res) => {
  res.json(all(`SELECT sr.*, t.label AS table_label FROM service_requests sr LEFT JOIN tables t ON t.id = sr.table_id WHERE sr.branch_id = ? AND (sr.status = 'open' OR sr.created_at >= datetime('now','-2 hours')) ORDER BY sr.status = 'open' DESC, sr.id DESC`, req.branchId));
});
r.post('/service-requests/:id/resolve', A.requirePerm('orders.create', 'tables.manage'), (req, res) => {
  require('../signal').resolve(Number(req.params.id), req.user, req.branchId);
  U.emit('table.updated', { branch_id: req.branchId });
  U.emit('signal.updated', { branch_id: req.branchId });
  res.json({ ok: true });
});

module.exports = { router: r };
