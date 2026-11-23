# Recon map: Scan2Order (web, mobile-first browser app)

Scope: **the core dine-in loop** — a guest scans a table QR, orders from a live menu,
the ticket hits a kitchen display, staff serve, the guest pays and gets a GST bill.
Plus the owner setup that loop needs: sign-up, venue, menu, tables/QR codes, staff roles.
Hotels, inventory, multi-property and the other Pro/Enterprise modules are listed but
deferred (`could`).
For: **to be confirmed with the user** (assumed: a product to sell to Indian
restaurants and cafés).
Date: 2026-11-23

> Evidence note: everything below comes from Scan2Order's **public** pages. The
> owner dashboard is behind a login and was **not** seen. Dashboard screens
> (S05–S17) are inferred from the features page, the pricing copy and the
> animated product demos on the home page, and are marked as inferred. A walk
> through the user's own account (or screenshots of it) would upgrade them.
> The Terms (s.9) contain no clause against building a competing product.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | marketing site / home | https://scan2order.co.in/ | Pitch, animated guest-menu, KDS and bill demos, 4-step flow, pricing, FAQ |
| 2 | features page | https://scan2order.co.in/features | The full feature list, in 6 groups — the most complete source |
| 3 | pricing (on home) | https://scan2order.co.in/ | Free / Starter ₹999 / Pro ₹2,499 / Enterprise custom; shows what's gated |
| 4 | about | https://scan2order.co.in/about | Positioning: India-first (GST, UPI, WhatsApp), Razorpay-direct, no lock-in |
| 5 | terms | https://scan2order.co.in/terms | Acceptable use; account closure deletes data after 14 days |
| 6 | sign in | https://app.scan2order.co.in/signin | Email + password, Google, forgot password |
| 7 | sign up | https://app.scan2order.co.in/signup | Name, email, password (8+), Google; "Register your restaurant" |
| 8 | help center | — | none found |
| 9 | changelog | — | none found |
| 10 | app store listing | — | none (browser-only; "no app to install") |
| 11 | walkthrough videos | — | none found; demo is by request ("Request a demo") |
| 12 | public API docs | — | none (webhooks are Enterprise-only) |
| 13 | user's own account | https://app.scan2order.co.in/ | not used yet — would confirm S05–S17 |

## Core loop

A guest scans the QR on their table, orders from their own phone with no app, the
order appears instantly on the kitchen screen, and the guest pays by UPI and gets a
GST bill on WhatsApp.

## Screens

