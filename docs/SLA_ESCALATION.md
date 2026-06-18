# SLA and ticket escalation (agent task 2 of 4)

This change points the SLA handlers at the real database model, starts the SLA
clock when a ticket is created, runs the breach sweep on its trigger, makes
escalation actually reassign and notify, repoints the SLA Config page at the
registered actions, and fixes ticket comment persistence. It reuses the step 1
notification emit path (`Notify.emit`) and adds no second notifier.

## 1. Introspection results

The SLA tables the old code named do not exist. The real model was confirmed by
introspection (`PRAGMA table_info`) and by three independent live-proven
readers already in the codebase. A read only helper, `reportSlaSchema()` in
`40_svc_sla.gs`, dumps the live schema from the Apps Script IDE so the result is
reproducible:

```js
// Run from the Apps Script editor (function picker -> reportSlaSchema -> Run),
// then read View > Logs. Returns and logs:
{
  sla_config:      [...columns...],
  tickets:         [...columns...],
  ticket_comments: [...columns...],
  sla_policies_exists: false,
  sla_breaches_exists: false,
  resolved_sla_columns: { id, priority, response, resolve, ... }
}
```

Confirmed model:

| Table | Real columns used here | Source of truth |
|---|---|---|
| `sla_config` (PK `sla_id`) | `priority`, `response_minutes`, `resolve_minutes` (plus optional `name`, `is_active`, `country_code`) | working dashboard read `40_svc_dashboard.gs:_dashSlaCompute_`; `00_constants.gs` PK map |
| `tickets` | deadlines `sla_response_by`, `sla_resolve_by`; flags `sla_response_breached`, `sla_resolve_breached` | dashboard SLA compute + the existing sweep filter |
| `ticket_comments` (PK `comment_id`) | `author_type`, `author_id`, `author_name`, `is_internal`, `is_resolution`, `content`, `created_at` | the working `addComment` write and the ticket UI which renders `c.author_id` |

There is no `sla_policies` table, no `sla_breaches` table, and no `entity_type`
column on `sla_config`. Thresholds are keyed on `priority` (optionally per
country). A breach is recorded as a flag on the ticket, not in a side table.

The old service disagreed with itself: `listPolicies` read `resolve_minutes`
while `createPolicy` wrote `resolution_minutes` to the non existent
`sla_policies`. The new code resolves the real column name once through
`SchemaIntrospect` (`_slaCols_`), so read and write always agree. The canonical
column is `resolve_minutes`; a legacy `resolution_minutes` spelling is tolerated
on read only, so there is no split.

## 2. SLA model change (SLA-1, SLA-4)

`40_svc_sla.gs` was rewritten to operate on `sla_config` and the ticket flags:

- `listPolicies` selects the real columns (aliased to canonical names), country
  scoped.
- `createPolicy` inserts into `sla_config` (adaptive column list), and upserts by
  priority + country so repeated admin saves never duplicate a row.
- `updatePolicy` updates `sla_config` by `sla_id`, mapping logical fields to the
  real physical columns.
- `checkEntity` flags the breach on the entity itself (`sla_*_breached`), never a
  side table.
- `listBreaches` reads the ticket flags (unchanged model, now returns the
  deadline columns too).
- Every reference to `sla_policies` / `sla_breaches` was removed, including the
  `system.dbStats` table list.

## 3. Deadline stamping at create (TKT-1)

`tickets.create` now matches the `sla_config` policy by priority + country
(shared helper `_slaComputeDeadlines_`) and stamps `sla_response_by` /
`sla_resolve_by`. No matching policy leaves them null without crashing. This is
the linchpin: without a stamped deadline the sweep can never flag a breach.

## 4. Breach sweep wiring (SLA-2)

- `runSlaBreachSweep()` now enqueues a deduped `SLA_BREACH_SWEEP` job and drains
  the queue (it previously only called `runJobs()` and enqueued nothing).
- The job type is dispatched in `Jobs._dispatch_` and the trigger is already in
  `installAllTriggers` (`runSlaBreachSweep`, every 15 minutes).
