'use strict';
// Order engine: pricing, totals (tax / service charge / discounts), stock deduction, payments, loyalty.
const { all, get, run, tx, insert, update } = require('./db');
const { getSetting, setSetting, httpError, token, nowIso, localParts, itemScheduledNow, emit, notify, messageCustomer, money, audit } = require('./util');

const ACTIVE = ['open', 'billed'];

function nextOrderNumber(branchId) {
  const lp = localParts();
  // Daily sequence per branch (resets each local day)
  const key = `order_seq_${branchId}`;
  const cur = getSetting(key) || {};
  const n = cur.date === lp.date ? cur.n + 1 : 1;
  setSetting(key, { date: lp.date, n });
  return n;
}

function activeOrderForTable(tableId) {
  return get(`SELECT * FROM orders WHERE table_id = ? AND status IN ('open','billed') ORDER BY id LIMIT 1`, tableId);
}

function createOrder({ branch_id, type = 'dine_in', source = 'pos', table_id = null, customer = {}, user = null, notes = '', geo = null, client_ref = null }) {
  if (!['dine_in', 'takeaway', 'pickup'].includes(type)) throw httpError(400, 'Invalid order type');
  if (type === 'dine_in' && !table_id && source === 'qr') throw httpError(400, 'Dine-in QR orders need a table');
  const number = nextOrderNumber(branch_id);
  const customer_id = customer.phone ? upsertCustomer(customer) : null;
  const id = insert('orders', {
    branch_id, number, public_key: token(16), type, source, table_id, customer_id,
    customer_name: customer.name || '', customer_phone: customer.phone || '',
    pickup_code: type === 'dine_in' ? null : String(1000 + Math.floor(Math.random() * 9000)),
    notes, created_by: user?.id ?? null, client_ref,
    geo_lat: geo?.lat ?? null, geo_lng: geo?.lng ?? null, geo_distance_m: geo?.distance_m ?? null,
  });
  if (table_id) run(`UPDATE tables SET status = 'occupied' WHERE id = ?`, table_id);
  return getOrder(id);
}

function upsertCustomer({ name = '', phone, email = '', consent = false }) {
  phone = String(phone).replace(/[^\d+]/g, '');
  if (!phone) return null;
  const c = get('SELECT * FROM customers WHERE phone = ?', phone);
  if (c) {
    const patch = {};
    if (name && !c.name) patch.name = name;
    if (email && !c.email) patch.email = email;
    if (consent && !c.consent) { patch.consent = 1; patch.consent_at = nowIso(); }
    if (Object.keys(patch).length) update('customers', c.id, patch);
    return c.id;
  }
  return insert('customers', { name, phone, email, consent: consent ? 1 : 0, consent_at: consent ? nowIso() : null });
}

