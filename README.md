# Pixberry ERP

Café management software: QR ordering from the table (only within a set distance of the café), point of sale and billing, a kitchen display, tables and floor, reservations and waiting list, inventory, recipes and food costing, suppliers and purchasing, staff and permissions, customers and loyalty, and reports.

It runs on Node.js with its built-in SQLite database, so there's no separate database server to install.

## Quick start

```bash
npm install
npm run seed      # optional: demo café with menu, tables, stock, suppliers & staff
npm start         # http://localhost:3000
```

| Screen | URL | Who uses it |
| --- | --- | --- |
| Back office (POS, tables, menu, stock, reports, settings…) | `/admin` | admin, manager, cashier |
| Kitchen display | `/kds` | kitchen, anyone with `kds.view` |
| Customer menu & ordering | `/order/<table QR token>` | guests, by scanning the table QR code |
| Digital receipt | `/r/<order key>` | guests and staff (print) |
| Signal counter display | `/signal` | the screen at the counter (any role that answers table requests) |
| Signal staff app | `/signal/app` | waiters and managers, on their phones ("Add to home screen") |

On the first start, the server creates the user **`admin`** and prints its password. You can also set it yourself with `ADMIN_PASSWORD=...`. The seed script adds the demo staff logins `manager`, `cashier` and `kitchen`, all with the password `pixberry123` (set `DEMO_PASSWORD` to change it).

Get the QR codes from **Tables & floor › Tables & QR codes**. "Print all QR codes" gives you a printable sheet.

## QR ordering is limited to a radius around the café

Customers can browse the menu from anywhere. They can only **place an order, add items, call a waiter or ask for the bill** while their phone is within the set radius of the café.

**Setting it up:** go to **Settings › 📍 Location & QR ordering**. Each branch has:

| Setting | Default | What it does |
| --- | --- | --- |
| Café latitude / longitude | — | Click the map, drag the pin, type the values, or stand in the café and press **Use my current location**. |
| Ordering radius (m) | 100 | How far from the café a guest can be and still order. |
| Require customers to be within the radius | on | Turn off to allow orders from anywhere. |
| GPS error allowance (m) | 30 | Extra distance forgiven, up to the phone's reported accuracy. This stops guests by the window or on weak indoor GPS being blocked. |
| Reject fixes less precise than (m) | 300 | Refuses very rough "approximate location" fixes, so a city-level position can't pass. |

**Test from where I am** shows whether an order from your current spot would be accepted or blocked.

**How the check works:**

1. When the menu page opens, it asks for the phone's location and sends it to `POST /api/public/t/:token/locate`. The server returns *inside*, *outside* (with the distance), *low accuracy*, or *not configured*. The guest sees a clear banner for each case, including what to do if location permission is turned off.
2. At checkout the page takes a **fresh** location fix (no cached position) and sends it with the order.
3. The **server re-checks it on every order and every service request**, using the haversine distance in `server/util.js › checkGeofence`. Outside the radius, it returns `403` with `{ geofence: { code, distance_m, radius_m } }` and creates nothing.
4. The café's exact coordinates are never sent to the customer's browser.
5. If a branch has the check turned on but no location saved yet, QR orders are **blocked** (fail closed). Staff orders on the POS are never location-checked.

**Limits:**
- Browsers only share location on **https** pages (or `localhost`). Put the app behind https and enter that address in **Settings › Café profile › Public URL**, because that address is what the QR codes point to.
- A determined user can fake GPS with developer tools or a spoofing app. The radius check stops casual remote and prank orders; it is not a guarantee. Rotating a table's QR code (**Regenerate QR**) makes old printouts stop working.

## Pixberry Signal: table cubes, counter display and staff app

Guests ask for something by flipping a **Signal Cube** on their table (Service, Bill, Water, Ready to order, To go, or Candle to rest), or from the QR menu page. Requests from both appear on:

- **Counter display** (`/signal`): requests oldest first with live timers, a light bar in the colour of the longest-waiting request, a floor map, who is on duty, cube battery and coaster health, and today's totals. A different chime plays for each request type. Switch between English and മലയാളം with one tap.
- **Staff app** (`/signal/app`): a phone web app for waiters. Go on duty, pick your zone (a floor section), and get a banner, vibration and chime for new requests in your zone. "On my way" claims a request, so the cube breathes and others see who's coming; "Done" finishes it. It also has a floor map with running bills, cube health, insights, and, for managers, cube pairing and display settings.

