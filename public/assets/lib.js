// Shared helpers for Pixberry frontends
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let currency = { symbol: '₹', code: 'INR' };
export function setCurrency(c) { if (c) currency = c; }
export function money(paise, { plain = false } = {}) {
  const v = (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: Number(paise) % 100 ? 2 : 0, maximumFractionDigits: 2 });
  return plain ? v : `${currency.symbol}${v}`;
}
export const rupees = p => (p == null || p === '' ? '' : (Number(p) / 100).toFixed(2).replace(/\.00$/, ''));
export const paise = v => (v === '' || v == null ? null : Math.round(Number(v) * 100));

export function toast(msg, kind = '') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6000 : 3500);
}

export class ApiError extends Error { constructor(status, body) { super(body?.error || `HTTP ${status}`); this.status = status; this.body = body; } }
export async function request(method, url, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (typeof body === 'string') { opts.body = body; opts.headers['content-type'] = 'text/plain'; }
    else { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, typeof data === 'object' ? data : { error: data });
  return data;
}

export function fmtTime(iso, opts = { hour: '2-digit', minute: '2-digit' }) { return iso ? new Date(iso).toLocaleTimeString([], opts) : ''; }
export function fmtDate(iso) { return iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; }
export function ago(iso) {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min`; const h = Math.floor(m / 60); return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d`;
}
export const dietMark = d => `<span class="diet ${d === 'nonveg' ? 'nonveg' : d === 'egg' ? 'egg' : ''}" title="${esc(d || 'veg')}"></span>`;
export function uid() { return (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`); }
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
