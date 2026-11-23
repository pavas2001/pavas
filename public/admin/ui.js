// Small UI toolkit for the back office: modals, forms, tables, tabs.
import { esc, $, $$, money, rupees, paise, toast } from '/assets/lib.js';

export function modal({ title, body = '', wide = false, actions = [], onOpen } = {}) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h2>${esc(title)}</h2><button class="btn ghost sm" data-close aria-label="Close">✕</button></header>
    <div class="body">${body}</div>
    ${actions.length ? `<footer>${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-a="${i}">${esc(a.label)}</button>`).join('')}</footer>` : ''}</div>`;
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('click', async e => {
    if (e.target === ov || e.target.closest('[data-close]')) return close();
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = actions[Number(b.dataset.a)];
    if (!a.onClick) return close();
    b.classList.add('loading');
    try { const r = await a.onClick({ el: ov, close }); if (r !== false) close(); }
    catch (err) { toast(err.message, 'bad'); }
    finally { b.classList.remove('loading'); }
  });
  document.body.append(ov);
  const m = { el: ov.querySelector('.modal'), body: ov.querySelector('.body'), close };
  onOpen?.(m);
  ov.querySelector('input:not([type=hidden]),select,textarea')?.focus();
  return m;
}
export function confirmBox(title, text, { danger = true, label = 'Confirm', input = null } = {}) {
  return new Promise(resolve => {
    const m = modal({
      title, body: `<p>${esc(text)}</p>${input ? `<div class="field"><label>${esc(input)}</label><input id="cbi"></div>` : ''}`,
      actions: [{ label: 'Cancel', onClick: () => resolve(null) }, { label, kind: danger ? 'danger' : 'primary', onClick: ({ el }) => { const v = input ? el.querySelector('#cbi').value.trim() : true; if (input && !v) { toast(`${input} is required`, 'bad'); return false; } resolve(v); } }],
    });
    m.el.closest('.overlay').addEventListener('click', e => { if (e.target.classList.contains('overlay') || e.target.closest('[data-close]')) resolve(null); });
  });
}