**Escalation:** a request nobody has claimed after 2 minutes is flagged *late* and the whole floor is notified. After 4 minutes the manager is notified. Change the timings in the staff app under **Shift**.

**Roles:** a new **Waiter** role can answer requests and take orders. Cashiers and managers can answer too (the `signal.respond` permission). Pairing cubes and changing display settings needs `tables.manage`.

### Connecting cubes

1. In the staff app, open **Cubes › Pair a new cube**, choose the table, and copy the key. It is shown only once.
2. The cube sends that key in an `X-Device-Key` header:

| Call | Body | When |
| --- | --- | --- |
| `POST /api/device/face` | `{ "face": "water", "battery": 80, "on_coaster": true }` | The cube has settled on a face for one second. `face`: `service`, `bill`, `water`, `order`, `togo` or `rest`. Flipping to another face replaces the cube's unanswered request; `rest` cancels it. |
| `POST /api/device/cancel` | `{}` | Two quick shakes |
| `POST /api/device/heartbeat` | `{ "battery": 80, "on_coaster": true, "rssi": -60, "firmware": "1.0.0" }` | Every few minutes |

Every call returns what the cube's light should do: `{ "light": "off" | "request" | "acknowledged" | "late" | "candle", "request": { "type", "acknowledged", "late" } | null, "evening_mode", "table" }`.

**No hardware yet?** `npm run seed` prints a demo key for each table's cube. Then:

```bash
npm run cube -- <key> water      # flip to Water
npm run cube -- <key> cancel     # shake to cancel
npm run cube -- <key> heartbeat 15 off   # report 15% battery, lifted off the coaster
```

Set `PIXBERRY_URL` if the server isn't on `http://localhost:3000`.

**Firmware:** the prototype cube firmware (ESP32-C3, accelerometer, LED ring) is in [`firmware/signal-cube`](firmware/signal-cube/README.md), with parts, wiring, flashing and setup steps.

## What's included

| Area | Features |
| --- | --- |
| **QR ordering** | A unique QR per table, plus a counter QR for takeaway and pickup. Table number shown. Categories, photos, descriptions, prices, diet marks, search, Popular and Chef's pick. Sizes, add-ons and options with required/min/max choices, and preparation notes. Cart saved on the phone. Several phones at one table add to the same order, with rounds sent as KOTs. Live order progress, call waiter, request bill, feedback and stars, digital receipt. Retried submits don't create duplicate orders. |
| **Menu** | Categories with time windows; items with dine-in and takeaway prices, sizes, add-on groups and combos; schedules (time and days); sold-out and available toggles; featured and recommended; kitchen stations; CSV/JSON import and export. |
| **POS & billing** | Dine-in, takeaway and pickup orders; add to an open table order; edit qty and notes; cancel items or whole orders (with a reason); transfer table; combine orders; split by item or equal shares; percent, flat or coupon discounts; loyalty redemption; GST inclusive or exclusive with CGST/SGST split; service charge; rounding; partial payments over cash, UPI, card or custom methods; change due; refunds; sequential invoice numbers; printable 80 mm, 58 mm or A4 bills; send the bill by WhatsApp, SMS or email; reprint any past bill. |
| **Kitchen display** | New, Preparing and Ready columns; live updates with a chime; filter by station; modifiers and notes; per-item or whole-ticket status; delayed tickets highlighted; Recall; served history (12 h). Guests and waiters are told when an order is ready. |
| **Tables & floor** | Sections; live floor (Available, Ordering, Occupied, Bill requested, Needs cleaning) with order totals and service-request alerts; combine and split tables; mark ready after payment; QR print sheet. |
| **Reservations & queue** | Bookings with guests, date, time and table; arrived, seated, cancelled or no-show; confirmations and reminders; walk-in waiting list with "table ready" notification. |
| **Inventory** | Ingredients, packaging and supplies; storage locations; stock received, used, wasted, adjusted or transferred; batches and expiry with an expiring-soon alert; low-stock alerts; automatic deduction from recipes on each sale (returned if an item is cancelled); stock counts with reconciliation; movement history. |
| **Recipes & costing** | Recipe per item or per size; cost per portion; food cost % against the price net of tax; margin; low-margin flag against a target you set; costs follow the latest purchase price. |
| **Suppliers & purchasing** | Supplier records; purchase orders (draft or ordered); "PO from low stock"; receive goods with quantities, prices, batches and expiry (updates stock and costs); supplier invoices and payment status; purchase history and price history per supplier; preferred supplier per item. |
| **Staff & permissions** | Accounts for admin, manager, cashier and kitchen; an editable role/permission matrix (for example, restrict discounts, cancellations and refunds); clock in and out; attendance with hours; shift roster; per-staff activity and audit trail. |
| **Customers & loyalty** | Contact details saved only with consent; order history and favourites; preferences; points earned per ₹100 and redeemed on the bill; coupons (percent or flat, minimum order, cap, uses, expiry); feedback and ratings; repeat and regular tags. |
| **Reports** | Today dashboard; sales by day, week or month; best and slow sellers; categories; order type and source (QR or POS); busy hours; average order; payment methods; discounts, refunds and cancellations; sales by staff; CSV exports (invoices, items, payments, daily tax summary). |
| **Notifications & messages** | In-app alerts for new orders, ready orders, delayed orders, low stock, refunds, waiter calls and bill requests. Outgoing WhatsApp, SMS and email go through a message queue to your provider's webhook (see below). |
| **Settings** | Café profile, logo, GSTIN; public URL; timezone; currency; opening hours and holidays (optionally blocking QR orders when closed); tax and service charge; payment types; bill design; status names; kitchen delay threshold; loyalty; messaging; multiple branches. |
| **Security & reliability** | scrypt password hashing; expiring sessions; sign-in throttling; role-based access on every API route; audit log of important changes; prices always recalculated on the server; idempotent order submits; automatic daily backup (`VACUUM INTO`) with retention; manual backup, download and full JSON export; offline queue for POS orders; service worker caching the app shell. |

