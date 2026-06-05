# Project A — wrapper deployment for Hass CMS (two-project library pattern)

This folder holds the **wrapper project (Project A)**. It is a *separate* Apps
Script project from the repo's main code (which becomes **Project B**, the
library). The files here are **reference copies** — Project A is created and
edited in the Apps Script editor, not synced by the GitHub Assistant extension.

> **Why this is a subfolder, not the repo root:** the GitHub Assistant
> extension syncs `.gs`/`.html` from the repo **root** into Project B. If
> `Code.gs` lived at the root it would be pushed into B and collide with B's
> own `doGet`/`doPost`. Subfolders (`cloudflare-proxy/`, `project-a-wrapper/`,
> `docs/`) are ignored by the extension, so the wrapper stays isolated.

---

## Assumptions stated inline

- **Project B = this repo's current code, unchanged.** Its `doGet`, `doPost`,
  `processRequest`, `getLoginPage`, `getStaffDashboardPage`, `getMfaEnrollPage`,
  `getMfaVerifyPage`, `logoutUser` (in `30_router.gs` / `30_dispatcher.gs`) are
  already global functions, which is exactly what a library needs to expose.
- **The client uses `google.script.run`, not `fetch`/`doPost`,** for the whole
  JSON API (`google.script.run.processRequest(...)`) and for page swaps. This is
  the single most important constraint: `google.script.run` only reaches
  **top-level functions of the deployed project (A)** — never library symbols.
  That's why `Code.gs` re-exports each one. A "doGet/doPost-only" wrapper would
  break at the login screen.
- Exactly **one new deployment** (Project A) is created. Project B is **never**
  deployed as a web app.

---

## Step 1 — Create Project B (the library) from your existing code

You already have it: it's the project the GitHub Assistant extension syncs.
Nothing to deploy. Just grab its **Script ID**:

1. Open Project B in the Apps Script editor.
2. ⚙️ **Project Settings** (left rail) → **IDs** → copy **Script ID**.

> HEAD-mode libraries serve B's **saved** code. You do **not** need to publish a
> library version for HEAD mode — but see the caveat about edit access below.

## Step 2 — Create Project A (the wrapper)

1. https://script.google.com → **New project**. Name it `Hass CMS — Wrapper (A)`.
2. Replace the default `Code.gs` contents with **`Code.gs` from this folder**.
3. ⚙️ **Project Settings** → tick **“Show appsscript.json manifest file in
   editor.”** Open the now-visible `appsscript.json` and paste the manifest
   from this folder (it already lists the right OAuth scopes + the library
   dependency). Replace `REPLACE_WITH_PROJECT_B_SCRIPT_ID` with B's Script ID.

## Step 3 — Add Project B as a HEAD-mode library (editor clicks)

In **Project A**'s editor:

1. In the left rail, next to **Libraries**, click the **+** (Add a library).
2. Paste **Project B's Script ID** into the box → click **Look up**.
3. **Version** dropdown → select **`HEAD (Development mode)`**.
4. **Identifier** → set it to exactly **`HassCMS`** (must match `Code.gs`).
5. **Add**.

> If you pasted the `appsscript.json` from this folder, the library is already
> declared (`userSymbol: "HassCMS"`, `developmentMode: true`) and the panel will
> already show it — just confirm the identifier reads `HassCMS` and the version
> reads `HEAD`.

## Step 4 — Authorize & deploy Project A as a web app

1. In Project A, **Run ▸ `doGet`** once (or any function) to trigger the OAuth
   consent screen. Approve **all** requested scopes — these are B's scopes,
   surfaced through A. (This is the re-auth caveat below.)
2. **Deploy ▸ New deployment** → gear ▸ **Web app**.
   - **Description:** `A → HEAD(B) wrapper`
   - **Execute as:** **Me** (`USER_DEPLOYING`)
   - **Who has access:** **Anyone**
   - **Deploy**.
