// Cloudflare Worker entry. Static UI is served from ./public via [assets];
// this handles /api/* and caches the aggregate for 45 s so every viewer shares one upstream poll.
import { fetchAll } from './sources.js';

const TTL = 45;
const json = (obj, extra = {}) => new Response(JSON.stringify(obj), {
  headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': `public, max-age=${TTL}`, ...extra },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/incidents') {
      const cache = caches.default;
      const key = new Request(url.origin + '/api/incidents', request);
      const hit = await cache.match(key);
      if (hit) return hit;
      const res = json(await fetchAll(), { 'x-cache': 'MISS' });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    }
    if (url.pathname === '/api/health') return json({ ok: true });
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};
