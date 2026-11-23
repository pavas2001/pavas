import { api, can } from '/assets/staff.js';
import { onLive } from '/admin/app.js';
import { esc, money, bars, hbars, tableHtml, chip } from '/admin/ui.js';

export async function render(el) {
  const load = async () => {
    const d = await api('GET', '/dashboard');
    const t = d.today, y = d.yesterday;
    const delta = (a, b) => b ? `${a >= b ? '▲' : '▼'} ${Math.abs(Math.round((a - b) / b * 100))}% vs yesterday` : 'no sales yesterday';
    const tbl = Object.fromEntries(d.tables.map(x => [x.status, x.n]));
    const hours = Array.from({ length: 24 }, (_, h) => d.hours.find(x => x.hour === h) || { hour: h, orders: 0, sales: 0 }).slice(6, 24);
    el.innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="l">Sales today</div><div class="v">${money(t.gross)}</div><div class="d">${delta(t.gross, y.gross)}</div></div>
        <div class="kpi"><div class="l">Paid orders</div><div class="v">${t.orders}</div><div class="d">${delta(t.orders, y.orders)}</div></div>
        <div class="kpi"><div class="l">Average order</div><div class="v">${money(t.avg_order)}</div><div class="d">yesterday ${money(y.avg_order)}</div></div>
        <div class="kpi"><div class="l">Open orders</div><div class="v">${d.active.n}</div><div class="d">${money(d.active.value)} unbilled</div></div>
        <div class="kpi"><div class="l">Kitchen</div><div class="v">${d.kitchen.new || 0} · ${d.kitchen.preparing || 0} · ${d.kitchen.ready || 0}</div><div class="d">new · preparing · ready</div></div>
        <div class="kpi"><div class="l">Tables</div><div class="v">${(tbl.occupied || 0) + (tbl.bill_requested || 0) + (tbl.ordering || 0)} busy</div><div class="d">${tbl.available || 0} free · ${tbl.cleaning || 0} cleaning · ${d.requests} request(s)</div></div>
        <div class="kpi"><div class="l">Discounts / refunds</div><div class="v">${money(t.discounts)}</div><div class="d">refunds ${money(t.refunds)} · cancelled ${t.cancelled.n}</div></div>
        <div class="kpi"><div class="l">Rating (30 days)</div><div class="v">${d.rating.avg ? `${d.rating.avg} ★` : '—'}</div><div class="d">${d.rating.n} review(s)</div></div>
      </div>
      <div class="cols">
        <div class="card"><h3>Orders by hour (today)</h3>${bars(hours, { label: r => r.hour, value: r => r.orders })}</div>
        <div class="card"><h3>Payments today</h3>${hbars(t.payments.filter(p => p.kind === 'payment'), { label: p => p.method.toUpperCase(), value: p => p.amount, fmt: money })}</div>
        <div class="card"><h3>Top items today</h3>${hbars(d.top_items, { label: r => r.name, value: r => r.qty })}</div>
        <div class="card"><h3>Sales by order type</h3>${hbars(t.by_type, { label: r => r.type.replace('_', '-'), value: r => r.sales, fmt: money })}</div>
        <div class="card"><h3>Today's reservations ${d.waitlist ? chip(`${d.waitlist} waiting`, 'warn') : ''}</h3>${tableHtml([{ label: 'Time', key: 'time' }, { label: 'Name', key: 'name' }, { label: 'Guests', key: 'guests', r: 1 }, { label: 'Status', render: r => chip(r.status) }], d.reservations, { empty: 'No reservations today.' })}</div>
        <div class="card"><h3>Low stock</h3>${tableHtml([{ label: 'Item', key: 'name' }, { label: 'Left', render: r => `${+(+r.level).toFixed(2)} ${esc(r.unit)}`, r: 1 }, { label: 'Alert at', render: r => `${r.low_stock_level} ${esc(r.unit)}`, r: 1 }], d.low_stock, { empty: 'All stocked up.' })}${can('purchasing.manage') && d.low_stock.length ? '<p style="margin-top:10px"><a class="btn sm" href="#/purchasing">Create purchase order</a></p>' : ''}</div>
      </div>`;
  };
  await load();
  let t; onLive(type => { if (type.startsWith('order.') || type === 'table.updated') { clearTimeout(t); t = setTimeout(load, 800); } });
  const iv = setInterval(load, 60000);
  return () => clearInterval(iv);
}
