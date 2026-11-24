'use strict';
const path = require('node:path');
const express = require('express');
const { all, get, run } = require('./db');
const U = require('./util');
const A = require('./auth');
const O = require('./orders');

function createApp() {
  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Geolocation is needed by the customer ordering page
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  // ---------- Public (customer) API ----------
  app.use('/api/public', require('./routes/public').router);
  // ---------- Signal Cube devices (authenticated by device key) ----------
  app.use('/api/device', require('./routes/signal').device);

  // ---------- Staff API ----------
  const api = express.Router();
  api.use(A.authenticate);
  // Branch context: X-Branch header / ?branch=, else the user's branch, else the first active branch
  api.use((req, _res, next) => {
    const want = Number(req.get('x-branch') || req.query.branch_id) || req.user?.branch_id || null;
    const b = want ? get('SELECT id FROM branches WHERE id = ?', want) : null;
    req.branchId = b?.id || get('SELECT id FROM branches WHERE active = 1 ORDER BY id LIMIT 1')?.id || null;
    next();
  });
  api.use(require('./routes/system').router);
  api.use(require('./routes/menu').router);
  api.use(require('./routes/pos').router);
  api.use(require('./routes/floor').router);
  api.use(require('./routes/inventory').router);
  api.use(require('./routes/people').router);
  api.use(require('./routes/reports').router);
  api.use(require('./routes/signal').router);

  // Live updates for staff screens (POS, tables, KDS, notifications) via Server-Sent Events
  api.get('/events', A.requireUser, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 3000\n\n`);
    const branch = req.branchId;
    const onEvent = ev => {
      if (ev.data?.branch_id && branch && ev.data.branch_id !== branch) return;
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    };
    U.bus.on('event', onEvent);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on('close', () => { clearInterval(ping); U.bus.off('event', onEvent); });
  });
  app.use('/api', api);
  app.use('/api', (_req, _res, next) => next(U.httpError(404, 'Not found')));

  // ---------- Receipt (public by unguessable key; also used by staff for printing) ----------
  app.get('/r/:key', (req, res) => {
    const row = get('SELECT id FROM orders WHERE public_key = ?', req.params.key);
    if (!row) return res.status(404).type('html').send('<h1>Receipt not found</h1>');
    res.type('html').send(receiptHtml(O.getOrder(row.id), req.query.print === '1'));
  });

  // ---------- Frontends ----------
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub, { index: false, maxAge: '1h' }));
  app.get('/order/:token', (_req, res) => res.sendFile(path.join(pub, 'order', 'index.html')));
  app.get(['/admin', '/admin/'], (_req, res) => res.sendFile(path.join(pub, 'admin', 'index.html')));
  app.get(['/kds', '/kds/'], (_req, res) => res.sendFile(path.join(pub, 'kds', 'index.html')));
  app.get(['/signal', '/signal/'], (_req, res) => res.sendFile(path.join(pub, 'signal', 'index.html')));
  app.get(['/signal/app', '/signal/app/'], (_req, res) => res.sendFile(path.join(pub, 'signal', 'app.html')));
  app.get('/', (_req, res) => res.redirect('/admin'));

  // ---------- Errors ----------
  app.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    const msg = status >= 500 ? 'Something went wrong. Please try again.' : err.message;
    if (req.path.startsWith('/api')) res.status(status).json({ error: msg, ...(err.extra || {}) });
    else res.status(status).type('text').send(msg);
  });
  return app;
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function receiptHtml(o, autoPrint) {
  const cafe = U.getSetting('cafe'), rc = U.getSetting('receipt'), m = U.money;
  const tz = U.getSetting('timezone');
  const when = new Date(o.closed_at || o.created_at).toLocaleString('en-IN', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
  const lines = o.items.filter(i => i.kds_status !== 'cancelled').map(i => `<tr><td>${i.qty}× ${esc(i.name)}${i.variant_name ? ` (${esc(i.variant_name)})` : ''}${i.modifiers.length ? `<div class="mod">+ ${esc(i.modifiers.map(x => x.name).join(', '))}</div>` : ''}</td><td class="r">${m(i.unit_price * i.qty)}</td></tr>`).join('');
  const row = (l, v, cls = '') => `<tr class="${cls}"><td>${l}</td><td class="r">${v}</td></tr>`;
  const pays = o.payments.map(p => row(`${p.kind === 'refund' ? 'Refund' : 'Paid'} · ${esc(p.method.toUpperCase())}`, `${p.kind === 'refund' ? '−' : ''}${m(p.amount)}`)).join('');
  const width = rc.paper === 'a4' ? '640px' : rc.paper === '58mm' ? '220px' : '300px';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.invoice_no || `Order #${o.number}`)} — ${esc(cafe.name)}</title>
<style>body{font:13px/1.4 ui-monospace,Menlo,Consolas,monospace;margin:0;padding:16px;background:#fff;color:#000}.rc{max-width:${width};margin:0 auto}
h1{font-size:16px;margin:4px 0;text-align:center}.c{text-align:center}.mut{color:#444}table{width:100%;border-collapse:collapse}td{padding:2px 0;vertical-align:top}.r{text-align:right;white-space:nowrap}
.mod{font-size:11px;color:#444}hr{border:0;border-top:1px dashed #000;margin:8px 0}.tot td{font-weight:700;font-size:15px}img{max-height:48px;display:block;margin:0 auto}
@media print{.np{display:none}body{padding:0}}</style></head><body><div class="rc">
${rc.show_logo && cafe.logo_url ? `<img src="${esc(cafe.logo_url)}" alt="">` : ''}<h1>${esc(cafe.name)}</h1>
<div class="c mut">${esc(o.branch_name)}${cafe.address ? `<br>${esc(cafe.address)}` : ''}${cafe.phone ? `<br>${esc(cafe.phone)}` : ''}${rc.show_gstin && cafe.gstin ? `<br>GSTIN: ${esc(cafe.gstin)}` : ''}</div>
${rc.header ? `<p class="c">${esc(rc.header)}</p>` : ''}<hr>
<table>${row(o.invoice_no ? 'Invoice' : 'Order', esc(o.invoice_no || `#${o.number}`))}${row('Order no.', `#${o.number}`)}${row('Date', esc(when))}${row('Type', esc(o.type.replace('_', '-')) + (o.table_label ? ` · ${esc(o.table_label)}` : '') + (o.pickup_code ? ` · code ${esc(o.pickup_code)}` : ''))}${o.customer_name ? row('Customer', esc(o.customer_name)) : ''}</table><hr>
<table>${lines}</table><hr><table>${row('Subtotal', m(o.subtotal))}${o.discount ? row(`Discount${o.coupon_code ? ` (${esc(o.coupon_code)})` : ''}`, `−${m(o.discount)}`) : ''}${o.service_charge ? row('Service charge', m(o.service_charge)) : ''}
${o.tax_breakdown.map(t => row(`${esc(t.label)}${o.tax_mode === 'inclusive' ? ' (incl.)' : ''}`, m(t.amount))).join('')}${o.round_off ? row('Round off', m(o.round_off)) : ''}${row('TOTAL', m(o.total), 'tot')}</table>
${pays ? `<hr><table>${pays}</table>` : ''}${o.status === 'paid' ? '<p class="c"><b>PAID</b></p>' : o.status === 'cancelled' ? '<p class="c"><b>CANCELLED</b></p>' : `<p class="c">Balance due: <b>${m(o.balance)}</b></p>`}
${rc.footer ? `<hr><p class="c">${esc(rc.footer)}</p>` : ''}<p class="c np"><button onclick="print()">Print</button></p></div>${autoPrint ? '<script>addEventListener("load",()=>setTimeout(print,200))</script>' : ''}</body></html>`;
}

// ---------- Background jobs ----------
function startJobs() {
  const { backupNow } = require('./routes/system');
  const timers = [];
  // Delayed-order alerts
  timers.push(setInterval(() => {
    try {
      const k = U.getSetting('kds');
      if (U.getSetting('notifications').delayed_orders === false) return;
      const cutoff = new Date(Date.now() - k.delay_minutes * 60e3).toISOString();
      for (const o of all(`SELECT DISTINCT o.id, o.number, o.branch_id, t.label FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN tables t ON t.id = o.table_id
                           WHERE o.status IN ('open','billed') AND o.delayed_notified = 0 AND oi.kds_status IN ('new','preparing') AND oi.created_at < ?`, cutoff)) {
        run('UPDATE orders SET delayed_notified = 1 WHERE id = ?', o.id);
        U.notify({ branch_id: o.branch_id, audience: 'manager', type: 'delayed_order', message: `Order #${o.number}${o.label ? ` (${o.label})` : ''} has been waiting more than ${k.delay_minutes} min`, ref: `order:${o.id}` });
        U.notify({ branch_id: o.branch_id, audience: 'kitchen', type: 'delayed_order', message: `Delayed: #${o.number}${o.label ? ` (${o.label})` : ''}`, ref: `order:${o.id}` });
      }
    } catch (e) { console.error('delay job', e); }
  }, 60e3));
  // Signal: escalate unanswered table requests (floor, then manager)
  timers.push(setInterval(() => { try { require('./signal').escalate(); } catch (e) { console.error('signal job', e); } }, 15e3));
  // Outbound messages
  timers.push(setInterval(() => U.flushOutbox().catch(e => console.error('outbox', e)), 15e3));
  // Daily automatic backup (checked hourly)
  const daily = () => {
    try {
      const cfg = U.getSetting('backup');
      if (!cfg.enabled) return;
      const today = U.localParts().date;
      if (U.getSetting('last_auto_backup') === today) return;
      const f = backupNow('auto');
      U.setSetting('last_auto_backup', today);
      console.log(`[backup] ${f}`);
    } catch (e) { console.error('backup job', e); }
  };
  timers.push(setInterval(daily, 3600e3));
  setTimeout(daily, 10e3).unref();
  timers.forEach(t => t.unref());
  return timers;
}

function bootstrap() {
  const pw = A.ensureAdmin();
  if (!get('SELECT id FROM branches LIMIT 1')) {
    const id = require('./db').insert('branches', { name: 'Main branch', radius_m: 100, geofence_enabled: 1 });
    require('./db').insert('stock_locations', { branch_id: id, name: 'Main store', is_default: 1 });
  }
  return pw;
}

if (require.main === module) {
  const pw = bootstrap();
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Pixberry ERP running on http://localhost:${port}`);
    console.log(`  Staff / admin:   http://localhost:${port}/admin`);
    console.log(`  Kitchen display: http://localhost:${port}/kds`);
    console.log(`  Signal display:  http://localhost:${port}/signal   (staff app: /signal/app)`);
    if (pw) console.log(`\n  First run — created user "admin" with password: ${pw}\n  (set ADMIN_PASSWORD to choose it; change it after signing in)\n`);
  });
  startJobs();
}

module.exports = { createApp, bootstrap, startJobs, receiptHtml };
