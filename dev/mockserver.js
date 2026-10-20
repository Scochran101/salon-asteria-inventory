/* Serves the real app files, with SCRIPT_URL rewritten to this server's
   /api endpoint, and implements the Apps Script contract in memory.
   Everything else about app.js is byte-identical to what ships. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const PORT = 8791;

let failWrites = false;   // toggled via /_control?fail=1 to test the queue

const zones = [
  { ZoneID: 'Z1', Name: 'Colour Bar',     SortOrder: 1, Active: 'Y' },
  { ZoneID: 'Z2', Name: 'Retail Shelf',   SortOrder: 2, Active: 'Y' },
  { ZoneID: 'Z3', Name: 'Back Bar',       SortOrder: 3, Active: 'Y' },
  { ZoneID: 'Z4', Name: 'Stockroom',      SortOrder: 4, Active: 'Y' }
];

const products = [
  { ProductID: 'P1', Category: 'Color',   Brand: 'Wella',   Line: 'Koleston', SubType: 'Permanent', Shade: '7N',  Par: 3, Price: 9.5,  Verify: '',  Notes: '', Active: 'Y' },
  { ProductID: 'P2', Category: 'Color',   Brand: 'Wella',   Line: 'Koleston', SubType: 'Permanent', Shade: '6A',  Par: 3, Price: 9.5,  Verify: 'Y', Notes: 'Price transcribed from notes', Active: 'Y' },
  { ProductID: 'P3', Category: 'Retail',  Brand: 'Olaplex', Line: '',         SubType: 'Treatment', Shade: 'No.3', Par: 4, Price: 30,  Verify: '',  Notes: '', Active: 'Y' },
  { ProductID: 'P4', Category: 'Back Bar',Brand: 'Kevin Murphy', Line: 'Repair Me', SubType: 'Wash', Shade: '', Par: 2, Price: 24,   Verify: '',  Notes: '', Active: 'Y' },
  { ProductID: 'P5', Category: 'Developer',Brand: 'Wella',  Line: 'Welloxon', SubType: '20 vol',    Shade: '',    Par: 2, Price: 12,  Verify: '',  Notes: '', Active: 'Y' },
  // Category deliberately NOT in KNOWN_CATEGORIES — the old build hid this
  // from the order list while still counting it in the total.
  { ProductID: 'P6', Category: 'Tools',   Brand: 'Denman',  Line: '',         SubType: 'Brush',     Shade: 'D3',  Par: 5, Price: 18,  Verify: '',  Notes: '', Active: 'Y' },
  { ProductID: 'P7', Category: 'Supplies',Brand: 'Salon',   Line: '',         SubType: 'Foil',      Shade: '',    Par: 6, Price: 7,   Verify: '',  Notes: '', Active: 'Y' },
  { ProductID: 'P8', Category: 'Retail',  Brand: 'Olaplex', Line: '',         SubType: 'Treatment', Shade: 'No.4', Par: 3, Price: 28, Verify: '',  Notes: '', Active: 'Y' }
];

const counts = [
  { ProductID: 'P1', ZoneID: 'Z1', Qty: 4,   LastUpdated: '' },
  { ProductID: 'P2', ZoneID: 'Z1', Qty: 1.5, LastUpdated: '' },
  { ProductID: 'P5', ZoneID: 'Z1', Qty: 1,   LastUpdated: '' },
  { ProductID: 'P3', ZoneID: 'Z2', Qty: 2,   LastUpdated: '' },
  { ProductID: 'P8', ZoneID: 'Z2', Qty: 5,   LastUpdated: '' },
  { ProductID: 'P4', ZoneID: 'Z3', Qty: 3,   LastUpdated: '' },
  { ProductID: 'P6', ZoneID: 'Z4', Qty: 2,   LastUpdated: '' },
  { ProductID: 'P7', ZoneID: 'Z4', Qty: 8,   LastUpdated: '' }
];

const snapshots = [
  { SnapshotID: 1, Date: '2026-07-29T09:00:00.000Z', Status: 'closed', Notes: 'weekly count' },
  { SnapshotID: 2, Date: '2026-08-05T09:00:00.000Z', Status: 'closed', Notes: 'weekly count' }
];

const restocks = [
  { RestockID: 'R1', Date: '2026-08-02T10:00:00.000Z', ProductID: 'P1', Qty: 6, Note: '' },
  { RestockID: 'R2', Date: '2026-08-04T10:00:00.000Z', ProductID: 'P3', Qty: 4, Note: '' }
];

const report = {
  ready: true,
  previous: { id: 1, date: '2026-07-29T09:00:00.000Z' },
  current:  { id: 2, date: '2026-08-05T09:00:00.000Z' },
  rows: [
    { brand: 'Wella',   line: 'Koleston', subType: 'Permanent', shade: '7N',   usage: 5,   label: 'tubes',   restocked: 6 },
    { brand: 'Olaplex', line: '',         subType: 'Treatment', shade: 'No.3', usage: 3,   label: 'bottles', restocked: 4 },
    { brand: 'Kevin Murphy', line: 'Repair Me', subType: 'Wash', shade: '',    usage: 1.5, label: 'litres',  restocked: 0 },
    { brand: 'Salon',   line: '',         subType: 'Foil',      shade: '',     usage: 2,   label: 'boxes',   restocked: 0 },
    { brand: 'Denman',  line: '',         subType: 'Brush',     shade: 'D3',   usage: 1,   label: 'each',    restocked: 0 },
    { brand: 'Wella',   line: 'Welloxon', subType: '20 vol',    shade: '',     usage: -2,  label: 'litres',  restocked: 0 }
  ]
};

let seq = 100;
const writeLog = [];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

function json(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost:' + PORT);

  if (u.pathname === '/_control') {
    if (u.searchParams.has('fail')) failWrites = u.searchParams.get('fail') === '1';
    return json(res, { failWrites: failWrites, writes: writeLog.length, log: writeLog.slice(-30) });
  }

  if (u.pathname === '/api') {
    if (req.method === 'GET') {
      const a = u.searchParams.get('action');
      if (a === 'login') {
        return u.searchParams.get('password') === '1234'
          ? json(res, { success: true, token: 'tok-test' })
          : json(res, { success: false });
      }
      if (u.searchParams.get('token') !== 'tok-test') return json(res, { error: 'AUTH' });
      if (a === 'boot')   return json(res, { products, zones, counts, snapshots, restocks });
      if (a === 'report') return json(res, report);
      return json(res, { error: 'unknown action ' + a });
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let p; try { p = JSON.parse(body); } catch (e) { return json(res, { error: 'bad json' }); }
      if (p.token !== 'tok-test') return json(res, { error: 'AUTH' });
      writeLog.push({ action: p.action, data: p.data, at: new Date().toISOString() });
      if (failWrites) { res.writeHead(500); return res.end('simulated outage'); }

      const d = p.data || {};
      if (p.action === 'addProduct')  return json(res, { productId: 'P' + (++seq) });
      if (p.action === 'addZone')     return json(res, { zoneId: 'Z' + (++seq) });
      if (p.action === 'restock')     return json(res, { restockId: 'R' + (++seq) });
      if (p.action === 'finishCount') return json(res, { snapshotId: ++seq });
      return json(res, { ok: true });
    });
    return;
  }

  // Static files, with SCRIPT_URL swapped for the local mock.
  let f = u.pathname === '/' ? '/index.html' : u.pathname;
  const full = path.join(APP, f);
  if (!full.startsWith(path.normalize(APP))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full).toLowerCase();
    if (ext === '.js' && f.endsWith('app.js')) {
      buf = Buffer.from(String(buf).replace(
        /const SCRIPT_URL = '[^']*'/,
        "const SCRIPT_URL = 'http://localhost:" + PORT + "/api'"
      ));
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, () => console.log('mock backend on http://localhost:' + PORT));
