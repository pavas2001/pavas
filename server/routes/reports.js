'use strict';
// Sales reports & dashboard. Dates are the café's local dates (settings.timezone).
const express = require('express');
const { all, get } = require('../db');
const U = require('../util');
const A = require('../auth');

const r = express.Router();
const RP = 'reports.view';

function range(req) {
  const today = U.localParts().date;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : today;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : from;
  const off = U.tzOffsetMinutes();
  const utc = (d, addDays = 0) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + addDays) - off * 60e3).toISOString();
  return { from, to, start: utc(from), end: utc(to, 1), off, branch: req.query.branch === 'all' ? null : req.branchId };
}
function where(rg, alias = 'o') {
  return { sql: `${alias}.status = 'paid' AND ${alias}.closed_at >= ? AND ${alias}.closed_at < ?${rg.branch ? ` AND ${alias}.branch_id = ?` : ''}`, p: [rg.start, rg.end].concat(rg.branch ? [rg.branch] : []) };
}
const localExpr = (rg, col = 'o.closed_at') => `datetime(${col}, '${rg.off >= 0 ? '+' : ''}${rg.off} minutes')`;

function summary(rg) {
  const w = where(rg);
  const s = get(`SELECT COUNT(*) AS orders, COALESCE(SUM(o.total),0) AS gross, COALESCE(SUM(o.subtotal),0) AS subtotal, COALESCE(SUM(o.discount),0) AS discounts,
                 COALESCE(SUM(o.tax),0) AS tax, COALESCE(SUM(o.service_charge),0) AS service_charge, COALESCE(SUM(o.refunded),0) AS refunds FROM orders o WHERE ${w.sql}`, ...w.p);
  s.net = s.gross - s.refunds;
  s.avg_order = s.orders ? Math.round(s.gross / s.orders) : 0;
  const cw = { sql: `o.status = 'cancelled' AND o.closed_at >= ? AND o.closed_at < ?${rg.branch ? ' AND o.branch_id = ?' : ''}`, p: w.p };
  s.cancelled = get(`SELECT COUNT(*) AS n, COALESCE(SUM(o.total),0) AS value FROM orders o WHERE ${cw.sql}`, ...cw.p);
  s.cancelled_items = get(`SELECT COUNT(*) AS n, COALESCE(SUM(oi.unit_price*oi.qty),0) AS value FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.kds_status = 'cancelled' AND oi.status_at >= ? AND oi.status_at < ?${rg.branch ? ' AND o.branch_id = ?' : ''}`, ...w.p);
  s.payments = all(`SELECT p.method, p.kind, COUNT(*) AS n, SUM(p.amount) AS amount FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.created_at >= ? AND p.created_at < ?${rg.branch ? ' AND o.branch_id = ?' : ''} GROUP BY p.method, p.kind ORDER BY amount DESC`, ...w.p);
  s.by_type = all(`SELECT o.type, COUNT(*) AS orders, SUM(o.total) AS sales FROM orders o WHERE ${w.sql} GROUP BY o.type`, ...w.p);
  s.by_source = all(`SELECT o.source, COUNT(*) AS orders, SUM(o.total) AS sales FROM orders o WHERE ${w.sql} GROUP BY o.source`, ...w.p);
  return s;
}

r.get('/reports/summary', A.requirePerm(RP), (req, res) => { const rg = range(req); res.json({ from: rg.from, to: rg.to, ...summary(rg) }); });

