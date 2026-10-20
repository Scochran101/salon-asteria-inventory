// The whole database as an .xlsx laid out exactly like the old Google Sheet:
// same tabs, same headers in the same order, dates as the ISO text the Apps
// Script wrote. Importing it into the Sheet (File > Import > Replace
// spreadsheet) puts the Apps Script backend back in business, and
// scripts/import-sheet.mjs reads it back into Neon unchanged.
// Not included: client_id (retry keys) and import records, which the sheet never had.
import ExcelJS from 'exceljs';
import { TABS } from './sheet-tabs.mjs';

function cell(type, v) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'text': return v === '' ? null : v;
    case 'iso': return v.toISOString();
    default: return v;   // int, float
  }
}

export async function buildWorkbook(sql) {
  const wb = new ExcelJS.Workbook();
  for (const { tab, table, columns } of TABS) {
    const ws = wb.addWorksheet(tab);
    ws.addRow(columns.map(c => c[0]));
    const rows = await sql.query(`SELECT * FROM ${table} ORDER BY id`);
    for (const r of rows) ws.addRow(columns.map(([, column, type]) => cell(type, r[column])));
    // Text columns stay text when the file goes back into Google Sheets ("7-9" is a shade, not a date).
    columns.forEach(([, , type], i) => { if (type === 'text') ws.getColumn(i + 1).numFmt = '@'; });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
