'use strict';
// Customer-facing QR ordering API. No login; access is by the table's unguessable QR token.
// Every action that places or changes an order (and service/bill requests) is GEOFENCED:
// the customer's coordinates are checked on the server against the branch's café location + radius.
const express = require('express');
const { all, get, run, insert, tx } = require('../db');
const { getSetting, checkGeofence, isOpenNow, localParts, itemScheduledNow, httpError, emit, notify } = require('../util');
const O = require('../orders');

const r = express.Router();

// --- tiny per-IP rate limiter for public writes ---
const hits = new Map();
function limit(max, windowMs) {
  return (req, _res, next) => {
    const k = `${req.ip}|${req.route?.path}`;
    const now = Date.now();
    const h = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (h.length >= max) return next(httpError(429, 'Too many requests, please wait a moment.'));
    h.push(now); hits.set(k, h); next();
  };
}

function loadTable(tokenStr) {
  const t = get(`SELECT t.*, s.name AS section_name FROM tables t LEFT JOIN sections s ON s.id = t.section_id WHERE t.qr_token = ? AND t.active = 1`, tokenStr);
  if (!t) throw httpError(404, 'This QR code is not valid any more. Please ask the staff.');
  const branch = get('SELECT * FROM branches WHERE id = ? AND active = 1', t.branch_id);
  if (!branch) throw httpError(404, 'This café branch is not accepting orders.');
  // If the table was merged into another, orders go to the main table
  const target = t.merged_into ? get('SELECT * FROM tables WHERE id = ?', t.merged_into) || t : t;
  return { table: t, target, branch };
}

/** Enforce the geofence or throw 403 with a machine-readable code the client can show. */
function requireInside(branch, location) {
  const g = checkGeofence(branch, location);
  if (!g.allowed) throw httpError(403, g.reason, { geofence: g });
  return g;
}

function publicMenu(orderType = 'dine_in') {
  const lp = localParts();
  const cats = all('SELECT * FROM categories WHERE active = 1 ORDER BY sort, name');
  const items = all('SELECT * FROM items WHERE available = 1 ORDER BY sort, name');
  const variants = all('SELECT * FROM item_variants ORDER BY sort, id');
  const groups = all('SELECT * FROM modifier_groups ORDER BY sort, id');
  const mods = all('SELECT * FROM modifiers ORDER BY sort, id');
  const takeaway = orderType !== 'dine_in';
  const shape = it => ({
    id: it.id, category_id: it.category_id, name: it.name, description: it.description, photo_url: it.photo_url,
    price: takeaway && it.takeaway_price != null ? it.takeaway_price : it.price, diet: it.diet,
    sold_out: !!it.sold_out, featured: !!it.featured, recommended: !!it.recommended,
    available_now: itemScheduledNow(it, lp), schedule: it.available_from && it.available_to ? `${it.available_from}–${it.available_to}` : null,
    is_combo: !!it.is_combo, combo_items: it.combo_items,
    variants: variants.filter(v => v.item_id === it.id).map(v => ({ id: v.id, name: v.name, price: takeaway && v.takeaway_price != null ? v.takeaway_price : v.price })),
    groups: groups.filter(g => g.item_id === it.id).map(g => ({ id: g.id, name: g.name, min: g.min_select, max: g.max_select, options: mods.filter(m => m.group_id === g.id).map(m => ({ id: m.id, name: m.name, price: m.price })) })),
  });
  return cats.map(c => ({
    id: c.id, name: c.name, description: c.description,
    available_now: itemScheduledNow(c, lp), schedule: c.available_from && c.available_to ? `${c.available_from}–${c.available_to}` : null,
    items: items.filter(i => i.category_id === c.id).map(shape),
  })).filter(c => c.items.length);
}

