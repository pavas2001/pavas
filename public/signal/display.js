// Pixberry Signal — counter display (runs on the Signal Hub or any screen at the counter).
import { esc, $, toast, store } from '/assets/lib.js';
import { session, api, loadMe, renderLogin, connectEvents, can } from '/assets/staff.js';
import { T, TYPES, COLORS, tile, syncClock, ageS, mmss, shortLabel, chimeFor, unlockAudio } from '/signal/common.js';

const S = { tab: store.get('pb.signal.tab', 'live'), board: null, devices: [], known: null, lateKnown: new Set(), localLang: store.get('pb.signal.lang', null), localChime: store.get('pb.signal.chime', null), live: true };
const L = () => T[S.localLang || S.board?.settings.language || 'en'] || T.en;
const chimeOn = () => (S.localChime ?? S.board?.settings.chime ?? true);
const canRespond = () => can('signal.respond') || can('orders.create') || can('tables.manage');

async function start() {
  if (!session.token) return renderLogin($('#login'), 'Signal · counter display', start);
  try { await loadMe(); } catch { return renderLogin($('#login'), 'Signal · counter display', start); }
  if (!canRespond()) { document.body.innerHTML = '<div class="empty" style="margin:40px">You do not have access to table requests. Ask a manager to give your role "Answer table requests".</div>'; return; }
  $('#app').hidden = false;
  $('#hint').hidden = false;
  addEventListener('pointerdown', () => { unlockAudio(); $('#hint').hidden = true; }, { once: true });
  keepAwake();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
  connectEvents(type => { if (['signal.updated', 'table.updated', 'order.created', 'order.updated'].includes(type)) load(); }, ok => { S.live = ok; drawStats(); });
  setInterval(tick, 1000);
  setInterval(load, 30000); // safety refresh
  await load();
}

// Keep the counter screen on (Android app plugin, or the browser's Screen Wake Lock)
let wakeLock = null;
async function keepAwake() {
  try {
    const K = window.Capacitor?.Plugins?.KeepAwake;
    if (K) { await K.keepAwake(); return; }
    if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
  } catch { /* not allowed right now; tried again when the page is shown */ }
}

let loading = false, again = false;
async function load() {
  if (loading) { again = true; return; }
  loading = true;
  try {
    const b = await api('GET', '/signal/board');
    syncClock(b.now);
    const prev = S.known;
    S.known = new Set(b.requests.map(r => r.id));
    S.board = b;
    if (S.tab === 'cubes') S.devices = await api('GET', '/signal/devices');
    if (prev) {
      const fresh = b.requests.filter(r => !prev.has(r.id));
      if (fresh.length && chimeOn()) chimeFor(fresh[0].type);
    }
    b.requests.filter(r => r.late).forEach(r => S.lateKnown.add(r.id));
    render();
  } catch (e) { toast(e.message, 'bad'); }
  finally { loading = false; if (again) { again = false; load(); } }
}

function tick() {
  if (!S.board) return;
  const lim = S.board.settings.escalate_after_s;
  let crossed = false;
  for (const r of S.board.requests) {
    const a = ageS(r.created_at);
    if (!r.claimed_by && a >= lim && !S.lateKnown.has(r.id)) { S.lateKnown.add(r.id); r.late = true; crossed = true; }
  }
  if (crossed) { if (chimeOn()) chimeFor('late'); render(); return; }
  document.querySelectorAll('[data-age]').forEach(el => { el.textContent = mmss(ageS(el.dataset.age)); });
  drawStats();
}

