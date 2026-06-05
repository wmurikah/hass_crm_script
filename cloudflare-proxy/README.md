# GAS Web App Proxy (Cloudflare Worker)

A Cloudflare Worker that proxies the Google Apps Script (HtmlService) web app
behind a clean custom subdomain. It forwards GET/POST, follows the GAS `302`
redirect to `script.googleusercontent.com` server-side, and returns the final
rendered HTML to the browser.

## Deploy

Run these from the `cloudflare-proxy/` directory (requires the `wrangler` CLI):

```bash
# 1. Authenticate wrangler with your Cloudflare account.
wrangler login

# 2. Store the target GAS /exec URL as a secret (NOT committed to the repo).
#    Paste the https://script.google.com/macros/s/AKfycb..../exec URL when
#    prompted.
wrangler secret put GAS_EXEC_URL

# 3. Deploy the Worker.
wrangler deploy
```

Then bind your custom subdomain by uncommenting the route/`custom_domain`
block in `wrangler.toml` and redeploying.

## GAS deployment requirement

For the proxy to reach the web app, the Apps Script deployment must be
configured as:

- **Execute as:** Me
- **Who has access:** Anyone

Otherwise GAS will require an interactive Google login that the Worker cannot
satisfy, and the proxy will receive a login redirect instead of your page.

## Limitation: `google.script.run`

The proxy serves the initial page correctly (it follows the 302 and returns the
real HTML). However, `google.script.run` is not plain `fetch` — the HtmlService
client talks back to the original `*.script.googleusercontent.com` origin over
an internal iframe RPC channel, so those calls go straight to Google rather than
through this Worker and are not same-origin with your custom domain. See the
detailed comment block at the bottom of `worker.js`. If you need every server
call to be same-origin behind the custom domain, expose the server functions via
`doGet`/`doPost` as a JSON API and call them with `fetch()` against this proxy.