function publicOrder(o) {
  if (!o) return null;
  const labels = getSetting('order_status_labels');
  return {
    key: o.public_key, number: o.number, type: o.type, status: o.status, table: o.table_label, pickup_code: o.pickup_code,
    created_at: o.created_at, invoice_no: o.invoice_no,
    items: o.items.map(i => ({ id: i.id, name: i.name, variant: i.variant_name, modifiers: i.modifiers.map(m => m.name), qty: i.qty, unit_price: i.unit_price, notes: i.notes, status: i.kds_status, status_label: labels[i.kds_status] || i.kds_status, kot: i.kot })),
    subtotal: o.subtotal, discount: o.discount, service_charge: o.service_charge, tax: o.tax, tax_breakdown: o.tax_breakdown, tax_mode: o.tax_mode, round_off: o.round_off,
    total: o.total, paid: o.paid - o.refunded, balance: o.balance,
    progress: progressOf(o),
  };
}
function progressOf(o) {
  const live = o.items.filter(i => i.kds_status !== 'cancelled');
  if (o.status === 'paid') return 'paid';
  if (o.status === 'cancelled') return 'cancelled';
  if (!live.length) return 'new';
  if (live.every(i => i.kds_status === 'served')) return 'served';
  if (live.every(i => ['ready', 'served'].includes(i.kds_status))) return 'ready';
  if (live.some(i => i.kds_status !== 'new')) return 'preparing';
  return 'new';
}

// GET menu + context for a table QR
r.get('/t/:token', (req, res) => {
  const { table, target, branch } = loadTable(req.params.token);
  const type = table.kind === 'counter' ? 'takeaway' : 'dine_in';
  const active = table.kind === 'table' ? O.activeOrderForTable(target.id) : null;
  const cafe = getSetting('cafe');
  const hours = isOpenNow();
  res.json({
    cafe: { name: cafe.name, logo_url: cafe.logo_url, phone: cafe.phone },
    branch: { id: branch.id, name: branch.name, address: branch.address },
    table: { label: target.label, kind: table.kind, section: table.section_name, merged_from: table.merged_into ? table.label : null },
    order_types: table.kind === 'counter' ? ['takeaway', 'pickup'] : ['dine_in'],
    geofence: { enabled: !!branch.geofence_enabled, radius_m: branch.radius_m, configured: branch.lat != null && branch.lng != null },
    open: getSetting('enforce_hours_for_qr') ? hours : { open: true, info: hours.open ? null : hours.reason },
    currency: getSetting('currency'),
    tax: (({ enabled, mode, rate, label }) => ({ enabled, mode, rate, label }))(getSetting('tax')),
    service_charge: getSetting('service_charge'),
    active_order: active ? publicOrder(O.getOrder(active.id)) : null,
    menu: publicMenu(type),
  });
});

// Menu priced for a given order type (counter QR switching takeaway/pickup)
r.get('/t/:token/menu', (req, res) => {
  loadTable(req.params.token);
  res.json(publicMenu(['takeaway', 'pickup'].includes(req.query.type) ? req.query.type : 'dine_in'));
});

// Location check — the client calls this before showing the cart/checkout and the server re-checks on every order.
r.post('/t/:token/locate', limit(30, 60e3), (req, res) => {
  const { target, branch, table } = loadTable(req.params.token);
  const g = checkGeofence(branch, req.body);
  if (g.allowed && table.kind === 'table' && target.status === 'available') {
    run(`UPDATE tables SET status = 'ordering' WHERE id = ?`, target.id);
    emit('table.updated', { table_id: target.id, branch_id: branch.id });
  }
  res.json(g);
});

