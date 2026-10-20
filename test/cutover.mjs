// The switch tools, end to end, on Neon:
//   1. the export round-trips: after real writes, export -> import -> every table identical;
//   2. the importer lock: once locked, an import refuses and changes nothing.
// Usage: node --env-file=.env.local test/cutover.mjs "<path to the sheet export .xlsx>"
// Reloads Neon from that export afterwards and clears the lock. Never run it after the switch.
import { execFileSync } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { TABS } from '../lib/sheet-tabs.mjs';
import { buildWorkbook } from '../lib/export-workbook.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node --env-file=.env.local test/cutover.mjs "<path to the sheet export .xlsx>"');
  process.exit(1);
}
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sql = neon(process.env.DATABASE_URL);
const run = (script, arg) => execFileSync(process.execPath, ['--env-file=.env.local', script, arg], { cwd: ROOT, stdio: 'pipe' });
const exported = join(tmpdir(), `asteria-roundtrip-${Date.now()}.xlsx`);
let checks = 0;
const failures = [];
function record(label, problems) {
  checks++;
  if (problems.length) { failures.push(label); console.log('FAIL ' + label); problems.slice(0, 8).forEach(p => console.log('     ' + p)); }
}

// Every mapped table's rows in order, without the row id (an import renumbers
// rows after deletes) and without columns the sheet does not have.
async function contents() {
  const out = {};
  for (const { table, columns } of TABS) {
    const rows = await sql.query(`SELECT * FROM ${table} ORDER BY id`);
    out[table] = rows.map(r => Object.fromEntries(columns.map(([, c, type]) => [c, type === 'iso' && r[c] ? r[c].toISOString() : r[c]])));
  }
  return out;
}
function compare(a, b) {
  const problems = [];
  for (const table of Object.keys(a)) {
    if (a[table].length !== b[table].length) { problems.push(`${table}: ${a[table].length} rows before, ${b[table].length} after`); continue; }
    a[table].forEach((row, i) => {
      if (JSON.stringify(row) !== JSON.stringify(b[table][i])) problems.push(`${table} row ${i + 1}: ${JSON.stringify(row).slice(0, 120)} vs ${JSON.stringify(b[table][i]).slice(0, 120)}`);
    });
  }
  return problems;
}

try {
  run('scripts/import-sheet.mjs', file);
  process.env.APP_PASSWORD = '4719';
  const { default: api } = await import('../api/index.js');
  const call = async body => (await api.fetch(new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) }))).json();
  const { token } = await call({ action: 'login', data: { password: '4719' } });
  const writes = [
    { action: 'setCount', data: { productId: 'P001', zoneId: 'Z1', qty: 1.5 } },
    { action: 'addProduct', data: { clientId: 'tmpP_zz1', category: 'Color', brand: 'Zz Brand', shade: '10-2', price: 8.5, notes: 'Zz', zoneId: 'Z2', qty: 2 } },
    { action: 'updateProduct', data: { productId: 'P002', price: null, notes: 'Zz edited' } },
    { action: 'addZone', data: { clientId: 'tmpZ_zz1', name: 'Zz Shelf' } },
    { action: 'restock', data: { clientId: 'tmpR_zz1', productId: 'P001', qty: 2, note: 'Zz' } },
    { action: 'restock', data: { clientId: 'tmpR_zz2', productId: 'P003', qty: 1 } },
    { action: 'deleteRestock', data: { restockId: 2 } },
    { action: 'removeFromZone', data: { productId: 'P004', zoneId: 'Z1' } },
    { action: 'finishCount', data: { notes: 'Zz count' } },
  ];
  const answers = [];
  for (const w of writes) answers.push(await call({ token, ...w }));
  record('setup writes all succeeded', answers.filter(a => a.error).map(a => a.error));

  const before = await contents();
  await writeFile(exported, await buildWorkbook(sql));
  run('scripts/import-sheet.mjs', exported);
  const after = await contents();
  record('export -> import: every table identical', compare(before, after));
  const shade = after.products.find(p => p.brand === 'Zz Brand')?.shade;
  record('a shade like 10-2 stays text through the round trip', shade === '10-2' ? [] : ['shade came back as ' + JSON.stringify(shade)]);
  let verified = true;
  try { run('scripts/verify-import.mjs', exported); } catch { verified = false; }
  record('the verifier passes on the exported file', verified ? [] : ['verify-import failed']);

  run('scripts/lock-import.mjs', 'Zz test lock');
  const locked = await contents();
  let refused = false;
  try { run('scripts/import-sheet.mjs', file); } catch (e) { refused = /importer is locked/.test(String(e.stderr)); }
  record('once locked, the importer refuses', refused ? [] : ['the import ran or failed for another reason']);
  record('a refused import changes nothing', compare(locked, await contents()));
} finally {
  await sql`DELETE FROM cutover`;
  run('scripts/import-sheet.mjs', file);
  await rm(exported, { force: true });
}
console.log(`\n${checks - failures.length} of ${checks} checks matched. Lock cleared, Neon reloaded from the export.`);
if (failures.length) console.log('FAILED: ' + failures.join('; '));
process.exit(failures.length ? 1 : 0);
