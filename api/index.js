/**
 * Salon Asteria inventory: backend on Neon Postgres (one Vercel Function serving /api).
 * ---------------------------------------------------------------------------
 * A port of backend/Code.gs (the Apps Script): every action answers with the
 * same shape, so the front end only changes its API URL.
 *   - READS  use GET:  /api?action=...&token=...
 *   - WRITES use POST with a JSON string body {token, action, data} (text/plain).
 * Tables mirror the old sheet tabs; see db/schema.sql.
 *
 * Deliberate differences from the Apps Script (the parity test names each):
 *   - login also works as a POST {action:'login', data:{password}}, so the PIN
 *     stays out of URLs; 10 wrong PINs in 15 minutes locks login for 15 minutes
 *     and answers {success:false, locked:true}.
 *   - addProduct, addZone and restock accept a clientId: a retry with the same
 *     clientId returns the row the first try made instead of a second row.
 *   - ping (no sign-in) answers the backend version; usageHistory is new.
 *   - Text stays text. Google Sheets turned some typed values into dates or
 *     numbers (shade "7-9" became July 9); here a shade is what was typed.
 *   - Price and par must be numbers; a count needs a product and a zone.
 *   - Sign-ins made on the Apps Script do not carry over: sign in once again.
 * ---------------------------------------------------------------------------
 */
import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const VERSION = 1;
const SESSION_DAYS = 30;
const LOGIN_LIMIT = 10;   // wrong PINs within 15 minutes before login locks for 15 minutes

// ===========================================================================
//  ENTRY POINT
// ===========================================================================

export default {
  async fetch(request) {
    try {
      if (request.method === 'POST') return jsonOut(await doPost(JSON.parse(await request.text())));
      return jsonOut(await doGet(Object.fromEntries(new URL(request.url).searchParams)));
    } catch (err) {
      return jsonOut({ error: err.message });
    }
  },
};

/** Handles all read requests (login, boot data, usage report). */
async function doGet(p) {
  if (p.action === 'ping') return { ok: true, message: 'Salon Asteria API is live.', version: VERSION };
  if (p.action === 'login') return login(p.password);
  if (!(await validateToken(p.token))) return { error: 'AUTH' };
  if (p.action === 'boot') return getBoot();
  if (p.action === 'report') return getReport();
  if (p.action === 'usageHistory') return getUsageHistory(p.periods);
  return { error: 'Unknown action: ' + p.action };
}

const POST_ACTIONS = {
  setCount, removeFromZone, addProduct, updateProduct, addZone, updateZone,
  restock: addRestock, deleteRestock, finishCount,
};

/** Handles all write requests (counts, products, zones, restocks, snapshots). */
async function doPost(body) {
  const d = body.data || {};
  if (body.action === 'login') return login(d.password);
  if (!(await validateToken(body.token))) return { error: 'AUTH' };
  const fn = Object.prototype.hasOwnProperty.call(POST_ACTIONS, body.action) ? POST_ACTIONS[body.action] : null;
  if (!fn) return { error: 'Unknown action: ' + body.action };
  return fn(d);
}

// ===========================================================================
//  SIGN-IN: one shared PIN (env APP_PASSWORD), 30-day tokens
// ===========================================================================

async function login(submitted) {
  const stored = process.env.APP_PASSWORD;
  if (!stored) return { success: false, error: 'APP_PASSWORD not set in Vercel' };
  const [locked] = await sql`SELECT 1 FROM login_failures WHERE key = 'pin' AND locked_until > now()`;
  if (locked) return { success: false, locked: true };
  if (submitted !== stored) {
    await sql`INSERT INTO login_failures AS f (key, fails, first_at) VALUES ('pin', 1, now())
      ON CONFLICT (key) DO UPDATE SET
        fails = CASE WHEN f.first_at < now() - interval '15 minutes' THEN 1 ELSE f.fails + 1 END,
        first_at = CASE WHEN f.first_at < now() - interval '15 minutes' THEN now() ELSE f.first_at END,
        locked_until = CASE WHEN f.first_at >= now() - interval '15 minutes' AND f.fails + 1 >= ${LOGIN_LIMIT}
          THEN now() + interval '15 minutes' ELSE f.locked_until END`;
    return { success: false };
  }
  const token = randomUUID();
  await sql.transaction([
    sql`DELETE FROM login_failures WHERE key = 'pin'`,
    sql`DELETE FROM sessions WHERE expires_at <= now()`,
    sql`INSERT INTO sessions (token, expires_at) VALUES (${token}, now() + make_interval(days => ${SESSION_DAYS}))`,
  ]);
  return { success: true, token };
}

async function validateToken(token) {
  if (!token) return false;
  const [s] = await sql`SELECT 1 FROM sessions WHERE token = ${String(token)} AND expires_at > now()`;
  return Boolean(s);
}

