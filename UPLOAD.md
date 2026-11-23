# Uploading Pixberry ERP to your hosting

Your hosting must support **Node.js 22.13 or newer**: look for **"Setup Node.js App"** in cPanel, "Node.js" in Hostinger hPanel or Plesk, or use any VPS.
Pixberry stores its data in its own built-in database file, so **you don't need to connect your MySQL/MariaDB database**. Leave it unused.

## Full app (pixberry-erp-upload.zip)

1. In File Manager, create a folder **outside** `public_html`, e.g. `/home/<you>/pixberry`, and upload **pixberry-erp-upload.zip** there. Extract it, then move the contents of the extracted `pixberry-erp` folder up into `/home/<you>/pixberry` (so `app.js` sits directly in that folder).
2. **Setup Node.js App → Create application**:
   - Node.js version: **22.x** (22.13+)
   - Application mode: Production
   - Application root: `pixberry`
   - Application URL: your domain (e.g. `order.mycafe.in`)
   - Application startup file: **`app.js`**
3. Add **environment variables** in the same screen:
   - `ADMIN_PASSWORD` = a strong password for the `admin` login
   - `PUBLIC_URL` = `https://your-domain` (exactly the address customers will use)
   - `TRUST_PROXY` = `1`
   - `PIXBERRY_DATA_DIR` = `/home/<you>/pixberry-data` (keeps your data outside the app folder, so updates never overwrite it)
4. Press **Run NPM Install**, then **Start/Restart** the app.
5. Turn on **SSL** for the domain (cPanel → SSL/TLS Status → Run AutoSSL, or "Let's Encrypt"). Guests' phones only share location on **https**.
6. Open `https://your-domain/admin`, sign in as **admin**, and change the password (click your name, top right).
7. Optional demo data: in the Node.js app screen, run the `seed` script (or `npm run seed` in Terminal, inside the app folder, with the app's environment activated).

Then follow "After it's live" in DEPLOY.md: set the café location from inside the café, add your menu and tables, and print the QR codes.

**Updating later:** upload the new zip, replace the files in the app folder (your data in `pixberry-data` isn't touched), Run NPM Install, Restart.

## Preview only (pixberry-preview/index.html)

A single page that works on **any** hosting, even plain PHP hosting with no Node.js.
Upload `index.html` into `public_html/preview/` and open `https://your-domain/preview/`.
Settings and orders stay in that browser, and nothing is sent to a kitchen or server. Real ordering needs the full app above, because only the server can enforce the distance check.
