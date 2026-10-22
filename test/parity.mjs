// Runs the Apps Script backend (backend/Code.gs, over an in-memory copy of a
// sheet export) and the Neon backend (api/index.js, on Neon loaded from the
// same export) side by side. Every request goes to both; both must answer the
// same and leave the same data behind. The PIN is made up; no real PIN is used.
// Usage: node --env-file=.env.local test/parity.mjs "<path to the sheet export .xlsx>"
// Reloads Neon from the export before and after. Never run it after the switch
// (the importer refuses anyway once the cutover row exists).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ExcelJS from 'exceljs';
import { neon } from '@neondatabase/serverless';
import { TABS, sheetText, isTypedCodeDate } from '../api/_lib/sheet-tabs.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node --env-file=.env.local test/parity.mjs "<path to the sheet export .xlsx>"');
  process.exit(1);
}
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sql = neon(process.env.DATABASE_URL);
const TOLERANCE_MS = 120000;   // the two backends stamp "now" a moment apart
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const SECRET_KEYS = ['password', 'token'];   // never printed, even in a failure
const APPS_SCRIPT_FILES = ['../backend/Code.gs'];
const TEST_PIN = '4719';
const okOf = r => r.success === true || (r.success === undefined && !r.error);
const isBlank = v => v === '' || v === null || v === undefined;
const reimport = () => execFileSync(process.execPath, ['--env-file=.env.local', 'scripts/import-sheet.mjs', file], { cwd: ROOT, stdio: 'ignore' });

// ---- The Apps Script side: an in-memory spreadsheet --------------------------
class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows; }
  getName() { return this.name; }
  getLastRow() {
    for (let r = this.rows.length; r > 0; r--) if (this.rows[r - 1].some(v => !isBlank(v))) return r;
    return 0;
  }
  getLastColumn() {
    let c = 0;
    for (const row of this.rows) for (let j = row.length; j > c; j--) if (!isBlank(row[j - 1])) { c = j; break; }
    return c;
  }
  cell(r, c) { const v = (this.rows[r - 1] || [])[c - 1]; return v === undefined || v === null ? '' : v; }
  set(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    const row = this.rows[r - 1];
    while (row.length < c) row.push('');
    // Like Google Sheets: number-looking text written to a cell becomes a number.
    row[c - 1] = v === null || v === undefined ? '' : (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
  }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  appendRow(vals) { const r = this.getLastRow() + 1; vals.forEach((v, j) => this.set(r, j + 1, v)); return this; }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
}
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => this.sh.cell(this.r + i, this.c + j))); }
  setValues(vs) { vs.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, v))); return this; }
  setValue(v) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, v); return this; }
}

// The Neon import restores shade codes Sheets had turned into dates ("7-9");
// both sides start from the same corrected data.
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const sheets = {};
for (const ws of wb.worksheets) {
  const rows = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      const cellObj = ws.getRow(r).getCell(c);
      const v = cellObj.value;
      if (v instanceof Date && !isTypedCodeDate(v, cellObj.numFmt)) throw new Error(`Unexpected date in ${ws.name} row ${r}`);
      row.push(v instanceof Date ? sheetText(v) : (v === null || v === undefined ? '' : v));
    }
    rows.push(row);
  }
  sheets[ws.name] = new Sheet(ws.name, rows);
}
const ss = { getSheetByName: n => sheets[n] || null };
const props = new Map([['APP_PASSWORD', TEST_PIN]]);
const store = map => ({
  getProperty: k => (map.has(k) ? map.get(k) : null),
  setProperty(k, v) { map.set(k, String(v)); return this; },
  deleteProperty(k) { map.delete(k); return this; },
});
const lock = { waitLock() {}, releaseLock() {} };
Object.assign(globalThis, {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  PropertiesService: { getScriptProperties: () => store(props) },
  LockService: { getScriptLock: () => lock },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: body => ({ body, setMimeType() { return this; } }) },
  Utilities: { getUuid: () => randomUUID() },
});
for (const gs of APPS_SCRIPT_FILES) vm.runInThisContext(await readFile(new URL(gs, import.meta.url), 'utf8'), { filename: gs });
const refGet = params => JSON.parse(globalThis.doGet({ parameter: params }).body);
const refPost = data => JSON.parse(globalThis.doPost({ postData: { contents: typeof data === 'string' ? data : JSON.stringify(data) } }).body);