/* Field definitions: { name, label, type: text|number|money|select|checkbox|textarea|date|time|password|email|tel, options: [[v,l]], hint, required, span, step, placeholder } */
export function fieldsHtml(defs, v = {}) {
  return `<div class="grid g2">${defs.map(d => {
    const val = v[d.name];
    const id = `f_${d.name}`;
    const req = d.required ? 'required' : '';
    const span = d.span ? 'style="grid-column:1/-1"' : '';
    let input;
    switch (d.type) {
      case 'select': input = `<select id="${id}" name="${d.name}" ${req}>${(d.options || []).map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(val ?? d.default ?? '') ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select>`; break;
      case 'checkbox': return `<div class="field" ${span}><label class="check" style="margin-top:22px"><input type="checkbox" id="${id}" name="${d.name}" ${(val ?? d.default) ? 'checked' : ''}> ${esc(d.label)}</label>${d.hint ? `<div class="hint">${esc(d.hint)}</div>` : ''}</div>`;
      case 'textarea': input = `<textarea id="${id}" name="${d.name}" ${req} placeholder="${esc(d.placeholder || '')}">${esc(val ?? '')}</textarea>`; break;
      case 'money': input = `<input id="${id}" name="${d.name}" type="number" step="0.01" min="0" inputmode="decimal" value="${esc(rupees(val))}" ${req} placeholder="${esc(d.placeholder || '')}">`; break;
      default: input = `<input id="${id}" name="${d.name}" type="${d.type || 'text'}" ${d.step ? `step="${d.step}"` : ''} value="${esc(val ?? d.default ?? '')}" ${req} placeholder="${esc(d.placeholder || '')}" ${d.type === 'password' ? 'autocomplete="new-password"' : ''}>`;
    }
    return `<div class="field" ${span}><label for="${id}">${esc(d.label)}${d.required ? ' *' : ''}</label>${input}${d.hint ? `<div class="hint">${esc(d.hint)}</div>` : ''}</div>`;
  }).join('')}</div>`;
}
export function readFields(root, defs) {
  const out = {};
  for (const d of defs) {
    const el = root.querySelector(`[name="${d.name}"]`);
    if (!el) continue;
    if (d.type === 'checkbox') out[d.name] = el.checked;
    else if (d.type === 'money') out[d.name] = paise(el.value);
    else if (d.type === 'number') out[d.name] = el.value === '' ? null : Number(el.value);
    else if (['date', 'time', 'select'].includes(d.type) && el.value === '') out[d.name] = null;
    else out[d.name] = el.value;
    if (d.required && (out[d.name] === '' || out[d.name] == null)) throw new Error(`${d.label} is required`);
  }
  return out;
}
export function formModal({ title, defs, values = {}, submit, wide, extra = '', onOpen, label = 'Save' }) {
  return modal({
    title, wide, body: `<form onsubmit="return false">${fieldsHtml(defs, values)}${extra}</form>`, onOpen,
    actions: [{ label: 'Cancel' }, { label, kind: 'primary', onClick: async ({ el }) => { await submit(readFields(el, defs), el); } }],
  });
}

/* Tables: cols = [{ label, key | render(row), cls, r: rightAlign }] */
export function tableHtml(cols, rows, { empty = 'Nothing here yet.', rowAttr } = {}) {
  if (!rows.length) return `<div class="card empty">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table class="data"><thead><tr>${cols.map(c => `<th class="${c.r ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr ${rowAttr ? rowAttr(r, i) : ''}>${cols.map(c => `<td class="${c.r ? 'r num' : ''} ${c.cls || ''}">${c.render ? c.render(r, i) : esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
export function tabs(el, items, current, onChange) {
  el.innerHTML = items.map(([k, l]) => `<button data-tab="${k}" class="${k === current ? 'on' : ''}">${esc(l)}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('[data-tab]'); if (!b) return; $$('button', el).forEach(x => x.classList.toggle('on', x === b)); onChange(b.dataset.tab); };
}
export const chip = (text, kind = '') => `<span class="chip ${kind}">${esc(text)}</span>`;
export const statusChip = s => chip(String(s).replace(/_/g, ' '), { paid: 'ok', open: 'info', billed: 'warn', cancelled: 'bad', merged: '', received: 'ok', ordered: 'info', draft: '', booked: 'info', arrived: 'warn', seated: 'ok', no_show: 'bad', waiting: 'warn', left: '', available: 'ok', occupied: 'warn', ordering: 'info', bill_requested: 'bad', cleaning: '', unpaid: 'bad', partial: 'warn', sent: 'ok', queued: 'info', failed: 'bad', skipped: '' }[s] || '');
export { money, esc, $, $$, toast, rupees, paise };
export const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const daysAgo = n => new Date(Date.now() - n * 86400e3 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export function bars(rows, { label, value, fmt = v => v }) {
  const max = Math.max(1, ...rows.map(value));
  return `<div class="bars">${rows.map(r => `<div class="b" style="height:${(value(r) / max) * 100}%" title="${esc(label(r))}: ${esc(fmt(value(r)))}"></div>`).join('')}</div>
    <div class="bars-x">${rows.map((r, i) => `<span>${rows.length > 14 && i % Math.ceil(rows.length / 12) ? '' : esc(label(r))}</span>`).join('')}</div>`;
}
export function hbars(rows, { label, value, fmt = v => v }) {
  const max = Math.max(1, ...rows.map(value));
  return rows.map(r => `<div class="hbar"><span>${esc(label(r))}</span><div class="t"><div style="width:${(value(r) / max) * 100}%"></div></div><span class="num">${esc(fmt(value(r)))}</span></div>`).join('') || '<div class="empty">No data.</div>';
}