## Connecting WhatsApp, SMS or email

In **Settings › Messaging**, turn a channel on and enter your provider's webhook URL and API token. Pixberry sends:

```http
POST <webhook_url>
Authorization: Bearer <token>
Content-Type: application/json

{ "channel": "whatsapp", "to": "+9198…", "subject": "Your receipt", "body": "Pixberry Café: thanks! Bill PB-2026-000042 …" }
```

This matches most WhatsApp Business API partners, SMS gateways and email relays, directly or through a small adapter. Until a channel is connected, messages appear as `skipped` under **Notifications & messages › Outgoing messages**.

## Configuration (environment variables)

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `PIXBERRY_DB` | `data/pixberry.db` | Database file |
| `PIXBERRY_BACKUP_DIR` | `backups/` | Where backups are written |
| `ADMIN_PASSWORD` | random, printed | Password for the first `admin` user |
| `TRUST_PROXY` | off | Set to `1` when running behind a reverse proxy (correct client IPs for rate limits) |
| `CAFE_LAT`, `CAFE_LNG` | Bengaluru | Café location used by `npm run seed` |

## Backups

- Automatic: once a day, kept for 14 days (change this in **Settings › Backup & data**).
- Manual: the **Back up now** button, or `npm run backup`.
- Restore: stop the server, then run `npm run restore -- backups/<file>.db`. The current database is kept as `*.before-restore-*`.

## Project layout

```
server/
  index.js        app, receipt page, live events (SSE), background jobs (delays, messages, backups)
  db.js           schema + helpers (node:sqlite)
  util.js         settings, geofence check, time zone, notifications, message queue
  auth.js         passwords, sessions, roles & permissions
  orders.js       order engine: pricing, tax/service/discounts, stock deduction, payments, loyalty
  crud.js         generic CRUD routes with field whitelists
  signal.js       Signal requests: cubes, claiming, escalation, floor/health/stats
  routes/         public (QR), system, menu, pos, floor, inventory, people, reports, signal (+ device API)
public/
  order/          customer ordering page (mobile)
  admin/          back office (views/*.js, one per section)
  kds/            kitchen display
  signal/         Signal counter display (index.html) and staff phone app (app.html)
scripts/          seed, backup, restore, cube-sim (Signal Cube simulator)
firmware/
  signal-cube/    ESP32-C3 firmware for the Signal Cube (PlatformIO)
test/             API + geofence tests (npm test)
```

Requires Node.js 22.13 or newer (it uses the built-in `node:sqlite` module).