/** Resolve a cart line against the live menu. Prices always come from the database, never from the client. */
function priceLine(line, orderType) {
  const item = get('SELECT * FROM items WHERE id = ?', Number(line.item_id));
  if (!item || !item.available) throw httpError(400, `Item is not on the menu`);
  if (item.sold_out) throw httpError(409, `${item.name} is sold out`);
  const cat = item.category_id ? get('SELECT * FROM categories WHERE id = ?', item.category_id) : null;
  if (cat && !cat.active) throw httpError(400, `${item.name} is not available`);
  const lp = localParts();
  if (!itemScheduledNow(item, lp) || (cat && !itemScheduledNow(cat, lp))) throw httpError(409, `${item.name} is not available at this time`);
  const takeaway = orderType !== 'dine_in';
  let base = takeaway && item.takeaway_price != null ? item.takeaway_price : item.price;
  let variant = null;
  const variants = all('SELECT * FROM item_variants WHERE item_id = ? ORDER BY sort, id', item.id);
  if (variants.length) {
    variant = variants.find(v => v.id === Number(line.variant_id)) || null;
    if (!variant) throw httpError(400, `Choose a size/variant for ${item.name}`);
    base = takeaway && variant.takeaway_price != null ? variant.takeaway_price : variant.price;
  }
  const groups = all('SELECT * FROM modifier_groups WHERE item_id = ? ORDER BY sort, id', item.id);
  const chosen = (Array.isArray(line.modifier_ids) ? line.modifier_ids : []).map(Number);
  const mods = [];
  for (const g of groups) {
    const opts = all('SELECT * FROM modifiers WHERE group_id = ?', g.id);
    const picked = opts.filter(o => chosen.includes(o.id));
    if (picked.length < g.min_select) throw httpError(400, `Choose at least ${g.min_select} for "${g.name}" (${item.name})`);
    if (g.max_select > 0 && picked.length > g.max_select) throw httpError(400, `Choose at most ${g.max_select} for "${g.name}" (${item.name})`);
    for (const p of picked) mods.push({ id: p.id, group: g.name, name: p.name, price: p.price });
  }
  const known = new Set(mods.map(m => m.id));
  if (chosen.some(id => !known.has(id))) throw httpError(400, `Invalid option for ${item.name}`);
  const qty = Math.max(1, Math.min(99, parseInt(line.qty, 10) || 1));
  return {
    item_id: item.id, variant_id: variant?.id ?? null, name: item.name, variant_name: variant?.name || '',
    modifiers: JSON.stringify(mods), unit_price: base + mods.reduce((s, m) => s + m.price, 0), qty,
    notes: String(line.notes || '').slice(0, 200), station_id: item.station_id,
  };
}

function addItems(orderId, lines, { addedBy = 'staff', user = null } = {}) {
  return tx(() => {
    const order = get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!order) throw httpError(404, 'Order not found');
    if (!ACTIVE.includes(order.status)) throw httpError(409, `Order #${order.number} is ${order.status}; start a new order`);
    if (!Array.isArray(lines) || !lines.length) throw httpError(400, 'Add at least one item');
    const priced = lines.map(l => priceLine(l, order.type));
    const kot = (get('SELECT MAX(kot) AS k FROM order_items WHERE order_id = ?', orderId).k || 0) + 1;
    const ids = [];
    for (const p of priced) {
      const id = insert('order_items', { ...p, order_id: orderId, kot, added_by: addedBy });
      ids.push(id);
      deductStock(order.branch_id, p, `Order #${order.number}`, user, -1);
    }
    if (order.status === 'billed') run(`UPDATE orders SET status = 'open' WHERE id = ?`, orderId);
    recalc(orderId);
    const o = getOrder(orderId);
    emit('order.items_added', { order_id: orderId, branch_id: order.branch_id, kot, number: order.number });
    notify({ branch_id: order.branch_id, audience: 'kitchen', type: 'new_order', message: `New ${kot > 1 ? `round (KOT ${kot}) ` : ''}order #${order.number}${o.table_label ? ` · ${o.table_label}` : ` · ${order.type.replace('_', ' ')}`} — ${priced.reduce((s, p) => s + p.qty, 0)} item(s)`, ref: `order:${orderId}` });
    if (user) audit(user, 'order.add_items', 'order', orderId, { kot, items: priced.map(p => `${p.qty}× ${p.name}`) });
    return o;
  });
}

// direction -1 deducts (sale), +1 restores (cancellation)
function deductStock(branchId, line, reference, user, direction) {
  const loc = get('SELECT id FROM stock_locations WHERE branch_id = ? ORDER BY is_default DESC, id LIMIT 1', branchId);
  if (!loc || !line.item_id) return;
  let rl = all('SELECT * FROM recipe_lines WHERE item_id = ? AND variant_id IS ?', line.item_id, line.variant_id ?? null);
  if (!rl.length && line.variant_id) rl = all('SELECT * FROM recipe_lines WHERE item_id = ? AND variant_id IS NULL', line.item_id);
  for (const r of rl) {
    const ing = get('SELECT * FROM ingredients WHERE id = ?', r.ingredient_id);
    insert('stock_movements', { ingredient_id: r.ingredient_id, location_id: loc.id, type: direction < 0 ? 'used' : 'adjusted', qty: direction * r.qty * line.qty, unit_cost: ing?.cost_per_unit ?? 0, reference, note: direction < 0 ? 'Sale' : 'Cancelled item', user_id: user?.id ?? null });
    if (direction < 0) checkLowStock(r.ingredient_id, branchId);
  }
}