3. Copy the new **Web app URL** (`https://script.google.com/macros/s/AKfycb…/exec`).
   **This is Project A's `/exec`** — the value the Worker will point at.

## Step 5 — Point the Cloudflare Worker at A's `/exec`

The Worker reads the target from a **secret** (`env.GAS_EXEC_URL`), so there is
**no hardcoded line to edit** — you rotate the secret. From `cloudflare-proxy/`:

```bash
wrangler secret put GAS_EXEC_URL
# paste Project A's new https://script.google.com/macros/s/AKfycb…/exec
wrangler deploy   # only needed if you also changed worker.js; secret alone is live on next request
```

> If you genuinely want a single literal line instead of the secret, the one
> line in `worker.js` would be:
> `const target = env.GAS_EXEC_URL;`  →  `const target = "https://script.google.com/macros/s/AKfycb…/exec";`
> The secret is recommended (keeps the URL out of git). The **clean Cloudflare
> URL does not change** either way.

After this: edit Project B → **Save** → next request through the clean URL runs
the new code. No version bump, no redeploy, clean URL unchanged.

---

## Migration safety — do this on a COPY first, cut over last

Never point the production Worker at an unverified wrapper. Use a throwaway test
edge in front of the **same** Project A while you validate, then flip the one
production secret.

1. **Build A pointing at B as above, but don't touch production yet.** A's
   `/exec` is directly reachable; you can smoke-test it before any Worker change.
2. **Test A directly** (bypass Cloudflare): open
   `…/exec?page=login`, log in, exercise a few of your 50 tables and a couple of
   the 16 roles. Confirm `google.script.run` works (login, dashboard load, an
   API write). If login fails instantly, a `google.script.run` re-export is
   missing in `Code.gs`.
3. **Test the framed path on a test Worker/route:** deploy the Worker under a
   **temporary** route/subdomain (e.g. `app-staging.example.com`) with
   `GAS_EXEC_URL` = A's `/exec`, and temporarily point `docs/index.html`'s
   iframe `src` at that staging URL on a branch. Verify the banner is cropped
   and the app is fully usable inside the iframe.
4. **Cut over only after verifying:** set the **production** Worker's
   `GAS_EXEC_URL` secret to A's `/exec`. This is the single switch. The clean
   URL never changes, so GitHub Pages / bookmarks are untouched.
5. **Instant rollback:** if anything misbehaves, `wrangler secret put
   GAS_EXEC_URL` back to the **old** `/exec`. Production is restored on the next
   request. (Keep the old `/exec` URL written down for exactly this.)

> Optional extra safety: make a **copy of Project B** (`File ▸ Make a copy`) and
> bind a second test wrapper to the copy's HEAD, so your experiments can't touch
> live B's code at all until you're satisfied.

---

## Caveats (all apply to this setup)

- **HEAD mode needs A to have edit access to B.** Project A must be owned by /
  shared-as-editor with the same Google account that owns B (it is, if you build
  both). If A loses edit access to B, HEAD silently **falls back to B's last
  published library version** — so your "save B = live" promise quietly stops
  working. Keep both projects under one owner.
- **New OAuth scopes in B force re-authorization of A.** If you later add code to
  B that needs a scope not already in A's `appsscript.json`, the next call throws
  an auth error until you (a) add the scope to A's manifest and (b) re-run a
  function in A to re-consent. Adding scopes is the one change that breaks the
  "zero redeploys" promise — batch scope changes deliberately.
- **Library calls are slightly slower.** Every request crosses the A→B library
  boundary; expect a small per-request overhead vs. monolithic code.
- **No step-debugging into HEAD library code.** You cannot set breakpoints inside
  B from A's debugger when B is bound as a HEAD library. Debug B by opening B
  directly and running its functions there.
- **Keep the `google.script.run` surface stable.** Any new client-side
  `google.script.run.<fn>()` target requires a matching pass-through in A's
  `Code.gs`. The five (plus `logoutUser`) currently used are already wired.