- `_handleSlaBreachSweep_` finds open tickets past a stamped deadline that are
  not yet flagged, flags the breach (response and/or resolve), emits a breach
  notification via the step 1 path, and triggers escalation. Each ticket is
  flagged once per breach type so it is never re-escalated for the same breach.

## 5. Escalation behaviour (TKT-3)

Escalation (manual `tickets.escalate` or from the sweep) runs one shared core,
`Tickets.escalateCore`:

- reassigns the ticket to the next tier (an active manager in the ticket country
  scope, not the current assignee), moving a `NEW` ticket to `OPEN`;
- bumps `escalation_level` and records both changes in `ticket_history`;
- emits a notification to the new owner and, optionally, the requester via
  `Notify.emit` (best effort, never blocks);
- audits the move.

When no eligible manager exists the ticket is still flagged, the level still
increments, and the breach still notifies; nothing crashes.

## 6. SLA Config page (SLA-3)

`partial_sla.html` now calls the registered actions instead of the unregistered
`config.list` / `config.set`:

- load thresholds: `sla.listPolicies` (minutes shown as hours);
- save thresholds: `sla.updatePolicy` for existing rows, `sla.createPolicy` for
  new ones (hours stored as minutes);
- breach report: `sla.listBreaches`.

## 7. Ticket comment persistence (TKT-2)

The three comment writes (create description, `addComment`, resolution note) now
go through one writer, `_insertComment_`, on the real `author_*` columns. The
write is no longer swallowed, so a failed comment surfaces instead of vanishing
while the handler falsely reports success.

## 8. Manual test checklist

Prerequisite: a SUPER_ADMIN session and at least one customer in a country (for
example KE). Run `reportSlaSchema()` once and confirm the columns above.

1. SLA Config page loads: open SLA Config; the thresholds table fills (defaults
   when `sla_config` is empty) and the breach report renders without a spinner
   hang.
2. Save thresholds: set, for example, CRITICAL response 1h / resolve 1h, click
   Save, expect the success toast; reload and confirm the values persist. Verify
   `sla_config` has one row per saved priority with `response_minutes` /
   `resolve_minutes` in minutes.
3. Deadlines stamped: create a CRITICAL ticket for the customer; confirm the new
   ticket row has non null `sla_response_by` and `sla_resolve_by` matching the
   saved policy. Create a ticket of a priority with no policy and confirm the
   deadlines are null and create still succeeds.
4. Comment persistence: confirm the description is saved as the first
   `ticket_comments` row (author_id set); add a comment and resolve the ticket,
   and confirm both the comment and the resolution note persist.
5. Breach sweep: set the CRITICAL policy to 0 or 1 minute, create a CRITICAL
   ticket, wait for the deadline to pass, then run `runSlaBreachSweep()` from the
   IDE (or wait for the 15 minute trigger). Confirm the ticket is flagged
   (`sla_resolve_breached = 1`), an escalation occurred (`escalation_level`
   increased, reassigned when a manager exists), a `TICKET_SLA_BREACHED` audit
   row exists, and `notifications` has PENDING breach/escalation rows. The ticket
   now shows on the SLA breach report.
6. Manual escalation: on an open ticket, call `tickets.escalate`; confirm the
   level increments, the ticket reassigns to a manager when one exists, and a
   `TICKET_ESCALATED` notification is enqueued.
7. Smoke: `smokeTickets()` still passes (create, assign, comment, escalate,
   resolve, close, reopen).

## 9. Going live

Code changes do not take effect on the published web app until a new version is
deployed:

1. In the Apps Script editor: Deploy > Manage deployments > New version, then
   Deploy.
2. Run `installAllTriggers()` once (or call `system.installTriggers` as an
   admin) so the 15 minute `runSlaBreachSweep` trigger and the rest are
   installed. Re-running is safe; it never stacks duplicates.

No change to `doGet` (`ALLOWALL` intact), the `/exec` URL, the Cloudflare worker,
or the `processRequest` contract. No order, payment, or customer business logic
was changed beyond the notification emits.
