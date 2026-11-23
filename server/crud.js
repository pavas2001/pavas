'use strict';
// Generic CRUD routes for simple entities, with field whitelists and permission checks.
const { all, get, insert, update, run } = require('./db');
const { httpError, audit, emit } = require('./util');
const { requirePerm, requireUser } = require('./auth');

// Field types: str, int, real, bool, money (paise, sent as paise integers), date, time, json
function coerce(type, v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return type === 'str' ? '' : null;
  switch (type) {
    case 'str': return String(v).slice(0, 2000);
    case 'int': case 'money': { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw httpError(400, `Invalid number: ${v}`); return n; }
    case 'real': { const n = Number(v); if (!Number.isFinite(n)) throw httpError(400, `Invalid number: ${v}`); return n; }
    case 'bool': return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
    case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw httpError(400, `Invalid date: ${v}`); return v;
    case 'time': if (!/^\d{2}:\d{2}$/.test(v)) throw httpError(400, `Invalid time: ${v}`); return v;
    case 'json': return typeof v === 'string' ? v : JSON.stringify(v);
    default: return v;
  }
}
function pick(fields, body, { partial } = {}) {
  const out = {};
  for (const [k, spec] of Object.entries(fields)) {
    const [type, req] = spec.split(':');
    const v = coerce(type, body?.[k]);
    if (v === undefined) { if (!partial && req === 'required') throw httpError(400, `${k} is required`); continue; }
    if (req === 'required' && (v === null || v === '')) throw httpError(400, `${k} is required`);
    out[k] = v;
  }
  return out;
}

/**
 * crud(router, '/suppliers', { table: 'suppliers', perm: 'purchasing.manage', fields: {...}, order: 'name',
 *   branchScoped: true, readPerm: 'x', filters: ['status'], select: 'custom SELECT', onChange: fn })
 */
function crud(router, path, opt) {
  const readGuard = opt.readPerm === 'any' ? requireUser : requirePerm(...[].concat(opt.readPerm || opt.perm));
  const writeGuard = requirePerm(...[].concat(opt.perm));
  const base = opt.select || `SELECT * FROM ${opt.table}`;
  router.get(path, readGuard, (req, res) => {
    const where = [], params = [];
    if (opt.branchScoped && req.branchId) { where.push(`${opt.alias ? opt.alias + '.' : ''}branch_id = ?`); params.push(req.branchId); }
    for (const f of opt.filters || []) if (req.query[f] != null && req.query[f] !== '') { where.push(`${opt.alias ? opt.alias + '.' : ''}${f} = ?`); params.push(req.query[f]); }
    if (opt.search && req.query.q) { where.push(`(${opt.search.map(c => `${c} LIKE ?`).join(' OR ')})`); opt.search.forEach(() => params.push(`%${req.query.q}%`)); }
    const sql = `${base}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${opt.order || 'id DESC'} LIMIT ${Math.min(Number(req.query.limit) || 500, 2000)}`;
    res.json(all(sql, ...params).map(opt.map || (x => x)));
  });
  router.get(`${path}/:id`, readGuard, (req, res) => {
    const row = get(`SELECT * FROM ${opt.table} WHERE id = ?`, req.params.id);
    if (!row) throw httpError(404, 'Not found');
    res.json(opt.map ? opt.map(row) : row);
  });
  router.post(path, writeGuard, (req, res) => {
    const data = pick(opt.fields, req.body);
    if (opt.branchScoped && data.branch_id == null && 'branch_id' in opt.fields) data.branch_id = req.branchId;
    if (opt.beforeSave) opt.beforeSave(data, req, null);
    const id = insert(opt.table, data);
    audit(req.user, `${opt.table}.create`, opt.table, id, opt.auditFields ? Object.fromEntries(opt.auditFields.map(f => [f, data[f]])) : null);
    opt.onChange?.(id, req);
    emit(`${opt.table}.changed`, { id, branch_id: req.branchId });
    res.status(201).json(get(`SELECT * FROM ${opt.table} WHERE id = ?`, id));
  });
  router.put(`${path}/:id`, writeGuard, (req, res) => {
    const row = get(`SELECT * FROM ${opt.table} WHERE id = ?`, req.params.id);
    if (!row) throw httpError(404, 'Not found');
    const data = pick(opt.fields, req.body, { partial: true });
    if (opt.beforeSave) opt.beforeSave(data, req, row);
    update(opt.table, row.id, data);
    audit(req.user, `${opt.table}.update`, opt.table, row.id, Object.keys(data));
    opt.onChange?.(row.id, req);
    emit(`${opt.table}.changed`, { id: row.id, branch_id: req.branchId });
    res.json(get(`SELECT * FROM ${opt.table} WHERE id = ?`, row.id));
  });
  if (opt.noDelete) return;
  router.delete(`${path}/:id`, writeGuard, (req, res) => {
    const row = get(`SELECT * FROM ${opt.table} WHERE id = ?`, req.params.id);
    if (!row) throw httpError(404, 'Not found');
    try { run(`DELETE FROM ${opt.table} WHERE id = ?`, row.id); }
    catch (e) {
      if (/FOREIGN KEY/i.test(e.message)) {
        if ('active' in row) { update(opt.table, row.id, { active: 0 }); audit(req.user, `${opt.table}.deactivate`, opt.table, row.id); return res.json({ ok: true, deactivated: true }); }
        throw httpError(409, 'This record is in use and cannot be deleted.');
      }
      throw e;
    }
    audit(req.user, `${opt.table}.delete`, opt.table, row.id, opt.auditFields ? Object.fromEntries(opt.auditFields.map(f => [f, row[f]])) : null);
    emit(`${opt.table}.changed`, { id: row.id, branch_id: req.branchId });
    res.json({ ok: true });
  });
}

module.exports = { crud, pick, coerce };
