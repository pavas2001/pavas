// Sales reports: summary, trend by day/week/month, items (best/low), categories, order types, busy hours, payments, discounts/refunds/cancellations, staff, CSV exports.
import { api, downloadFile, session } from '/assets/staff.js';
import { esc, $, money, tableHtml, bars, hbars, today, daysAgo } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';

export async function render(el) {
  const f = { from: daysAgo(6), to: today(), group: 'day', branch: '' };
  el.innerHTML = `<div class="toolbar">
      <select id="preset"><option value="7">Last 7 days</option><option value="0">Today</option><option value="1">Yesterday</option><option value="30">Last 30 days</option><option value="month">This month</option><option value="custom">Custom</option></select>
      <input type="date" id="from" value="${f.from}"><input type="date" id="to" value="${f.to}">
      <select id="group"><option value="day">By day</option><option value="week">By week</option><option value="month">By month</option></select>
      ${session.me.branches.length > 1 ? '<select id="br"><option value="">This branch</option><option value="all">All branches</option></select>' : ''}
      <span class="grow"></span>
      <select id="exp"><option value="">Export CSV…</option><option value="orders">Invoices / orders</option><option value="items">Item sales</option><option value="payments">Payments</option><option value="tax">Tax summary (by day)</option></select>
    </div><div id="rep"><div class="empty">Loading…</div></div>`;
  async function load() {
    const p = new URLSearchParams({ from: f.from, to: f.to, group: f.group, ...(f.branch ? { branch: f.branch } : {}) });
    const [s, sales, items, cats, hours, disc, staff] = await Promise.all(['summary', 'sales', 'items', 'categories', 'hours', 'discounts', 'staff'].map(k => api('GET', `/reports/${k}?${p}`)));
    $('#rep').innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="l">Gross sales</div><div class="v">${money(s.gross)}</div><div class="d">net of refunds ${money(s.net)}</div></div>
        <div class="kpi"><div class="l">Orders</div><div class="v">${s.orders}</div><div class="d">avg ${money(s.avg_order)}</div></div>
        <div class="kpi"><div class="l">Tax collected</div><div class="v">${money(s.tax)}</div></div>
        <div class="kpi"><div class="l">Service charge</div><div class="v">${money(s.service_charge)}</div></div>
        <div class="kpi"><div class="l">Discounts</div><div class="v">${money(s.discounts)}</div></div>
        <div class="kpi"><div class="l">Refunds</div><div class="v">${money(s.refunds)}</div></div>
        <div class="kpi"><div class="l">Cancelled</div><div class="v">${s.cancelled.n} orders</div><div class="d">${money(s.cancelled.value)} · ${s.cancelled_items.n} items ${money(s.cancelled_items.value)}</div></div>
      </div>
      <div class="cols">
        <div class="card" style="grid-column:1/-1"><h3>Sales by ${f.group}</h3>${bars(sales.rows, { label: r => r.period.slice(f.group === 'day' ? 5 : 0), value: r => r.sales, fmt: money })}
          ${tableHtml([{ label: 'Period', key: 'period' }, { label: 'Orders', key: 'orders', r: 1 }, { label: 'Sales', render: r => money(r.sales), r: 1 }, { label: 'Avg order', render: r => money(r.avg_order), r: 1 }, { label: 'Discounts', render: r => money(r.discounts), r: 1 }, { label: 'Tax', render: r => money(r.tax), r: 1 }], sales.rows, { empty: 'No paid orders in this range.' })}</div>
        <div class="card"><h3>Best sellers</h3>${tableHtml([{ label: 'Item', key: 'name' }, { label: 'Qty', key: 'qty', r: 1 }, { label: 'Sales', render: r => money(r.sales), r: 1 }], items.best, { empty: 'No sales.' })}</div>
        <div class="card"><h3>Slow sellers</h3>${tableHtml([{ label: 'Item', key: 'name' }, { label: 'Category', key: 'category' }, { label: 'Qty', key: 'qty', r: 1 }], items.low, { empty: '—' })}</div>
        <div class="card"><h3>By category</h3>${hbars(cats, { label: r => r.category, value: r => r.sales, fmt: money })}</div>
        <div class="card"><h3>By order type & source</h3>${hbars(s.by_type, { label: r => r.type.replace('_', '-'), value: r => r.sales, fmt: money })}<hr>${hbars(s.by_source, { label: r => (r.source === 'qr' ? 'QR orders' : 'POS orders'), value: r => r.sales, fmt: money })}</div>
        <div class="card"><h3>Busy hours</h3>${bars(hours.slice(6), { label: r => r.hour, value: r => r.orders })}<p class="hint">Paid orders by hour the order was placed.</p></div>
        <div class="card"><h3>Payment methods</h3>${tableHtml([{ label: 'Method', render: r => esc(r.method.toUpperCase()) }, { label: 'Type', key: 'kind' }, { label: 'Count', key: 'n', r: 1 }, { label: 'Amount', render: r => money(r.amount), r: 1 }], s.payments, { empty: 'No payments.' })}</div>
        <div class="card"><h3>Sales by staff</h3>${tableHtml([{ label: 'Staff', key: 'name' }, { label: 'Role', key: 'role' }, { label: 'Orders', key: 'orders', r: 1 }, { label: 'Sales', render: r => money(r.sales), r: 1 }], staff, { empty: 'Only POS orders are attributed to staff.' })}</div>
        <div class="card" style="grid-column:1/-1"><h3>Discounts, refunds & cancellations</h3>
          ${tableHtml([{ label: 'Order', render: r => `#${r.number} ${esc(r.invoice_no || '')}` }, { label: 'Discount', render: r => esc(r.coupon_code || (r.discount_type === 'percent' ? `${r.discount_value}%` : 'flat')) }, { label: 'Amount', render: r => money(r.discount), r: 1 }, { label: 'Staff', key: 'by_name' }, { label: 'When', render: r => esc(fmtDate(r.closed_at)) }], disc.discounts, { empty: 'No discounts.' })}
          <div style="height:12px"></div>${tableHtml([{ label: 'Refund on', render: r => `#${r.number} ${esc(r.invoice_no || '')}` }, { label: 'Method', key: 'method' }, { label: 'Amount', render: r => money(r.amount), r: 1 }, { label: 'Reason', key: 'note' }, { label: 'By', key: 'by_name' }, { label: 'When', render: r => esc(fmtDate(r.created_at)) }], disc.refunds, { empty: 'No refunds.' })}
          <div style="height:12px"></div>${tableHtml([{ label: 'Cancelled order', render: r => `#${r.number}` }, { label: 'Value', render: r => money(r.total), r: 1 }, { label: 'Reason', key: 'cancel_reason' }, { label: 'When', render: r => esc(fmtDate(r.closed_at)) }], disc.cancellations, { empty: 'No cancellations.' })}</div>
      </div>`;
  }
  el.addEventListener('change', e => {
    const id = e.target.id;
    if (id === 'preset') {
      const v = e.target.value;
      if (v === 'month') { f.from = `${today().slice(0, 8)}01`; f.to = today(); }
      else if (v === '1') { f.from = f.to = daysAgo(1); }
      else if (v !== 'custom') { f.from = daysAgo(Number(v) ? Number(v) - 1 : 0); f.to = today(); }
      $('#from').value = f.from; $('#to').value = f.to;
    }
    if (id === 'from') { f.from = e.target.value; $('#preset').value = 'custom'; }
    if (id === 'to') { f.to = e.target.value; $('#preset').value = 'custom'; }
    if (id === 'group') f.group = e.target.value;
    if (id === 'br') f.branch = e.target.value;
    if (id === 'exp') { if (e.target.value) downloadFile(`/reports/export/${e.target.value}.csv?${new URLSearchParams({ from: f.from, to: f.to, ...(f.branch ? { branch: f.branch } : {}) })}`, `pixberry-${e.target.value}-${f.from}_${f.to}.csv`); e.target.value = ''; return; }
    load();
  });
  await load();
}
