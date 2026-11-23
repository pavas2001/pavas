# Hosting Pixberry ERP on HTTPS

Customers' phones only share their location with **https** sites, so the QR ordering radius only works once Pixberry is on an https address.

Pick **one** option:

| | Option A — Railway (easiest) | Option B — Your own server (VPS) |
| --- | --- | --- |
| You need | A Railway account | A small Linux server and a domain name |
| HTTPS | Automatic | Automatic (Caddy + Let's Encrypt) |
| Effort | ~10 minutes, all in the browser | ~30 minutes, some terminal commands |
| Cost (approx.) | ~US$5/month | ~US$4–6/month server + domain |

Both options keep the database on a **persistent disk**, so orders and settings survive restarts and redeploys.

The repository includes a `Dockerfile`, which both options use. Railway's screens change from time to time, so menu names below may differ slightly.

---

## Option A — Railway

1. **Sign up** at https://railway.com and connect your GitHub account.
2. **New Project → Deploy from GitHub repo →** pick `pavas2001/pavas`.
   - The code is currently on branch `ccr-62f351d7-l486z8`. Either merge it into `main` first, or set that branch in the service's **Settings → Source / Branch**.
   - Railway finds the `Dockerfile` and builds it automatically.
3. **Add a volume** (this is your database disk): open the service → **Volumes / Add volume** → mount path **`/data`**.
   *Don't skip this step: without a volume, the database is wiped on every redeploy.*
4. **Variables** (service → Variables):
   | Name | Value |
   | --- | --- |
   | `ADMIN_PASSWORD` | a strong password for the `admin` login |
   | `PUBLIC_URL` | fill in after step 5, e.g. `https://pixberry-production.up.railway.app` |
5. **Get an https address**: service → **Settings → Networking → Generate Domain**. You get `https://<something>.up.railway.app` with HTTPS already on.
   - Put that address into `PUBLIC_URL` (step 4). Railway redeploys automatically.
   - **Your own domain** (e.g. `order.mycafe.in`): use **Custom Domain** in the same place and add the DNS record Railway shows at your domain registrar. Then change `PUBLIC_URL` to `https://order.mycafe.in`.
6. Open `https://<your address>/admin` and sign in as **`admin`** with your `ADMIN_PASSWORD`.

Then continue with **After it's live** below.

---

## Option B — Your own server (VPS) with automatic HTTPS

You need:
- A Linux server (Ubuntu 22.04/24.04), e.g. DigitalOcean, Hetzner, Lightsail or Linode, with ports **80 and 443** open.
- A domain or subdomain, e.g. `order.mycafe.in`.

1. **Point the domain at the server**: at your domain registrar, add an **A record**: `order` → your server's IP address. Wait a few minutes for it to take effect.
2. **Install Docker** on the server:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
3. **Get the code** onto the server:
   ```bash
   git clone -b ccr-62f351d7-l486z8 https://github.com/pavas2001/pavas.git pixberry
   cd pixberry/deploy
   ```
   (Or upload `pixberry-erp.zip`, unzip it, and `cd pixberry-erp/deploy`.)
4. **Start it** (use your domain and choose a strong password):
   ```bash
   DOMAIN=order.mycafe.in ADMIN_PASSWORD='choose-a-strong-password' docker compose up -d --build
   ```
   Caddy gets a free Let's Encrypt certificate automatically and renews it. After about a minute, `https://order.mycafe.in/admin` is live.
5. **Updating later**:
   ```bash
   cd pixberry && git pull && cd deploy && DOMAIN=order.mycafe.in docker compose up -d --build
   ```
6. **Logs**: `docker compose logs -f app`

The database and backups are kept in the Docker volume `pixberry-data`. It survives restarts and rebuilds.

---

## After it's live (both options)

1. **Sign in** at `/admin` → click your name (top right) → **change the admin password**.
2. **Settings › Café profile**: fill in your café's details. Check that **Public URL** is your https address (leave it blank to use `PUBLIC_URL`).
3. **Settings › 📍 Location & QR ordering**: stand inside the café on your phone, open the admin page, press **Use my current location** → **Save**. Choose a radius (50–150 m is typical). Press **Test from where I am**: it should say *accepted*.
4. **Menu**: add your categories and items, or `Import` a CSV.
5. **Tables & floor › Tables & QR codes**: add your tables, then **Print all QR codes**. *Print them only after step 2*, because the QR codes contain the public address.
6. **Staff & attendance**: create logins for your manager, cashiers and kitchen.
7. Scan a table QR with your phone **inside the café** and place a test order. It should appear on `/kds`.

Want demo data instead of an empty café? Run `npm run seed` once on the host:
- Railway: the service's shell / "Run command".
- VPS: `docker compose exec app npm run seed`

## Backups

- Automatic daily backups are written to `/data/backups` (on the persistent disk) and kept for 14 days.
- Download a copy now and then from **Settings › Backup & data**, so you have one off the server too.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Customers see "Location needs a secure (https) link" | They opened an `http://` address. Check `PUBLIC_URL` / Settings › Public URL, then reprint the QR codes. |
| Everyone is "outside the radius" | The café location isn't set or is wrong: redo step 3 above while standing in the café. |
| Guests inside are sometimes blocked | Increase the radius a little, or raise "GPS error allowance". |
| Data disappeared after a redeploy (Railway) | The volume wasn't mounted at `/data`: see Option A, step 3. |
| Certificate error on the VPS | The domain's A record must point at the server, and ports 80/443 must be open. Check `docker compose logs caddy`. |
