'use strict';
// Inventory, stock movements & counts, recipes & food costing, suppliers & purchase orders.
const express = require('express');
const { all, get, run, insert, update, tx } = require('../db');
const U = require('../util');
const A = require('../auth');
const O = require('../orders');
const { crud } = require('../crud');

const r = express.Router();
const INV = 'inventory.manage', PUR = 'purchasing.manage';

crud(r, '/suppliers', { table: 'suppliers', perm: PUR, readPerm: [PUR, INV], order: 'name', search: ['name', 'contact_person', 'phone'], auditFields: ['name'],
  fields: { name: 'str:required', contact_person: 'str', phone: 'str', email: 'str', address: 'str', gstin: 'str', notes: 'str', active: 'bool' } });
crud(r, '/stock-locations', { table: 'stock_locations', perm: INV, branchScoped: true, order: 'is_default DESC, name', fields: { branch_id: 'int', name: 'str:required', is_default: 'bool' }, auditFields: ['name'],
  beforeSave(d, req) { if (d.is_default) run('UPDATE stock_locations SET is_default = 0 WHERE branch_id = ?', req.branchId); } });

crud(r, '/ingredients', { table: 'ingredients', perm: INV, readPerm: [INV, PUR], order: 'name', search: ['name'], filters: ['kind'], auditFields: ['name', 'cost_per_unit'],
  fields: { name: 'str:required', kind: 'str', unit: 'str:required', cost_per_unit: 'real', low_stock_level: 'real', preferred_supplier_id: 'int', active: 'bool' },
  beforeSave(d, req, before) {
    if (before && d.cost_per_unit != null && d.cost_per_unit !== before.cost_per_unit) U.audit(req.user, 'ingredients.cost_change', 'ingredients', before.id, { from: before.cost_per_unit, to: d.cost_per_unit });
  } });

