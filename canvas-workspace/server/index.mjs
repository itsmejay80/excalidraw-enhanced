import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import httpProxy from 'http-proxy';
import { Catalog, HttpError, atomicWrite } from './catalog.mjs';
import { Workers } from './workers.mjs';
import { canvasMcp } from './mcp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 9124);
const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
const source = process.env.CANVAS_ENGINE_SOURCE || path.join(dataHome, 'excalidraw-mcp/source');
const originalUrl = process.env.ORIGINAL_CANVAS_URL || 'http://127.0.0.1:9123';
const publicUrl = process.env.PUBLIC_URL || `http://127.0.0.1:${port}`;
const data = process.env.CANVAS_WORKSPACE_DATA || path.join(dataHome, 'excalidraw-workspace');
const catalog = new Catalog(data, { includeOriginal: process.env.INCLUDE_ORIGINAL !== '0' });
const workers = new Workers(catalog, { source, originalUrl });
const app = express();
app.disable('x-powered-by');
const server = createServer(app);
const proxy = httpProxy.createProxyServer({ ws: true, proxyTimeout: 50_000 });
proxy.on('error', (error, req, res) => {
  if ('writeHead' in res) {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Canvas connection failed. Retry in a moment.' }));
  } else res.destroy();
});
const json = express.json({ limit: '12mb' });
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const allowedHosts = new Set(['127.0.0.1', 'localhost', new URL(publicUrl).hostname]);
function validOrigin(req) {
  if (!req.headers.origin) return true; // Local MCP processes do not send Origin.
  try {
    const origin = new URL(req.headers.origin);
    return allowedHosts.has(origin.hostname) && origin.host === req.headers.host;
  } catch { return false; }
}
app.use((req, res, next) => {
  const hostname = req.hostname;
  if (!allowedHosts.has(hostname) || !validOrigin(req)) return res.status(403).json({ error: 'Origin not allowed.' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!req.path.startsWith('/assets/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
const previewTimers = new Map();
function changed(id) {
  catalog.update(id, {});
  clearTimeout(previewTimers.get(id));
  previewTimers.set(id, setTimeout(() => {
    previewTimers.delete(id);
    void preview(id).catch(() => {});
  }, 1000).unref());
}
const previewJobs = new Map();
async function preview(id) {
  if (previewJobs.has(id)) return previewJobs.get(id);
  const job = (async () => {
    const canvas = catalog.get(id);
    const filename = path.join(data, `${id}.png`);
    if (fs.existsSync(filename) && fs.statSync(filename).mtimeMs >= Date.parse(canvas.updatedAt)) return filename;
    const worker = await workers.get(id);
    worker.requests++;
    try {
      const response = await fetch(`${worker.url}/api/export/image`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'png', background: true, renderer: 'node', scale: 1, padding: 40 }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) throw new Error('Preview unavailable.');
      const result = await response.json();
      atomicWrite(filename, Buffer.from(result.data, 'base64'));
      // A newer edit can arrive while the renderer is running. Keep the
      // thumbnail tied to the revision it rendered, not the write's wall time.
      fs.utimesSync(filename, new Date(canvas.updatedAt), new Date(canvas.updatedAt));
      return filename;
    } finally { worker.requests--; }
  })();
  previewJobs.set(id, job);
  try { return await job; } finally { previewJobs.delete(id); }
}

app.get('/api/canvases', (req, res) => res.json({ canvases: catalog.list({ archived: req.query.archived === 'true' }) }));
app.post('/api/canvases', json, (req, res, next) => {
  try { res.status(201).json(catalog.create(req.body.name)); } catch (error) { next(error); }
});
app.get('/api/canvases/:id', (req, res, next) => { try { res.json(catalog.get(req.params.id)); } catch (error) { next(error); } });
app.patch('/api/canvases/:id', json, (req, res, next) => { try { res.json(catalog.update(req.params.id, req.body)); } catch (error) { next(error); } });
app.get('/api/canvases/:id/preview', asyncRoute(async (req, res) => {
  catalog.get(req.params.id);
  try { res.sendFile(await preview(req.params.id)); }
  catch { res.status(204).end(); } // Empty canvases have a deliberate blank preview.
}));

async function routeCanvas(req, res, id, targetPath) {
  const worker = await workers.get(id);
  worker.requests++;
  const mutatesScene = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && /^\/api\/(elements|files|snapshots)(\/|$)/.test(targetPath);
  res.once('finish', () => {
    worker.requests--; worker.usedAt = Date.now();
    if (mutatesScene && res.statusCode < 400) { try { changed(id); } catch (error) { console.error('Could not update canvas metadata:', error.message); } }
  });
  req.url = targetPath;
  proxy.web(req, res, { target: worker.url });
}
app.use('/canvases/:id', asyncRoute((req, res) => {
  if (!/^\/(api\/|health(?:\?|$))/.test(req.url)) throw new HttpError(404, 'Canvas endpoint not found.');
  return routeCanvas(req, res, req.params.id, req.url);
}));
// Existing npx clients keep targeting their original canvas, never the newest one.
app.use('/api', asyncRoute((req, res) => routeCanvas(req, res, 'default', `/api${req.url}`)));
app.get('/health', asyncRoute((req, res) => routeCanvas(req, res, 'default', '/health')));
const mcp = await canvasMcp({ catalog, workers, source, publicUrl, changed });
app.all('/mcp', json, mcp.serve);
app.get('/workspace-health', (req, res) => res.json({ status: 'healthy', canvases: catalog.list().length, activeWorkers: workers.entries.size }));

// Retire the old editor's PWA cache without removing localStorage or IndexedDB.
// That browser-only drawing is offered for import by the new library.
app.get('/sw.js', (req, res) => {
  res.type('application/javascript').send(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())await caches.delete(key);await self.clients.claim();await self.registration.unregister();for(const client of await self.clients.matchAll({type:'window'}))await client.navigate(client.url);})()));`);
});
app.use(express.static(path.join(root, 'dist'), { index: false, maxAge: 0 }));
// Old cached HTML can still request its scripts while the retiring SW updates.
app.use(express.static(process.env.LEGACY_EDITOR_DIST || path.join(dataHome, 'excalidraw'), { index: false }));
app.get(['/', '/c/:id'], (req, res, next) => {
  try {
    if (req.params.id) catalog.get(req.params.id);
    res.sendFile(path.join(root, 'dist/index.html'));
  } catch (error) { next(error); }
});
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (!error.status) console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not complete this request. Retry in a moment.' });
});
server.on('upgrade', async (req, socket, head) => {
  try {
    if (!validOrigin(req)) return socket.destroy();
    const match = /^\/canvases\/([^/]+)\/ws(?:\?|$)/.exec(req.url);
    const id = match?.[1] || (req.url === '/' ? 'default' : null);
    if (!id) return socket.destroy();
    const worker = await workers.get(id);
    req.url = '/';
    proxy.ws(req, socket, head, { target: worker.url });
  } catch { socket.destroy(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Canvas workspace listening on 127.0.0.1:${port}`));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  for (const timer of previewTimers.values()) clearTimeout(timer);
  await mcp.handler.close();
  await workers.close();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
