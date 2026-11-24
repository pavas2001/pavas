'use strict';
// Pixberry ERP — database layer (Node's built-in SQLite, no native modules).
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.PIXBERRY_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = process.env.PIXBERRY_DB || path.join(DATA_DIR, 'pixberry.db');

if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, address TEXT DEFAULT '', phone TEXT DEFAULT '',
  -- Geofence for QR ordering: customers must be within radius_m metres of (lat, lng)
  lat REAL, lng REAL, radius_m INTEGER NOT NULL DEFAULT 100,
  geofence_enabled INTEGER NOT NULL DEFAULT 1,
  accuracy_tolerance_m INTEGER NOT NULL DEFAULT 30, -- GPS error we forgive on top of the radius
  max_accuracy_m INTEGER NOT NULL DEFAULT 300,      -- fixes less precise than this are rejected
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'cashier', phone TEXT DEFAULT '',
  branch_id INTEGER REFERENCES branches(id), active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), branch_id INTEGER,
  clock_in TEXT NOT NULL, clock_out TEXT, notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), branch_id INTEGER,
  date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, user_id INTEGER, user_name TEXT, action TEXT NOT NULL, entity TEXT,
  entity_id INTEGER, details TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sections (id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id), name TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id),
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  label TEXT NOT NULL, seats INTEGER DEFAULT 4,
  kind TEXT NOT NULL DEFAULT 'table',      -- table | counter (counter QR = takeaway/pickup)
  qr_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'available', -- available | ordering | occupied | bill_requested | cleaning
  merged_into INTEGER REFERENCES tables(id), active INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', sort INTEGER DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, available_from TEXT, available_to TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL, description TEXT DEFAULT '', photo_url TEXT DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,          -- dine-in price, minor units (paise)
  takeaway_price INTEGER,                    -- optional takeaway/pickup price
  diet TEXT DEFAULT 'veg',                   -- veg | nonveg | egg | vegan
  available INTEGER NOT NULL DEFAULT 1,      -- shown on menu at all
  sold_out INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0, recommended INTEGER NOT NULL DEFAULT 0,
  available_from TEXT, available_to TEXT, available_days TEXT, -- schedule e.g. 07:00-11:30, days "1,2,3,4,5"
  station_id INTEGER REFERENCES stations(id) ON DELETE SET NULL,
  is_combo INTEGER NOT NULL DEFAULT 0, combo_items TEXT DEFAULT '',
  sort INTEGER DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS item_variants (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, name TEXT NOT NULL, price INTEGER NOT NULL, takeaway_price INTEGER, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS modifier_groups (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, name TEXT NOT NULL, min_select INTEGER DEFAULT 0, max_select INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS modifiers (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES modifier_groups(id) ON DELETE CASCADE, name TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0, sort INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY, name TEXT DEFAULT '', phone TEXT UNIQUE, email TEXT DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0, consent_at TEXT, preferences TEXT DEFAULT '', points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS loyalty_txns (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, order_id INTEGER, points INTEGER NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT DEFAULT '',
  type TEXT NOT NULL DEFAULT 'percent', value INTEGER NOT NULL DEFAULT 0, -- percent (whole number) or flat (paise)
  min_order INTEGER DEFAULT 0, max_discount INTEGER, max_uses INTEGER, used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id), number INTEGER NOT NULL,
  public_key TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'dine_in', -- dine_in | takeaway | pickup
  source TEXT NOT NULL DEFAULT 'pos',      -- pos | qr
  table_id INTEGER REFERENCES tables(id), customer_id INTEGER REFERENCES customers(id),
  customer_name TEXT DEFAULT '', customer_phone TEXT DEFAULT '', pickup_code TEXT,
  status TEXT NOT NULL DEFAULT 'open',     -- open | billed | paid | cancelled | merged
  subtotal INTEGER NOT NULL DEFAULT 0, discount_type TEXT, discount_value INTEGER DEFAULT 0,
  coupon_code TEXT, discount INTEGER NOT NULL DEFAULT 0, service_charge INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0, round_off INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0, refunded INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '', cancel_reason TEXT, created_by INTEGER REFERENCES users(id),
  geo_lat REAL, geo_lng REAL, geo_distance_m REAL, delayed_notified INTEGER NOT NULL DEFAULT 0,
  client_ref TEXT, invoice_no TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_branch_status ON orders(branch_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_ref ON orders(client_ref) WHERE client_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL, variant_id INTEGER, name TEXT NOT NULL, variant_name TEXT DEFAULT '',
  modifiers TEXT DEFAULT '[]', unit_price INTEGER NOT NULL, qty INTEGER NOT NULL DEFAULT 1, notes TEXT DEFAULT '',
  station_id INTEGER, kot INTEGER NOT NULL DEFAULT 1,
  kds_status TEXT NOT NULL DEFAULT 'new',  -- new | preparing | ready | served | cancelled
  added_by TEXT DEFAULT 'staff', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_oi_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_oi_kds ON order_items(kds_status);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'payment',    -- payment | refund
  method TEXT NOT NULL, amount INTEGER NOT NULL, reference TEXT DEFAULT '', note TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL, table_id INTEGER, order_id INTEGER,
  type TEXT NOT NULL, note TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL, customer_id INTEGER,
  rating INTEGER NOT NULL, comment TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT DEFAULT '', email TEXT DEFAULT '',
  guests INTEGER NOT NULL DEFAULT 2, date TEXT NOT NULL, time TEXT NOT NULL, table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'booked',   -- booked | arrived | seated | cancelled | no_show
  notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT DEFAULT '', guests INTEGER NOT NULL DEFAULT 2,
  quoted_minutes INTEGER DEFAULT 15, status TEXT NOT NULL DEFAULT 'waiting', -- waiting | seated | left | cancelled
  notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact_person TEXT DEFAULT '', phone TEXT DEFAULT '', email TEXT DEFAULT '',
  address TEXT DEFAULT '', gstin TEXT DEFAULT '', notes TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'ingredient', -- ingredient | packaging | supply
  unit TEXT NOT NULL DEFAULT 'g', cost_per_unit REAL NOT NULL DEFAULT 0, -- paise per unit
  low_stock_level REAL NOT NULL DEFAULT 0, preferred_supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS stock_locations (id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id), name TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY, ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES stock_locations(id), type TEXT NOT NULL, -- received | used | wasted | adjusted | count | transfer
  qty REAL NOT NULL, unit_cost REAL, batch_no TEXT, expiry_date TEXT, reference TEXT DEFAULT '', note TEXT DEFAULT '',
  user_id INTEGER, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sm_ing ON stock_movements(ingredient_id, location_id);
CREATE TABLE IF NOT EXISTS stock_counts (
  id INTEGER PRIMARY KEY, location_id INTEGER NOT NULL, lines TEXT NOT NULL, user_id INTEGER, note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS recipe_lines (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, variant_id INTEGER,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE, qty REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY, supplier_id INTEGER NOT NULL REFERENCES suppliers(id), branch_id INTEGER NOT NULL,
  location_id INTEGER REFERENCES stock_locations(id), status TEXT NOT NULL DEFAULT 'draft', -- draft | ordered | received | cancelled
  invoice_no TEXT DEFAULT '', invoice_amount INTEGER DEFAULT 0, amount_paid INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid', notes TEXT DEFAULT '', created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), received_at TEXT
);
CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id), qty REAL NOT NULL, unit_cost REAL NOT NULL DEFAULT 0,
  received_qty REAL NOT NULL DEFAULT 0, batch_no TEXT, expiry_date TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, branch_id INTEGER, audience TEXT NOT NULL DEFAULT 'staff', -- staff | kitchen | manager
  type TEXT NOT NULL, message TEXT NOT NULL, ref TEXT, is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY, channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT DEFAULT '', body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', error TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), sent_at TEXT
);
`;
db.exec(SCHEMA);

// ---------- Pixberry Signal (table cubes + counter display) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS signal_devices (
  id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id),
  kind TEXT NOT NULL DEFAULT 'cube',        -- cube | hub
  name TEXT DEFAULT '', table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
  key_hash TEXT NOT NULL UNIQUE,             -- sha256 of the device key; the key itself is shown once at pairing
  face TEXT NOT NULL DEFAULT 'rest',         -- face currently on top
  battery INTEGER, on_coaster INTEGER, rssi INTEGER, firmware TEXT DEFAULT '',
  last_seen TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS signal_staff (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  section_id INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  on_duty INTEGER NOT NULL DEFAULT 0, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sr_branch_status ON service_requests(branch_id, status);
`);
function addColumn(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addColumn('service_requests', 'source', "TEXT NOT NULL DEFAULT 'qr'"); // qr | cube | staff
addColumn('service_requests', 'device_id', 'INTEGER');
addColumn('service_requests', 'claimed_by', 'INTEGER');
addColumn('service_requests', 'claimed_at', 'TEXT');
addColumn('service_requests', 'resolved_by', 'INTEGER');
addColumn('service_requests', 'escalation', 'INTEGER NOT NULL DEFAULT 0'); // 0 none, 1 whole floor, 2 manager

function all(sql, ...p) { return db.prepare(sql).all(...p).map(plain); }
function get(sql, ...p) { const r = db.prepare(sql).get(...p); return r ? plain(r) : null; }
function run(sql, ...p) { const r = db.prepare(sql).run(...p); return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }; }
function plain(r) { return Object.assign({}, r); }

let depth = 0;
function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth--; }
}

// Insert / update with a column whitelist
function insert(table, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return run(`INSERT INTO ${table} DEFAULT VALUES`).id;
  return run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => norm(obj[k]))).id;
}
function update(table, id, obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return 0;
  return run(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => norm(obj[k])), id).changes;
}
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function tableNames() { return all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(r => r.name); }

module.exports = { db, all, get, run, tx, insert, update, tableNames, DB_FILE, DATA_DIR };