function stockLevel(ingredientId, locationId = null) {
  return locationId
    ? get('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE ingredient_id = ? AND location_id = ?', ingredientId, locationId).q
    : get('SELECT COALESCE(SUM(qty),0) AS q FROM stock_movements WHERE ingredient_id = ?', ingredientId).q;
}
const lowAlerted = new Map();
function checkLowStock(ingredientId, branchId) {
  const ing = get('SELECT * FROM ingredients WHERE id = ?', ingredientId);
  if (!ing || !ing.low_stock_level) return;
  const lvl = stockLevel(ingredientId);
  if (lvl <= ing.low_stock_level) {
    const last = lowAlerted.get(ingredientId) || 0;
    if (Date.now() - last > 6 * 3600e3 && (getSetting('notifications') || {}).low_stock !== false) {
      lowAlerted.set(ingredientId, Date.now());
      notify({ branch_id: branchId, audience: 'manager', type: 'low_stock', message: `Low stock: ${ing.name} — ${+lvl.toFixed(2)} ${ing.unit} left (alert at ${ing.low_stock_level})`, ref: `ingredient:${ingredientId}` });
    }
  } else lowAlerted.delete(ingredientId);
}

function couponDiscount(code, subtotal) {
  const c = get('SELECT * FROM coupons WHERE code = ?', code);
  if (!c || !c.active) throw httpError(400, 'Coupon not found or inactive');
  if (c.expires_at && c.expires_at < localParts().date) throw httpError(400, 'Coupon has expired');
  if (c.max_uses && c.used >= c.max_uses) throw httpError(400, 'Coupon usage limit reached');
  if (c.min_order && subtotal < c.min_order) throw httpError(400, `Coupon needs a minimum order of ${money(c.min_order)}`);
  let d = c.type === 'percent' ? Math.round(subtotal * c.value / 100) : c.value;
  if (c.max_discount) d = Math.min(d, c.max_discount);
  return Math.min(d, subtotal);
}

function recalc(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  const subtotal = get(`SELECT COALESCE(SUM(unit_price*qty),0) AS s FROM order_items WHERE order_id = ? AND kds_status != 'cancelled'`, orderId).s;
  let discount = 0;
  if (o.coupon_code) { try { discount = couponDiscount(o.coupon_code, subtotal); } catch { discount = 0; } }
  else if (o.discount_type === 'percent') discount = Math.round(subtotal * (o.discount_value || 0) / 100);
  else if (o.discount_type === 'flat') discount = Math.min(o.discount_value || 0, subtotal);
  const taxable = subtotal - discount;
  const sc = getSetting('service_charge');
  const service = sc.enabled && (!sc.dine_in_only || o.type === 'dine_in') ? Math.round(taxable * sc.percent / 100) : 0;
  const t = getSetting('tax');
  let tax = 0, total = taxable + service;
  if (t.enabled && t.rate > 0) {
    if (t.mode === 'inclusive') tax = Math.round(total - total / (1 + t.rate / 100));
    else { tax = Math.round(total * t.rate / 100); total += tax; }
  }
  let round_off = 0;
  if (getSetting('rounding')) { round_off = Math.round(total / 100) * 100 - total; total += round_off; }
  run('UPDATE orders SET subtotal=?, discount=?, service_charge=?, tax=?, round_off=?, total=? WHERE id=?', subtotal, discount, service, tax, round_off, total, orderId);
}