r.get('/reports/sales', A.requirePerm(RP), (req, res) => {
  const rg = range(req); const w = where(rg);
  const fmt = { day: '%Y-%m-%d', week: '%Y-W%W', month: '%Y-%m' }[req.query.group] || '%Y-%m-%d';
  res.json({ from: rg.from, to: rg.to, group: req.query.group || 'day', rows: all(`SELECT strftime('${fmt}', ${localExpr(rg)}) AS period, COUNT(*) AS orders, SUM(o.total) AS sales, SUM(o.discount) AS discounts, SUM(o.tax) AS tax, ROUND(AVG(o.total)) AS avg_order
    FROM orders o WHERE ${w.sql} GROUP BY period ORDER BY period`, ...w.p) });
});
r.get('/reports/items', A.requirePerm(RP), (req, res) => {
  const rg = range(req); const w = where(rg);
  const rows = all(`SELECT oi.item_id, oi.name, c.name AS category, SUM(oi.qty) AS qty, SUM(oi.qty*oi.unit_price) AS sales, COUNT(DISTINCT o.id) AS orders
    FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN items i ON i.id = oi.item_id LEFT JOIN categories c ON c.id = i.category_id
    WHERE ${w.sql} AND oi.kds_status != 'cancelled' GROUP BY oi.item_id, oi.name ORDER BY qty DESC`, ...w.p);
  const sold = new Set(rows.map(x => x.item_id));
  const unsold = all(`SELECT i.id AS item_id, i.name, c.name AS category FROM items i LEFT JOIN categories c ON c.id = i.category_id WHERE i.available = 1`).filter(i => !sold.has(i.item_id)).map(i => ({ ...i, qty: 0, sales: 0, orders: 0 }));
  res.json({ from: rg.from, to: rg.to, best: rows.slice(0, 15), low: rows.slice().reverse().slice(0, 15).concat(unsold).sort((a, b) => a.qty - b.qty).slice(0, 15), all: rows.concat(unsold) });
});
r.get('/reports/categories', A.requirePerm(RP), (req, res) => {
  const rg = range(req); const w = where(rg);
  res.json(all(`SELECT COALESCE(c.name, 'Uncategorised') AS category, SUM(oi.qty) AS qty, SUM(oi.qty*oi.unit_price) AS sales FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN items i ON i.id = oi.item_id LEFT JOIN categories c ON c.id = i.category_id
    WHERE ${w.sql} AND oi.kds_status != 'cancelled' GROUP BY category ORDER BY sales DESC`, ...w.p));
});
r.get('/reports/hours', A.requirePerm(RP), (req, res) => {
  const rg = range(req); const w = where(rg);
  const rows = all(`SELECT CAST(strftime('%H', ${localExpr(rg, 'o.created_at')}) AS INTEGER) AS hour, COUNT(*) AS orders, SUM(o.total) AS sales FROM orders o WHERE ${w.sql} GROUP BY hour ORDER BY hour`, ...w.p);
  res.json(Array.from({ length: 24 }, (_, h) => rows.find(x => x.hour === h) || { hour: h, orders: 0, sales: 0 }));
});
r.get('/reports/discounts', A.requirePerm(RP), (req, res) => {
  const rg = range(req); const w = where(rg);
  res.json({
    discounts: all(`SELECT o.id, o.number, o.invoice_no, o.coupon_code, o.discount_type, o.discount_value, o.discount, o.subtotal, u.name AS by_name, o.closed_at FROM orders o LEFT JOIN users u ON u.id = o.created_by WHERE ${w.sql} AND o.discount > 0 ORDER BY o.id DESC`, ...w.p),
    refunds: all(`SELECT p.*, o.number, o.invoice_no, u.name AS by_name FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.created_by WHERE p.kind = 'refund' AND p.created_at >= ? AND p.created_at < ?${rg.branch ? ' AND o.branch_id = ?' : ''} ORDER BY p.id DESC`, ...w.p),
    cancellations: all(`SELECT o.id, o.number, o.total, o.cancel_reason, o.closed_at FROM orders o WHERE o.status = 'cancelled' AND o.closed_at >= ? AND o.closed_at < ?${rg.branch ? ' AND o.branch_id = ?' : ''} ORDER BY o.id DESC`, ...w.p),
  });
});
r.get('/reports/staff', A.requirePerm(RP), (req, res) => {
  const rg = range(req); const w = where(rg);
  res.json(all(`SELECT u.id, u.name, u.role, COUNT(o.id) AS orders, COALESCE(SUM(o.total),0) AS sales FROM orders o JOIN users u ON u.id = o.created_by WHERE ${w.sql} GROUP BY u.id ORDER BY sales DESC`, ...w.p));
});

