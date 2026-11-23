# Pixberry Café: PHP edition on InfinityFree

This version runs on free PHP + MySQL hosting such as InfinityFree. It includes:
- **Guest QR menu:** photos, cart, notes, order status, and "call waiter" / "ask for bill" buttons.
- **Café distance check, enforced by the server:** orders from outside your radius are refused.
- **Back office:** kitchen screen, counter & bills (Cash / UPI / Card), menu with photo upload, table QR codes (printable), daily sales, setup and staff logins.

## 1. Create the database
InfinityFree **Control Panel → MySQL Databases** → create a database, e.g. `pixberry`.
Write down these four details shown on that page:
- **MySQL host name**, e.g. `sql123.infinityfree.com`
- **Database name**, e.g. `if0_12345678_pixberry`
- **MySQL username**, e.g. `if0_12345678`
- **Password**: your hosting account password (Control Panel → Account → *Show password*)

## 2. Upload the files
1. Control Panel → **Online File Manager** → open the **`htdocs`** folder. Delete the default `index2.html` if it's there.
2. Upload **pixberry-infinityfree.zip** into `htdocs`, then right-click it → **Extract**.
   Files like `admin.php`, `menu.php` and `api.php` must sit **directly in `htdocs`** (not in a subfolder).
   *If your file manager can't extract zips, unzip on your computer and upload the files with FileZilla (FTP details are in the Control Panel).*

## 3. Turn on HTTPS (required for location)
Control Panel → **Free SSL Certificates** → request one for your domain → follow the steps → **Install**.
Guests' phones only share their location on `https://` links, so the radius check won't work without this.

## 4. Run the installer
Open `https://yourdomain/install.php`, enter the four database details from step 1, your café name, the number of tables and an admin password → **Install**.
Then **delete `install.php`** in the File Manager.

## 5. Set up the café
Open `https://yourdomain/admin.php` and sign in.
1. **Setup:** stand inside the café → **Use my current location** → set the radius (100–150 m) → **Save setup** → **Test from where I am** (it should say *accepted*). Upload your logo and edit the welcome text.
2. **Menu:** add your dishes. After saving a dish, choose its photo.
3. **Tables & QR codes:** **Print QR codes** and put one on each table.
4. **Setup → Staff logins:** add your cashier and kitchen staff.
5. Test: scan a table QR **inside the café** and order. It appears on the **Kitchen** tab within ~8 seconds.

## Good to know (InfinityFree limits)
- The kitchen and counter screens refresh every 8 seconds, and only while the screen is visible. InfinityFree allows about 50,000 page hits a day, which is plenty for a café. Close the kitchen screen at night.
- Free hosting can be slow or briefly offline. For a busy café, move to paid hosting later; the same files work on any PHP 8.1+ hosting with MySQL.
- Back up: Control Panel → **MySQL Databases → phpMyAdmin → Export**.
