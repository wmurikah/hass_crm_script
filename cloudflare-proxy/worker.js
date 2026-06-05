// Cloudflare Worker: reverse proxy for a Google Apps Script (GAS) HtmlService
// web app, exposing it behind a clean custom subdomain.
//
// Why a server-side proxy is needed:
//   A GET to the GAS /exec endpoint does NOT return HTML directly. It returns a
//   302 redirect to a one-time script.googleusercontent.com URL that actually
//   holds the rendered page. A browser cannot follow that redirect across
//   origins inside the proxied context, so we must follow it *here*, on the
//   server, and stream back the FINAL response body.

export default {
  /**
   * @param {Request} request  Incoming browser request.
   * @param {{ GAS_EXEC_URL: string }} env  Worker env; GAS_EXEC_URL is a secret.
   */
  async fetch(request, env) {
    // The target /exec URL is supplied as a Worker secret, never hardcoded.
    // Set it with: wrangler secret put GAS_EXEC_URL
    const target = env.GAS_EXEC_URL;
    if (!target) {
      return new Response(
        'Proxy misconfigured: GAS_EXEC_URL secret is not set.',
        { status: 500 },
      );
    }

    const incoming = new URL(request.url);

    // --- CORS preflight ----------------------------------------------------
    // If the browser issues an OPTIONS preflight (e.g. for a cross-origin
    // fetch against this proxy), answer it directly. For same-origin use this
    // is never hit, but it keeps simple cross-origin callers working.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    // --- Build the upstream URL -------------------------------------------
    // Forward the query string verbatim so GAS routing (?page=..., tokens,
    // google.script.run plumbing parameters, etc.) is preserved.
    const upstreamUrl = new URL(target);
    upstreamUrl.search = incoming.search;

    // --- Forward request headers ------------------------------------------
    // Copy the client's headers but drop Host so fetch sets it correctly for
    // script.google.com. We also strip hop-by-hop / CF-specific headers that
    // should not be re-sent upstream.
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.delete('host');
    fwdHeaders.delete('cf-connecting-ip');
    fwdHeaders.delete('cf-ipcountry');
    fwdHeaders.delete('cf-ray');
    fwdHeaders.delete('cf-visitor');
    fwdHeaders.delete('x-forwarded-host');

    // --- Forward method + body --------------------------------------------
    // GET/HEAD have no body; everything else (POST) streams its body through.
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

    const upstreamRequest = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers: fwdHeaders,
      body: hasBody ? request.body : undefined,
      // Follow GAS's 302 to script.googleusercontent.com server-side so the
      // browser receives the real, rendered HTML instead of a redirect it
      // cannot complete cross-origin.
      redirect: 'follow',
    });

    // --- Fetch upstream and relay the FINAL response ----------------------
    const upstreamResponse = await fetch(upstreamRequest);

    // Preserve the upstream Content-Type (text/html, application/json, ...)
    // and status. We copy headers but drop framing/security headers that would
    // either be wrong for our origin or block embedding.
    const respHeaders = new Headers(upstreamResponse.headers);
    respHeaders.delete('content-security-policy');
    respHeaders.delete('content-security-policy-report-only');
    respHeaders.delete('x-frame-options');
    // Let the runtime recompute transfer/encoding framing for our response.
    respHeaders.delete('content-encoding');
    respHeaders.delete('content-length');
    respHeaders.delete('transfer-encoding');

    // Permit cross-origin callers (harmless for same-origin custom-domain use).
    for (const [k, v] of Object.entries(corsHeaders(request))) {
      respHeaders.set(k, v);
    }

    // Return the body UNCHANGED so the rendered HTML reaches the browser as-is.
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: respHeaders,
    });
  },
};

// Build permissive CORS headers, echoing the caller's Origin so credentialed
// requests are allowed when present.
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      request.headers.get('Access-Control-Request-Headers') || 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

// ---------------------------------------------------------------------------
// LIMITATION — google.script.run callbacks
// ---------------------------------------------------------------------------
// This proxy faithfully serves the initial page: it follows the 302 and
// returns the final HTML, so the app renders behind the custom subdomain.
//
// However, google.script.run is NOT plain fetch. The HtmlService client runs
// inside a sandboxed iframe whose contents are served from
// *.script.googleusercontent.com, and google.script.run talks back to that
// SAME googleusercontent origin using an internal postMessage/iframe RPC
// channel — not to our /exec URL. Those calls therefore go directly to Google,
// not through this Worker, and cannot be transparently rewritten to be
// same-origin with the custom subdomain by a simple reverse proxy.
//
// Practical consequences:
//   * Page load, navigation, and any doGet/doPost form posts routed through
//     /exec work through this proxy.
//   * google.script.run.<func>() calls continue to hit Google directly. They
//     generally keep working (the iframe holds an absolute googleusercontent
//     URL), but they are NOT same-origin with your custom domain and are not
//     proxied here.
//
// If you need every server call to be same-origin behind the custom domain,
// expose your server functions through doGet/doPost (a JSON API) and have the
// client call them via fetch() against this proxy, instead of relying on
// google.script.run. That application-level change is intentionally out of
// scope for this proxy.
