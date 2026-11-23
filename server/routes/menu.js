'use strict';
const express = require('express');
const { all, get, run, insert, update, tx } = require('../db');
const U = require('../util');
const A = require('../auth');
const { crud, pick } = require('../crud');

const r = express.Router();
const P = 'menu.manage';

crud(r, '/categories', { table: 'categories', perm: P, readPerm: 'any', order: 'sort, name', auditFields: ['name'],
  fields: { name: 'str:required', description: 'str', sort: 'int', active: 'bool', available_from: 'time', available_to: 'time' } });
crud(r, '/stations', { table: 'stations', perm: P, readPerm: 'any', order: 'sort, name', fields: { name: 'str:required', sort: 'int' }, auditFields: ['name'] });

const ITEM_FIELDS = {
  category_id: 'int', name: 'str:required', description: 'str', photo_url: 'str', price: 'money:required', takeaway_price: 'money',
  diet: 'str', available: 'bool', sold_out: 'bool', featured: 'bool', recommended: 'bool',
  available_from: 'time', available_to: 'time', available_days: 'str', station_id: 'int', is_combo: 'bool', combo_items: 'str', sort: 'int',
};

function fullItem(id) {
  const it = get('SELECT i.*, c.name AS category_name, s.name AS station_name FROM items i LEFT JOIN categories c ON c.id = i.category_id LEFT JOIN stations s ON s.id = i.station_id WHERE i.id = ?', id);
  if (!it) return null;
  it.variants = all('SELECT * FROM item_variants WHERE item_id = ? ORDER BY sort, id', id);
  it.groups = all('SELECT * FROM modifier_groups WHERE item_id = ? ORDER BY sort, id', id).map(g => ({ ...g, options: all('SELECT * FROM modifiers WHERE group_id = ? ORDER BY sort, id', g.id) }));
  const rc = get(`SELECT COALESCE(SUM(rl.qty * ing.cost_per_unit), 0) AS c FROM recipe_lines rl JOIN ingredients ing ON ing.id = rl.ingredient_id WHERE rl.item_id = ? AND rl.variant_id IS NULL`, id);
  it.recipe_cost = Math.round(rc.c);
  return it;
}

// Replace variants & modifier groups from a nested payload
function saveNested(itemId, body) {
  if (Array.isArray(body.variants)) {
    run('DELETE FROM item_variants WHERE item_id = ?', itemId);
    body.variants.forEach((v, i) => { if (v.name) insert('item_variants', { item_id: itemId, name: String(v.name), price: Math.round(+v.price || 0), takeaway_price: v.takeaway_price === '' || v.takeaway_price == null ? null : Math.round(+v.takeaway_price), sort: i }); });
  }
  if (Array.isArray(body.groups)) {
    run('DELETE FROM modifier_groups WHERE item_id = ?', itemId);
    body.groups.forEach((g, gi) => {
      if (!g.name) return;
      const gid = insert('modifier_groups', { item_id: itemId, name: String(g.name), min_select: Math.max(0, +g.min_select || 0), max_select: Math.max(0, +g.max_select || 0), sort: gi });
      (g.options || []).forEach((o, oi) => { if (o.name) insert('modifiers', { group_id: gid, name: String(o.name), price: Math.round(+o.price || 0), sort: oi }); });
    });
  }
}