function getOrder(id) {
  const o = get(`SELECT o.*, t.label AS table_label, b.name AS branch_name, u.name AS created_by_name
                 FROM orders o LEFT JOIN tables t ON t.id = o.table_id LEFT JOIN branches b ON b.id = o.branch_id LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`, id);
  if (!o) return null;
  o.items = all(`SELECT oi.*, s.name AS station_name FROM order_items oi LEFT JOIN stations s ON s.id = oi.station_id WHERE order_id = ? ORDER BY kot, oi.id`, id)
    .map(i => ({ ...i, modifiers: JSON.parse(i.modifiers || '[]') }));
  o.payments = all(`SELECT p.*, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE order_id = ? ORDER BY p.id`, id);
  o.balance = ACTIVE.includes(o.status) ? o.total - o.paid + o.refunded : 0;
  const t = getSetting('tax');
  o.tax_breakdown = !o.tax ? [] : t.split
    ? [{ label: `C${t.label} ${t.rate / 2}%`, amount: Math.floor(o.tax / 2) }, { label: `S${t.label} ${t.rate / 2}%`, amount: o.tax - Math.floor(o.tax / 2) }]
    : [{ label: `${t.label} ${t.rate}%`, amount: o.tax }];
  o.tax_mode = t.mode;
  return o;
}

function addPayment(orderId, { method, amount, reference = '', note = '' }, user) {
  return tx(() => {
    const o = getOrder(orderId);
    if (!o) throw httpError(404, 'Order not found');
    if (!ACTIVE.includes(o.status)) throw httpError(409, `Order is ${o.status}`);
    const methods = getSetting('payment_methods');
    if (!methods.includes(method)) throw httpError(400, `Payment method "${method}" is not enabled`);
    amount = Math.round(Number(amount));
    if (!(amount > 0)) throw httpError(400, 'Amount must be positive');
    if (amount > o.balance && method !== 'cash') throw httpError(400, `Amount exceeds balance due (${money(o.balance)})`);
    const applied = Math.min(amount, o.balance);
    const change = amount - applied;
    insert('payments', { order_id: orderId, kind: 'payment', method, amount: applied, reference, note: change ? `${note} (tendered ${money(amount)}, change ${money(change)})`.trim() : note, created_by: user?.id ?? null });
    run('UPDATE orders SET paid = paid + ? WHERE id = ?', applied, orderId);
    audit(user, 'payment.add', 'order', orderId, { method, amount: applied });
    const after = getOrder(orderId);
    if (after.balance <= 0 && after.items.some(i => i.kds_status !== 'cancelled')) closeOrder(orderId, user);
    emit('order.updated', { order_id: orderId, branch_id: o.branch_id });
    return { order: getOrder(orderId), change };
  });
}

function closeOrder(orderId, user) {
  const o = getOrder(orderId);
  const seq = (getSetting('invoice_seq') || 0) + 1;
  setSetting('invoice_seq', seq);
  const invoice_no = `PB-${localParts().date.slice(0, 4)}-${String(seq).padStart(6, '0')}`;
  run(`UPDATE orders SET status = 'paid', closed_at = ?, invoice_no = ? WHERE id = ?`, nowIso(), invoice_no, orderId);
  if (o.table_id && !activeOrderForTable(o.table_id)) run(`UPDATE tables SET status = 'cleaning' WHERE id = ?`, o.table_id);
  if (o.coupon_code) run('UPDATE coupons SET used = used + 1 WHERE code = ?', o.coupon_code);
  const loyalty = getSetting('loyalty');
  if (o.customer_id && loyalty.enabled) {
    const pts = Math.floor(o.total / 10000) * loyalty.points_per_100;
    if (pts > 0) {
      insert('loyalty_txns', { customer_id: o.customer_id, order_id: orderId, points: pts, reason: `Earned on #${o.number}` });
      run('UPDATE customers SET points = points + ? WHERE id = ?', pts, o.customer_id);
    }
  }
  if (o.customer_phone && (getSetting('notifications') || {}).digital_receipts !== false) {
    const base = getSetting('public_url') || '';
    messageCustomer({ phone: o.customer_phone }, `${getSetting('cafe').name}: thanks! Bill ${invoice_no} · ${money(o.total)} paid. Receipt: ${base}/r/${o.public_key}`, 'Your receipt');
  }
  audit(user, 'order.paid', 'order', orderId, { invoice_no, total: o.total });
}

