import { readFile } from 'node:fs/promises';
import { Client } from '@neondatabase/serverless';

const client = new Client(process.env.DATABASE_URL_UNPOOLED);
await client.connect();
await client.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await client.end();
console.log('Schema applied.');