// ===========================================================================
//  READS
// ===========================================================================

// Rows come back in sheet order (id = sheet row), keyed by the sheet's headers.
// An empty cell reads as '' like Apps Script's getValues().
const cell = v => (v === null || v === undefined ? '' : v);
const iso = d => (d ? d.toISOString() : '');
const productRow = r => ({ ProductID: r.product_id, Category: r.category, Brand: r.brand, Line: r.line,
  SubType: r.sub_type, Shade: r.shade, Par: cell(r.par), Price: cell(r.price), Verify: r.verify,
  Notes: r.notes, Active: r.active });
const zoneRow = r => ({ ZoneID: r.zone_id, Name: r.name, SortOrder: cell(r.sort_order), Active: r.active });
const countRow = r => ({ ProductID: r.product_id, ZoneID: r.zone_id, Qty: cell(r.qty), LastUpdated: iso(r.last_updated) });
const snapshotRow = r => ({ SnapshotID: r.snapshot_id, Date: iso(r.date), Status: r.status, Notes: r.notes });
const restockRow = r => ({ RestockID: r.restock_id, Date: iso(r.date), ProductID: r.product_id, Qty: cell(r.qty), Note: r.note });

async function getBoot() {
  const [products, zones, counts, snapshots, restocks] = await sql.transaction([
    sql`SELECT * FROM products ORDER BY id`,
    sql`SELECT * FROM zones ORDER BY id`,
    sql`SELECT * FROM zone_counts ORDER BY id`,
    sql`SELECT * FROM snapshots ORDER BY id`,
    sql`SELECT * FROM (SELECT * FROM restocks ORDER BY id DESC LIMIT 50) r ORDER BY id`,
  ], { readOnly: true });
  return {
    products: products.map(productRow),
    zones: zones.map(zoneRow),
    counts: counts.map(countRow),
    snapshots: snapshots.map(snapshotRow),
    restocks: restocks.map(restockRow),
  };
}

async function closedSnapshots() {
  return (await sql`SELECT snapshot_id, date FROM snapshots WHERE status = 'closed' ORDER BY snapshot_id, id`)
    .map(s => ({ id: s.snapshot_id, date: iso(s.date) }));
}

/** Per product between two snapshots: last count + restocks in between − this count. */
async function usageBetween(prev, cur) {
  const [lines, restocks, products] = await sql.transaction([
    sql`SELECT snapshot_id, product_id, qty FROM snapshot_lines WHERE snapshot_id IN (${prev.id}, ${cur.id}) ORDER BY id`,
    sql`SELECT product_id, qty, date FROM restocks ORDER BY id`,
    sql`SELECT * FROM products ORDER BY id`,
  ], { readOnly: true });
  const sum = snapId => {
    const m = {};
    lines.filter(l => l.snapshot_id === snapId).forEach(l => { m[l.product_id] = (m[l.product_id] || 0) + (l.qty || 0); });
    return m;
  };
  const prevQty = sum(prev.id), curQty = sum(cur.id);
  const from = Date.parse(prev.date), to = Date.parse(cur.date);
  const restocked = {};
  restocks.forEach(r => {
    const t = r.date ? r.date.getTime() : NaN;
    if (t > from && t <= to) restocked[r.product_id] = (restocked[r.product_id] || 0) + (r.qty || 0);
  });
  const rows = [];
  products.forEach(pr => {
    const a = prevQty[pr.product_id] || 0, b = curQty[pr.product_id] || 0, rs = restocked[pr.product_id] || 0;
    if (a === 0 && b === 0 && rs === 0) return;
    rows.push({
      productId: pr.product_id, category: pr.category, brand: pr.brand, line: pr.line,
      subType: pr.sub_type, shade: pr.shade,
      previous: a, restocked: rs, current: b,
      usage: Math.round((a + rs - b) * 2) / 2,
      label: pr.category === 'Retail' ? 'Sold/Used' : 'Used',
    });
  });
  return rows;
}

async function getReport() {
  const snaps = await closedSnapshots();
  if (snaps.length < 2) return { ready: false, message: 'Need at least two completed counts to compare.' };
  const prev = snaps[snaps.length - 2], cur = snaps[snaps.length - 1];
  return { ready: true, previous: prev, current: cur, rows: await usageBetween(prev, cur) };
}

/** Usage for each of the last N counting periods (default 8), oldest first. */
async function getUsageHistory(periods) {
  const n = Math.max(1, Math.min(52, Math.floor(Number(periods)) || 8));
  const snaps = (await closedSnapshots()).slice(-(n + 1));
  const out = [];
  for (let i = 1; i < snaps.length; i++) {
    const rows = await usageBetween(snaps[i - 1], snaps[i]);
    out.push({ from: snaps[i - 1].date, to: snaps[i].date,
      rows: rows.map(r => ({ productId: r.productId, usage: r.usage, restocked: r.restocked, label: r.label })) });
  }
  return { ready: out.length > 0, periods: out };
}