function refund(orderId, { amount, method, reason }, user) {
  return tx(() => {
    const o = getOrder(orderId);
    if (!o) throw httpError(404, 'Order not found');
    amount = Math.round(Number(amount));
    const refundable = o.paid - o.refunded;
    if (!(amount > 0) || amount > refundable) throw httpError(400, `Refund must be between 0 and ${money(refundable)}`);
    if (!reason) throw httpError(400, 'A refund reason is required');
    insert('payments', { order_id: orderId, kind: 'refund', method: method || 'cash', amount, note: reason, created_by: user.id });
    run('UPDATE orders SET refunded = refunded + ? WHERE id = ?', amount, orderId);
    audit(user, 'order.refund', 'order', orderId, { amount, reason });
    notify({ branch_id: o.branch_id, audience: 'manager', type: 'refund', message: `${user.name} refunded ${money(amount)} on #${o.number}: ${reason}`, ref: `order:${orderId}` });
    return getOrder(orderId);
  });
}

function cancelItem(orderItemId, reason, user) {
  return tx(() => {
    const it = get('SELECT * FROM order_items WHERE id = ?', orderItemId);
    if (!it) throw httpError(404, 'Item not found');
    if (it.kds_status === 'cancelled') return getOrder(it.order_id);
    const o = get('SELECT * FROM orders WHERE id = ?', it.order_id);
    if (!ACTIVE.includes(o.status)) throw httpError(409, 'Order is closed');
    run(`UPDATE order_items SET kds_status = 'cancelled', status_at = ?, notes = TRIM(notes || ' [cancelled: ' || ? || ']') WHERE id = ?`, nowIso(), reason || 'no reason', orderItemId);
    deductStock(o.branch_id, it, `Cancel #${o.number}`, user, +1);
    recalc(it.order_id);
    audit(user, 'order.cancel_item', 'order', it.order_id, { item: `${it.qty}× ${it.name}`, reason });
    emit('order.updated', { order_id: it.order_id, branch_id: o.branch_id });
    return getOrder(it.order_id);
  });
}

function cancelOrder(orderId, reason, user) {
  return tx(() => {
    const o = getOrder(orderId);
    if (!o) throw httpError(404, 'Order not found');
    if (!ACTIVE.includes(o.status)) throw httpError(409, `Order is ${o.status}`);
    if (o.paid - o.refunded > 0) throw httpError(409, 'Refund payments before cancelling this order');
    if (!reason) throw httpError(400, 'A cancellation reason is required');
    for (const it of o.items.filter(i => i.kds_status !== 'cancelled')) {
      run(`UPDATE order_items SET kds_status = 'cancelled', status_at = ? WHERE id = ?`, nowIso(), it.id);
      deductStock(o.branch_id, it, `Cancel #${o.number}`, user, +1);
    }
    run(`UPDATE orders SET status = 'cancelled', cancel_reason = ?, closed_at = ? WHERE id = ?`, reason, nowIso(), orderId);
    if (o.table_id && !activeOrderForTable(o.table_id)) run(`UPDATE tables SET status = 'available' WHERE id = ?`, o.table_id);
    audit(user, 'order.cancel', 'order', orderId, { reason, total: o.total });
    emit('order.updated', { order_id: orderId, branch_id: o.branch_id });
    return getOrder(orderId);
  });
}

module.exports = { ACTIVE, createOrder, addItems, priceLine, recalc, getOrder, addPayment, refund, cancelItem, cancelOrder, activeOrderForTable, upsertCustomer, couponDiscount, stockLevel, checkLowStock };
