// Staff session helpers shared by the back office and the kitchen display.
import { request, ApiError, store, esc, toast, setCurrency } from '/assets/lib.js';

export const session = {
  token: store.get('pb.token'), branch: store.get('pb.branch'), me: null,
};
export async function api(method, url, body) {
  const headers = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (session.branch) headers['x-branch'] = String(session.branch);
  try { return await request(method, `/api${url}`, body, headers); }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) { logout(false); }
    throw e;
  }
}
export function can(p) { const u = session.me?.user; return !!u && (u.role === 'admin' || u.permissions.includes(p)); }
export async function loadMe() {
  session.me = await api('GET', '/auth/me');
  setCurrency(session.me.currency);
  if (!session.branch || !session.me.branches.some(b => b.id === session.branch)) setBranch(session.me.user.branch_id || session.me.branches[0]?.id);
  return session.me;
}
export function setBranch(id) { session.branch = Number(id) || null; store.set('pb.branch', session.branch); }
export function logout(callServer = true) {
  if (callServer && session.token) api('POST', '/auth/logout').catch(() => {});
  session.token = null; session.me = null; store.del('pb.token');
  location.reload();
}
export async function downloadFile(url, filename) {
  const res = await fetch(`/api${url}`, { headers: { authorization: `Bearer ${session.token}`, 'x-branch': String(session.branch || '') } });
  if (!res.ok) { toast((await res.json().catch(() => ({}))).error || 'Download failed', 'bad'); return; }
  const blob = await res.blob();
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
// Opens an authenticated HTML page (e.g. the QR print sheet) in a new tab
export async function openAuthed(url) {
  const w = window.open('', '_blank');
  const res = await fetch(`/api${url}`, { headers: { authorization: `Bearer ${session.token}`, 'x-branch': String(session.branch || '') } });
  const html = await res.text();
  if (w) { w.document.open(); w.document.write(html); w.document.close(); }
}

export function renderLogin(el, title, onDone) {
  el.hidden = false;
  el.innerHTML = `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px">
    <form class="card" style="width:min(380px,100%)" id="lf">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:16px"><img src="/assets/icon.svg" width="40" height="40" alt=""><div><h1 style="margin:0">Pixberry ERP</h1><small>${esc(title)}</small></div></div>
      <div class="field"><label for="lu">Username</label><input id="lu" autocomplete="username" required autofocus></div>
      <div class="field"><label for="lp">Password</label><input id="lp" type="password" autocomplete="current-password" required></div>
      <p class="hint" id="le" role="alert" style="color:var(--bad)"></p>
      <button class="btn primary block lg">Sign in</button>
    </form></div>`;
  el.querySelector('#lf').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.classList.add('loading');
    try {
      const r = await request('POST', '/api/auth/login', { username: el.querySelector('#lu').value.trim(), password: el.querySelector('#lp').value });
      session.token = r.token; store.set('pb.token', r.token);
      el.hidden = true; el.innerHTML = '';
      onDone();
    } catch (err) { el.querySelector('#le').textContent = err.message; }
    finally { btn.classList.remove('loading'); }
  });
}

// Live events (SSE). Calls handler(type, data). Reconnects automatically.
export function connectEvents(handler, onStatus = () => {}) {
  let es;
  const open = () => {
    es = new EventSource(`/api/events?access_token=${encodeURIComponent(session.token)}&branch_id=${session.branch || ''}`);
    es.onopen = () => onStatus(true);
    es.onerror = () => onStatus(false);
    for (const t of ['order.created', 'order.items_added', 'order.updated', 'table.updated', 'notification', 'menu.changed', 'reservations.changed', 'waitlist.changed'])
      es.addEventListener(t, ev => handler(t, JSON.parse(ev.data || '{}')));
  };
  open();
  return () => es?.close();
}

let audioCtx;
export function chime() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t + i * 0.18); g.gain.exponentialRampToValueAtTime(0.3, t + i * 0.18 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.3);
      o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.32);
    });
  } catch { /* audio not available */ }
}
