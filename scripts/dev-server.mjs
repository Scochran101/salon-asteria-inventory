// Local preview of the whole app: serves the static files and routes /api to
// api/index.js, as Vercel does. It talks to the real Neon database in .env.local.
// Usage: node --env-file=.env.local scripts/dev-server.mjs   (PORT env, default 8792)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import api from '../api/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATIC = join(ROOT, '');
const PORT = Number(process.env.PORT || 8792);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/api') {
    let body;
    if (req.method === 'POST') {
      body = '';
      for await (const chunk of req) body += chunk;
    }
    const out = await api.fetch(new Request(url, { method: req.method, body, headers: req.headers }));
    res.writeHead(out.status, { 'Content-Type': out.headers.get('content-type') || 'application/json' });
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  const path = normalize(join(STATIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!path.startsWith(STATIC) || path.split(sep).some(part => part.startsWith('.env'))) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Dev server on http://localhost:${PORT}`));
