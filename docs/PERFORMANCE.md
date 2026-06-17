# Hass CMS - Performance layer

A transparent speed layer added on top of the existing app. It changes nothing
about what data is fetched, what `processRequest` returns, RBAC, sessions, or any
business result. It only changes WHEN the user sees data they have seen before
(instantly) and how many network round-trips a page costs.

Going live still needs the usual step: **New version then Deploy** in the Apps
Script UI (sync does not deploy). To activate the optional aggregate warmer
trigger, run `installAllTriggers()` once after deploying.

## The layers

| Layer | What | Where |
|---|---|---|
| 1. Stale-while-revalidate | Paint last-known data instantly from a per-user cache, refetch in the background, repaint only if it changed. | `js_perf.html` (`HassStore`, `API.swr`); wired into customers, orders, tickets, invoices, catalog. |
| 2. Predictive + hover prefetch | Warm the likely-next pages on idle and on nav hover/focus, never blocking user actions. | `js_perf.html` (`Prefetch`); registered in `Staffdashboard.html`. |
| 3. Optimistic writes | Update the UI immediately, save in the background, roll back cleanly on failure. | `js_perf.html` (`API.optimistic`); wired into `tickets.addComment`. |
| 4. One bundle call per page | Several reads in a single round-trip via `bundle.batch`, each sub-call gated exactly as on its own. | `40_svc_bundle.gs`, `API.batch` / `API.batchWarm`; catalog warms all tabs in one call. The dashboard already uses the `auth.me` init bundle. |
| 5. One Turso pipeline call | Independent sequential queries batched into a single `/v2/pipeline` request. | `customers.customer360` (5 reads collapse to 1 batch). The dashboard summary/charts/SLA already batch. |
| 6. Server reference cache | Rarely-changing reference data served from `CacheService`, invalidated on its admin write. | `branding.get` (+ bump on update), `catalog.listSegments` / `listDepots`. |
| 7. Precompute heavy aggregates | Dashboard summary/charts/SLA and PO/SO approval charts + leaderboard read a cached blob instead of grinding rows on every view. | `AggCache` in `10_cache.gs`; dashboard + approvals handlers; warmed by `precomputeAggregates()`. |

## Correctness and safety

- **Per-user namespacing.** Every client cache key is `hs1|<userId>|<sig>`. One
  user can never read another's cache. `HassStore.setUser()` purges the store if
  the owner changes (a different user on the same browser).
- **Cleared on logout / session loss.** The logout button, the `hass:logout`
  event, and any `NO_SESSION` / `SESSION_EXPIRED` refetch all clear the store.
- **Invalidated on writes.** Any non-read `API.call` invalidates the cache it
  could affect (a per-service related-set, falling back to a full clear). A
  failed write invalidates nothing (nothing changed server-side).
- **Always revalidate.** SWR serves stale instantly but always refetches; it
  repaints only when the new result differs. A refetch that returns
  `PERMISSION_DENIED` / `NOT_FOUND` evicts the entry, so a permission change can
  never keep showing now-forbidden data.
- **Server caches are scope-keyed, not user-keyed.** Aggregate blobs are pure
  functions of the country scope, so two users with the same scope share one
  entry. RBAC is enforced in each handler BEFORE the cache is consulted, so the
  cache never widens what a user may see.
- **Server invalidation.** Reference data bumps its namespace on write
  (`branding.update`). Dashboard aggregates are invalidated on every audited
  mutation (`Audit.log` -> `AggCache.onAudit`) and on any background job run, with
  a short TTL backstop. Approval aggregates are invalidated at the single write
  choke point (`OracleApprovalsLoader.loadFromRows`, used by upload, sync and
  webhook).
- **Sandbox storage.** `HassStore` feature-detects `localStorage`, falling back
  to `sessionStorage` then in-memory, so it degrades gracefully.

## Not changed

`processRequest`, the dispatcher, RBAC, session validation, `doGet` ALLOWALL, the
`/exec` URL, and the Cloudflare worker are untouched. Outputs are identical, only
delivered faster. No new dependencies, no em dashes, navy/gold brand and the
responsive shell preserved.
