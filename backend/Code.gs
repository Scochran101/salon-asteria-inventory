/************************************************************
 * SALON ASTERIA INVENTORY — BACKEND
 * Google Apps Script bound to "Salon Asteria Inventory DB"
 *
 * ONE-TIME SETUP: run seedDatabase() once (instructions below),
 * then deploy as a Web App.
 ************************************************************/

// Tab names used throughout
const TAB_PRODUCTS = 'Products';
const TAB_ZONES = 'Zones';
const TAB_COUNTS = 'ZoneCounts';
const TAB_SNAPSHOTS = 'Snapshots';
const TAB_LINES = 'SnapshotLines';
const TAB_RESTOCKS = 'Restocks';

/* ============================================================
 * WEB ENTRY POINTS
 * ============================================================ */

// Handles all read requests (login, boot data, usage report)
function doGet(e) {
  try {
    const p = e.parameter || {};
    if (p.action === 'login') return json(checkPassword(p.password));
    if (!validateToken(p.token)) return json({ error: 'AUTH' });
    if (p.action === 'boot') return json(getBoot());
    if (p.action === 'report') return json(getReport());
    return json({ error: 'Unknown action: ' + p.action });
  } catch (err) {
    return json({ error: err.message });
  }
}

// Handles all write requests (counts, products, zones, restocks, snapshots)
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const body = JSON.parse(e.postData.contents);
    if (!validateToken(body.token)) return json({ error: 'AUTH' });
    const d = body.data || {};
    switch (body.action) {
      case 'setCount':      return json(setCount(d));
      case 'removeFromZone':return json(removeFromZone(d));
      case 'addProduct':    return json(addProduct(d));
      case 'updateProduct': return json(updateProduct(d));
      case 'addZone':       return json(addZone(d));
      case 'updateZone':    return json(updateZone(d));
      case 'restock':       return json(addRestock(d));
      case 'deleteRestock': return json(deleteRestock(d));
      case 'finishCount':   return json(finishCount(d));
      default: return json({ error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return json({ error: err.message });
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
 * AUTH — shared password, 30-day tokens (survives closing the tab)
 * ============================================================ */

// Checks the submitted password against the APP_PASSWORD Script Property
function checkPassword(submitted) {
  const stored = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD');
  if (!stored) return { success: false, error: 'APP_PASSWORD not set in Script Properties' };
  if (submitted !== stored) return { success: false };
  const token = Utilities.getUuid();
  const expires = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
  PropertiesService.getScriptProperties().setProperty('tok_' + token, String(expires));
  return { success: true, token: token };
}

// Returns true if the token exists and has not expired
function validateToken(token) {
  if (!token) return false;
  const props = PropertiesService.getScriptProperties();
  const exp = props.getProperty('tok_' + token);
  if (!exp) return false;
  if (Date.now() > Number(exp)) { props.deleteProperty('tok_' + token); return false; }
  return true;
}

/* ============================================================
 * READS
 * ============================================================ */

// Returns everything the app needs to start: products, zones, live counts, snapshot list
function getBoot() {
  return {
    products: readRows(TAB_PRODUCTS),
    zones: readRows(TAB_ZONES),
    counts: readRows(TAB_COUNTS),
    snapshots: readRows(TAB_SNAPSHOTS),
    restocks: readRows(TAB_RESTOCKS).slice(-50) // recent restocks for display/undo
  };
}

// Usage report: last snapshot + restocks in between − current snapshot, per product
function getReport() {
  const snaps = readRows(TAB_SNAPSHOTS).filter(s => s.Status === 'closed')
    .sort((a, b) => Number(a.SnapshotID) - Number(b.SnapshotID));
  if (snaps.length < 2) return { ready: false, message: 'Need at least two completed counts to compare.' };
  const prev = snaps[snaps.length - 2], cur = snaps[snaps.length - 1];
  const lines = readRows(TAB_LINES);
  const sum = (snapId) => {
    const m = {};
    lines.filter(l => String(l.SnapshotID) === String(snapId))
      .forEach(l => { m[l.ProductID] = (m[l.ProductID] || 0) + Number(l.Qty || 0); });
    return m;
  };
  const prevQty = sum(prev.SnapshotID), curQty = sum(cur.SnapshotID);
  const restocked = {};
  readRows(TAB_RESTOCKS).forEach(r => {
    const t = new Date(r.Date).getTime();
    if (t > new Date(prev.Date).getTime() && t <= new Date(cur.Date).getTime()) {
      restocked[r.ProductID] = (restocked[r.ProductID] || 0) + Number(r.Qty || 0);
    }
  });
  const products = readRows(TAB_PRODUCTS);
  const rows = [];
  products.forEach(pr => {
    const a = prevQty[pr.ProductID] || 0, b = curQty[pr.ProductID] || 0, rs = restocked[pr.ProductID] || 0;
    if (a === 0 && b === 0 && rs === 0) return;
    rows.push({
      productId: pr.ProductID, category: pr.Category, brand: pr.Brand, line: pr.Line,
      subType: pr.SubType, shade: pr.Shade,
      previous: a, restocked: rs, current: b,
      usage: Math.round((a + rs - b) * 2) / 2,
      label: pr.Category === 'Retail' ? 'Sold/Used' : 'Used'
    });
  });
  return { ready: true, previous: { id: prev.SnapshotID, date: prev.Date }, current: { id: cur.SnapshotID, date: cur.Date }, rows: rows };
}

/* ============================================================
 * WRITES
 * ============================================================ */

// Sets the absolute quantity of a product in a zone (creates the row if new)
function setCount(d) {
  const qty = cleanQty(d.qty);
  const s = sh(TAB_COUNTS), rows = s.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === d.productId && rows[i][1] === d.zoneId) {
      s.getRange(i + 1, 3, 1, 2).setValues([[qty, nowIso()]]);
      return { ok: true };
    }
  }
  s.appendRow([d.productId, d.zoneId, qty, nowIso()]);
  return { ok: true };
}

// Removes a product from a zone entirely (used when something was filed in the wrong spot)
function removeFromZone(d) {
  const s = sh(TAB_COUNTS), rows = s.getDataRange().getValues();
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === d.productId && rows[i][1] === d.zoneId) s.deleteRow(i + 1);
  }
  return { ok: true };
}