Guest side (seen in public demos — high confidence):

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Guest menu | scan table QR → `/<venue>/t/<table>` (guess) | Browse and add items | venue header (logo, name, "Table 4 · Dine-in"), search, category tabs, item card (name, description, price, veg mark, "Bestseller" tag), ADD → − 1 + stepper, language switcher, sticky cart bar ("2 items · ₹340 · Place order →") | loading ("Loading menu…"), filled, item in cart, multi-language |
| S02 | Item options sheet | tap an item with variants | Pick variant / modifiers / combo, add a note ("less spicy") | bottom sheet, radio/checkbox groups, note field, qty stepper | inferred from "variants, modifiers & combos" and ticket notes |
| S03 | Order placed | after Place order | Confirm the order was sent | order number (#248), item count, total, "Sent straight to the kitchen", live status | placed; status NEW → PREPARING → READY (inferred) |
| S04 | Bill & pay | "Pay" / "Request bill" from the menu | Consolidated table bill, split, pay | line items, CGST/SGST rows, total, "Split 3 ways · ₹357 each", Pay with UPI (Razorpay), pay at counter | unpaid, split, paid ("Paid · UPI") |
| S04b | WhatsApp bill | guest's WhatsApp | Bill delivered off-app | message with total, payment method, "Download bill (PDF)" | sent, paid |

Staff/owner side (behind login — inferred unless noted):

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S05 | Sign in | `/signin` (seen) | Staff/owner log in | Google button, email, password with show/hide, forgot password, link to sign up, theme toggle | default (seen); error, loading inferred |
| S06 | Sign up | `/signup` (seen) | Owner registers a restaurant | Google button, name, email, password (8+ hint), legal links | default (seen) |
| S06b | Forgot password | `/forgot-password` (link seen) | Reset by email | email field | inferred |
| S07 | Onboarding / venue setup | after sign-up (inferred) | Venue name, address, GSTIN, tax mode (inclusive/exclusive), brand colour, subdomain, languages | stepper form | inferred |
| S08 | Kitchen display (KDS) | dashboard → Kitchen (seen in demo) | Live tickets by column | columns NEW / PREPARING / READY, ticket card (table/room/pickup code, #order, items with qty and notes, channel "via QR/Captain/Counter/In-room", age timer), Accept / Later, "LIVE · 7:42 PM", new-order alert toast | empty ("Waiting for orders…"), filled, new-order alert |
| S09 | Floor / tables | dashboard → Floor (inferred) | Live view of tables, drag-and-drop plan, zones | table tiles with status (free/ordering/served/bill due), zone tabs, edit mode | inferred |
| S10 | Table QR codes | dashboard → Tables (inferred) | Create tables, download/print a unique QR per table | table list, QR preview, print sheet | inferred |
| S11 | Menu editor | dashboard → Menu (inferred) | Categories, items, price, veg mark, tags, variants/modifiers, translations, sold-out toggle | category list, item form, translation tabs (EN/हिन्दी/ಕನ್ನಡ) | inferred |
| S12 | Orders list | dashboard → Orders (inferred) | All orders, filter by status/channel/date | table, filters, order detail drawer | inferred |
| S13 | Waiter (captain) app | dashboard on phone (inferred from "distraction-free mobile order-taking view") | Waiter places orders for a table | table picker, menu, send to kitchen | inferred |
| S14 | Billing / counter | dashboard → Billing (inferred) | Settle tables, take cash/UPI, print/send bill, refunds (manager approval) | bill view, payment method, split, refund request | inferred |
| S15 | Staff & roles | dashboard → Staff (inferred) | Invite staff as owner/manager/cashier/waiter/kitchen | staff list, role select, invite | inferred |
| S16 | Reports | dashboard → Analytics (inferred, Starter) | Sales, items, CSV export | charts, date range, export | inferred |
| S17 | Settings & billing | dashboard → Admin (Terms mention "Admin → Billing") | Venue, payments (Razorpay keys), WhatsApp, plan, close account | settings sections | inferred |

## Flows

```
F01 Guest orders from the table (the core loop)
    QR scan -> S01 menu -> (S02 options) -> S01 cart bar -> S03 order placed
    happy path clicks: 3 (ADD, ADD, Place order) for two simple items
    edge: item sold out mid-order, guest adds a second round later, two phones on
          one table, language switched mid-order, network drops on submit (no dupes)

F02 Kitchen handles a ticket
    S08 new-order alert -> Accept -> PREPARING -> READY -> waiter notified
    happy path clicks: 2 (Accept, Ready)
    edge: "Later" on a ticket, order edited or cancelled after accept, two
          stations (bar vs kitchen) splitting one order

F03 Guest pays and gets the bill
    S01 -> S04 bill -> (split) -> Pay with UPI -> paid -> S04b WhatsApp bill
    happy path clicks: 2 (View bill, Pay)
    edge: pay at counter instead, split unevenly, payment fails or is abandoned,
          one guest pays for the table, refund after payment

F04 Owner sets up a venue
    S06 sign up -> S07 venue setup -> S11 add menu -> S10 create tables & print QR
    -> S08 open kitchen screen
    happy path clicks: ~15–20 for one category, 5 items, 4 tables (estimate)
    edge: free plan's 10-table cap, GST inclusive vs exclusive, missing GSTIN

F05 Waiter takes an order for a guest
    S13 pick table -> menu -> send -> S08
    edge: guest also ordering by QR on the same table (one consolidated bill)

F06 Cashier settles a table at the counter
    S14 pick table -> bill -> cash/UPI -> close table -> bill on WhatsApp/email
    edge: refund needs manager approval, shift close with denomination count
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Button | primary (brand), secondary, ghost, danger, Google | default, hover, focus, disabled, loading | all |
| Text input / password | text, email, password with show/hide | default, focus, error, disabled | S05, S06, S07, S11 |
| Menu item card | simple, with image, tagged (Bestseller), sold out | not in cart, in cart (stepper) | S01, S13 |
| Qty stepper | ADD → − n + | 0, n, max | S01, S02, S13 |
| Veg / non-veg mark | veg, non-veg, egg (guess) | — | S01, S11, tickets |
| Category tabs | scrollable chips | active, inactive | S01, S11 |
| Sticky cart bar | items + total + CTA | hidden, visible, submitting | S01 |
| Bottom sheet | item options, language picker | open, closed | S01, S02 |
| Language switcher | EN / हिन्दी / ಕನ್ನಡ / தமிழ் | selected | S01 |
| Order ticket (KOT) card | dine-in (T4), room (R204), pickup (P31) | NEW, PREPARING, READY; timer; notes | S08, S12 |
| Kanban column | NEW / PREPARING / READY | empty, filled | S08 |
| Toast / alert | new order, staff action ("Chef Arjun started #248") | info, success, error | S08, dashboard |
| Bill summary | line items, CGST/SGST rows, total, split | unpaid, split, paid | S04, S14 |
| Table tile | free, occupied, bill due | — | S09 |
| QR card | table label + venue + "SCAN TO ORDER" | — | S10, printables |
| Data table | orders, staff, items | empty, loading, filled | S12, S15, S16 |
| Theme toggle | light / dark | — | S05, S06, dashboard |
| Status chip | NEW, PREPARING, READY, PAID, LIVE | — | S03, S08, S04 |

## Inferred data model

```
Venue        id, name, slug (subdomain), address, area, gstin, tax_mode (inclusive|exclusive),
             languages[], brand_color, wifi_ssid/password, plan (free|starter|pro|enterprise),
             razorpay_key (encrypted), whatsapp_config (encrypted)
             evidence: about ("own subdomain"), features (brand colour, Wi-Fi on menu), pricing
             confidence: high (fields), medium (shape)

User / Staff id, venue_id, name, email, password_hash | google_id,
             role (owner|manager|cashier|waiter|kitchen)
             evidence: S05, S06, features "role-based staff accounts"
             confidence: high

Zone         id, venue_id, name                              evidence: "table & zone/area management"  confidence: medium
Table        id, venue_id, zone_id, label (T4), qr_token, seats, pos_x, pos_y
             evidence: S01 header, floor plan, "unique QR on their table"   confidence: high

Category     id, venue_id, name, sort, translations(json)    evidence: S01 tabs   confidence: high
MenuItem     id, category_id, name, description, price, is_veg, tags[] (bestseller),
             image, available (sold-out), translations(json), station (kitchen|bar)
             evidence: S01 cards, "sold-out alerts", "bar & kitchen stations"   confidence: high
ModifierGroup / Modifier / Variant   id, item_id, name, price_delta, min/max
             evidence: "item variants, modifiers & combos"    confidence: medium

TableSession id, table_id, opened_at, closed_at, status (open|bill_requested|paid)
             evidence: "one consolidated bill" across several orders   confidence: medium (guess at the name)

Order        id, venue_id, session_id, number (#248), channel (qr|captain|counter|in_room|pickup|delivery),
             status (new|preparing|ready|served|cancelled), created_at, placed_by (guest|staff_id)
             evidence: KDS tickets "via QR / Captain / Counter / In-room", statuses   confidence: high
OrderItem    id, order_id, item_id, qty, unit_price, note ("less spicy"), modifiers(json)
             evidence: ticket lines with notes   confidence: high

Bill         id, session_id, subtotal, cgst, sgst, total, invoice_no, status (unpaid|paid|refunded)
             evidence: S04 CGST 2.5% / SGST 2.5%, "GST invoices"   confidence: high
Payment      id, bill_id, method (upi|card|cash), amount, razorpay_payment_id, status, split_index
             evidence: S04 split + Paid·UPI, Razorpay FAQ   confidence: high
Refund       id, payment_id, amount, requested_by, approved_by, status
             evidence: "manager-approval workflow for refunds"   confidence: medium

Guest        id, phone (WhatsApp), name, loyalty_points
             evidence: WhatsApp OTP login, loyalty points   confidence: medium
MessageLog   id, venue_id, channel (whatsapp|email), kind (bill|otp), billable, sent_at
             evidence: pricing allowances and per-message overage   confidence: medium
AuditLog     id, venue_id, user_id, action, at        evidence: Pro "audit log"   confidence: medium
```

Relationships: Venue 1-n Staff, Venue 1-n Zone 1-n Table, Venue 1-n Category 1-n MenuItem,
Table 1-n TableSession 1-n Order 1-n OrderItem, TableSession 1-1 Bill 1-n Payment 1-n Refund,
Guest 1-n Order (optional).

## Feature matrix

See `features.csv`. Must: 21, should: 16, could: 21, skip: 3.

## Out of scope (cannot or should not be cloned)

- The brand: the name "Scan2Order", its logo, its copy and its demo venue
  ("Spice Garden", "Chef Arjun") — replica-brand gives the clone its own.
- The "Powered by Scan2Order" footer and its customer base / reputation.
- Razorpay and the WhatsApp Business API are third parties: the clone integrates with
  them through their own official APIs and your own accounts, under their terms.
- WhatsApp message pricing and any template approvals are Meta's, not something to copy.

## Size

Screens 20 (5 guest incl. WhatsApp bill, 15 staff), flows 6, entities 16.
Hard parts:
1. **Realtime** — tickets on the KDS and status back to the guest within a second,
   across many phones per table, without duplicates on flaky mobile networks.
2. **Payments and GST billing** — Razorpay per venue (each restaurant's own account),
   split bills, refunds, correct CGST/SGST maths in inclusive and exclusive mode,
   sequential invoice numbers.
3. **WhatsApp delivery** — the Business API, approved templates, OTP login, and
   metering usage per plan.
Also: thermal KOT printing (browser → printer), multi-language menus.

Size: **M** (a few weeks) for the scoped core loop. The full product including
hotels, inventory, multi-property and SSO is **L–XL**: rescope before you build it.