// Stock levels per ingredient for this branch (all its locations)
r.get('/stock', A.requirePerm(INV, PUR), (req, res) => {
  const locs = all('SELECT * FROM stock_locations WHERE branch_id = ? ORDER BY is_default DESC, name', req.branchId);
  const ings = all(`SELECT i.*, s.name AS supplier_name FROM ingredients i LEFT JOIN suppliers s ON s.id = i.preferred_supplier_id WHERE i.active = 1 ORDER BY i.name`);
  const lv = all(`SELECT ingredient_id, location_id, SUM(qty) AS q FROM stock_movements WHERE location_id IN (SELECT id FROM stock_locations WHERE branch_id = ?) GROUP BY ingredient_id, location_id`, req.branchId);
  const soon = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);
  res.json({
    locations: locs,
    items: ings.map(i => {
      const by = Object.fromEntries(locs.map(l => [l.id, +(lv.find(x => x.ingredient_id === i.id && x.location_id === l.id)?.q || 0).toFixed(3)]));
      const total = Object.values(by).reduce((a, b) => a + b, 0);
      return { ...i, by_location: by, total: +total.toFixed(3), value: Math.round(total * i.cost_per_unit), low: i.low_stock_level > 0 && total <= i.low_stock_level };
    }),
    expiring: all(`SELECT m.ingredient_id, i.name, i.unit, m.batch_no, m.expiry_date, m.qty, l.name AS location FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id JOIN stock_locations l ON l.id = m.location_id
                   WHERE m.type = 'received' AND m.expiry_date IS NOT NULL AND m.expiry_date <= ? AND l.branch_id = ? AND m.created_at >= datetime('now','-120 days') ORDER BY m.expiry_date`, soon, req.branchId),
  });
});
r.get('/stock/movements', A.requirePerm(INV), (req, res) => {
  const where = ['l.branch_id = ?'], p = [req.branchId];
  if (req.query.ingredient_id) { where.push('m.ingredient_id = ?'); p.push(req.query.ingredient_id); }
  if (req.query.type) { where.push('m.type = ?'); p.push(req.query.type); }
  res.json(all(`SELECT m.*, i.name AS ingredient, i.unit, l.name AS location, u.name AS user_name FROM stock_movements m JOIN ingredients i ON i.id = m.ingredient_id JOIN stock_locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.user_id
                WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ${Math.min(Number(req.query.limit) || 300, 3000)}`, ...p));
});
// Record received / used / wasted / adjusted / transfer
r.post('/stock/movements', A.requirePerm(INV), (req, res) => {
  const b = req.body || {};
  const type = b.type;
  if (!['received', 'used', 'wasted', 'adjusted', 'transfer'].includes(type)) throw U.httpError(400, 'Invalid movement type');
  const ing = get('SELECT * FROM ingredients WHERE id = ?', b.ingredient_id);
  const loc = get('SELECT * FROM stock_locations WHERE id = ? AND branch_id = ?', b.location_id, req.branchId);
  if (!ing || !loc) throw U.httpError(400, 'Ingredient and location are required');
  let qty = Number(b.qty);
  if (!Number.isFinite(qty) || qty === 0) throw U.httpError(400, 'Quantity is required');
  const ids = tx(() => {
    if (type === 'transfer') {
      const to = get('SELECT * FROM stock_locations WHERE id = ?', b.to_location_id);
      if (!to || to.id === loc.id) throw U.httpError(400, 'Choose a different destination');
      qty = Math.abs(qty);
      return [
        insert('stock_movements', { ingredient_id: ing.id, location_id: loc.id, type, qty: -qty, unit_cost: ing.cost_per_unit, reference: `to ${to.name}`, note: b.note || '', user_id: req.user.id }),
        insert('stock_movements', { ingredient_id: ing.id, location_id: to.id, type, qty, unit_cost: ing.cost_per_unit, reference: `from ${loc.name}`, note: b.note || '', user_id: req.user.id }),
      ];
    }
    if (type === 'used' || type === 'wasted') qty = -Math.abs(qty);
    if (type === 'received') qty = Math.abs(qty);
    const unit_cost = b.unit_cost != null && b.unit_cost !== '' ? Number(b.unit_cost) : ing.cost_per_unit;
    if (type === 'received' && b.update_cost && unit_cost > 0) update('ingredients', ing.id, { cost_per_unit: unit_cost });
    return [insert('stock_movements', { ingredient_id: ing.id, location_id: loc.id, type, qty, unit_cost, batch_no: b.batch_no || null, expiry_date: b.expiry_date || null, reference: b.reference || '', note: b.note || '', user_id: req.user.id })];
  });
  O.checkLowStock(ing.id, req.branchId);
  U.audit(req.user, `stock.${type}`, 'ingredients', ing.id, { qty, location: loc.name });
  res.status(201).json({ ids });
});
// Stock count & reconcile: lines [{ingredient_id, counted}] → creates 'count' adjustments for the differences
r.post('/stock/counts', A.requirePerm(INV), (req, res) => {
  const loc = get('SELECT * FROM stock_locations WHERE id = ? AND branch_id = ?', req.body?.location_id, req.branchId);
  if (!loc) throw U.httpError(400, 'Choose a location');
  const lines = (req.body?.lines || []).filter(l => l.counted !== '' && l.counted != null);
  const result = tx(() => lines.map(l => {
    const expected = O.stockLevel(Number(l.ingredient_id), loc.id);
    const counted = Number(l.counted);
    const diff = +(counted - expected).toFixed(4);
    if (diff !== 0) insert('stock_movements', { ingredient_id: Number(l.ingredient_id), location_id: loc.id, type: 'count', qty: diff, reference: 'Stock count', note: req.body.note || '', user_id: req.user.id });
    return { ingredient_id: Number(l.ingredient_id), expected: +expected.toFixed(3), counted, diff };
  }));
  const id = insert('stock_counts', { location_id: loc.id, lines: JSON.stringify(result), user_id: req.user.id, note: req.body.note || '' });
  U.audit(req.user, 'stock.count', 'stock_counts', id, { lines: result.length, variances: result.filter(x => x.diff).length });
  res.status(201).json({ id, lines: result });
});
r.get('/stock/counts', A.requirePerm(INV), (req, res) => {
  res.json(all(`SELECT c.*, l.name AS location, u.name AS user_name FROM stock_counts c JOIN stock_locations l ON l.id = c.location_id LEFT JOIN users u ON u.id = c.user_id WHERE l.branch_id = ? ORDER BY c.id DESC LIMIT 50`, req.branchId).map(c => ({ ...c, lines: JSON.parse(c.lines) })));
});

