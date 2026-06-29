// Cloudflare Worker: first-party entry point for the Hass CMS Google Apps
// Script (GAS) HtmlService web app, behind a clean custom subdomain.
//
// WHY A REDIRECT (NOT AN IFRAME OR A REVERSE PROXY)
// -------------------------------------------------
// The app must reach the browser FIRST-PARTY. Whenever the GAS app is embedded
// in a cross-origin iframe, or reverse-proxied under this custom origin, the
// page that HtmlService renders still runs its sandbox and its
// google.script.run RPC channel on *.script.googleusercontent.com, and the
// Google session cookie is therefore a THIRD-PARTY cookie relative to the page
// the user is looking at.
//
// Mobile browsers block third-party cookies by default (iOS Safari ITP; Chrome
// on Android). With the cookie blocked, the embedded Google content cannot
// establish its session, so Google serves its "Sorry, unable to open the file
// at present" page. Desktop browsers, which still allow third-party cookies,
// kept working, which is exactly the reported symptom.
//
// Redirecting the browser to the /exec URL lands it directly on Google's own
// origin (script.google.com, then script.googleusercontent.com). The sandbox
// iframe, google.script.run and the session cookie are then all FIRST-PARTY, so
// there is no third-party-cookie dependency and the app loads on mobile.
//
// Unchanged: the /exec URL and the deployment id (the redirect target is still
// the GAS_EXEC_URL secret), and doGet keeps HtmlService.XFrameOptionsMode.ALLOWALL.
//
// Trade-off: a top-level visit to /exec shows Google's "created by another
// user" banner, which the old cross-origin iframe wrapper cropped. Loading on
// mobile takes priority over hiding that banner. If the banner must be hidden
// again, do it WITHOUT a cross-origin iframe (that would reintroduce this bug).
//
// GAS deployment requirement (operational, not code): the web app deployment
// must be "Execute as: Me" and "Who has access: Anyone". If it is "Anyone with
// a Google account", a mobile browser not signed into Google cannot reach even
// the raw /exec page, and this redirect cannot help. See README.md.

export default {
  /**
   * @param {Request} request  Incoming browser request.
   * @param {{ GAS_EXEC_URL?: string, GAS_BASE?: string }} env  Worker env.
   */
  async fetch(request, env) {
    // The target /exec URL is supplied as a Worker secret, never hardcoded.
    //   wrangler secret put GAS_EXEC_URL
    // GAS_BASE is accepted as an alias so an existing secret keeps working.
    const target = env.GAS_EXEC_URL || env.GAS_BASE;
    if (!target) {
      return new Response(
        'Proxy misconfigured: GAS_EXEC_URL secret is not set.',
        { status: 500 },
      );
    }

    const incoming = new URL(request.url);

    // Preserve GAS routing/query params verbatim (?page=login|staff|portal|...,
    // tokens, etc.) so a deep link still lands on the right page.
    const dest = new URL(target);
    dest.search = incoming.search;

    // First-party redirect. 302 for a normal browser navigation (GET/HEAD);
    // 307 for any other method so the method and body are preserved if some
    // caller ever POSTs to this entry point (webhooks normally hit /exec
    // directly, not this Worker).
    const status = (request.method === 'GET' || request.method === 'HEAD') ? 302 : 307;

    return new Response(null, {
      status,
      headers: {
        'Location': dest.toString(),
        // Do not cache the bounce, so changing the target later takes effect.
        'Cache-Control': 'no-store',
      },
    });
  },
};
