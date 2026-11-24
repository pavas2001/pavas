# Pixberry Signal app (Android & iPhone)

A store app for the **staff app** (`/signal/app`). One phone or tablet can also be switched to the **counter display**. It opens your own Pixberry server, so it always shows the latest screens without an app update.

What the store app adds over the web app:
- **Lock-screen alerts** through Firebase Cloud Messaging: reliable on Android and on iPhone.
- **Keeps the counter display's screen on.**
- An app icon and a full-screen app, with no browser bars.

The web app at `/signal/app` still works without the store app. "Add to Home Screen" plus **Shift › Lock-screen alerts** gives lock-screen alerts on Android Chrome, and on iPhone (iOS 16.4 or later) when opened from the Home Screen.

## 1. Lock-screen alerts: Firebase (one time, free)

1. Create a project at <https://console.firebase.google.com>.
2. **Android:** add an Android app with package name `in.pixberry.signal`, and download `google-services.json`.
3. **iPhone:** add an iOS app with bundle ID `in.pixberry.signal`, download `GoogleService-Info.plist`, and upload your APNs key under *Project settings › Cloud Messaging*.
4. **Server:** *Project settings › Service accounts › Generate new private key*. Put the whole JSON file (or its base64) into the server's `FCM_SERVICE_ACCOUNT` environment variable.

Keep these files private. They are listed in `.gitignore`.

## 2. Build the Android app

**Easiest: on GitHub, no Android Studio needed**
1. In the repository settings, add the variable `PIXBERRY_URL` (your https address) and the secret `GOOGLE_SERVICES_JSON` (the file's contents).
2. Go to *Actions › Android app › Run workflow*.
3. Download `pixberry-signal-android`. It contains the `.apk` to install on phones.
4. For Google Play, also add the signing secrets listed at the top of `.github/workflows/android-app.yml` to get a signed `.aab`.

**On your computer** (needs Android Studio):
```bash
cd mobile
npm install
cp ~/Downloads/google-services.json android/app/
PIXBERRY_URL=https://pos.mycafe.in npm run android   # opens Android Studio; press Run
```

## 3. Build the iPhone app (needs a Mac with Xcode and an Apple Developer account)

```bash
cd mobile
npm install
PIXBERRY_URL=https://pos.mycafe.in npm run ios        # opens Xcode
```

In Xcode:
1. Drag `GoogleService-Info.plist` into *App/App*.
2. Under *Signing & Capabilities*, choose your team, then add **Push Notifications** and **Background Modes › Remote notifications**.
3. Archive the app, then upload it to TestFlight or the App Store.

## Counter display on a tablet

1. Install the app on the tablet and sign in.
2. Go to **Shift › Use as counter display**.
3. The tablet now opens straight to the display and keeps its screen on. **Staff app** in the display's top bar switches it back.
4. To stop anyone leaving the app, turn on Android's *App pinning* (Settings › Security). On iPad, use *Guided Access*.

For a Windows PC or mini-PC at the counter, use [`scripts/windows/signal-display.cmd`](../scripts/windows/signal-display.cmd) instead. It opens the display full screen in Edge or Chrome, and can be added to the Startup folder.
