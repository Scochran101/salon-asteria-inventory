// Checks a Neon import against the .xlsx it came from.
// Usage: npm run db:verify -- "C:\path\to\Salon Asteria Inventory DB.xlsx"
//   1. The newest sheet_imports row is this exact file (sha256).
//   2. Every tab: same rows, same sheet row numbers, every cell equal; the next
//      new id continues after the last row.
// The live API is not compared: every read needs the real PIN.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { neon } from '@neondatabase/serverless';
import { TABS, readTab, sheetText } from '../api/_lib/sheet-tabs.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run db:verify -- "<path to the .xlsx>"');
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);
const rowsOf = table => sql.query(`SELECT * FROM ${table} ORDER BY id`);
const failures = [];
const fail = msg => { if (failures.push(msg) <= 25) console.log('  MISMATCH', msg); };

// ---- 1. Which export is loaded -------------------------------------------
const buf = await readFile(file);
const sha = createHash('sha256').update(buf).digest('hex');
const [latest] = await sql`SELECT source_sha256, imported_at FROM sheet_imports ORDER BY id DESC LIMIT 1`;
if (!latest || latest.source_sha256 !== sha) fail('the newest import in Neon is not this file');
console.log(`1. Loaded export: ${latest?.source_sha256 === sha ? 'this file' : 'DIFFERENT FILE'} (imported ${latest?.imported_at?.toISOString()})`);

// ---- 2. Cell by cell -------------------------------------------------------
const isEmpty = v => v === null || v === undefined || v === '';
function expected(type, v) {
  switch (type) {
    case 'text': return isEmpty(v) ? '' : sheetText(v);
    case 'int': case 'float': return isEmpty(v) ? null : Number(v);
    case 'iso': return isEmpty(v) ? null : Date.parse(v);
  }
}
const actual = (type, d) => type === 'iso' ? (d === null ? null : d.getTime()) : d;

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);
let cells = 0;
console.log('2. Cell-by-cell against the export:');
for (const { tab, table, columns } of TABS) {
  const { rows } = readTab(wb.getWorksheet(tab));
  const db = await rowsOf(table);
  if (db.length !== rows.length) fail(`${tab}: ${rows.length} sheet rows, ${db.length} in ${table}`);
  rows.forEach(({ sheetRow, cells: src }, i) => {
    const got = db[i];
    if (!got || got.id !== sheetRow) return fail(`${tab} row ${sheetRow}: ${table} has id ${got?.id} at that position`);
    for (const [header, column, type] of columns) {
      cells++;
      const want = expected(type, src[header]);
      const have = actual(type, got[column]);
      if (JSON.stringify(want) !== JSON.stringify(have)) fail(`${tab} row ${sheetRow} "${header}": sheet ${JSON.stringify(want)}, ${table}.${column} ${JSON.stringify(have)}`);
    }
  });
  const [{ seq }] = await sql.query(`SELECT pg_get_serial_sequence('${table}', 'id') AS seq`);
  const [s] = await sql.query(`SELECT last_value, is_called FROM ${seq}`);
  const next = Number(s.last_value) + (s.is_called ? 1 : 0);
  const maxId = db.length ? db[db.length - 1].id : 0;
  if (next !== maxId + 1) fail(`${table}: next new id would be ${next}, expected ${maxId + 1}`);
}
console.log(`   ${cells} cells in ${TABS.length} tabs checked`);

console.log(failures.length ? `\nFAILED: ${failures.length} mismatch(es).` : '\nPASSED: every check matched.');
process.exit(failures.length ? 1 : 0);