function render() {
  const l = L(), b = S.board;
  document.documentElement.lang = S.localLang || b.settings.language || 'en';
  const tabs = [['live', l.live], ['floor', l.floor], ['cubes', l.cubes], ['today', l.today]];
  $('#nav').innerHTML = tabs.map(([k, n]) => `<button data-tab="${k}" ${S.tab === k ? 'aria-current="page"' : ''}>${esc(n)}${k === 'cubes' && b.device_problems ? ` <span style="color:var(--d-late)">●</span>` : ''}</button>`).join('');
  $('#lang').textContent = (S.localLang || b.settings.language) === 'ml' ? 'English' : 'മലയാളം';
  $('#chime').textContent = chimeOn() ? l.chime_on : l.chime_off;
  $('#chime').setAttribute('aria-pressed', String(chimeOn()));
  const dedicated = store.get('pb.device.mode') === 'display';
  $('#back').textContent = dedicated ? l.staff_app : l.back_office;
  $('#back').href = dedicated ? '#' : '/admin';
  $('#back').hidden = !dedicated && !can('reports.view') && !can('tables.manage');
  $('#evening').hidden = !b.settings.evening_mode;
  $('#evening').textContent = l.evening;
  $('#hint').textContent = l.sound_hint;
  // Light bar: colour of the longest-waiting request nobody has claimed
  const waiting = b.requests.filter(r => !r.claimed_by);
  const top = waiting[0];
  const beam = $('#beam');
  beam.style.setProperty('--beam', top ? COLORS[top.type] : b.settings.evening_mode ? '#5a4220' : '#2a343c');
  beam.style.setProperty('--beam-glow', top ? COLORS[top.type] : 'transparent');
  beam.classList.toggle('pulse', waiting.some(r => r.late));
  drawStats();
  const main = $('#main');
  if (S.tab === 'live') main.innerHTML = liveHtml();
  else if (S.tab === 'floor') main.innerHTML = floorHtml(true);
  else if (S.tab === 'cubes') main.innerHTML = cubesHtml();
  else main.innerHTML = todayHtml();
}

function drawStats() {
  const b = S.board; if (!b) return;
  const l = L(), list = b.requests;
  const longest = list.length ? mmss(ageS(list[0].created_at)) : '—';
  const avg = b.stats.avg_response_s != null ? mmss(b.stats.avg_response_s) : '—';
  $('#stats').innerHTML = `<span>${esc(l.open)} <b>${list.length}</b></span><span>${esc(l.longest)} <b>${longest}</b></span><span>${esc(l.avg)} <b>${avg}</b></span><span><b>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></span><span class="dot ${S.live ? '' : 'off'}" title="${S.live ? 'Live' : 'Reconnecting'}"></span>`;
}