// Place an order (or add a new round to the table's open order)
r.post('/t/:token/orders', limit(12, 60e3), (req, res) => {
  const { table, target, branch } = loadTable(req.params.token);
  const body = req.body || {};
  const geo = requireInside(branch, body.location);
  if (getSetting('enforce_hours_for_qr')) { const h = isOpenNow(); if (!h.open) throw httpError(403, h.reason); }

  // Idempotency: a retried submit (flaky network) returns the original order instead of duplicating it
  if (body.client_ref) {
    const dup = get('SELECT id FROM orders WHERE client_ref = ?', String(body.client_ref));
    if (dup) return res.json({ order: publicOrder(O.getOrder(dup.id)), duplicate: true });
    const dupRound = get(`SELECT order_id FROM order_items WHERE added_by = ?`, `qr:${body.client_ref}`);
    if (dupRound) return res.json({ order: publicOrder(O.getOrder(dupRound.order_id)), duplicate: true });
  }
  const customer = body.customer || {};
  if (customer.phone && !customer.consent) customer.phone = ''; // only store contact details with consent
  let type = 'dine_in';
  if (table.kind === 'counter') {
    type = ['takeaway', 'pickup'].includes(body.type) ? body.type : 'takeaway';
    if (!String(customer.name || '').trim()) throw httpError(400, 'Please enter your name for the pickup order.');
  }
  const geoInfo = { lat: Number(body.location.lat), lng: Number(body.location.lng), distance_m: geo.distance_m ?? null };

  const order = tx(() => {
  let order;
  const existing = type === 'dine_in' ? O.activeOrderForTable(target.id) : null;
  if (existing) {
    order = O.addItems(existing.id, body.items, { addedBy: body.client_ref ? `qr:${body.client_ref}` : 'qr' });
    if (customer.phone && !existing.customer_phone) {
      const cid = O.upsertCustomer(customer);
      run('UPDATE orders SET customer_id = ?, customer_phone = ?, customer_name = COALESCE(NULLIF(customer_name, \'\'), ?) WHERE id = ?', cid, customer.phone, customer.name || '', existing.id);
    }
  } else {
    // validate lines before creating the order so a bad cart doesn't leave an empty order behind
    (body.items || []).forEach(l => O.priceLine(l, type));
    const created = O.createOrder({ branch_id: branch.id, type, source: 'qr', table_id: type === 'dine_in' ? target.id : null, customer, notes: String(body.notes || '').slice(0, 300), geo: geoInfo, client_ref: body.client_ref ? String(body.client_ref) : null });
    order = O.addItems(created.id, body.items, { addedBy: 'qr' });
  }
  return order;
  });
  emit('order.created', { order_id: order.id, branch_id: branch.id });
  res.status(201).json({ order: publicOrder(O.getOrder(order.id)) });
});

// Order progress
r.get('/orders/:key', (req, res) => {
  const o = get('SELECT id FROM orders WHERE public_key = ?', req.params.key);
  if (!o) throw httpError(404, 'Order not found');
  res.json(publicOrder(O.getOrder(o.id)));
});

// Call waiter / ask for the bill / water
r.post('/t/:token/requests', limit(6, 60e3), (req, res) => {
  const { target, branch } = loadTable(req.params.token);
  const body = req.body || {};
  requireInside(branch, body.location);
  const type = ['waiter', 'bill', 'water', 'other'].includes(body.type) ? body.type : 'waiter';
  const recent = get(`SELECT id FROM service_requests WHERE table_id = ? AND type = ? AND status = 'open'`, target.id, type);
  const active = O.activeOrderForTable(target.id);
  if (type === 'bill') {
    if (!active) throw httpError(400, 'There is no open order on this table yet.');
    run(`UPDATE orders SET status = 'billed' WHERE id = ?`, active.id);
    run(`UPDATE tables SET status = 'bill_requested' WHERE id = ?`, target.id);
  }
  if (!recent) {
    insert('service_requests', { branch_id: branch.id, table_id: target.id, order_id: active?.id ?? null, type, note: String(body.note || '').slice(0, 200) });
    const what = { waiter: 'is calling a waiter', bill: 'asked for the bill', water: 'asked for water', other: 'needs help' }[type];
    notify({ branch_id: branch.id, audience: 'staff', type: `request_${type}`, message: `${target.label} ${what}${body.note ? `: ${String(body.note).slice(0, 80)}` : ''}`, ref: `table:${target.id}` });
  }
  emit('table.updated', { table_id: target.id, branch_id: branch.id });
  res.json({ ok: true, already_requested: !!recent });
});

r.post('/orders/:key/feedback', limit(5, 60e3), (req, res) => {
  const o = get('SELECT id, customer_id FROM orders WHERE public_key = ?', req.params.key);
  if (!o) throw httpError(404, 'Order not found');
  const rating = Math.max(1, Math.min(5, parseInt(req.body?.rating, 10) || 0));
  if (!rating) throw httpError(400, 'Rating 1–5 required');
  if (get('SELECT id FROM feedback WHERE order_id = ?', o.id)) throw httpError(409, 'Thanks — feedback already received for this order.');
  insert('feedback', { order_id: o.id, customer_id: o.customer_id, rating, comment: String(req.body?.comment || '').slice(0, 1000) });
  res.status(201).json({ ok: true });
});

module.exports = { router: r, publicOrder, publicMenu };