// ---------- Recipes & costing ----------
r.get('/recipes/:itemId', A.requirePerm(INV, 'menu.manage'), (req, res) => {
  const item = get('SELECT * FROM items WHERE id = ?', req.params.itemId);
  if (!item) throw U.httpError(404, 'Item not found');
  res.json({ item, variants: all('SELECT * FROM item_variants WHERE item_id = ?', item.id), lines: all(`SELECT rl.*, i.name AS ingredient, i.unit, i.cost_per_unit FROM recipe_lines rl JOIN ingredients i ON i.id = rl.ingredient_id WHERE rl.item_id = ? ORDER BY rl.id`, item.id) });
});
r.put('/recipes/:itemId', A.requirePerm(INV, 'menu.manage'), (req, res) => {
  const item = get('SELECT * FROM items WHERE id = ?', req.params.itemId);
  if (!item) throw U.httpError(404, 'Item not found');
  tx(() => {
    run('DELETE FROM recipe_lines WHERE item_id = ?', item.id);
    for (const l of req.body?.lines || []) {
      const q = Number(l.qty);
      if (!l.ingredient_id || !(q > 0)) continue;
      insert('recipe_lines', { item_id: item.id, variant_id: l.variant_id ? Number(l.variant_id) : null, ingredient_id: Number(l.ingredient_id), qty: q });
    }
  });
  U.audit(req.user, 'recipes.update', 'items', item.id, { name: item.name });
  res.json({ ok: true });
});
// Food cost report: cost vs price per item (and per variant), margin, low-margin flag
r.get('/costing', A.requirePerm(INV, 'menu.manage', 'reports.view'), (req, res) => {
  const target = Number(req.query.target_pct) || 35; // food cost % above this is flagged
  const tax = U.getSetting('tax');
  const items = all('SELECT i.*, c.name AS category FROM items i LEFT JOIN categories c ON c.id = i.category_id ORDER BY c.sort, i.name');
  const lines = all('SELECT rl.*, ing.cost_per_unit FROM recipe_lines rl JOIN ingredients ing ON ing.id = rl.ingredient_id');
  const variants = all('SELECT * FROM item_variants');
  const out = [];
  for (const it of items) {
    const vs = variants.filter(v => v.item_id === it.id);
    const rows = vs.length ? vs.map(v => ({ variant_id: v.id, variant: v.name, price: v.price })) : [{ variant_id: null, variant: '', price: it.price }];
    for (const row of rows) {
      let rl = lines.filter(l => l.item_id === it.id && l.variant_id === row.variant_id);
      if (!rl.length) rl = lines.filter(l => l.item_id === it.id && l.variant_id == null);
      const cost = Math.round(rl.reduce((s, l) => s + l.qty * l.cost_per_unit, 0));
      const net = tax.enabled && tax.mode === 'inclusive' ? Math.round(row.price / (1 + tax.rate / 100)) : row.price;
      const pct = net > 0 ? +(cost / net * 100).toFixed(1) : null;
      out.push({ item_id: it.id, name: it.name, category: it.category, ...row, net_price: net, cost, margin: net - cost, food_cost_pct: pct, has_recipe: rl.length > 0, low_margin: rl.length > 0 && pct != null && pct > target });
    }
  }
  res.json({ target_pct: target, items: out });
});