// Adds a new product to the catalog, optionally placing it straight into a zone with a count
function addProduct(d) {
  if (!d.brand && !d.line && !d.shade) throw new Error('Product needs at least a brand, line, or shade.');
  const s = sh(TAB_PRODUCTS);
  const ids = readRows(TAB_PRODUCTS).map(r => Number(String(r.ProductID).replace('P', '')) || 0);
  const id = 'P' + String((ids.length ? Math.max.apply(null, ids) : 0) + 1).padStart(3, '0');
  s.appendRow([id, d.category || 'Retail', d.brand || '', d.line || '', d.subType || '',
    d.shade || '', cleanQty(d.par != null ? d.par : 1), d.price || '', d.verify ? 'Y' : '', d.notes || '', 'Y']);
  if (d.zoneId) sh(TAB_COUNTS).appendRow([id, d.zoneId, cleanQty(d.qty || 0), nowIso()]);
  return { ok: true, productId: id };
}

// Updates any editable field on a product (par, price, verify flag, names, active/archived)
function updateProduct(d) {
  const s = sh(TAB_PRODUCTS), rows = s.getDataRange().getValues(), head = rows[0];
  const col = {}; head.forEach((h, i) => col[h] = i + 1);
  const editable = { category: 'Category', brand: 'Brand', line: 'Line', subType: 'SubType',
    shade: 'Shade', par: 'Par', price: 'Price', verify: 'Verify', notes: 'Notes', active: 'Active' };
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === d.productId) {
      Object.keys(editable).forEach(k => {
        if (d[k] !== undefined) {
          let v = d[k];
          if (k === 'verify' || k === 'active') v = v ? 'Y' : '';
          if (k === 'par') v = cleanQty(v);
          s.getRange(i + 1, col[editable[k]]).setValue(v);
        }
      });
      return { ok: true };
    }
  }
  throw new Error('Product not found: ' + d.productId);
}

