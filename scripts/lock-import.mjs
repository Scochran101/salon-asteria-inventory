// Marks Neon as the live database (run once, at the switch). From then on
// scripts/import-sheet.mjs refuses to run, so the old sheet can never
// overwrite what the app has saved since.
// Usage: npm run db:lock -- "<note>"
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
await sql`INSERT INTO cutover (note) VALUES (${process.argv[2] || ''}) ON CONFLICT (id) DO NOTHING`;
const [row] = await sql`SELECT done_at, note FROM cutover`;
console.log('Importer locked since ' + row.done_at.toISOString() + (row.note ? ' (' + row.note + ')' : '') + '.');