// Dashboard: today at a glance + comparisons
r.get('/dashboard', A.requirePerm(RP, 'orders.create'), (req, res) => {
  const today = range({ query: {}, branchId: req.branchId });
  const yd = new Date(Date.parse(today.from) - 86400e3).toISOString().slice(0, 10);
  const yesterday = range({ query: { from: yd, to: yd }, branchId: req.branchId });
  const t = summary(today);
  res.json({
    date: today.from,
    today: t,
    yesterday: (({ orders, gross, avg_order }) => ({ orders, gross, avg_order }))(summary(yesterday)),
    active: get(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM orders WHERE branch_id = ? AND status IN ('open','billed')`, req.branchId),
    kitchen: get(`SELECT SUM(oi.kds_status='new') AS new, SUM(oi.kds_status='preparing') AS preparing, SUM(oi.kds_status='ready') AS ready FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.branch_id = ? AND o.status IN ('open','billed')`, req.branchId),
    tables: all(`SELECT status, COUNT(*) AS n FROM tables WHERE branch_id = ? AND active = 1 AND kind = 'table' GROUP BY status`, req.branchId),
    requests: get(`SELECT COUNT(*) AS n FROM service_requests WHERE branch_id = ? AND status = 'open'`, req.branchId).n,
    reservations: all(`SELECT * FROM reservations WHERE branch_id = ? AND date = ? AND status IN ('booked','arrived') ORDER BY time LIMIT 10`, req.branchId, today.from),
    waitlist: get(`SELECT COUNT(*) AS n FROM waitlist WHERE branch_id = ? AND status = 'waiting'`, req.branchId).n,
    low_stock: all(`SELECT i.id, i.name, i.unit, i.low_stock_level, COALESCE(SUM(m.qty),0) AS level FROM ingredients i LEFT JOIN stock_movements m ON m.ingredient_id = i.id WHERE i.active = 1 AND i.low_stock_level > 0 GROUP BY i.id HAVING level <= i.low_stock_level ORDER BY level - i.low_stock_level LIMIT 10`),
    top_items: all(`SELECT oi.name, SUM(oi.qty) AS qty FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.branch_id = ? AND o.created_at >= ? AND oi.kds_status != 'cancelled' GROUP BY oi.name ORDER BY qty DESC LIMIT 5`, req.branchId, today.start),
    hours: all(`SELECT CAST(strftime('%H', ${localExpr(today, 'o.created_at')}) AS INTEGER) AS hour, COUNT(*) AS orders, SUM(o.total) AS sales FROM orders o WHERE o.branch_id = ? AND o.created_at >= ? AND o.status NOT IN ('cancelled','merged') GROUP BY hour`, req.branchId, today.start),
    rating: get(`SELECT COUNT(*) AS n, ROUND(AVG(rating),2) AS avg FROM feedback WHERE created_at >= datetime('now','-30 days')`),
  });
});

// CSV exports for accounting
function csv(rows, cols) {
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(c => c[0]).join(',')].concat(rows.map(r => cols.map(([, f]) => esc(typeof f === 'function' ? f(r) : r[f])).join(','))).join('\n');
}
const rupees = k => r => (r[k] == null ? '' : (r[k] / 100).toFixed(2));
r.get('/reports/export/:kind.csv', A.requirePerm(RP), (req, res) => {
  const rg = range(req); const w = where(rg);
  let out;
  switch (req.params.kind) {
    case 'orders':
      out = csv(all(`SELECT o.*, t.label AS table_label, b.name AS branch, ${localExpr(rg)} AS local_time,
        (SELECT GROUP_CONCAT(p.method || ':' || printf('%.2f', p.amount/100.0), ' ') FROM payments p WHERE p.order_id = o.id AND p.kind='payment') AS pay FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN branches b ON b.id = o.branch_id WHERE ${w.sql} ORDER BY o.closed_at`, ...w.p),
        [['invoice_no', 'invoice_no'], ['order_no', 'number'], ['closed_at_local', 'local_time'], ['branch', 'branch'], ['type', 'type'], ['source', 'source'], ['table', 'table_label'], ['customer', 'customer_name'], ['phone', 'customer_phone'],
          ['subtotal', rupees('subtotal')], ['discount', rupees('discount')], ['service_charge', rupees('service_charge')], ['tax', rupees('tax')], ['round_off', rupees('round_off')], ['total', rupees('total')], ['refunded', rupees('refunded')], ['payments', 'pay']]);
      break;
    case 'items':
      out = csv(all(`SELECT oi.name, oi.variant_name, SUM(oi.qty) AS qty, SUM(oi.qty*oi.unit_price) AS sales FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE ${w.sql} AND oi.kds_status != 'cancelled' GROUP BY oi.name, oi.variant_name ORDER BY sales DESC`, ...w.p),
        [['item', 'name'], ['variant', 'variant_name'], ['qty', 'qty'], ['sales', rupees('sales')]]);
      break;
    case 'payments':
      out = csv(all(`SELECT p.*, o.number, o.invoice_no, u.name AS by_name FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.created_by WHERE p.created_at >= ? AND p.created_at < ?${rg.branch ? ' AND o.branch_id = ?' : ''} ORDER BY p.id`, ...w.p),
        [['date', 'created_at'], ['invoice_no', 'invoice_no'], ['order_no', 'number'], ['kind', 'kind'], ['method', 'method'], ['amount', rupees('amount')], ['reference', 'reference'], ['note', 'note'], ['by', 'by_name']]);
      break;
    case 'tax':
      out = csv(all(`SELECT strftime('%Y-%m-%d', ${localExpr(rg)}) AS day, COUNT(*) AS invoices, SUM(o.total - o.round_off - o.tax) AS taxable, SUM(o.tax) AS tax, SUM(o.total) AS total FROM orders o WHERE ${w.sql} GROUP BY day ORDER BY day`, ...w.p),
        [['date', 'day'], ['invoices', 'invoices'], ['taxable_value', rupees('taxable')], ['tax', rupees('tax')], ['total', rupees('total')]]);
      break;
    default: throw U.httpError(404, 'Unknown export');
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="pixberry-${req.params.kind}-${rg.from}_${rg.to}.csv"`);
  res.send(out);
});

module.exports = { router: r };
