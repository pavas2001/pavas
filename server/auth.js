'use strict';
const crypto = require('node:crypto');
const { get, run, all } = require('./db');
const { getSetting, httpError, token } = require('./util');

const PERMISSIONS = {
  'orders.create': 'Create orders & add items',
  'orders.edit': 'Edit order items',
  'orders.cancel': 'Cancel orders / items',
  'orders.transfer': 'Transfer, split & combine orders/tables',
  'orders.discount': 'Apply discounts & coupons',
  'orders.refund': 'Issue refunds',
  'payments.take': 'Take payments',
  'kds.view': 'Kitchen display',
  'tables.manage': 'Manage tables & floor',
  'reservations.manage': 'Reservations & waitlist',
  'menu.manage': 'Menu management',
  'inventory.manage': 'Inventory & recipes',
  'purchasing.manage': 'Suppliers & purchasing',
  'customers.manage': 'Customers, loyalty & coupons',
  'staff.manage': 'Staff, roles & shifts',
  'reports.view': 'Reports & dashboard',
  'settings.manage': 'Business settings & backups',
  'audit.view': 'Audit log',
};
const ROLES = ['admin', 'manager', 'cashier', 'kitchen'];
const DEFAULT_ROLE_PERMS = {
  admin: Object.keys(PERMISSIONS),
  manager: Object.keys(PERMISSIONS).filter(p => !['settings.manage'].includes(p)),
  cashier: ['orders.create', 'orders.edit', 'payments.take', 'kds.view', 'tables.manage', 'reservations.manage', 'customers.manage'],
  kitchen: ['kds.view'],
};

function rolePermissions() {
  const custom = getSetting('permissions') || {};
  const out = {};
  for (const r of ROLES) out[r] = r === 'admin' ? Object.keys(PERMISSIONS) : (Array.isArray(custom[r]) ? custom[r] : DEFAULT_ROLE_PERMS[r]);
  return out;
}
function permsFor(role) { return rolePermissions()[role] || []; }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), 64);
  const want = Buffer.from(h, 'base64');
  return want.length === hash.length && crypto.timingSafeEqual(want, hash);
}

const SESSION_HOURS = 12;
function createSession(userId) {
  const t = token(32);
  const now = new Date();
  run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', t, userId, now.toISOString(), new Date(now.getTime() + SESSION_HOURS * 3600e3).toISOString());
  run('DELETE FROM sessions WHERE expires_at < ?', now.toISOString());
  return t;
}
function userFromToken(t) {
  if (!t) return null;
  const s = get('SELECT * FROM sessions WHERE token = ?', t);
  if (!s || s.expires_at < new Date().toISOString()) return null;
  const u = get('SELECT id, name, username, role, branch_id, active FROM users WHERE id = ?', s.user_id);
  if (!u || !u.active) return null;
  u.permissions = permsFor(u.role);
  return u;
}

// Simple in-memory login throttle: 10 failures / 15 min per username+ip
const fails = new Map();
function throttleKey(req, username) { return `${req.ip}|${String(username).toLowerCase()}`; }
function checkThrottle(req, username) {
  const f = fails.get(throttleKey(req, username));
  if (f && f.count >= 10 && Date.now() - f.first < 15 * 60e3) throw httpError(429, 'Too many failed sign-in attempts. Try again in 15 minutes.');
}
function recordFail(req, username) {
  const k = throttleKey(req, username);
  const f = fails.get(k);
  if (!f || Date.now() - f.first > 15 * 60e3) fails.set(k, { count: 1, first: Date.now() });
  else f.count++;
}
function clearFails(req, username) { fails.delete(throttleKey(req, username)); }

function authenticate(req, _res, next) {
  const h = req.get('authorization') || '';
  // Query-string tokens are only accepted for the SSE stream (EventSource cannot send headers)
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.path === '/events' ? req.query.access_token || null : null);
  req.user = userFromToken(t);
  req.sessionToken = req.user ? t : null;
  next();
}
function requireUser(req, _res, next) {
  if (!req.user) return next(httpError(401, 'Please sign in.'));
  next();
}
function can(user, perm) { return !!user && (user.role === 'admin' || user.permissions.includes(perm)); }
function requirePerm(...perms) {
  return (req, _res, next) => {
    if (!req.user) return next(httpError(401, 'Please sign in.'));
    if (!perms.some(p => can(req.user, p))) return next(httpError(403, `You don't have permission for this (${perms.join(' / ')}).`));
    next();
  };
}

function ensureAdmin() {
  const n = get('SELECT COUNT(*) AS n FROM users').n;
  if (n > 0) return null;
  const pw = process.env.ADMIN_PASSWORD || token(9);
  run('INSERT INTO users (name, username, password_hash, role) VALUES (?, ?, ?, ?)', 'Administrator', 'admin', hashPassword(pw), 'admin');
  return pw;
}

module.exports = {
  PERMISSIONS, ROLES, DEFAULT_ROLE_PERMS, rolePermissions, permsFor,
  hashPassword, verifyPassword, createSession, userFromToken,
  checkThrottle, recordFail, clearFails, authenticate, requireUser, requirePerm, can, ensureAdmin,
};
