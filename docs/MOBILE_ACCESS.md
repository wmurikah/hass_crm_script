# Mobile access fix (site would not load on phones)

**Symptom:** on mobile, the app URL showed Google's "Sorry, unable to open the
file at present" page. On desktop the app loaded.

## Cause

The app was reaching the browser through **cross-origin iframes**:

1. `docs/index.html` (GitHub Pages) embedded the Worker in a banner-cropping
   `<iframe>`.
2. The HtmlService page itself runs its sandbox and its `google.script.run` RPC
   on `*.script.googleusercontent.com`, and the Google **session cookie lives on
   that Google origin**.

Relative to the page the user was looking at, that Google session cookie was a
**third-party cookie**. Mobile browsers block third-party cookies by default
(iOS Safari ITP; Chrome on Android), so the embedded Google content could not
establish its session and Google served the "unable to open the file" page.
Desktop browsers still allow third-party cookies, so they kept working, which is
exactly the desktop-vs-mobile split that was reported.

## Diagnose (run these on the phone, in this order)

1. **Deployment access.** In **Manage deployments**, confirm **Who has access**
   is **Anyone**, not "Anyone with a Google account". The app has its own login,
   so anonymous reach to the login page is required. "Anyone with a Google
   account" alone blocks a phone not signed into Google. This is a setting, not
   code.
2. **Raw `/exec` test.** Open the raw `https://script.google.com/.../exec` URL
   directly on the phone (outside the Worker).
   - Raw `/exec` **also fails** on mobile  ->  cause is the deployment access in
     step 1 (fix the setting and redeploy; no code change helps).
   - Raw `/exec` **works** on mobile but the Worker URL did not  ->  cause is the
     cross-origin iframe / third-party cookies (the fix in this PR).
3. **Confirm the wrapper framed the app.** `docs/index.html` contained an
   `<iframe src="https://hass-cms-proxy.hasspe.workers.dev/">`, and the rendered
   HtmlService page nests a `script.googleusercontent.com` sandbox. That is the
   cross-origin embedding that needs the blocked third-party cookie.

## Fix (this PR)

Load the app **first-party** instead of embedding it cross-origin:

- `cloudflare-proxy/worker.js` now **302-redirects** to the GAS `/exec` URL
  (the `GAS_EXEC_URL` secret), preserving the query string, instead of
  reverse-proxying it.
- `docs/index.html` now does a **top-level redirect** to the Worker URL instead
  of embedding it in an iframe.

The browser ends up on Google's own origin, so the sandbox, `google.script.run`
and the session cookie are all first-party and no third-party cookie is needed.

**Unchanged:** the `/exec` URL, the deployment id, and `doGet`'s
`HtmlService.XFrameOptionsMode.ALLOWALL`. No application behaviour, route, or
handler changed.

**Trade-off:** a top-level `/exec` shows Google's "created by another user"
banner that the iframe used to crop. Loading on mobile takes priority. If the
banner must be hidden again, do it without a cross-origin iframe.

## Verify after deploying

- On Chrome (Android) and Safari (iOS), open the normal URL: the app loads and
  you can log in, with no Google Drive error.
- On desktop, the app still loads and works.