// ===========================================================================
//  WRITES
// ===========================================================================

async function setCount(d) {
  const qty = cleanQty(d.qty);
  if (!d.productId || !d.zoneId) throw new Error('A count needs a product and a zone.');
  await sql`INSERT INTO zone_counts (product_id, zone_id, qty, last_updated)
    VALUES (${String(d.productId)}, ${String(d.zoneId)}, ${qty}, ${nowIso()})
    ON CONFLICT (product_id, zone_id) DO UPDATE SET qty = EXCLUDED.qty, last_updated = EXCLUDED.last_updated`;
  return { ok: true };
}

async function removeFromZone(d) {
  await sql`DELETE FROM zone_counts WHERE product_id = ${String(d.productId ?? '')} AND zone_id = ${String(d.zoneId ?? '')}`;
  return { ok: true };
}

// New ids follow the Apps Script's rule: the highest numeric part + 1. Two
// requests at once could pick the same id; the unique constraint then refuses
// the second, which tries again with the next id.
const idNumber = (v, prefix) => Number(String(v).replace(prefix, '')) || 0;
const nextNumber = (ids, prefix) => (ids.length ? Math.max(...ids.map(v => idNumber(v, prefix))) : 0) + 1;

async function addProduct(d) {
  if (!d.brand && !d.line && !d.shade) throw new Error('Product needs at least a brand, line, or shade.');
  if (d.clientId) {
    const [done] = await sql`SELECT product_id FROM products WHERE client_id = ${String(d.clientId)}`;
    if (done) return { ok: true, productId: done.product_id };
  }
  const par = cleanQty(d.par != null ? d.par : 1);
  const price = d.price ? toPrice(d.price) : null;
  const qty = cleanQty(d.qty || 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    const ids = (await sql`SELECT product_id FROM products`).map(r => r.product_id);
    const id = 'P' + String(nextNumber(ids, 'P')).padStart(3, '0');
    const [made] = await sql`WITH p AS (
        INSERT INTO products (product_id, category, brand, line, sub_type, shade, par, price, verify, notes, active, client_id)
        VALUES (${id}, ${text(d.category || 'Retail')}, ${text(d.brand)}, ${text(d.line)}, ${text(d.subType)},
          ${text(d.shade)}, ${par}, ${price}, ${d.verify ? 'Y' : ''}, ${text(d.notes)}, 'Y', ${d.clientId ? String(d.clientId) : null})
        ON CONFLICT DO NOTHING RETURNING product_id),
      c AS (
        INSERT INTO zone_counts (product_id, zone_id, qty, last_updated)
        SELECT product_id, ${text(d.zoneId)}, ${qty}, ${nowIso()} FROM p WHERE ${Boolean(d.zoneId)}
        ON CONFLICT DO NOTHING)
      SELECT product_id FROM p`;
    if (made) return { ok: true, productId: made.product_id };
    if (d.clientId) {
      const [done] = await sql`SELECT product_id FROM products WHERE client_id = ${String(d.clientId)}`;
      if (done) return { ok: true, productId: done.product_id };
    }
  }
  throw new Error('Could not add the product. Try again.');
}

const PRODUCT_FIELDS = { category: 'category', brand: 'brand', line: 'line', subType: 'sub_type',
  shade: 'shade', par: 'par', price: 'price', verify: 'verify', notes: 'notes', active: 'active' };

async function updateProduct(d) {
  const set = [];
  for (const [k, column] of Object.entries(PRODUCT_FIELDS)) {
    if (d[k] === undefined) continue;
    let v = d[k];
    if (k === 'verify' || k === 'active') v = v ? 'Y' : '';
    else if (k === 'par') v = cleanQty(v);
    else if (k === 'price') v = v === null || v === '' ? null : toPrice(v);
    else v = text(v);
    set.push([column, v]);
  }
  const [hit] = await sql.query(
    `UPDATE products SET ${set.length ? set.map(([c], i) => `${c} = $${i + 2}`).join(', ') : 'product_id = product_id'}
     WHERE id = (SELECT id FROM products WHERE product_id = $1 ORDER BY id LIMIT 1) RETURNING id`,
    [String(d.productId ?? ''), ...set.map(([, v]) => v)]);
  if (!hit) throw new Error('Product not found: ' + d.productId);
  return { ok: true };
}

