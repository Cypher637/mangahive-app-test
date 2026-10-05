# Turning MangaHive into a real Android .apk

## What's in this zip
- `index.html` — the app, with two fixes baked in:
  - Its library storage now uses a real IndexedDB-backed store (it used
    to rely on `window.storage`, which only exists inside Claude.ai and
    would silently fail to save anywhere else).
  - It's wired up as a proper installable web app (manifest + service
    worker + icons).
- `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`,
  `icon-maskable-512.png` — the pieces that make it a real PWA.

I can't run the actual Android build here — that needs either a hosted
HTTPS URL or a full Android SDK/Gradle toolchain, and this sandbox has
no network access and can't install either. Here are your two realistic
paths, both of which end with a real, installable `.apk` you can side-load
or upload to the Play Store.

---

## Option A — PWABuilder (fastest, no coding)

1. **Host these files somewhere with HTTPS.** Any static host works —
   GitHub Pages, Netlify, Vercel, Cloudflare Pages, all have free tiers.
   Drag-and-drop the whole folder in (e.g. Netlify Drop:
   https://app.netlify.com/drop) and you'll get a URL like
   `https://your-app.netlify.app`.
2. Go to **https://www.pwabuilder.com**, paste that URL in, and click
   "Start".
3. PWABuilder will score your manifest/service worker (should pass, since
   they're already set up) — click **Package for stores → Android**.
4. It'll ask a few options (package name like `com.yourname.mangahive`,
   whether to sign now or later). Download the generated package — you'll
   get a signed `.apk`/`.aab` you can install directly on a phone
   (enable "install unknown apps" for your file manager/browser) or
   upload to the Play Console.

This produces a "Trusted Web Activity" — full-screen, no browser
address bar, your icon and splash screen — that loads your hosted site.
It behaves like a native app to the user, but does need that hosted URL
to keep working (it's not fully bundled offline).

## Option B — Capacitor (fully bundled, no hosting required, but needs local tools)

This bundles the HTML/JS/CSS directly inside the APK — nothing is
fetched from a server except the manga sources themselves (MangaDex, etc).
You'll need on your own machine: **Node.js**, **Android Studio** (with
the Android SDK it prompts you to install), and a JDK (Android Studio
bundles one).

```bash
mkdir fairs-library-app && cd fairs-library-app
npm init -y
npm install @capacitor/core @capacitor/android
npx cap init "MangaHive" "com.yourname.mangahive" --web-dir=www
mkdir www
# copy index.html, manifest.json, sw.js, vendor-supabase.js, the icon PNGs, and the
# src/ and config/ folders from this zip into www/ (index.html loads src/domain/*.js
# and src/services/*.js as separate scripts - without them the app will not start)
npx cap add android
npx cap open android
```

That last command opens the project in Android Studio. From there:
**Build → Generate Signed Bundle / APK**, walk through creating a
signing key (first time only), and Android Studio produces the `.apk`.

---

## Which should you pick?

- Want something installable **today** with the least effort → **Option A**.
- Want it to work fully offline with no dependency on a host staying up,
  or you're planning to add native device features later (camera, share
  sheet, etc.) → **Option B**.

Either way, the storage fix already in `index.html` is what makes your
library actually persist once it's out of Claude.ai — that part doesn't
depend on which path you pick.