// Creates a new zone at the end of the walk order
function addZone(d) {
  if (!d.name) throw new Error('Zone needs a name.');
  const zones = readRows(TAB_ZONES);
  const ids = zones.map(z => Number(String(z.ZoneID).replace('Z', '')) || 0);
  const id = 'Z' + ((ids.length ? Math.max.apply(null, ids) : 0) + 1);
  const order = (zones.length ? Math.max.apply(null, zones.map(z => Number(z.SortOrder) || 0)) : 0) + 1;
  sh(TAB_ZONES).appendRow([id, d.name, order, 'Y']);
  return { ok: true, zoneId: id };
}

// Renames, reorders, or hides a zone
function updateZone(d) {
  const s = sh(TAB_ZONES), rows = s.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === d.zoneId) {
      if (d.name !== undefined) s.getRange(i + 1, 2).setValue(d.name);
      if (d.sortOrder !== undefined) s.getRange(i + 1, 3).setValue(Number(d.sortOrder));
      if (d.active !== undefined) s.getRange(i + 1, 4).setValue(d.active ? 'Y' : '');
      return { ok: true };
    }
  }
  throw new Error('Zone not found: ' + d.zoneId);
}

// Logs a restock (stock received) for a product
function addRestock(d) {
  const qty = cleanQty(d.qty);
  if (qty <= 0) throw new Error('Restock quantity must be more than zero.');
  const ids = readRows(TAB_RESTOCKS).map(r => Number(r.RestockID) || 0);
  const id = (ids.length ? Math.max.apply(null, ids) : 0) + 1;
  sh(TAB_RESTOCKS).appendRow([id, nowIso(), d.productId, qty, d.note || '']);
  return { ok: true, restockId: id };
}

// Deletes a restock entry (undo for a mis-tap)
function deleteRestock(d) {
  const s = sh(TAB_RESTOCKS), rows = s.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(d.restockId)) { s.deleteRow(i + 1); return { ok: true }; }
  }
  throw new Error('Restock entry not found.');
}

// Closes out a count: freezes the current ZoneCounts as a new dated snapshot
function finishCount(d) {
  const ids = readRows(TAB_SNAPSHOTS).map(r => Number(r.SnapshotID) || 0);
  const id = (ids.length ? Math.max.apply(null, ids) : 0) + 1;
  sh(TAB_SNAPSHOTS).appendRow([id, nowIso(), 'closed', d.notes || '']);
  const lines = sh(TAB_LINES);
  const out = readRows(TAB_COUNTS).map(c => [id, c.ProductID, c.ZoneID, Number(c.Qty) || 0]);
  if (out.length) lines.getRange(lines.getLastRow() + 1, 1, out.length, 4).setValues(out);
  return { ok: true, snapshotId: id };
}

/* ============================================================
 * HELPERS
 * ============================================================ */

// Gets a tab by name, with a readable error if it is missing
function sh(name) {
  const s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!s) throw new Error('Missing tab: ' + name + '. Run seedDatabase() first.');
  return s;
}

// Reads a whole tab into an array of objects keyed by the header row
function readRows(name) {
  const v = sh(name).getDataRange().getValues();
  const head = v[0];
  return v.slice(1).filter(r => r[0] !== '').map(r => {
    const o = {};
    head.forEach((h, i) => o[h] = r[i]);
    return o;
  });
}

// Rounds a quantity to the nearest half unit and blocks negatives
function cleanQty(q) {
  const n = Number(q);
  if (isNaN(n) || n < 0) throw new Error('Quantity must be zero or a positive number.');
  return Math.round(n * 2) / 2;
}

// Current timestamp as an ISO string
function nowIso() { return new Date().toISOString(); }

// Wraps a result object as a JSON web response
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
 * ONE-TIME SETUP — run seedDatabase() once, then never again
 * ============================================================ */

