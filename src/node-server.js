// Node HTTP server (start it through ../server.js so Lebanon's certificate fix is applied).
// Same data layer as the Cloudflare Worker; in-memory 45 s cache shared by every client.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fetchAll } from './sources.js';

const PORT = +process.env.PORT || 8787;
const TTL_MS = 45_000;
const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
let cache = { at: 0, body: null, pending: null };

async function getData() {
  if (cache.body && Date.now() - cache.at < TTL_MS) return cache.body;
  if (!cache.pending) {
    cache.pending = fetchAll()
      .then((d) => { cache = { at: Date.now(), body: JSON.stringify(d), pending: null }; return cache.body; })
      .catch((e) => { cache.pending = null; throw e; });
  }
  return cache.pending;
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (path === '/api/incidents') {
      const body = await getData();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(body);
    }
    const file = normalize(join(pub, path === '/' ? 'index.html' : path));
    if (!file.startsWith(pub + sep)) { res.writeHead(403).end(); return; } // no ../ escapes
    const data = await readFile(file).catch(() => null);
    if (!data) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => {
  console.log(`CAD monitor running → http://localhost:${PORT}`);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) console.log(`On your phone (same Wi-Fi) → http://${lan.address}:${PORT}`);
});