// ---- The Neon side --------------------------------------------------------
process.env.APP_PASSWORD = TEST_PIN;
reimport();
const { default: api } = await import('../api/index.js');
async function newGet(params) {
  const u = new URL('http://localhost/api');
  for (const k in params) if (params[k] !== undefined) u.searchParams.set(k, params[k]);
  return (await api.fetch(new Request(u))).json();
}
async function newPost(data) {
  return (await api.fetch(new Request('http://localhost/api', {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: typeof data === 'string' ? data : JSON.stringify(data),
  }))).json();
}

// ---- Comparing ------------------------------------------------------------
let checks = 0;
const failures = [];
function record(label, diffs) {
  checks++;
  if (diffs.length) {
    failures.push(label);
    console.log(`FAIL ${label}`);
    diffs.slice(0, 8).forEach(d => console.log('     ' + d));
  }
}
const show = (v, key) => (SECRET_KEYS.includes(String(key).toLowerCase()) ? '<secret>' : String(JSON.stringify(v)).slice(0, 140));
function diff(a, b, path, out, skip) {
  const key = path.slice(path.lastIndexOf('.') + 1).replace(/\[\d+\]$/, '');
  if (skip && skip.includes(key)) return;
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) {
    if (Math.abs(Date.parse(a) - Date.parse(b)) > TOLERANCE_MS) out.push(`${path}: apps-script ${a} vs neon ${b}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}: apps-script ${a.length} items vs neon ${b.length}`);
    else a.forEach((x, i) => diff(x, b[i], `${path}[${i}]`, out, skip));
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join() !== kb.join() && new Set(ka).size === new Set([...ka, ...kb]).size) out.push(`${path}: field order apps-script ${ka} vs neon ${kb}`);
    for (const k of new Set([...ka, ...kb])) diff(a[k], b[k], `${path}.${k}`, out, skip);
  } else if (a !== b) {
    out.push(`${path}: apps-script ${show(a, key)} vs neon ${show(b, key)}`);
  }
}

// Each side signs in with its own token; "TOKEN" in a payload becomes the side's.
const tokens = { ref: null, neu: null };
const withToken = (payload, side) => (payload && typeof payload === 'object' && payload.token === 'TOKEN' ? { ...payload, token: tokens[side] } : payload);

/** Sends one request to both backends. opts.ok asserts the expected outcome,
 *  so both failing the same way (a broken test) can't pass as parity.
 *  opts.error is Neon's own wording where it deliberately differs.
 *  opts.skip lists fields that differ by design (random tokens). */
async function both(label, kind, payload, opts = {}) {
  const ref = kind === 'GET' ? refGet(withToken(payload, 'ref')) : refPost(withToken(payload, 'ref'));
  const neu = kind === 'GET' ? await newGet(withToken(payload, 'neu')) : await newPost(withToken(payload, 'neu'));
  const d = [];
  if (opts.ok !== undefined && okOf(ref) !== opts.ok) d.push(`expected ok:${opts.ok}, apps-script answered ${show(ref)}`);
  if (opts.error !== undefined && neu.error !== opts.error) d.push(`expected neon error "${opts.error}", got ${show(neu)}`);
  diff(ref, neu, label, d, opts.error !== undefined ? [...(opts.skip || []), 'error'] : opts.skip);
  record(label, d);
  return { ref, neu };
}
/** A check on the new backend alone, for behaviour the Apps Script never had. */
function only(label, ok, detail) { record(label, ok ? [] : [detail]); }

function sheetCell(type, v) {
  switch (type) {
    case 'text': return isBlank(v) ? '' : String(v);
    case 'int': case 'float': return isBlank(v) ? null : Number(v);
    case 'iso': return isBlank(v) ? null : Date.parse(v);
  }
}
function sameCell(type, want, have) {
  if (type === 'iso') return want === null ? have === null : have !== null && Math.abs(want - have) <= TOLERANCE_MS;
  return JSON.stringify(want) === JSON.stringify(have);
}