// Builds all tabs and seeds zones, all 222 products, current counts, and Snapshot #0
function seedDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(TAB_PRODUCTS)) throw new Error('Database already exists — seeding skipped.');

  const make = (name, headers) => {
    const s = ss.insertSheet(name);
    s.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    s.setFrozenRows(1);
    return s;
  };
  const pTab = make(TAB_PRODUCTS, ['ProductID','Category','Brand','Line','SubType','Shade','Par','Price','Verify','Notes','Active']);
  const zTab = make(TAB_ZONES, ['ZoneID','Name','SortOrder','Active']);
  const cTab = make(TAB_COUNTS, ['ProductID','ZoneID','Qty','LastUpdated']);
  const sTab = make(TAB_SNAPSHOTS, ['SnapshotID','Date','Status','Notes']);
  const lTab = make(TAB_LINES, ['SnapshotID','ProductID','ZoneID','Qty']);
  make(TAB_RESTOCKS, ['RestockID','Date','ProductID','Qty','Note']);

  // Starting zones — she can rename, reorder, and add more in the app
  const zones = [
    ['Z1','Retail Shelves',1,'Y'],
    ['Z2','Color Shelves',2,'Y'],
    ['Z3','Back Bar',3,'Y'],
    ['Z4','Storage Cabinet',4,'Y'],
    ['Z5','Mixing Station Cabinets',5,'Y']
  ];
  zTab.getRange(2, 1, zones.length, 4).setValues(zones);

  // Seed rows: [zone, category, brand, line, subType, shade, count, price, verify, notes]
  const S = [
    // ---------- RETAIL (Retail Shelves) ----------
    ['Z1','Retail','MoroccanOil','Shampoo','','Frizz',3,11.20,0,''],
    ['Z1','Retail','MoroccanOil','Shampoo','','Color Care',2,14.00,0,''],
    ['Z1','Retail','MoroccanOil','Shampoo','','Hydrate',0,13.50,0,''],
    ['Z1','Retail','MoroccanOil','Shampoo','','Moisture Repair',3,14.00,0,''],
    ['Z1','Retail','MoroccanOil','Shampoo','','Purple',0,14.00,0,''],
    ['Z1','Retail','MoroccanOil','Conditioner','','Frizz Control',0,11.20,0,''],
    ['Z1','Retail','MoroccanOil','Conditioner','','Leave In',3,16.00,0,''],
    ['Z1','Retail','MoroccanOil','Conditioner','','Purple',0,14.00,0,''],
    ['Z1','Retail','MoroccanOil','Conditioner','','Color Care',4,14.00,0,''],
    ['Z1','Retail','MoroccanOil','Conditioner','','Hydrate',3,13.50,0,''],
    ['Z1','Retail','MoroccanOil','Conditioner','','Moisture Repair',3,14.00,0,''],
    ['Z1','Retail','MoroccanOil','Treatment','','Light',0,17.00,0,''],
    ['Z1','Retail','MoroccanOil','Treatment','','Original',0,17.00,0,''],
    ['Z1','Retail','MoroccanOil','Treatment','','Purple',0,19.00,0,''],
    ['Z1','Retail','MoroccanOil','Treatment','','Dry Scalp',0,20.00,0,''],
    ['Z1','Retail','MoroccanOil','Mask','','Copper',0,15.00,0,''],
    ['Z1','Retail','MoroccanOil','Mask','','Restore',2,22.50,0,''],
    ['Z1','Retail','MoroccanOil','Lotion','','Smoothing',1,14.40,0,''],
    ['Z1','Retail','MoroccanOil','Lotion','','Smoothing Travel',0,8.00,0,''],
    ['Z1','Retail','MoroccanOil','Spray','','Texture 50% Dry',3,16.00,0,''],
    ['Z1','Retail','MoroccanOil','Spray','','Strong 49%',0,14.00,0,''],
    ['Z1','Retail','MoroccanOil','Spray','','Perfect Defense',1,16.00,0,'Photo label: MO-Spray P. Defence'],
    ['Z1','Retail','MoroccanOil','Spray','','Luminous',3,'',1,'Verify price'],
    ['Z1','Retail','MoroccanOil','Spray','','Frizz Shield',1,'',1,'Verify price'],
    ['Z1','Retail','MoroccanOil','Mousse','','Curl Control',1,'',1,'Verify price'],
    ['Z1','Retail','MoroccanOil','Cream','','Intense Curl',1,'',1,'Verify price'],
    ['Z1','Retail','MoroccanOil','Cream','','Hydrate',0,'',1,'Verify price'],
    ['Z1','Retail','MoroccanOil','Travel Set','','Body',2,29.00,0,''],
    ['Z1','Retail','MoroccanOil','Travel Set','','Hydrate',1,29.00,0,''],
    ['Z1','Retail','Joico','Shampoo','','',2,'',1,'Verify variant + price'],
    ['Z1','Retail','Joico','Conditioner','','Leave-in',3,'',1,'Verify price'],
    ['Z1','Retail','Davines','Conditioner','','Perfect Leave',3,'',1,'Verify price'],
    ['Z1','Retail','Davines','Shampoo','','',2,'',1,'Verify variant + price'],
    ['Z1','Retail','Davines','Conditioner','','',1,'',1,'Verify variant + price'],
    ['Z1','Retail','Davines','Spray','','Heat Protector',1,'',1,'Verify exact product + price'],
    ['Z1','Retail','Unknown','Mousse','','Curl',1,'',1,'Verify brand'],
    ['Z1','Retail','Unknown','Cream','','Curl',1,'',1,'Verify brand'],
    ['Z1','Retail','Unknown','Conditioner','','Leave Almond?',3,'',1,'Verify brand + product'],
    ['Z1','Retail','Unknown','Spray','','Texturizing',1,'',1,'Verify brand'],
    // ---------- BACK BAR (Back Bar) ----------
    ['Z3','Back Bar','Joico','Shampoo','','Defy',8,'',1,'Count looks like 8 — verify'],
    ['Z3','Back Bar','Joico','Conditioner','','Defy',7,'',1,'7+1 on photo — verify'],
    ['Z3','Back Bar','Joico','Treatment','Deep','K-Bond 2.0',1.5,'',0,'Partial bottle'],
    ['Z3','Back Bar','Joico','Spray','Deep','Deep Cond Spray',1,'',0,''],
    ['Z3','Back Bar','Olaplex','Shampoo','','Purple',2,'',0,''],
    ['Z3','Back Bar','Olaplex','Conditioner','','Purple',1,'',0,''],
    ['Z3','Back Bar','Olaplex','Shampoo','','Nourish',1,'',0,''],
    ['Z3','Back Bar','Olaplex','Conditioner','','Nourish',1,'',0,''],
    ['Z3','Back Bar','Olaplex','Conditioner','','Moisture',1,'',0,''],
    ['Z3','Back Bar','Olaplex','Conditioner','Bond','B-light Bond Cond',1,'',0,''],
    ['Z3','Back Bar','MoroccanOil','Shampoo','','',1,'',1,'Verify variant'],
    ['Z3','Back Bar','MoroccanOil','Conditioner','','',1,'',1,'Verify variant'],
    ['Z3','Back Bar','K-18','Spray','','Mist',5,'',0,''],
    ['Z3','Back Bar','K-18','Leave-in','','',1,'',1,'Verify exact product'],
    ['Z3','Back Bar','Biolage','Shampoo','','Scalp',1,'',1,'From margin notes — verify'],
    ['Z3','Back Bar','Biolage','Conditioner','','Scalp',1,'',1,'From margin notes — verify'],
    // ---------- COLOR — MoroccanOil Rhapsody Permanent (Color Shelves) ----------
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','2B',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','2N',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','3N',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','4C',4,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','4CH',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','4G',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','4N',6,8.50,1,'Possibly 16 — ink blot on photo'],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','4NN',4,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','4R',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','4RV',3,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','4V',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','5G',0,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','5GC',4,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','5N',0,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','5NN',5,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','5RR',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6B',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6BV',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6C',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6CG',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6CH',5,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6G',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6GYV',0,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6N',6,8.50,0,'Photo: 5+1'],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6NB',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6NCH',0,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6NG',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6NN',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6R',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','6V',3,8.50,0,'Photo: 1+2'],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','7C',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','7CH',3,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','7G',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','7G PERM',0,8.50,1,'Duplicate of 7G? — verify'],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','7GC',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','7N',3,8.50,1,'Smudged on photo — verify'],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','7NN',4,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','8C',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','8CG',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','8N',2,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','8NN',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','9GC',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','9N',2,8.50,0,'Photo: 1+1'],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','HiLift HLB',1,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','HiLift HLN',0,8.50,0,''],
    ['Z2','Color','MoroccanOil','Rhapsody','Permanent','HiLift HLV',0,8.50,0,''],
    // ---------- COLOR — MoroccanOil Calypso Demi ----------
    ['Z2','Color','MoroccanOil','Calypso','Demi','2B',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','2N',3,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','3N',0,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','4N',2,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','4R',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','4V',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','5C',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','5N',3,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','6B',3,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','6GYV',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','6N',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','6V',3,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','7C',2,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','7VB',3,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','8C',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','8G',2,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','9N',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','9V',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','9VB',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','9VV',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','10G',1,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','10N',3,7.00,0,''],
    ['Z2','Color','MoroccanOil','Calypso','Demi','10V',4,7.00,0,''],
    // ---------- COLOR — MoroccanOil Infuse Boosters ----------
    ['Z2','Color','MoroccanOil','Infuse','Booster','MXR Blue',1,5.00,0,''],
    ['Z2','Color','MoroccanOil','Infuse','Booster','MXR Green',1,5.00,0,''],
    // ---------- COLOR — Schwarzkopf ----------
    ['Z2','Color','Schwarzkopf','Igora Royal','Permanent','4-99 EIS',1,'',1,'Verify shade code'],
    ['Z2','Color','Schwarzkopf','Vibrance','Demi','6-99',2,'',1,'Verify price'],
    ['Z2','Color','Schwarzkopf','Vibrance','Demi','0-99',1,'',1,'Verify price'],
    ['Z2','Color','Schwarzkopf','Vibrance','Demi','5-00',1,'',1,'Verify price'],
    ['Z2','Color','Schwarzkopf','Vibrance','Demi','7-9',1,'',1,'Could be 7-9 or 7-99 — verify'],
    ['Z2','Color','Schwarzkopf','Festival Lights','Hi-Lift','L89',1,'',1,'Verify price'],
    ['Z2','Color','Schwarzkopf','Festival Lights','Hi-Lift','L88',4,'',1,'Verify price'],
    // ---------- COLOR — Joico Vero K-Pak ----------
    ['Z2','Color','Joico','Vero K-Pak','Demi','7NM',3,'',1,'Verify line + price'],
    ['Z2','Color','Joico','Vero K-Pak','Demi','5NM',2,'',1,'Verify line + price'],
    ['Z2','Color','Joico','Vero K-Pak','Demi','6NM',1,'',1,'Verify line + price'],
    // ---------- COLOR — Calura (Oligo) ----------
    ['Z2','Color','Calura','Glaze 10','Demi','3N',1,'',1,'Verify line name + price'],
    ['Z2','Color','Calura','Glaze 10','Demi','5N',2,'',1,'Verify'],
    ['Z2','Color','Calura','Glaze 10','Demi','6N',1,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','5-44',1,'',1,'Verify price'],
    ['Z2','Color','Calura','Permanent','Permanent','5-4',1,'',1,'Verify price'],
    ['Z2','Color','Calura','Permanent','Permanent','5-55',1,'',1,'Verify price'],
    ['Z2','Color','Calura','Permanent','Permanent','5-556',1,'',1,'Unusual shade code — verify'],
    ['Z2','Color','Calura','Permanent','Permanent','3R',2,'',1,'Verify line'],
    ['Z2','Color','Calura','Permanent','Permanent','3N',1,'',1,'Possible duplicate of Glaze 10 3N'],
    ['Z2','Color','Calura','Permanent','Permanent','5K',3,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','5N',1,'',1,'Possible duplicate'],
    ['Z2','Color','Calura','Permanent','Permanent','5V',1,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','6A',6,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','6AA',3,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','6GK',4,'',1,'Verify shade code'],
    ['Z2','Color','Calura','Permanent','Permanent','6N',5,'',1,'Possible duplicate'],
    ['Z2','Color','Calura','Permanent','Permanent','6R',3,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','7G',4,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','7N',4,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','8A',4,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','8AA',3,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','8GV',3,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','8K',3,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','8N',6,'',1,'Photo: 5+1'],
    ['Z2','Color','Calura','Permanent','Permanent','9AI',4,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','9GI',6,'',1,'4+2 — verify 9GI vs 9GJ'],
    ['Z2','Color','Calura','Permanent','Permanent','9GV',10,'',1,'Photo: 5+5 — verify'],
    ['Z2','Color','Calura','Permanent','Permanent','9N',4,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','9V',5,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','10AI',4,'',1,'Verify'],
    ['Z2','Color','Calura','Permanent','Permanent','10N',7,'',1,'Photo: 4+3'],
    ['Z2','Color','Calura','Permanent','Permanent','10V',6,'',1,'Photo: 4+2'],
    // ---------- COLOR — Danger Jones Semi ----------
    ['Z2','Color','Danger Jones','','Semi','Ivory',1,'',1,'Verify price'],
    ['Z2','Color','Danger Jones','','Semi','Grey',1,'',1,'Verify price'],
    ['Z2','Color','Danger Jones','','Semi','Blue Add',1,'',1,'Verify price'],
    ['Z2','Color','Danger Jones','','Semi','Masquerade',2,'',1,'Verify price'],
    ['Z2','Color','Danger Jones','','Semi','Diablo',1,'',1,'Verify price'],
    ['Z2','Color','Danger Jones','','Semi','Solitude',1,'',1,'Verify price'],
    ['Z2','Color','Danger Jones','','Semi','Hustler',3,'',1,'Verify price'],
    ['Z2','Color','Danger Jones','','Semi','Mug Shot',1,'',1,'Verify name + price'],
    ['Z2','Color','Danger Jones','','Semi','Love Sicle',1,'',1,'Verify name + price'],
    ['Z2','Color','Danger Jones','','Semi','Pool Side',1,'',1,'Verify price'],
    ['Z2','Color','Danger Jones','','Semi','Libertine',1,'',1,'Verify price'],
    // ---------- DEVELOPER (Storage Cabinet) ----------
    ['Z4','Developer','MoroccanOil','Calypso','','7V',0,5.76,0,''],
    ['Z4','Developer','MoroccanOil','Calypso','Demi Activator','',1,'',0,'From margin notes'],
    ['Z4','Developer','MoroccanOil','','','20V',2,5.76,0,'Includes 1 from margin'],
    ['Z4','Developer','MoroccanOil','','','30V',1,'',1,'Verify price'],
    ['Z4','Developer','MoroccanOil','','','40V',1,'',1,'Verify price'],
    ['Z4','Developer','Olaplex','B-Light','','20V',1,'',1,'Photo: 20V + 40 vol 1+1 — verify'],
    ['Z4','Developer','Olaplex','B-Light','','40V',1,'',0,''],
    ['Z4','Developer','Oligo','','Lotion','7V',1,'',1,'Verify price'],
    ['Z4','Developer','Oligo','','','Clear',1,'',0,''],
    ['Z4','Developer','Oligo','','','13V',1,'',0,''],
    ['Z4','Developer','Oligo Black','','Crème','7V',1,'',0,''],
    ['Z4','Developer','Oligo Black','','','10V',1,'',0,''],
    ['Z4','Developer','Oligo Black','','','20V',2,'',0,''],
    ['Z4','Developer','Oligo Black','','','30V',1,'',0,''],
    ['Z4','Developer','Oligo Black','','Lotion','7V',1,'',0,''],
    ['Z4','Developer','Joico','','Transform','',2,'',1,'Verify shade/volume'],
    ['Z4','Developer','Joico','','','',1,'',1,'Second J-Dev row from photo — verify'],
    ['Z4','Developer','Goldwell','','','6V',1,'',1,'Verify price'],
    ['Z4','Developer','Schwarzkopf','BlondMe','','40V',1,'',1,'Verify price'],
    ['Z4','Developer','Schwarzkopf','Vibrance','','6V',1,'',0,'Photo label: Sch-Vito 6V'],
    ['Z4','Developer','Chi','','','5V',1,'',1,'Verify price'],
    ['Z4','Developer','Chi','','','20V',1,'',0,''],
    ['Z4','Developer','Unknown','','','10V',1,'',1,'Brand unmarked'],
    ['Z4','Developer','Unknown','','','15V',1,'',1,'Brand unmarked'],
    ['Z4','Developer','Unknown','','','13V',1,'',1,'Brand unmarked'],
    // ---------- BLEACH / LIGHTENERS (Mixing Station Cabinets) ----------
    ['Z5','Bleach & Treatment','MoroccanOil','Blonde Voyage','Lightener','',2,18.72,0,''],
    ['Z5','Bleach & Treatment','Olaplex','B-Light','Clay Lightener','',1,'',1,'Verify price'],
    ['Z5','Bleach & Treatment','Olaplex','B-Light','Crème Lightener','',1,'',1,'Verify price'],
    ['Z5','Bleach & Treatment','Olaplex','B-Light','San Blonde','',1,'',1,'Verify price'],
    ['Z5','Bleach & Treatment','Chi','','Infused Lightener','',1,'',1,'Verify price'],
    // ---------- TREATMENTS (Back Bar) ----------
    ['Z3','Bleach & Treatment','Malibu','','','Scalp',1,'',1,'Verify price'],
    ['Z3','Bleach & Treatment','Malibu','','','CPR',1,'',1,'Verify price'],
    ['Z3','Bleach & Treatment','B-Blowout','','Step 2','',1,'',1,'Verify price'],
    ['Z3','Bleach & Treatment','B-Blowout','','Step 3','',1,'',0,''],
    ['Z3','Bleach & Treatment','B-Blowout','','Cleanser','',1,'',0,''],
    ['Z3','Bleach & Treatment','B-Blowout','','Deep Cond Masque','',2,'',0,''],
    ['Z3','Bleach & Treatment','B-Blowout','','Leave Cond','',1,'',0,''],
    ['Z3','Bleach & Treatment','B-Blowout','','Conditioner','',2,'',0,''],
    ['Z3','Bleach & Treatment','B-Blowout','','Shampoo','',2,'',0,''],
    ['Z3','Bleach & Treatment','B-Blowout','','Treatment','',1,'',0,'From margin: B. Blowout 1'],
    ['Z3','Bleach & Treatment','Barbicide','','Disinfectant','',0.5,'',0,'Half bottle'],
    // ---------- SUPPLIES (Storage Cabinet) ----------
    ['Z4','Supplies','','','Foils','Roll',1,'',1,'Verify size + price'],
    ['Z4','Supplies','','','Foils','Box',1,'',1,'Verify size + price']
  ];

  // Write products, live zone counts, and freeze everything as Snapshot #0
  const now = nowIso();
  const pRows = [], cRows = [], lRows = [];
  S.forEach((r, i) => {
    const id = 'P' + String(i + 1).padStart(3, '0');
    pRows.push([id, r[1], r[2], r[3], r[4], r[5], 1, r[7], r[8] ? 'Y' : '', r[9], 'Y']);
    cRows.push([id, r[0], r[6], now]);
    lRows.push([0, id, r[0], r[6]]);
  });
  pTab.getRange(2, 1, pRows.length, 11).setValues(pRows);
  cTab.getRange(2, 1, cRows.length, 4).setValues(cRows);
  sTab.getRange(2, 1, 1, 4).setValues([[0, now, 'closed', 'Initial import from original spreadsheet']]);
  lTab.getRange(2, 1, lRows.length, 4).setValues(lRows);

  // Remove the default empty tab if it is still there
  const def = ss.getSheetByName('Sheet1');
  if (def) ss.deleteSheet(def);
}