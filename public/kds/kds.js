// Pixberry — Kitchen display system
import { esc, $, toast, store, fmtTime } from '/assets/lib.js';
import { session, api, loadMe, setBranch, renderLogin, connectEvents, chime, can } from '/assets/staff.js';

const S = { station: store.get('pb.kds.station', ''), history: false, tickets: [], labels: {}, known: new Set(), first: true };

async function start() {
  if (!session.token) return renderLogin($('#login'), 'Kitchen display', start);
  try { await loadMe(); } catch { return renderLogin($('#login'), 'Kitchen display', start); }
  if (!can('kds.view')) { document.body.innerHTML = '<div class="empty">You do not have access to the kitchen display.</div>'; return; }
  $('#app').hidden = false;
  const stations = await api('GET', '/stations');
  $('#station').innerHTML = `<option value="">All stations</option>${stations.map(s => `<option value="${s.id}" ${String(s.id) === String(S.station) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
  $('#branch').innerHTML = session.me.branches.map(b => `<option value="${b.id}" ${b.id === session.branch ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  $('#branch').hidden = session.me.branches.length < 2;
  $('#station').onchange = e => { S.station = e.target.value; store.set('pb.kds.station', S.station); load(); };
  $('#branch').onchange = e => { setBranch(e.target.value); location.reload(); };
  $('#hist').onchange = e => { S.history = e.target.checked; load(); };
  $('#sound').checked = store.get('pb.kds.sound', true);
  $('#sound').onchange = e => store.set('pb.kds.sound', e.target.checked);
  connectEvents((type) => { if (type.startsWith('order.')) load(); }, ok => $('#live').classList.toggle('off', !ok));
  setInterval(() => { $('#clock').textContent = fmtTime(new Date().toISOString()); }, 1000);
  setInterval(load, 30000); // safety refresh + age timers
  load();
}

let loading = false, again = false;
async function load() {
  if (loading) { again = true; return; }
  loading = true;
  try {
    const r = await api('GET', `/kds?${new URLSearchParams({ station_id: S.station, history: S.history ? '1' : '' })}`);
    S.tickets = r.tickets; S.labels = r.labels;
    const fresh = r.tickets.filter(t => t.status === 'new' && !S.known.has(t.key));
    r.tickets.forEach(t => S.known.add(t.key));
    if (!S.first && fresh.length) { if ($('#sound').checked) chime(); toast(`New order: #${fresh[0].number}${fresh[0].table ? ` · ${fresh[0].table}` : ''}`); }
    S.first = false;
    render();
  } catch (e) { toast(e.message, 'bad'); }
  finally { loading = false; if (again) { again = false; load(); } }
}

function ticketHtml(t) {
  const where = t.table ? esc(t.table) : t.pickup_code ? `Pickup ${esc(t.pickup_code)}` : esc(t.type.replace('_', ' '));
  const next = { new: ['preparing', 'Start'], preparing: ['ready', 'Ready'], ready: ['served', 'Served'] }[t.status];
  const live = t.items.filter(i => i.status === t.status);
  return `<article class="tk ${t.status} ${t.delayed ? 'delayed' : ''}">
    <div class="hd"><span class="where">${where}</span><span class="age" title="Waiting time">${t.age_min}′</span></div>
    <div class="meta">#${t.number}${t.kot > 1 ? ` · round ${t.kot}` : ''} · ${t.source === 'qr' ? 'QR' : 'POS'} · ${esc(t.type.replace('_', '-'))}${t.customer_name ? ` · ${esc(t.customer_name)}` : ''} · ${fmtTime(t.created_at)}${t.delayed ? ' · <b style="color:var(--bad)">DELAYED</b>' : ''}</div>
    ${t.order_notes ? `<div class="note" style="margin-top:6px">📝 ${esc(t.order_notes)}</div>` : ''}
    <ul>${t.items.map(i => `<li class="${i.status !== t.status && !S.history ? 'done' : ''}"><span class="q">${i.qty}×</span><span class="n">${esc(i.name)}${i.variant ? ` (${esc(i.variant)})` : ''}
      ${i.modifiers.length ? `<span class="mod">+ ${esc(i.modifiers.join(', '))}</span>` : ''}${i.notes ? `<span class="note">“${esc(i.notes)}”</span>` : ''}${!S.station && i.station ? `<span class="mod">${esc(i.station)}</span>` : ''}</span>
      ${!S.history && i.status === t.status && next && t.items.length > 1 ? `<button class="btn sm ghost" data-ids="${i.id}" data-st="${next[0]}" title="Only this item">${next[1]}</button>` : ''}</li>`).join('')}</ul>
    ${S.history ? `<div class="acts"><button class="btn sm" data-ids="${t.items.map(i => i.id).join(',')}" data-st="ready">Recall to Ready</button></div>`
      : next ? `<div class="acts">${t.status !== 'new' ? `<button class="btn sm ghost" data-ids="${live.map(i => i.id).join(',')}" data-st="${t.status === 'ready' ? 'preparing' : 'new'}">↩</button>` : ''}<button class="btn primary" data-ids="${live.map(i => i.id).join(',')}" data-st="${next[0]}">${next[1]} ${live.length > 1 ? 'all' : ''}</button></div>` : ''}
  </article>`;
}
function render() {
  const board = $('#board');
  if (S.history) { board.style.gridTemplateColumns = '1fr'; board.innerHTML = `<div class="col"><h2>Served (last 12 h)</h2>${S.tickets.map(ticketHtml).join('') || '<div class="empty">Nothing yet.</div>'}</div>`; return; }
  board.style.gridTemplateColumns = '';
  const cols = [['new', S.labels.new || 'New'], ['preparing', S.labels.preparing || 'Preparing'], ['ready', S.labels.ready || 'Ready']];
  board.innerHTML = cols.map(([k, label]) => {
    const list = S.tickets.filter(t => t.status === k).sort((a, b) => (b.delayed - a.delayed) || a.created_at.localeCompare(b.created_at));
    return `<section class="col"><h2><span>${esc(label)}</span><span>${list.length}</span></h2>${list.map(ticketHtml).join('') || `<div class="empty">${k === 'new' ? 'Waiting for orders…' : '—'}</div>`}</section>`;
  }).join('');
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-st]');
  if (!b) return;
  b.classList.add('loading');
  try { await api('POST', '/kds/items/status', { item_ids: b.dataset.ids.split(',').map(Number), status: b.dataset.st }); await load(); }
  catch (err) { toast(err.message, 'bad'); b.classList.remove('loading'); }
});
start();