/** Every tab of the in-memory sheet against every table in Neon, row by row. */
async function compareState(label) {
  const d = [];
  for (const { tab, table, columns } of TABS) {
    const vals = ss.getSheetByName(tab).getDataRange().getValues();
    const heads = vals[0].map(h => String(h).trim());
    const rows = vals.slice(1).filter(r => r.some(v => !isBlank(v)));
    const db = await sql.query(`SELECT * FROM ${table} ORDER BY id`);
    if (rows.length !== db.length) { d.push(`${tab}: apps-script ${rows.length} rows vs neon ${db.length}`); continue; }
    rows.forEach((r, i) => {
      for (const [header, column, type] of columns) {
        const want = sheetCell(type, r[heads.indexOf(header)]);
        const raw = db[i][column];
        const have = type === 'iso' ? (raw === null ? null : raw.getTime()) : raw;
        if (!sameCell(type, want, have)) d.push(`${tab} row ${i + 2} ${header}: apps-script ${show(want, header)} vs neon ${show(have, header)}`);
      }
    });
  }
  record(`data after ${label}`, d);
}
const pause = ms => new Promise(r => setTimeout(r, ms));

// ---- The run ----------------------------------------------------------------
try {
  await compareState('setup');

  // Sign-in and refusals before any write.
  await both('login: wrong PIN', 'GET', { action: 'login', password: '0000' }, { ok: false });
  await both('login: no PIN', 'GET', { action: 'login' }, { ok: false });
  const signIn = await both('login: right PIN', 'GET', { action: 'login', password: TEST_PIN }, { ok: true, skip: ['token'] });
  tokens.ref = signIn.ref.token; tokens.neu = signIn.neu.token;
  only('login: new token looks like a uuid', /^[0-9a-f-]{36}$/.test(tokens.neu), 'token ' + typeof tokens.neu);
  await both('boot without a token', 'GET', { action: 'boot' }, { ok: false });
  await both('boot with a made-up token', 'GET', { action: 'boot', token: 'nope' }, { ok: false });

  // Reads.
  await both('boot', 'GET', { action: 'boot', token: 'TOKEN' }, { ok: true });
  await both('report with one count', 'GET', { action: 'report', token: 'TOKEN' }, { ok: true });
  await both('unknown GET action', 'GET', { action: 'nope', token: 'TOKEN' }, { ok: false });
  await both('GET without an action', 'GET', { token: 'TOKEN' }, { ok: false });

  // POST refusals.
  await both('POST without a token', 'POST', { action: 'setCount', data: { productId: 'P001', zoneId: 'Z1', qty: 1 } }, { ok: false });
  await both('POST with a made-up token', 'POST', { token: 'nope', action: 'setCount', data: {} }, { ok: false });
  await both('POST body that is not JSON', 'POST', 'not json', { ok: false });
  await both('POST with an empty body', 'POST', '', { ok: false });
  await both('unknown POST action', 'POST', { token: 'TOKEN', action: 'nope' }, { ok: false });
  await both('POST without an action', 'POST', { token: 'TOKEN' }, { ok: false });
  await compareState('refusals');

  // Counts.
  await both('setCount: existing row', 'POST', { token: 'TOKEN', action: 'setCount', data: { productId: 'P001', zoneId: 'Z1', qty: 2.5 } }, { ok: true });
  await both('setCount: new product+zone, rounds to a half', 'POST', { token: 'TOKEN', action: 'setCount', data: { productId: 'P005', zoneId: 'Z3', qty: 1.26 } }, { ok: true });
  await both('setCount: numeric text', 'POST', { token: 'TOKEN', action: 'setCount', data: { productId: 'P002', zoneId: 'Z1', qty: '4' } }, { ok: true });
  await both('setCount: zero', 'POST', { token: 'TOKEN', action: 'setCount', data: { productId: 'P003', zoneId: 'Z1', qty: 0 } }, { ok: true });
  await both('setCount: negative refused', 'POST', { token: 'TOKEN', action: 'setCount', data: { productId: 'P001', zoneId: 'Z1', qty: -1 } }, { ok: false });
  await both('setCount: not a number refused', 'POST', { token: 'TOKEN', action: 'setCount', data: { productId: 'P001', zoneId: 'Z1', qty: 'lots' } }, { ok: false });
  await both('setCount: no qty refused', 'POST', { token: 'TOKEN', action: 'setCount', data: { productId: 'P001', zoneId: 'Z1' } }, { ok: false });
  await both('removeFromZone: existing', 'POST', { token: 'TOKEN', action: 'removeFromZone', data: { productId: 'P004', zoneId: 'Z1' } }, { ok: true });
  await both('removeFromZone: not there', 'POST', { token: 'TOKEN', action: 'removeFromZone', data: { productId: 'P004', zoneId: 'Z5' } }, { ok: true });
  await compareState('counts');

  // Products.
  await both('addProduct: needs a name', 'POST', { token: 'TOKEN', action: 'addProduct', data: { category: 'Color' } }, { ok: false });
  await both('addProduct: full, placed in a zone', 'POST', { token: 'TOKEN', action: 'addProduct', data: {
    category: 'Color', brand: 'Zz Brand', line: 'Zz Line', subType: 'Demi', shade: '9N', price: 7.25, par: 2.2,
    verify: true, notes: 'Zz test', zoneId: 'Z2', qty: 3 } }, { ok: true });
  await both('addProduct: brand only, defaults', 'POST', { token: 'TOKEN', action: 'addProduct', data: { brand: 'Zz Only' } }, { ok: true });
  await both('addProduct: price as text', 'POST', { token: 'TOKEN', action: 'addProduct', data: { shade: 'Zz Shade', price: '12.50', zoneId: 'Z4' } }, { ok: true });
  await both('addProduct: price 0 stays blank', 'POST', { token: 'TOKEN', action: 'addProduct', data: { line: 'Zz Free', price: 0 } }, { ok: true });
  await both('addProduct: negative par refused', 'POST', { token: 'TOKEN', action: 'addProduct', data: { brand: 'Zz Bad', par: -2 } }, { ok: false });
  await both('updateProduct: several fields', 'POST', { token: 'TOKEN', action: 'updateProduct', data: {
    productId: 'P010', category: 'Back Bar', brand: 'Zz Renamed', par: 3.3, price: 19.99, notes: 'Zz note', verify: true } }, { ok: true });
  await both('updateProduct: clear a price with null', 'POST', { token: 'TOKEN', action: 'updateProduct', data: { productId: 'P001', price: null } }, { ok: true });
  await both('updateProduct: clear a price with blank', 'POST', { token: 'TOKEN', action: 'updateProduct', data: { productId: 'P002', price: '' } }, { ok: true });
  await both('updateProduct: unverify and archive', 'POST', { token: 'TOKEN', action: 'updateProduct', data: { productId: 'P023', verify: false, active: false } }, { ok: true });
  await both('updateProduct: blank a text field with null', 'POST', { token: 'TOKEN', action: 'updateProduct', data: { productId: 'P024', notes: null } }, { ok: true });
  await both('updateProduct: nothing to change', 'POST', { token: 'TOKEN', action: 'updateProduct', data: { productId: 'P025' } }, { ok: true });
  await both('updateProduct: unknown product', 'POST', { token: 'TOKEN', action: 'updateProduct', data: { productId: 'P999', brand: 'x' } }, { ok: false });
  await both('updateProduct: negative par refused', 'POST', { token: 'TOKEN', action: 'updateProduct', data: { productId: 'P026', par: -1 } }, { ok: false });
  await compareState('products');

  // Zones.
  await both('addZone: needs a name', 'POST', { token: 'TOKEN', action: 'addZone', data: {} }, { ok: false });
  await both('addZone', 'POST', { token: 'TOKEN', action: 'addZone', data: { name: 'Zz Front Desk', sortOrder: 2 } }, { ok: true });
  await both('updateZone: rename and reorder', 'POST', { token: 'TOKEN', action: 'updateZone', data: { zoneId: 'Z2', name: 'Zz Colour Wall', sortOrder: 7 } }, { ok: true });
  await both('updateZone: hide', 'POST', { token: 'TOKEN', action: 'updateZone', data: { zoneId: 'Z5', active: false } }, { ok: true });
  await both('updateZone: unknown zone', 'POST', { token: 'TOKEN', action: 'updateZone', data: { zoneId: 'Z99', name: 'x' } }, { ok: false });
  await compareState('zones');

  // A first count, deliveries after it, a second count, and the report.
  await both('finishCount #1', 'POST', { token: 'TOKEN', action: 'finishCount', data: { notes: 'Zz weekly' } }, { ok: true });
  await pause(50);
  await both('restock: zero refused', 'POST', { token: 'TOKEN', action: 'restock', data: { productId: 'P001', qty: 0 } }, { ok: false });
  await both('restock', 'POST', { token: 'TOKEN', action: 'restock', data: { productId: 'P001', qty: 3 } }, { ok: true });
  await both('restock: with a note', 'POST', { token: 'TOKEN', action: 'restock', data: { productId: 'P002', qty: 2.5, note: 'Zz box' } }, { ok: true });
  await both('restock: to undo', 'POST', { token: 'TOKEN', action: 'restock', data: { productId: 'P003', qty: 1 } }, { ok: true });
  await both('deleteRestock', 'POST', { token: 'TOKEN', action: 'deleteRestock', data: { restockId: 3 } }, { ok: true });
  await both('deleteRestock: unknown', 'POST', { token: 'TOKEN', action: 'deleteRestock', data: { restockId: 99 } }, { ok: false });
  await both('setCount after deliveries', 'POST', { token: 'TOKEN', action: 'setCount', data: { productId: 'P001', zoneId: 'Z1', qty: 4 } }, { ok: true });
  await both('setCount: a sale', 'POST', { token: 'TOKEN', action: 'setCount', data: { productId: 'P006', zoneId: 'Z1', qty: 0 } }, { ok: true });
  await pause(50);
  await both('finishCount #2', 'POST', { token: 'TOKEN', action: 'finishCount', data: {} }, { ok: true });
  await compareState('two counts and deliveries');
  await both('report across two counts', 'GET', { action: 'report', token: 'TOKEN' }, { ok: true });
  await both('boot after everything', 'GET', { action: 'boot', token: 'TOKEN' }, { ok: true });

  // ---- Deliberate differences: the new backend alone ------------------------
  const ping = await newGet({ action: 'ping' });
  only('ping answers without a sign-in', ping.ok === true && ping.version === 1, JSON.stringify(ping));
  const report = await newGet({ action: 'report', token: tokens.neu });
  const hist = await newGet({ action: 'usageHistory', token: tokens.neu });
  const lastPeriod = hist.periods && hist.periods[hist.periods.length - 1];
  only('usageHistory: last period equals the report',
    hist.ready === true && hist.periods.length === 2 && lastPeriod.from === report.previous.date && lastPeriod.to === report.current.date &&
    JSON.stringify(lastPeriod.rows) === JSON.stringify(report.rows.map(r => ({ productId: r.productId, usage: r.usage, restocked: r.restocked, label: r.label }))),
    JSON.stringify(hist).slice(0, 300));
  const one = await newGet({ action: 'usageHistory', token: tokens.neu, periods: '1' });
  only('usageHistory: periods=1 gives one period', one.periods.length === 1, JSON.stringify(one).slice(0, 200));
  only('usageHistory needs a sign-in', (await newGet({ action: 'usageHistory' })).error === 'AUTH', 'no AUTH');

  const shades = await newGet({ action: 'boot', token: tokens.neu });
  const shade = id => shades.products.find(p => p.ProductID === id).Shade;
  only('shade codes are text again (7-9, 5-4)', shade('P131') === '7-9' && shade('P141') === '5-4', `${shade('P131')} ${shade('P141')}`);

  const cid = 'tmpP_zz' + Date.now();
  const p1 = await newPost({ token: tokens.neu, action: 'addProduct', data: { clientId: cid, brand: 'Zz Retry', zoneId: 'Z1', qty: 2 } });
  const p2 = await newPost({ token: tokens.neu, action: 'addProduct', data: { clientId: cid, brand: 'Zz Retry', zoneId: 'Z1', qty: 2 } });
  const [{ n: pn }] = await sql`SELECT count(*)::int AS n FROM products WHERE brand = 'Zz Retry'`;
  const [{ n: cn }] = await sql`SELECT count(*)::int AS n FROM zone_counts WHERE product_id = ${p1.productId}`;
  only('addProduct retried with the same clientId: one product, one count', p1.productId && p1.productId === p2.productId && pn === 1 && cn === 1, `${JSON.stringify([p1, p2])} products ${pn} counts ${cn}`);
  const z1 = await newPost({ token: tokens.neu, action: 'addZone', data: { clientId: 'tmpZ_zz', name: 'Zz Retry Zone' } });
  const z2 = await newPost({ token: tokens.neu, action: 'addZone', data: { clientId: 'tmpZ_zz', name: 'Zz Retry Zone' } });
  only('addZone retried with the same clientId: one zone', z1.zoneId && z1.zoneId === z2.zoneId, JSON.stringify([z1, z2]));
  const r1 = await newPost({ token: tokens.neu, action: 'restock', data: { clientId: 'tmpR_zz', productId: 'P001', qty: 2 } });
  const r2 = await newPost({ token: tokens.neu, action: 'restock', data: { clientId: 'tmpR_zz', productId: 'P001', qty: 2 } });
  const [{ n: rn }] = await sql`SELECT count(*)::int AS n FROM restocks WHERE client_id = 'tmpR_zz'`;
  only('restock retried with the same clientId: one delivery', r1.restockId && r1.restockId === r2.restockId && rn === 1, JSON.stringify([r1, r2]));
  const p3 = await newPost({ token: tokens.neu, action: 'addProduct', data: { clientId: cid + 'b', brand: 'Zz Other' } });
  only('a different clientId makes a new product', p3.productId && p3.productId !== p1.productId, JSON.stringify(p3));

  const badPrice = await newPost({ token: tokens.neu, action: 'updateProduct', data: { productId: 'P001', price: 'abc' } });
  only('a price that is not a number is refused', badPrice.error === 'Price must be a number.', JSON.stringify(badPrice));
  const noZone = await newPost({ token: tokens.neu, action: 'setCount', data: { productId: 'P001', qty: 1 } });
  only('a count without a zone is refused', noZone.error === 'A count needs a product and a zone.', JSON.stringify(noZone));

  const postLogin = await newPost({ action: 'login', data: { password: TEST_PIN } });
  only('login as a POST, PIN out of the URL', postLogin.success === true && /^[0-9a-f-]{36}$/.test(postLogin.token), JSON.stringify({ success: postLogin.success }));
  const viaPost = await newGet({ action: 'boot', token: postLogin.token });
  only('a token from the POST login works', Array.isArray(viaPost.products), 'boot failed');

  let lastWrong;
  for (let i = 0; i < 9; i++) lastWrong = await newPost({ action: 'login', data: { password: '0000' } });
  const stillOpen = await newPost({ action: 'login', data: { password: TEST_PIN } });
  only('9 wrong PINs, then the right one still signs in (and clears the count)', lastWrong.success === false && !lastWrong.locked && stillOpen.success === true, JSON.stringify([lastWrong, { success: stillOpen.success }]));
  for (let i = 0; i < 10; i++) lastWrong = await newGet({ action: 'login', password: '0000' });
  const locked = await newPost({ action: 'login', data: { password: TEST_PIN } });
  only('after 10 wrong PINs login is locked, even for the right PIN', lastWrong.success === false && locked.success === false && locked.locked === true && !locked.token, JSON.stringify([lastWrong, locked]));
  only('signed-in phones keep working while login is locked', Array.isArray((await newGet({ action: 'boot', token: tokens.neu })).products), 'boot refused');
  await sql`UPDATE login_failures SET locked_until = now() - interval '1 second', first_at = now() - interval '16 minutes' WHERE key = 'pin'`;
  const after = await newPost({ action: 'login', data: { password: TEST_PIN } });
  only('the lock ends after 15 minutes', after.success === true, JSON.stringify({ success: after.success }));

  await sql`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE token = ${tokens.neu}`;
  only('an expired sign-in is refused', (await newGet({ action: 'boot', token: tokens.neu })).error === 'AUTH', 'expired token accepted');
} finally {
  reimport();
}
console.log(`\n${checks - failures.length} of ${checks} checks matched. Neon was reloaded from the export afterwards.`);
if (failures.length) console.log(`FAILED: ${failures.join('; ')}`);
process.exit(failures.length ? 1 : 0);
