// Writes the whole database to an .xlsx laid out like the old Google Sheet
// (see lib/export-workbook.mjs).
// Usage: npm run db:export -- "C:\path\to\Salon Asteria export.xlsx"
import { writeFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { buildWorkbook } from '../lib/export-workbook.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: npm run db:export -- "<path for the .xlsx>"');
  process.exit(1);
}
await writeFile(file, await buildWorkbook(neon(process.env.DATABASE_URL)));
console.log('Wrote ' + file);
