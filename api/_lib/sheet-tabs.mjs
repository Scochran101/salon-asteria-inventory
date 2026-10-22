// Every tab of the Google Sheet and the table it copies into.
// columns: [sheet header, table column, type]
//   text  string cell ('' when empty)       int/float  number, or numeric text
//   iso   ISO 8601 text written by the Apps Script (nowIso), stored as timestamptz
// Columns are listed in the Sheet's own column order: the export writes them
// back in this order.

export const SHEET_TIMEZONE = 'America/Chicago';

export const TABS = [
  { tab: 'Products', table: 'products', columns: [
    ['ProductID', 'product_id', 'text'],
    ['Category', 'category', 'text'],
    ['Brand', 'brand', 'text'],
    ['Line', 'line', 'text'],
    ['SubType', 'sub_type', 'text'],
    ['Shade', 'shade', 'text'],
    ['Par', 'par', 'float'],
    ['Price', 'price', 'float'],
    ['Verify', 'verify', 'text'],
    ['Notes', 'notes', 'text'],
    ['Active', 'active', 'text'],
  ] },
  { tab: 'Zones', table: 'zones', columns: [
    ['ZoneID', 'zone_id', 'text'],
    ['Name', 'name', 'text'],
    ['SortOrder', 'sort_order', 'float'],
    ['Active', 'active', 'text'],
  ] },
  { tab: 'ZoneCounts', table: 'zone_counts', columns: [
    ['ProductID', 'product_id', 'text'],
    ['ZoneID', 'zone_id', 'text'],
    ['Qty', 'qty', 'float'],
    ['LastUpdated', 'last_updated', 'iso'],
  ] },
  { tab: 'Snapshots', table: 'snapshots', columns: [
    ['SnapshotID', 'snapshot_id', 'int'],
    ['Date', 'date', 'iso'],
    ['Status', 'status', 'text'],
    ['Notes', 'notes', 'text'],
  ] },
  { tab: 'SnapshotLines', table: 'snapshot_lines', columns: [
    ['SnapshotID', 'snapshot_id', 'int'],
    ['ProductID', 'product_id', 'text'],
    ['ZoneID', 'zone_id', 'text'],
    ['Qty', 'qty', 'float'],
  ] },
  { tab: 'Restocks', table: 'restocks', columns: [
    ['RestockID', 'restock_id', 'int'],
    ['Date', 'date', 'iso'],
    ['ProductID', 'product_id', 'text'],
    ['Qty', 'qty', 'float'],
    ['Note', 'note', 'text'],
  ] },
];

export const SKIPPED_TABS = {};

const isEmpty = v => v === null || v === undefined || v === '';

// Google Sheets turned two shade codes typed as text ("7-9", "5-4") into dates
// formatted m-d. A date in a text column is only accepted in that format, and
// it is read back as the code it was typed as.
export function sheetText(v) {
  if (v instanceof Date) return `${v.getUTCMonth() + 1}-${v.getUTCDate()}`;
  return String(v);
}
export function isTypedCodeDate(v, numFmt) {
  return v instanceof Date && numFmt === 'm-d';
}

// Reads a tab into { header: cell value } objects keyed by sheet row number,
// skipping blank rows the way the Apps Script's readRows does.
export function readTab(ws) {
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(c.value ?? '').trim(); });
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const cells = ws.getRow(r);
    const obj = {};
    const formats = {};
    let blank = true;
    headers.forEach((h, i) => {
      const cell = cells.getCell(i + 1);
      obj[h] = cell.value;
      formats[h] = cell.numFmt;
      if (!isEmpty(cell.value)) blank = false;
    });
    for (let c = headers.length + 1; c <= ws.columnCount; c++) {
      if (!isEmpty(cells.getCell(c).value)) throw new Error(`Tab "${ws.name}" row ${r} has a value in column ${c}, which has no header.`);
    }
    if (!blank) rows.push({ sheetRow: r, cells: obj, formats });
  }
  return { headers, rows };
}
