// Settings: café profile, branches & CAFÉ LOCATION (QR ordering radius), hours, tax & charges, receipt, kitchen & loyalty, messaging, permissions, backup.
import { api, downloadFile, loadMe } from '/assets/staff.js';
import { getSettings } from '/admin/app.js';
import { esc, $, $$, money, modal, formModal, fieldsHtml, readFields, tableHtml, tabs, toast, chip } from '/admin/ui.js';
import { fmtDate } from '/assets/lib.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function render(el, [initialTab]) {
  let tab = initialTab || 'location';
  let S = await getSettings(true);
  el.innerHTML = `<div class="tabs" id="sett"></div><div id="setc"></div>`;
  tabs($('#sett'), [['location', '📍 Location & QR ordering'], ['cafe', 'Café profile'], ['hours', 'Hours & holidays'], ['tax', 'Tax, charges & payments'], ['receipt', 'Bill & receipt'], ['kitchen', 'Orders, kitchen & loyalty'], ['messaging', 'Messaging'], ['perms', 'Roles & permissions'], ['backup', 'Backup & data']], tab, t => { tab = t; draw(); });
  const save = async (key, value) => { await api('PUT', `/settings/${key}`, { value }); S = await getSettings(true); toast('Saved', 'ok'); };
  const section = (title, body, key, hint = '') => `<div class="card"><h2>${esc(title)}</h2>${hint ? `<p class="muted">${hint}</p>` : ''}<form data-key="${key}" onsubmit="return false">${body}<div class="row" style="margin-top:8px"><button class="btn primary" data-save="${key}">Save</button></div></form></div>`;

  async function draw() {
    const c = $('#setc');
    if (tab === 'location') return drawLocation(c);
    if (tab === 'cafe') {
      c.innerHTML = section('Café profile', fieldsHtml(cafeDefs, S.cafe), 'cafe', 'Shown on the customer menu, bills and QR cards.') +
        section('Web address & region', fieldsHtml(regionDefs, { public_url: S.public_url, timezone: S.timezone, currency_symbol: S.currency.symbol, currency_code: S.currency.code }), 'region',
          'The public URL is printed inside QR codes, so set it to the https address customers will use (location access needs https).');
    } else if (tab === 'hours') {
      c.innerHTML = `<div class="card"><h2>Opening hours</h2><form onsubmit="return false"><div class="table-wrap"><table class="data"><thead><tr><th>Day</th><th>Opens</th><th>Closes</th><th>Closed</th></tr></thead><tbody>
        ${DAYS.map((d, i) => { const h = S.hours[i] || {}; return `<tr><td>${d}</td><td><input type="time" data-o="${i}" value="${esc(h.open || '')}"></td><td><input type="time" data-c="${i}" value="${esc(h.close || '')}"></td><td><input type="checkbox" data-x="${i}" ${h.closed ? 'checked' : ''}></td></tr>`; }).join('')}
        </tbody></table></div>
        <label class="check" style="margin-top:12px"><input type="checkbox" id="enf" ${S.enforce_hours_for_qr ? 'checked' : ''}> Block QR orders outside opening hours and on holidays</label>
        <div class="field" style="margin-top:12px"><label>Holidays (one date per line, YYYY-MM-DD)</label><textarea id="hol">${esc((S.holidays || []).join('\n'))}</textarea></div>
        <button class="btn primary" data-savehours>Save</button></form></div>`;
    } else if (tab === 'tax') {
      c.innerHTML = section('Tax', fieldsHtml(taxDefs, S.tax), 'tax', 'Inclusive: menu prices already include tax. Exclusive: tax is added on the bill. “Split” shows CGST + SGST halves.') +
        section('Service charge', fieldsHtml(scDefs, S.service_charge), 'service_charge') +
        section('Rounding & payment types', fieldsHtml([{ name: 'rounding', label: 'Round bills to the nearest whole rupee', type: 'checkbox', span: 1 }, { name: 'payment_methods', label: 'Payment types (comma separated)', span: 1, hint: 'e.g. cash, upi, card, wallet, zomato' }], { rounding: S.rounding, payment_methods: S.payment_methods.join(', ') }), 'payments');
    } else if (tab === 'receipt') {
      c.innerHTML = section('Bill & receipt', fieldsHtml(receiptDefs, S.receipt), 'receipt', 'Open any paid order and use “Print bill” to preview.');
    } else if (tab === 'kitchen') {
      c.innerHTML = section('Order status names', fieldsHtml(['new', 'preparing', 'ready', 'served'].map(k => ({ name: k, label: `“${k}” shows as` })), S.order_status_labels), 'order_status_labels', 'What staff and guests see for each kitchen status.') +
        section('Kitchen display', fieldsHtml([{ name: 'delay_minutes', label: 'Highlight orders waiting longer than (minutes)', type: 'number' }, { name: 'sound', label: 'Play sound for new orders', type: 'checkbox' }], S.kds), 'kds') +
        section('Notifications', fieldsHtml([{ name: 'customer_ready', label: 'Tell customers when their order is ready', type: 'checkbox', span: 1 }, { name: 'digital_receipts', label: 'Send digital receipts after payment', type: 'checkbox', span: 1 }, { name: 'low_stock', label: 'Alert managers about low stock', type: 'checkbox', span: 1 }, { name: 'delayed_orders', label: 'Alert managers about delayed orders', type: 'checkbox', span: 1 }], S.notifications), 'notifications', 'Customer messages are only sent to guests who gave consent and only on connected channels.') +
        section('Loyalty points', fieldsHtml([{ name: 'enabled', label: 'Enable loyalty points', type: 'checkbox', span: 1 }, { name: 'points_per_100', label: 'Points earned per ₹100 spent', type: 'number' }, { name: 'point_value', label: 'Value of 1 point (₹)', type: 'money' }], S.loyalty), 'loyalty');
    } else if (tab === 'messaging') {
      const ch = (k, label) => `<h3 style="margin-top:12px">${label}</h3>${fieldsHtml([{ name: `${k}_enabled`, label: `Enable ${label}`, type: 'checkbox', span: 1 }, { name: `${k}_webhook_url`, label: 'Gateway webhook URL', span: 1, placeholder: 'https://your-provider.example/send' }, { name: `${k}_token`, label: 'API token', type: 'password' }, ...(k === 'email' ? [{ name: 'email_from', label: 'From address' }] : [])], { [`${k}_enabled`]: S.messaging[k]?.enabled, [`${k}_webhook_url`]: S.messaging[k]?.webhook_url, [`${k}_token`]: S.messaging[k]?.token, email_from: S.messaging.email?.from })}`;
      c.innerHTML = section('Messaging channels', ch('whatsapp', 'WhatsApp') + ch('sms', 'SMS') + ch('email', 'Email'), 'messaging',
        'Pixberry POSTs <code>{channel, to, subject, body}</code> as JSON (with <code>Authorization: Bearer &lt;token&gt;</code>) to your provider\'s webhook — e.g. your WhatsApp Business API partner, SMS gateway, or an email relay. Until a channel is connected, messages are logged as “skipped” in Notifications › Outgoing messages.');
    } else if (tab === 'perms') {
      const perms = Object.entries((await api('GET', '/auth/me')).permissions);
      const rp = S.role_permissions;
      c.innerHTML = `<div class="card"><h2>Roles & permissions</h2><p class="muted">Admins always have every permission. Use this to restrict discounts, cancellations and refunds to managers, for example.</p>
        <div class="table-wrap"><table class="data perm-grid"><thead><tr><th>Permission</th>${S.roles.map(r => `<th>${esc(r)}</th>`).join('')}</tr></thead><tbody>
        ${perms.map(([p, label]) => `<tr><td>${esc(label)}<div class="faint">${esc(p)}</div></td>${S.roles.map(r => `<td><input type="checkbox" data-role="${r}" data-perm="${p}" ${rp[r].includes(p) ? 'checked' : ''} ${r === 'admin' ? 'disabled' : ''}></td>`).join('')}</tr>`).join('')}
        </tbody></table></div><button class="btn primary" style="margin-top:12px" data-saveperms>Save permissions</button></div>`;
    } else if (tab === 'backup') {
      const files = await api('GET', '/backups');
      c.innerHTML = section('Automatic backups', fieldsHtml([{ name: 'enabled', label: 'Back up the database automatically every day', type: 'checkbox', span: 1 }, { name: 'keep_days', label: 'Keep backups for (days)', type: 'number' }], S.backup), 'backup',
        'Backups are full copies of the database in the <code>backups/</code> folder. To restore: stop the server and run <code>npm run restore -- backups/&lt;file&gt;.db</code>. Copy backups off the machine regularly.') +
        `<div class="card"><div class="row between"><h2 style="margin:0">Backup files</h2><div class="row"><button class="btn" data-export>Export all data (JSON)</button><button class="btn primary" data-backup>Back up now</button></div></div><div style="margin-top:12px">
        ${tableHtml([{ label: 'File', key: 'file' }, { label: 'Created', render: f => esc(fmtDate(f.at)) }, { label: 'Size', render: f => `${(f.size / 1024).toFixed(0)} KB`, r: 1 }, { label: '', render: f => `<button class="btn sm ghost" data-dl="${esc(f.file)}">Download</button>` }], files, { empty: 'No backups yet.' })}</div></div>`;
    }
  }

  // ---------------- Location & geofence ----------------
  async function drawLocation(c) {
    const branches = await api('GET', '/branches');
    c.innerHTML = `<div class="banner info">Customers can browse the menu from anywhere, but they can only <b>place a QR order</b> (or call a waiter / ask for the bill) when their phone's location is inside the radius around the café. The check runs on the server for every order.</div>
      <div class="toolbar"><button class="btn" data-newbranch>＋ Add branch</button></div>
      ${branches.map(b => `<div class="card" data-branch="${b.id}">
        <div class="row between"><h2 style="margin:0">${esc(b.name)} ${b.active ? '' : chip('inactive')}</h2>${b.geofence_enabled ? (b.lat != null ? chip(`QR ordering within ${b.radius_m} m`, 'ok') : chip('Location not set — QR orders are blocked', 'bad')) : chip('Location check OFF', 'warn')}</div>
        <div class="grid g2" style="margin-top:12px;align-items:start">
          <div><div class="map" id="map${b.id}"><div class="empty">Loading map…</div></div><p class="hint">Click the map or drag the pin to set the café entrance. The circle shows the ordering radius.</p></div>
          <form onsubmit="return false">${fieldsHtml(branchDefs, b)}
            <div class="row"><button class="btn" data-here="${b.id}">📍 Use my current location</button><button class="btn" data-test="${b.id}">Test from where I am</button><button class="btn primary" data-savebranch="${b.id}">Save</button></div>
            <p class="hint" id="geomsg${b.id}" role="status"></p></form>
        </div></div>`).join('')}`;
    branches.forEach(b => initMap(b));
  }
  const maps = {};
  async function loadLeaflet() {
    if (window.L) return window.L;
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.append(css);
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; s.onload = res; s.onerror = rej; document.head.append(s); });
    return window.L;
  }
  async function initMap(b) {
    const box = $(`#map${b.id}`);
    const form = box.closest('[data-branch]');
    try {
      const L = await loadLeaflet();
      box.innerHTML = '';
      const center = b.lat != null ? [b.lat, b.lng] : [20.5937, 78.9629];
      const map = L.map(box).setView(center, b.lat != null ? 17 : 4);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
      const marker = L.marker(center, { draggable: true }).addTo(map);
      const circle = L.circle(center, { radius: b.radius_m, color: '#6b2fa0', fillOpacity: 0.12 }).addTo(map);
      const setPos = (lat, lng, pan = false) => {
        marker.setLatLng([lat, lng]); circle.setLatLng([lat, lng]);
        $('[name=lat]', form).value = lat.toFixed(6); $('[name=lng]', form).value = lng.toFixed(6);
        if (pan) map.setView([lat, lng], 17);
      };
      map.on('click', e => setPos(e.latlng.lat, e.latlng.lng));
      marker.on('dragend', () => { const p = marker.getLatLng(); setPos(p.lat, p.lng); });
      form.addEventListener('input', e => {
        if (e.target.name === 'radius_m') circle.setRadius(Number(e.target.value) || 0);
        if (['lat', 'lng'].includes(e.target.name)) { const lat = Number($('[name=lat]', form).value), lng = Number($('[name=lng]', form).value); if (Number.isFinite(lat) && Number.isFinite(lng)) { marker.setLatLng([lat, lng]); circle.setLatLng([lat, lng]); } }
      });
      maps[b.id] = { map, setPos };
      setTimeout(() => map.invalidateSize(), 50);
    } catch {
      box.innerHTML = '<div class="empty">Map unavailable offline — enter latitude and longitude, or use “Use my current location”.</div>';
    }
  }
  function myPosition() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('This browser cannot share location'));
      navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }), e => rej(new Error(e.code === 1 ? 'Location permission denied' : 'Could not get location')), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  const cafeDefs = [{ name: 'name', label: 'Café name', required: true }, { name: 'logo_url', label: 'Logo URL' }, { name: 'address', label: 'Address', span: 1 }, { name: 'phone', label: 'Phone' }, { name: 'email', label: 'Email', type: 'email' }, { name: 'gstin', label: 'GSTIN / tax ID' }, { name: 'website', label: 'Website' }];
  const regionDefs = [{ name: 'public_url', label: 'Public URL for QR codes', span: 1, placeholder: 'https://order.mycafe.in' }, { name: 'timezone', label: 'Time zone', placeholder: 'Asia/Kolkata' }, { name: 'currency_symbol', label: 'Currency symbol' }, { name: 'currency_code', label: 'Currency code' }];
  const taxDefs = [{ name: 'enabled', label: 'Charge tax', type: 'checkbox' }, { name: 'label', label: 'Tax name', placeholder: 'GST' }, { name: 'rate', label: 'Rate (%)', type: 'number', step: '0.01' }, { name: 'mode', label: 'Prices are', type: 'select', options: [['exclusive', 'Exclusive of tax (add on bill)'], ['inclusive', 'Inclusive of tax']] }, { name: 'split', label: 'Show as CGST + SGST', type: 'checkbox' }];
  const scDefs = [{ name: 'enabled', label: 'Add a service charge', type: 'checkbox' }, { name: 'percent', label: 'Percent', type: 'number', step: '0.1' }, { name: 'dine_in_only', label: 'Dine-in orders only', type: 'checkbox' }];
  const receiptDefs = [{ name: 'header', label: 'Header text', span: 1 }, { name: 'footer', label: 'Footer text', span: 1 }, { name: 'show_logo', label: 'Show logo', type: 'checkbox' }, { name: 'show_gstin', label: 'Show GSTIN', type: 'checkbox' }, { name: 'paper', label: 'Paper', type: 'select', options: [['80mm', '80 mm thermal'], ['58mm', '58 mm thermal'], ['a4', 'A4 / letter']] }];
  const branchDefs = [
    { name: 'name', label: 'Branch name', required: true }, { name: 'phone', label: 'Phone' }, { name: 'address', label: 'Address', span: 1 },
    { name: 'lat', label: 'Café latitude', type: 'number', step: 'any' }, { name: 'lng', label: 'Café longitude', type: 'number', step: 'any' },
    { name: 'radius_m', label: 'Ordering radius (metres)', type: 'number', required: true, hint: 'Typical: 50–150 m. Too small and guests on weak GPS get blocked.' },
    { name: 'geofence_enabled', label: 'Require customers to be within the radius', type: 'checkbox' },
    { name: 'accuracy_tolerance_m', label: 'GPS error allowance (m)', type: 'number', hint: 'Extra distance forgiven based on the phone\'s reported accuracy (max)' },
    { name: 'max_accuracy_m', label: 'Reject fixes less precise than (m)', type: 'number', hint: 'Stops very rough “approximate location” fixes' },
    { name: 'active', label: 'Branch active', type: 'checkbox' },
  ];

  el.addEventListener('click', async e => {
    const q = s => e.target.closest(s);
    try {
      const sv = q('[data-save]');
      if (sv) {
        const key = sv.dataset.save, form = sv.closest('form');
        if (key === 'cafe') await save('cafe', readFields(form, cafeDefs));
        if (key === 'region') { const d = readFields(form, regionDefs); await save('public_url', d.public_url.trim().replace(/\/$/, '')); await save('timezone', d.timezone.trim() || 'Asia/Kolkata'); await save('currency', { symbol: d.currency_symbol || '₹', code: d.currency_code || 'INR' }); }
        if (key === 'tax') await save('tax', readFields(form, taxDefs));
        if (key === 'service_charge') await save('service_charge', readFields(form, scDefs));
        if (key === 'payments') { const d = readFields(form, [{ name: 'rounding', type: 'checkbox' }, { name: 'payment_methods' }]); await save('rounding', d.rounding); await save('payment_methods', d.payment_methods.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)); }
        if (key === 'receipt') await save('receipt', readFields(form, receiptDefs));
        if (key === 'order_status_labels') await save(key, readFields(form, ['new', 'preparing', 'ready', 'served'].map(k => ({ name: k }))));
        if (key === 'kds') await save('kds', readFields(form, [{ name: 'delay_minutes', type: 'number' }, { name: 'sound', type: 'checkbox' }]));
        if (key === 'notifications') await save('notifications', readFields(form, ['customer_ready', 'digital_receipts', 'low_stock', 'delayed_orders'].map(n => ({ name: n, type: 'checkbox' }))));
        if (key === 'loyalty') await save('loyalty', readFields(form, [{ name: 'enabled', type: 'checkbox' }, { name: 'points_per_100', type: 'number' }, { name: 'point_value', type: 'money' }]));
        if (key === 'backup') await save('backup', readFields(form, [{ name: 'enabled', type: 'checkbox' }, { name: 'keep_days', type: 'number' }]));
        if (key === 'messaging') {
          const v = {};
          for (const ch of ['whatsapp', 'sms', 'email']) v[ch] = { enabled: $(`[name=${ch}_enabled]`, form).checked, webhook_url: $(`[name=${ch}_webhook_url]`, form).value.trim(), token: $(`[name=${ch}_token]`, form).value };
          v.email.from = $('[name=email_from]', form).value;
          await save('messaging', v);
        }
        if (key === 'cafe' || key === 'region') loadMe();
      }
      if (q('[data-savehours]')) {
        const hours = {};
        DAYS.forEach((_, i) => { hours[i] = { open: $(`[data-o="${i}"]`).value, close: $(`[data-c="${i}"]`).value, closed: $(`[data-x="${i}"]`).checked }; });
        const holidays = $('#hol').value.split(/\s+/).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
        await save('hours', hours); await save('holidays', holidays); await save('enforce_hours_for_qr', $('#enf').checked);
      }
      if (q('[data-saveperms]')) {
        const v = {};
        S.roles.filter(r => r !== 'admin').forEach(r => { v[r] = $$(`[data-role="${r}"]:checked`).map(x => x.dataset.perm); });
        await save('permissions', v);
      }
      if (q('[data-backup]')) { const r = await api('POST', '/backups'); toast(`Backup created: ${r.file}`, 'ok'); draw(); }
      if (q('[data-dl]')) downloadFile(`/backups/${encodeURIComponent(q('[data-dl]').dataset.dl)}`, q('[data-dl]').dataset.dl);
      if (q('[data-export]')) downloadFile('/export/all.json', 'pixberry-export.json');
      // location
      if (q('[data-here]')) {
        const id = q('[data-here]').dataset.here, msg = $(`#geomsg${id}`);
        msg.textContent = 'Getting your location…';
        const p = await myPosition();
        const form = q('[data-here]').closest('form');
        if (maps[id]) maps[id].setPos(p.lat, p.lng, true); else { $('[name=lat]', form).value = p.lat.toFixed(6); $('[name=lng]', form).value = p.lng.toFixed(6); }
        msg.textContent = `Set to your position (±${Math.round(p.accuracy)} m). Stand at the café when doing this, then press Save.`;
      }
      if (q('[data-test]')) {
        const id = q('[data-test]').dataset.test, msg = $(`#geomsg${id}`);
        msg.textContent = 'Checking…';
        const p = await myPosition();
        const r = await api('POST', `/branches/${id}/geofence-test`, p);
        msg.innerHTML = r.allowed ? `✅ An order from here would be <b>accepted</b>${r.distance_m != null ? ` (${r.distance_m} m away, ±${Math.round(p.accuracy)} m)` : ''}.` : `🚫 An order from here would be <b>blocked</b>: ${esc(r.reason)}`;
      }
      if (q('[data-savebranch]')) {
        const id = q('[data-savebranch]').dataset.savebranch;
        const d = readFields(q('[data-savebranch]').closest('form'), branchDefs);
        if (d.geofence_enabled && (d.lat == null || d.lng == null)) toast('Set the café location, otherwise QR orders will be blocked', 'bad');
        await api('PUT', `/branches/${id}`, d); toast('Branch saved', 'ok'); loadMe(); draw();
      }
      if (q('[data-newbranch]')) formModal({ title: 'Add branch', defs: branchDefs.slice(0, 3).concat([{ name: 'radius_m', label: 'Ordering radius (m)', type: 'number', default: 100 }]), submit: async d => { await api('POST', '/branches', { ...d, geofence_enabled: true, active: true }); toast('Branch added — now set its location', 'ok'); await loadMe(); draw(); } });
    } catch (err) { toast(err.message, 'bad'); }
  });
  void money; void modal; void tableHtml;
  await draw();
}
