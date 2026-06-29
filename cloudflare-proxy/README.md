# GAS Web App Entry (Cloudflare Worker)

A Cloudflare Worker that gives the Google Apps Script (HtmlService) web app a
clean custom subdomain. It **redirects** the browser to the GAS `/exec`
endpoint (preserving the query string) so the app loads **first-party** on
Google's own origin.

It used to reverse-proxy / be framed cross-origin. That broke on mobile (see
below), so it now redirects.

## Why a redirect, not an iframe or a reverse proxy

When the GAS app is embedded in a cross-origin `<iframe>`, or reverse-proxied
under this custom origin, the HtmlService page still runs its sandbox and its
`google.script.run` channel on `*.script.googleusercontent.com`, so the Google
session cookie is a **third-party** cookie relative to the page the user sees.

Mobile browsers block third-party cookies by default (iOS Safari ITP; Chrome on
Android), so the embedded Google content cannot establish its session and
Google serves **"Sorry, unable to open the file at present"**. Desktop, which
still allows third-party cookies, kept working.

Redirecting to `/exec` lands the browser on Google's origin top-level, so the
sandbox, `google.script.run` and the session cookie are all first-party. No
third-party-cookie dependency, so it loads on mobile.

**Trade-off:** a direct visit to `/exec` shows Google's "created by another
user" banner, which the old iframe cropped. Loading on mobile takes priority. If
the banner must be hidden again, do it WITHOUT a cross-origin iframe (that would
reintroduce the bug).

## GAS deployment requirement (operational, check this FIRST)

The web app deployment must be configured, in **Manage deployments**, as:

- **Execute as:** Me
- **Who has access:** **Anyone**

If it is **"Anyone with a Google account"**, a mobile browser not signed into
Google cannot reach even the raw `/exec` page, and no Worker change can fix
that. The app has its own login, so anonymous reach to the login page is
correct and required. This is a setting, not code; fix it and redeploy.

How to tell which one you have: open the **raw** `https://script.google.com/.../exec`
URL directly on the phone (outside this Worker). If the raw `/exec` ALSO fails
on mobile, the cause is the deployment access above. If the raw `/exec` works on
mobile but the Worker URL did not, the cause was the iframe / third-party
cookies that this redirect fixes.

## Deploy

Run from the `cloudflare-proxy/` directory (requires the `wrangler` CLI):

```bash
# 1. Authenticate wrangler with your Cloudflare account.
wrangler login

# 2. Store the target GAS /exec URL as a secret (NOT committed to the repo).
#    Paste the https://script.google.com/macros/s/AKfycb..../exec URL when
#    prompted. The /exec URL and deployment id do not change.
wrangler secret put GAS_EXEC_URL

# 3. Deploy the Worker.
wrangler deploy
```

Then bind your custom subdomain by uncommenting the route / `custom_domain`
block in `wrangler.toml` and redeploying.

## google.script.run

Because the browser now lands on Google's own origin, `google.script.run` is
first-party again and works normally, with no proxy limitations. (The earlier
reverse-proxy could not make `google.script.run` same-origin with the custom
domain; that limitation is gone with the redirect.)