function reqHtml(r) {
  const l = L();
  const zone = r.section_name ? `${esc(r.section_name)}` : '';
  const sub = r.claimed_by ? `${esc(r.claimed_by_name)} ${esc(l.on_the_way)}` : r.late ? `<span class="lt">${esc(l.late)}</span>` : [zone, esc(l[`via_${r.source}`] || '')].filter(Boolean).join(' · ');
  return `<div class="rq ${r.late && !r.claimed_by ? 'late' : ''} ${r.claimed_by ? 'claimed' : ''}">
    ${tile(r.type, `<span class="tn">${shortLabel(r.table_label)}</span>`)}
    <span class="what"><b>${esc(l[r.type] || r.label)}</b><small>${sub}${r.note ? ` · “${esc(r.note)}”` : ''}</small></span>
    <span class="r"><span class="age" data-age="${esc(r.created_at)}">${mmss(ageS(r.created_at))}</span>
      <button class="act ${r.claimed_by ? 'done' : ''}" data-id="${r.id}" data-do="${r.claimed_by ? 'done' : 'claim'}">${esc(r.claimed_by ? l.done : l.onway)}</button></span></div>`;
}
function liveHtml() {
  const l = L(), b = S.board;
  const people = b.staff.length ? b.staff.map(s => `<div><b>${esc(s.name)}</b><span>${esc(s.section_name || l.no_zone)} · ${s.open_claims} ${esc(l.on_the_way)}</span></div>`).join('') : `<div>${esc(l.nobody)}</div>`;
  return `<div class="live"><section class="col"><div class="sec"><span>${esc(l.requests)}</span><span>${esc(l.waiting)}</span></div>
      ${b.requests.length ? b.requests.map(reqHtml).join('') : `<div class="empty">${esc(l.clear)}</div>`}</section>
    <section class="col"><div class="sec"><span>${esc(l.floor)}</span><span></span></div>${floorHtml(false)}
      <div class="sec" style="padding-top:10px"><span>${esc(l.on_floor)}</span><span></span></div><div class="people">${people}</div></section></div>`;
}
function floorHtml(big) {
  const l = L(), b = S.board;
  const groups = new Map();
  for (const t of b.tables) { const k = t.section_name || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const cell = t => {
    const on = t.request_type;
    const info = on ? (big ? esc(l[on]) : '') : t.order_id ? (big ? `${t.seated_min ?? 0} ${esc(l.min)}` : `${t.seated_min ?? 0}′`) : esc(l.free);
    return `<span class="tb ${on ? 'on' : ''} ${t.request_claimed ? 'claimed' : ''}" style="${on ? `background:${COLORS[on]}` : ''}"><b>${shortLabel(t.label)}</b><span>${info}</span></span>`;
  };
  return [...groups.entries()].map(([name, list]) => `${groups.size > 1 || big ? `<div class="zone-h">${esc(name || l.no_zone)}</div>` : ''}<div class="map ${big ? 'big' : ''}">${list.map(cell).join('')}</div>`).join('');
}
function cubesHtml() {
  const l = L();
  if (!S.devices.length) return `<div class="empty">${esc(l.no_cubes)}</div>`;
  return `<div class="cubes">${S.devices.map(d => {
    const warn = d.problems.map(p => l[p] || p).join(' · ');
    const batt = d.battery ?? 0;
    return `<div class="cube ${d.problems.length ? 'bad' : ''}"><span class="h"><b>${d.kind === 'hub' ? 'Hub' : shortLabel(d.table_label) || esc(l.not_assigned)}</b><small>${d.battery != null ? `${batt}%` : '—'}</small></span>
      <div class="batt"><i class="${batt < 25 ? 'low' : ''}" style="width:${batt}%"></i></div>
      <small class="${warn ? 'warn' : ''}">${esc(warn || l.ok)}${d.name ? ` · ${esc(d.name)}` : ''}</small></div>`;
  }).join('')}</div>`;
}
function todayHtml() {
  const l = L(), s = S.board.stats;
  const max = Math.max(1, ...TYPES.map(t => s.by_type[t] || 0));
  const smax = Math.max(1, ...s.by_staff.map(x => x.n));
  return `<div class="today">
    <div class="stat"><small>${esc(l.total)}</small><b>${s.total}</b></div>
    <div class="stat"><small>${esc(l.avg)}</small><b>${s.avg_response_s != null ? mmss(s.avg_response_s) : '—'}</b></div>
    <div class="stat"><small>${esc(l.late_n)}</small><b>${s.late}</b></div>
    <div class="stat"><small>${esc(l.fastest)}</small><b>${s.fastest_s != null ? mmss(s.fastest_s) : '—'}</b></div>
    <div class="bars"><h3>${esc(l.by_type)}</h3>${TYPES.map(t => `<div class="bar"><span>${esc(l[t])}</span><span class="track"><i style="width:${(s.by_type[t] || 0) / max * 100}%;background:${COLORS[t]}"></i></span><span>${s.by_type[t] || 0}</span></div>`).join('')}</div>
    <div class="bars"><h3>${esc(l.by_staff)}</h3>${s.by_staff.length ? s.by_staff.map(x => `<div class="bar"><span>${esc(x.name)}</span><span class="track"><i style="width:${x.n / smax * 100}%;background:#4fc7c9"></i></span><span>${x.n}</span></div>`).join('') : '<span style="color:var(--d-mut)">—</span>'}</div>
  </div>`;
}

document.addEventListener('click', async e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { S.tab = tab.dataset.tab; store.set('pb.signal.tab', S.tab); if (S.tab === 'cubes') S.devices = await api('GET', '/signal/devices').catch(() => []); render(); return; }
  const act = e.target.closest('[data-do]');
  if (act) {
    act.disabled = true;
    try { await api('POST', `/signal/requests/${act.dataset.id}/${act.dataset.do}`); await load(); }
    catch (err) { toast(err.message, 'bad'); act.disabled = false; load(); }
    return;
  }
  if (e.target.closest('#back') && store.get('pb.device.mode') === 'display') { e.preventDefault(); store.del('pb.device.mode'); location.href = '/signal/app'; return; }
  if (e.target.closest('#lang')) {
    const next = (S.localLang || S.board.settings.language) === 'ml' ? 'en' : 'ml';
    if (S.board.me.can_manage) { S.localLang = null; store.del('pb.signal.lang'); await api('PUT', '/signal/settings', { language: next }).catch(err => toast(err.message, 'bad')); load(); }
    else { S.localLang = next; store.set('pb.signal.lang', next); render(); }
    return;
  }
  if (e.target.closest('#chime')) {
    const next = !chimeOn();
    if (S.board.me.can_manage) { S.localChime = null; store.del('pb.signal.chime'); await api('PUT', '/signal/settings', { chime: next }).catch(err => toast(err.message, 'bad')); load(); }
    else { S.localChime = next; store.set('pb.signal.chime', next); render(); }
    if (next) chimeFor('water');
  }
});

start();
