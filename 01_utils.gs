/**
 * 01_utils.gs  —  Hass CMS rebuild foundation
 *
 * Pure utility functions — no database access, no side-effects.
 *
 *   uuidv4()                             RFC 4122 v4 UUID
 *   genId(prefix)                        prefixed ID  e.g. "ORD-<uuid>"
 *   nowIso()                             current UTC ISO timestamp
 *   addMinutes(date, minutes)            date arithmetic
 *   subtractDays(date, days)             date arithmetic
 *   businessHoursBetween(fromIso, toIso) elapsed business minutes (skeleton)
 *   jsonParse(str, fallback)             safe JSON.parse
 *   jsonStringify(obj, fallback)         safe JSON.stringify
 */

// ── ID generation ─────────────────────────────────────────────────────────────

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    var v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function genId(prefix) {
  var id = uuidv4();
  return prefix ? prefix + '-' + id : id;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + minutes * 60000);
}

function subtractDays(date, days) {
  return new Date(new Date(date).getTime() - days * 86400000);
}

/**
 * businessHoursBetween — skeleton only for Stage 1.
 *
 * Stage 2 (SLA service) fills this in by querying:
 *   SELECT * FROM business_hours
 *   SELECT * FROM holidays WHERE holiday_date BETWEEN ? AND ?
 *
 * Returns raw minute difference until then.
 */
function businessHoursBetween(fromIso, toIso) {
  var diff = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.max(0, Math.round(diff / 60000));
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

function jsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch (_) {
    return fallback !== undefined ? fallback : null;
  }
}

function jsonStringify(obj, fallback) {
  try {
    return JSON.stringify(obj);
  } catch (_) {
    return fallback !== undefined ? fallback : '{}';
  }
}