r.get('/items', A.requireUser, (req, res) => {
  const where = [], p = [];
  if (req.query.category_id) { where.push('category_id = ?'); p.push(req.query.category_id); }
  if (req.query.q) { where.push('(i.name LIKE ? OR i.description LIKE ?)'); p.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const rows = all(`SELECT i.id FROM items i ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.sort, i.name`, ...p);
  res.json(rows.map(x => fullItem(x.id)));
});
r.get('/items/:id', A.requireUser, (req, res) => { const it = fullItem(req.params.id); if (!it) throw U.httpError(404, 'Not found'); res.json(it); });
r.post('/items', A.requirePerm(P), (req, res) => {
  const id = tx(() => { const id = insert('items', pick(ITEM_FIELDS, req.body)); saveNested(id, req.body); return id; });
  U.audit(req.user, 'items.create', 'items', id, { name: req.body.name, price: req.body.price });
  U.emit('menu.changed', {});
  res.status(201).json(fullItem(id));
});
r.put('/items/:id', A.requirePerm(P), (req, res) => {
  const before = get('SELECT * FROM items WHERE id = ?', req.params.id);
  if (!before) throw U.httpError(404, 'Not found');
  tx(() => { update('items', before.id, pick(ITEM_FIELDS, req.body, { partial: true })); saveNested(before.id, req.body); });
  const after = fullItem(before.id);
  const changes = {};
  for (const k of ['price', 'takeaway_price', 'sold_out', 'available', 'name']) if (before[k] !== after[k]) changes[k] = [before[k], after[k]];
  U.audit(req.user, 'items.update', 'items', before.id, changes);
  U.emit('menu.changed', {});
  res.json(after);
});
r.post('/items/:id/sold-out', A.requirePerm(P, 'orders.create'), (req, res) => {
  const it = get('SELECT * FROM items WHERE id = ?', req.params.id);
  if (!it) throw U.httpError(404, 'Not found');
  const v = req.body?.sold_out ? 1 : 0;
  update('items', it.id, { sold_out: v });
  U.audit(req.user, v ? 'items.sold_out' : 'items.back_in_stock', 'items', it.id, { name: it.name });
  U.emit('menu.changed', {});
  res.json(fullItem(it.id));
});
r.delete('/items/:id', A.requirePerm(P), (req, res) => {
  const it = get('SELECT * FROM items WHERE id = ?', req.params.id);
  if (!it) throw U.httpError(404, 'Not found');
  run('DELETE FROM items WHERE id = ?', it.id); // order_items keep their own name/price copy
  U.audit(req.user, 'items.delete', 'items', it.id, { name: it.name });
  U.emit('menu.changed', {});
  res.json({ ok: true });
});

// ---------- Import / export ----------
function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
const CSV_COLS = ['category', 'name', 'description', 'price', 'takeaway_price', 'diet', 'available', 'sold_out', 'featured', 'station', 'available_from', 'available_to', 'photo_url'];

r.get('/menu/export.json', A.requirePerm(P), (_req, res) => {
  res.setHeader('content-disposition', 'attachment; filename="pixberry-menu.json"');
  res.json({ version: 1, categories: all('SELECT * FROM categories ORDER BY sort'), stations: all('SELECT * FROM stations'), items: all('SELECT id FROM items ORDER BY sort, name').map(x => fullItem(x.id)) });
});
r.get('/menu/export.csv', A.requirePerm(P), (_req, res) => {
  const rows = all('SELECT i.*, c.name AS category, s.name AS station FROM items i LEFT JOIN categories c ON c.id = i.category_id LEFT JOIN stations s ON s.id = i.station_id ORDER BY c.sort, i.sort, i.name');
  const lines = [CSV_COLS.join(',')].concat(rows.map(r => CSV_COLS.map(c => csvEscape(['price', 'takeaway_price'].includes(c) ? (r[c] == null ? '' : (r[c] / 100).toFixed(2)) : r[c])).join(',')));
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="pixberry-menu.csv"');
  res.send(lines.join('\n'));
});
// CSV import: upserts items by (category, name). Prices in currency units (e.g. 149.00).
r.post('/menu/import', A.requirePerm(P), express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  const text = typeof req.body === 'string' ? req.body : '';
  let created = 0, updated = 0;
  tx(() => {
    if (text.trim().startsWith('{')) {
      const data = JSON.parse(text);
      for (const c of data.categories || []) if (!get('SELECT id FROM categories WHERE name = ?', c.name)) insert('categories', { name: c.name, description: c.description || '', sort: c.sort || 0, active: c.active ?? 1, available_from: c.available_from, available_to: c.available_to });
      for (const s of data.stations || []) if (!get('SELECT id FROM stations WHERE name = ?', s.name)) insert('stations', { name: s.name });
      for (const it of data.items || []) {
        const cat = it.category_name ? get('SELECT id FROM categories WHERE name = ?', it.category_name) : null;
        const st = it.station_name ? get('SELECT id FROM stations WHERE name = ?', it.station_name) : null;
        const fields = pick(ITEM_FIELDS, { ...it, category_id: cat?.id ?? null, station_id: st?.id ?? null });
        const ex = get('SELECT id FROM items WHERE name = ? AND category_id IS ?', it.name, cat?.id ?? null);
        const id = ex ? (update('items', ex.id, fields), ex.id) : insert('items', fields);
        saveNested(id, { variants: (it.variants || []), groups: (it.groups || []) });
        ex ? updated++ : created++;
      }
      return;
    }
    const rows = parseCsv(text);
    if (!rows.length) throw U.httpError(400, 'Empty file');
    const head = rows[0].map(h => h.trim().toLowerCase());
    if (!head.includes('name') || !head.includes('price')) throw U.httpError(400, 'CSV needs at least "name" and "price" columns');
    for (const row of rows.slice(1)) {
      const o = Object.fromEntries(head.map((h, i) => [h, (row[i] ?? '').trim()]));
      if (!o.name) continue;
      let cat = null;
      if (o.category) { cat = get('SELECT id FROM categories WHERE name = ?', o.category) || { id: insert('categories', { name: o.category }) }; }
      let st = null;
      if (o.station) { st = get('SELECT id FROM stations WHERE name = ?', o.station) || { id: insert('stations', { name: o.station }) }; }
      const fields = pick(ITEM_FIELDS, {
        category_id: cat?.id ?? null, name: o.name, description: o.description, photo_url: o.photo_url,
        price: U.toPaise(o.price), takeaway_price: o.takeaway_price ? U.toPaise(o.takeaway_price) : null,
        diet: o.diet || 'veg', available: o.available === '' || o.available == null ? 1 : o.available, sold_out: o.sold_out || 0, featured: o.featured || 0,
        station_id: st?.id ?? null, available_from: o.available_from || null, available_to: o.available_to || null,
      });
      const ex = get('SELECT id FROM items WHERE name = ? AND category_id IS ?', o.name, cat?.id ?? null);
      if (ex) { update('items', ex.id, fields); updated++; } else { insert('items', fields); created++; }
    }
  });
  U.audit(req.user, 'menu.import', 'items', null, { created, updated });
  U.emit('menu.changed', {});
  res.json({ created, updated });
});

module.exports = { router: r, fullItem };