// ---------- Purchase orders ----------
function fullPo(id) {
  const po = get(`SELECT po.*, s.name AS supplier_name, l.name AS location_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id LEFT JOIN stock_locations l ON l.id = po.location_id WHERE po.id = ?`, id);
  if (!po) return null;
  po.lines = all('SELECT pl.*, i.name AS ingredient, i.unit FROM po_lines pl JOIN ingredients i ON i.id = pl.ingredient_id WHERE po_id = ? ORDER BY pl.id', id);
  po.total = Math.round(po.lines.reduce((s, l) => s + l.qty * l.unit_cost, 0));
  return po;
}
r.get('/purchase-orders', A.requirePerm(PUR), (req, res) => {
  const where = ['po.branch_id = ?'], p = [req.branchId];
  if (req.query.supplier_id) { where.push('po.supplier_id = ?'); p.push(req.query.supplier_id); }
  if (req.query.status) { where.push('po.status = ?'); p.push(req.query.status); }
  res.json(all(`SELECT po.id FROM purchase_orders po WHERE ${where.join(' AND ')} ORDER BY po.id DESC LIMIT 300`, ...p).map(x => fullPo(x.id)));
});
r.get('/purchase-orders/:id', A.requirePerm(PUR), (req, res) => { const po = fullPo(req.params.id); if (!po) throw U.httpError(404, 'Not found'); res.json(po); });
function saveLines(poId, lines) {
  run('DELETE FROM po_lines WHERE po_id = ?', poId);
  for (const l of lines || []) {
    const q = Number(l.qty);
    if (!l.ingredient_id || !(q > 0)) continue;
    insert('po_lines', { po_id: poId, ingredient_id: Number(l.ingredient_id), qty: q, unit_cost: Number(l.unit_cost) || 0 });
  }
}
r.post('/purchase-orders', A.requirePerm(PUR), (req, res) => {
  const b = req.body || {};
  if (!get('SELECT id FROM suppliers WHERE id = ?', b.supplier_id)) throw U.httpError(400, 'Choose a supplier');
  const loc = b.location_id || get('SELECT id FROM stock_locations WHERE branch_id = ? ORDER BY is_default DESC, id LIMIT 1', req.branchId)?.id;
  const id = tx(() => { const id = insert('purchase_orders', { supplier_id: Number(b.supplier_id), branch_id: req.branchId, location_id: loc || null, status: b.status === 'ordered' ? 'ordered' : 'draft', notes: b.notes || '', created_by: req.user.id }); saveLines(id, b.lines); return id; });
  U.audit(req.user, 'po.create', 'purchase_orders', id);
  res.status(201).json(fullPo(id));
});
r.put('/purchase-orders/:id', A.requirePerm(PUR), (req, res) => {
  const po = fullPo(req.params.id);
  if (!po) throw U.httpError(404, 'Not found');
  const b = req.body || {};
  tx(() => {
    const patch = {};
    if (b.status && ['draft', 'ordered', 'cancelled'].includes(b.status) && po.status !== 'received') patch.status = b.status;
    for (const k of ['notes', 'invoice_no']) if (b[k] != null) patch[k] = String(b[k]);
    if (b.invoice_amount != null) patch.invoice_amount = Math.round(Number(b.invoice_amount) || 0);
    if (b.location_id) patch.location_id = Number(b.location_id);
    if (b.supplier_id && po.status !== 'received') patch.supplier_id = Number(b.supplier_id);
    update('purchase_orders', po.id, patch);
    if (b.lines && po.status !== 'received') saveLines(po.id, b.lines);
  });
  U.audit(req.user, 'po.update', 'purchase_orders', po.id, Object.keys(b));
  res.json(fullPo(po.id));
});
// Receive goods: adds stock, records batch/expiry, updates ingredient purchase cost (→ recipe costs update)
r.post('/purchase-orders/:id/receive', A.requirePerm(PUR), (req, res) => {
  const po = fullPo(req.params.id);
  if (!po) throw U.httpError(404, 'Not found');
  if (['received', 'cancelled'].includes(po.status)) throw U.httpError(409, `PO is ${po.status}`);
  const b = req.body || {};
  const loc = b.location_id || po.location_id;
  if (!loc) throw U.httpError(400, 'Choose a stock location');
  tx(() => {
    for (const l of po.lines) {
      const rec = (b.lines || []).find(x => Number(x.id) === l.id) || {};
      const qty = rec.received_qty != null && rec.received_qty !== '' ? Number(rec.received_qty) : l.qty;
      const cost = rec.unit_cost != null && rec.unit_cost !== '' ? Number(rec.unit_cost) : l.unit_cost;
      run('UPDATE po_lines SET received_qty = ?, unit_cost = ?, batch_no = ?, expiry_date = ? WHERE id = ?', qty, cost, rec.batch_no || null, rec.expiry_date || null, l.id);
      if (qty > 0) {
        insert('stock_movements', { ingredient_id: l.ingredient_id, location_id: Number(loc), type: 'received', qty, unit_cost: cost, batch_no: rec.batch_no || null, expiry_date: rec.expiry_date || null, reference: `PO-${po.id}${b.invoice_no ? ` / ${b.invoice_no}` : ''}`, user_id: req.user.id });
        if (cost > 0) update('ingredients', l.ingredient_id, { cost_per_unit: cost });
      }
    }
    update('purchase_orders', po.id, { status: 'received', received_at: U.nowIso(), location_id: Number(loc), invoice_no: b.invoice_no || po.invoice_no, invoice_amount: b.invoice_amount != null ? Math.round(Number(b.invoice_amount)) : fullPo(po.id).total });
  });
  U.audit(req.user, 'po.receive', 'purchase_orders', po.id, { invoice_no: b.invoice_no });
  res.json(fullPo(po.id));
});
r.post('/purchase-orders/:id/pay', A.requirePerm(PUR), (req, res) => {
  const po = fullPo(req.params.id);
  if (!po) throw U.httpError(404, 'Not found');
  const amt = Math.round(Number(req.body?.amount) || 0);
  if (amt <= 0) throw U.httpError(400, 'Amount required');
  const paid = po.amount_paid + amt;
  const due = po.invoice_amount || po.total;
  update('purchase_orders', po.id, { amount_paid: paid, payment_status: paid >= due ? 'paid' : 'partial' });
  U.audit(req.user, 'po.pay', 'purchase_orders', po.id, { amount: amt });
  res.json(fullPo(po.id));
});
r.get('/suppliers/:id/history', A.requirePerm(PUR), (req, res) => {
  res.json({
    orders: all('SELECT id FROM purchase_orders WHERE supplier_id = ? ORDER BY id DESC LIMIT 100', req.params.id).map(x => fullPo(x.id)),
    prices: all(`SELECT i.name AS ingredient, i.unit, pl.unit_cost, po.received_at FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id JOIN ingredients i ON i.id = pl.ingredient_id WHERE po.supplier_id = ? AND po.status = 'received' ORDER BY po.received_at DESC LIMIT 200`, req.params.id),
  });
});

module.exports = { router: r };
