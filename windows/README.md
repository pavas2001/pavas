# Pixberry for Windows

A Windows installer for running Pixberry **on the café's own PC** — the "install it in the
customer's PC/laptop and host it from there" setup — instead of on a cloud server.

It installs:
- the app, with its own private copy of Node.js (nothing else to install);
- it as a **Windows service** called "Pixberry", set to start automatically when the PC turns
  on and to restart itself if it ever crashes — nobody has to open an app or sign in to Windows;
- a **Scheduled Task** that runs every 15 minutes. It does nothing while the café is open. The
  first time it notices the café is closed for the day (from the opening hours set in Pixberry's
  own Settings) it makes an extra backup, and — only if you chose this during setup — shuts the PC
  down a minute later. Because the PC is meant to be switched off outside opening hours, this in
  practice only ever runs once a day, right at closing;
- a Windows Firewall rule so the counter display, staff phones and Signal Cubes on the café's own
  Wi-Fi can reach it.

The database and backups are kept in `%ProgramData%\Pixberry`, separate from the program files, so
reinstalling or upgrading never touches them.

## Get the installer

**Easiest:** on GitHub, go to **Actions › Windows installer › Run workflow**, then download
`pixberry-windows-installer` from the finished run. It contains `PixberrySetup.exe`.

Nothing to configure — it has no required secrets.

## Install it on the café PC

1. Copy `PixberrySetup.exe` to the PC and run it. It asks Windows for permission (it needs to
   install a service).
2. Set the **admin password** — this is only used the very first time Pixberry starts; change it
   later from Settings once signed in.
3. Choose whether the PC should **shut itself down automatically after closing**. Off by default:
   Pixberry always backs up at closing either way, but turning the PC off is something only you
   should decide to turn on.
4. When it finishes, it opens `http://localhost:3000/admin` in your browser. Sign in and set up
   the café: name, opening hours, menu, tables, and staff accounts. Opening hours matter here —
   they're what the closing-time task and the Signal Cube's overnight sleep go by.

> **First-run setup only.** Don't run `npm run seed` on this install; that's for development, and
> would add a demo café. The installer gives you a clean one.

## Give it an https address

A PC on the café's own network is enough for the counter display, cubes and a POS terminal, but
staff phones, lock-screen alerts and the QR ordering location check all need **https** — the
café's own local address (`http://192.168.x.x:3000`) isn't enough for those. The simplest free way
to add that without touching the café's router is a **Cloudflare Tunnel**, which also means you
never need to forward a port or have a public IP address (many Indian broadband/mobile
connections don't give you one anyway).

1. Add the café's domain to a free Cloudflare account (or buy one through Cloudflare).
2. Install `cloudflared` on the same PC: <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/>.
3. In the Cloudflare dashboard, under **Zero Trust › Networks › Tunnels**, create a tunnel and add
   a **public hostname** (for example `pos.yourcafe.in`) that points at `http://localhost:3000`.
   Cloudflare gives you a one-line command to run `cloudflared` with that tunnel's token.
4. Install that as a Windows service too, so it also starts automatically:
   ```
   cloudflared service install <token>
   ```
5. In Pixberry, go to **Settings › Café profile** and set **Public URL** to `https://pos.yourcafe.in`.
   The QR codes on your tables use this address, so print them (or reprint if you already did)
   after setting it.

Cloudflare Tunnel is free for this. You only pay for the domain itself (bought from any registrar).

## What to check if something's wrong

- **Service logs:** `%ProgramData%\Pixberry\logs\service.log` (also reachable from the Start Menu
  shortcut "Pixberry status / logs").
- **Is the service running?** Open *Services* (`services.msc`) and look for "Pixberry". Or run
  `sc query Pixberry` in an elevated Command Prompt.
- **Is it reachable?** Visit `http://localhost:3000/healthz` on the café PC — it should say
  `{"ok":true}`.
- **Scheduled Task:** Task Scheduler › Task Scheduler Library › "Pixberry Closing Watch". Run it by
  hand to test it (right-click › Run); check `%ProgramData%\Pixberry\logs` or the task's *History*
  tab for what it did.
- **Windows Defender SmartScreen** may warn on first run, because this installer isn't
  code-signed yet. Choose "More info" › "Run anyway". A proper code-signing certificate removes
  that warning — worth getting once you're installing this at more than a handful of cafés.

## Reinstalling, updating, uninstalling

- Running `PixberrySetup.exe` again (a newer build) reinstalls the app files and service, and
  **keeps** your database and backups.
- Uninstalling (Settings › Apps, or the Start Menu shortcut) removes the service, the scheduled
  task and the firewall rule, but — the installer tells you this, and it's true — **does not**
  delete `%ProgramData%\Pixberry`. Remove that folder yourself if you really want to erase the
  café's data.

## Advanced: installing by hand, without the prebuilt installer

If you'd rather not wait for or trust a prebuilt `.exe`, every step it automates can be done by
hand with ordinary Windows tools:

```powershell
# 1. Install Node.js 22.13+ from nodejs.org (or unzip the official Windows build anywhere).
# 2. Get the app code and its dependencies onto the PC (e.g. git clone this repo, or copy it over):
cd C:\Pixberry
npm ci --omit=dev

# 3. Write the config Pixberry reads instead of environment variables:
mkdir C:\ProgramData\Pixberry\data, C:\ProgramData\Pixberry\backups
@'
{
  "ADMIN_PASSWORD": "choose-one-here",
  "PIXBERRY_DB": "C:\\ProgramData\\Pixberry\\data\\pixberry.db",
  "PIXBERRY_BACKUP_DIR": "C:\\ProgramData\\Pixberry\\backups",
  "PORT": "3000"
}
'@ | Out-File -Encoding utf8 C:\ProgramData\Pixberry\config.json

# 4. Register it as a service with NSSM (https://nssm.cc) so it survives reboots:
nssm install Pixberry "C:\Program Files\nodejs\node.exe" "C:\Pixberry\scripts\run-with-config.js"
nssm set Pixberry AppDirectory "C:\Pixberry"
nssm set Pixberry Start SERVICE_AUTO_START
nssm set Pixberry AppExit Default Restart
nssm start Pixberry

# 5. The closing-time task, every 15 minutes. /tr must be one quoted argument, so the node.exe
#    and .js paths are quoted again inside it:
schtasks /create /tn "Pixberry Closing Watch" /tr "\"C:\Program Files\nodejs\node.exe\" \"C:\Pixberry\scripts\closing-watch.js\"" /sc minute /mo 15 /ru SYSTEM /rl highest /f
# (append --shutdown after closing-watch.js\" if you also want it to turn the PC off)

# 6. Let other devices on the café Wi-Fi reach it:
netsh advfirewall firewall add rule name="Pixberry ERP" dir=in action=allow protocol=TCP localport=3000
```

`scripts/closing-watch.js` and `scripts/run-with-config.js` are the same scripts the installer
uses — see their comments for exactly what each does.