async function addZone(d) {
  if (!d.name) throw new Error('Zone needs a name.');
  if (d.clientId) {
    const [done] = await sql`SELECT zone_id FROM zones WHERE client_id = ${String(d.clientId)}`;
    if (done) return { ok: true, zoneId: done.zone_id };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const zones = await sql`SELECT zone_id, sort_order FROM zones`;
    const id = 'Z' + nextNumber(zones.map(z => z.zone_id), 'Z');
    const order = (zones.length ? Math.max(...zones.map(z => Number(z.sort_order) || 0)) : 0) + 1;
    const [made] = await sql`INSERT INTO zones (zone_id, name, sort_order, active, client_id)
      VALUES (${id}, ${text(d.name)}, ${order}, 'Y', ${d.clientId ? String(d.clientId) : null})
      ON CONFLICT DO NOTHING RETURNING zone_id`;
    if (made) return { ok: true, zoneId: made.zone_id };
    if (d.clientId) {
      const [done] = await sql`SELECT zone_id FROM zones WHERE client_id = ${String(d.clientId)}`;
      if (done) return { ok: true, zoneId: done.zone_id };
    }
  }
  throw new Error('Could not add the zone. Try again.');
}

async function updateZone(d) {
  const set = [];
  if (d.name !== undefined) set.push(['name', text(d.name)]);
  if (d.sortOrder !== undefined) set.push(['sort_order', Number(d.sortOrder)]);
  if (d.active !== undefined) set.push(['active', d.active ? 'Y' : '']);
  const [hit] = await sql.query(
    `UPDATE zones SET ${set.length ? set.map(([c], i) => `${c} = $${i + 2}`).join(', ') : 'zone_id = zone_id'}
     WHERE id = (SELECT id FROM zones WHERE zone_id = $1 ORDER BY id LIMIT 1) RETURNING id`,
    [String(d.zoneId ?? ''), ...set.map(([, v]) => v)]);
  if (!hit) throw new Error('Zone not found: ' + d.zoneId);
  return { ok: true };
}

async function addRestock(d) {
  const qty = cleanQty(d.qty);
  if (qty <= 0) throw new Error('Restock quantity must be more than zero.');
  if (d.clientId) {
    const [done] = await sql`SELECT restock_id FROM restocks WHERE client_id = ${String(d.clientId)}`;
    if (done) return { ok: true, restockId: done.restock_id };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = nextNumber((await sql`SELECT restock_id FROM restocks`).map(r => r.restock_id), '');
    const [made] = await sql`INSERT INTO restocks (restock_id, date, product_id, qty, note, client_id)
      VALUES (${id}, ${nowIso()}, ${text(d.productId)}, ${qty}, ${text(d.note)}, ${d.clientId ? String(d.clientId) : null})
      ON CONFLICT DO NOTHING RETURNING restock_id`;
    if (made) return { ok: true, restockId: made.restock_id };
    if (d.clientId) {
      const [done] = await sql`SELECT restock_id FROM restocks WHERE client_id = ${String(d.clientId)}`;
      if (done) return { ok: true, restockId: done.restock_id };
    }
  }
  throw new Error('Could not log the delivery. Try again.');
}

async function deleteRestock(d) {
  const [hit] = await sql`DELETE FROM restocks WHERE id = (
    SELECT id FROM restocks WHERE restock_id::text = ${String(d.restockId)} ORDER BY id LIMIT 1) RETURNING id`;
  if (!hit) throw new Error('Restock entry not found.');
  return { ok: true };
}

/** Freezes the current counts as a new dated snapshot. */
async function finishCount(d) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = nextNumber((await sql`SELECT snapshot_id FROM snapshots`).map(r => r.snapshot_id), '');
    const [made] = await sql`WITH s AS (
        INSERT INTO snapshots (snapshot_id, date, status, notes)
        VALUES (${id}, ${nowIso()}, 'closed', ${text(d.notes)})
        ON CONFLICT DO NOTHING RETURNING snapshot_id),
      l AS (
        INSERT INTO snapshot_lines (snapshot_id, product_id, zone_id, qty)
        SELECT s.snapshot_id, c.product_id, c.zone_id, coalesce(c.qty, 0)
        FROM s CROSS JOIN zone_counts c ORDER BY c.id)
      SELECT snapshot_id FROM s`;
    if (made) return { ok: true, snapshotId: made.snapshot_id };
  }
  throw new Error('Could not save the count. Try again.');
}

// ===========================================================================
//  HELPERS
// ===========================================================================

/** Rounds a quantity to the nearest half unit and blocks negatives. */
function cleanQty(q) {
  const n = Number(q);
  if (isNaN(n) || n < 0) throw new Error('Quantity must be zero or a positive number.');
  return Math.round(n * 2) / 2;
}

function toPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Price must be a number.');
  return n;
}

const text = v => (v === null || v === undefined ? '' : String(v));
const nowIso = () => new Date().toISOString();

function jsonOut(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
