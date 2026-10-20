// Copies an .xlsx export of the Google Sheet into Neon.
// Usage: npm run db:import -- "C:\path\to\Salon Asteria Inventory DB.xlsx"
// Replaces every table's contents in one transaction, so a failure leaves the
// database as it was. Refuses to run after the switch (cutover table): Neon then
// holds rows the sheet does not.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import ExcelJS from 'exceljs';
import { Client } from '@neondatabase/serverless';
import { TABS, SKIPPED_TABS, SHEET_TIMEZONE, readTab, sheetText, isTypedCodeDate } from '../lib/sheet-tabs.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run db:import -- "<path to the .xlsx>"');
  process.exit(1);
}

// Sign-ins start over after an import: the Apps Script's tokens are not copied.
const ALSO_EMPTY = ['login_failures', 'sessions'];

const SQL_TYPE = { text: 'text', int: 'integer', float: 'double precision', iso: 'timestamptz' };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function convert(type, v, numFmt, where) {
  const empty = v === null || v === undefined || v === '';
  const fail = () => { throw new Error(`${where}: cannot read ${JSON.stringify(v)} as ${type}.`); };
  switch (type) {
    case 'text':
      if (empty) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (isTypedCodeDate(v, numFmt)) return sheetText(v);
      return fail();
    case 'int':
    case 'float': {
      if (empty) return null;
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
      if (!Number.isFinite(n) || (type === 'int' && !Number.isInteger(n))) return fail();
      return n;
    }
    case 'iso':
      if (empty) return null;
      if (typeof v !== 'string' || !ISO.test(v)) return fail();
      return v;
  }
}

const buf = await readFile(file);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf);

const known = new Set([...TABS.map(t => t.tab), ...Object.keys(SKIPPED_TABS)]);
for (const ws of wb.worksheets) {
  if (!known.has(ws.name)) throw new Error(`Tab "${ws.name}" is not mapped in lib/sheet-tabs.mjs.`);
}
for (const name of Object.keys(SKIPPED_TABS)) {
  const ws = wb.getWorksheet(name);
  if (ws && readTab(ws).rows.length) throw new Error(`Tab "${name}" is skipped (${SKIPPED_TABS[name]}) but holds data.`);
}

const loads = TABS.map(({ tab, table, columns }) => {
  const ws = wb.getWorksheet(tab);
  if (!ws) throw new Error(`Tab "${tab}" is missing from the export.`);
  const { headers, rows } = readTab(ws);
  const expected = columns.map(c => c[0]);
  const unmapped = headers.filter(h => !expected.includes(h));
  const missing = expected.filter(h => !headers.includes(h));
  if (unmapped.length || missing.length || new Set(headers).size !== headers.length) {
    throw new Error(`Tab "${tab}" headers do not match the map. Unmapped: ${unmapped.join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}.`);
  }
  const records = rows.map(({ sheetRow, cells, formats }) => {
    const rec = { id: sheetRow };
    for (const [header, column, type] of columns) {
      rec[column] = convert(type, cells[header], formats[header], `Tab "${tab}" row ${sheetRow} column "${header}"`);
    }
    return rec;
  });
  return { table, columns, records };
});

const client = new Client(process.env.DATABASE_URL_UNPOOLED);
await client.connect();
const { rows: [lock] } = await client.query('SELECT done_at FROM cutover');
if (lock) {
  await client.end();
  throw new Error(`Neon has been the live database since ${lock.done_at.toISOString()}. Importing the sheet would erase everything saved since, so the importer is locked.`);
}
try {
  await client.query('BEGIN');
  await client.query(`TRUNCATE ${[...TABS.map(t => t.table), ...ALSO_EMPTY].join(', ')} RESTART IDENTITY`);
  for (const { table, columns, records } of loads) {
    const names = columns.map(([, col]) => `"${col}"`);
    const values = columns.map(([, col]) => `r."${col}"`);
    const shape = ['id integer', ...columns.map(([, col, type]) => `"${col}" ${SQL_TYPE[type]}`)];
    await client.query(
      `INSERT INTO ${table} (id, ${names.join(', ')}) SELECT r.id, ${values.join(', ')} FROM jsonb_to_recordset($1::jsonb) AS r(${shape.join(', ')})`,
      [JSON.stringify(records)]);
    await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce(max(id), 0) + 1, false) FROM ${table}`);
  }
  const counts = Object.fromEntries(loads.map(l => [l.table, l.records.length]));
  await client.query(
    'INSERT INTO sheet_imports (source_file, source_sha256, sheet_timezone, row_counts) VALUES ($1, $2, $3, $4)',
    [basename(file), createHash('sha256').update(buf).digest('hex'), SHEET_TIMEZONE, JSON.stringify(counts)]);
  await client.query('COMMIT');
  console.table(loads.map(l => ({ tab: TABS.find(t => t.table === l.table).tab, table: l.table, rows: l.records.length })));
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
