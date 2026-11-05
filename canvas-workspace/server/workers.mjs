import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { HttpError } from './catalog.mjs';

async function availablePort() {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

// A separate process gives each canvas its own scene, image files, snapshots,
// persistence lock, and WebSocket audience without changing the upstream engine.
export class Workers {
  constructor(catalog, { source, originalUrl, maxWorkers = 8 }) {
    this.catalog = catalog; this.source = source; this.originalUrl = originalUrl;
    this.maxWorkers = maxWorkers; this.entries = new Map(); this.startQueue = Promise.resolve();
    this.timer = setInterval(() => { void this.reap(); }, 60_000).unref();
  }
  async reap() {
    for (const [id, worker] of this.entries) {
      if (Date.now() - worker.usedAt > 15 * 60_000 && !worker.requests) {
        try {
          const health = await (await fetch(`${worker.url}/health`, { signal: AbortSignal.timeout(1000) })).json();
          if (!health.websocket_clients) await this.stop(id);
        } catch { /* Starting or exiting workers are handled by their owner. */ }
      }
    }
  }
  async get(id) {
    this.catalog.get(id);
    if (id === 'default') return { url: this.originalUrl, usedAt: Date.now(), requests: 0 };
    const start = this.startQueue.then(() => this.start(id));
    this.startQueue = start.catch(() => {});
    return start;
  }
  async start(id) {
    const existing = this.entries.get(id);
    if (existing) { existing.usedAt = Date.now(); return existing; }
    if (this.entries.size >= this.maxWorkers) {
      // Only evict an idle canvas. Never interrupt an open editor or MCP call.
      for (const [oldId, worker] of [...this.entries].sort((a,b) => a[1].usedAt - b[1].usedAt)) {
        if (worker.requests) continue;
        try {
          const health = await (await fetch(`${worker.url}/health`, { signal: AbortSignal.timeout(1000) })).json();
          if (!health.websocket_clients) { await this.stop(oldId); break; }
        } catch { continue; }
      }
      if (this.entries.size >= this.maxWorkers) throw new HttpError(503, 'Eight canvases are currently open. Close an unused canvas tab and try again.');
    }
    const port = await availablePort();
    const directory = this.catalog.dataDirectory(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const log = fs.openSync(path.join(directory, 'worker.log'), 'a', 0o600);
    const child = spawn(process.execPath, [path.join(this.source, 'dist/server.js')], {
      cwd: this.source, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), EXCALIDRAW_DATA_DIR: directory },
      stdio: ['ignore', log, log]
    });
    fs.closeSync(log);
    const worker = { child, url: `http://127.0.0.1:${port}`, usedAt: Date.now(), requests: 0 };
    this.entries.set(id, worker);
    child.on('exit', () => { if (this.entries.get(id) === worker) this.entries.delete(id); worker.mcp?.close(); });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (spawnError || child.exitCode !== null) throw spawnError || new Error('Canvas worker exited during startup.');
        try {
          const health = await (await fetch(`${worker.url}/health`, { signal: AbortSignal.timeout(300) })).json();
          if (health.pid === child.pid) return worker;
        } catch { /* Wait for the worker to bind its port. */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Canvas startup timed out.');
    } catch (error) { await this.stop(id); throw error; }
  }
  async stop(id) {
    const worker = this.entries.get(id);
    if (!worker) return;
    this.entries.delete(id); worker.mcp?.close();
    if (worker.child.exitCode === null) {
      const exited = once(worker.child, 'exit');
      worker.child.kill('SIGTERM');
      const killer = setTimeout(() => worker.child.kill('SIGKILL'), 3000).unref();
      try { await exited; } finally { clearTimeout(killer); }
    }
  }
  async close() { clearInterval(this.timer); await Promise.all([...this.entries.keys()].map(id => this.stop(id))); this.originalMcp?.close(); }
  async tool(id, name, args) {
    const worker = await this.get(id);
    worker.requests++;
    try {
      let client;
      if (id === 'default') {
        if (!this.originalMcp || this.originalMcp.closed) this.originalMcp = new ToolClient(this.source, this.originalUrl);
        client = this.originalMcp;
      } else {
        if (!worker.mcp || worker.mcp.closed) worker.mcp = new ToolClient(this.source, worker.url);
        client = worker.mcp;
      }
      return await client.call(name, args);
    } finally { worker.requests--; worker.usedAt = Date.now(); }
  }
}

class ToolClient {
  constructor(source, url) {
    this.pending = new Map(); this.sequence = 0; this.closed = false;
    const exportDirectory = path.resolve(source, '../exports');
    fs.mkdirSync(exportDirectory, { recursive: true, mode: 0o700 });
    this.child = spawn(process.execPath, [path.join(source, 'dist/bin.js'), '--url', url], {
      cwd: source, env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1', EXCALIDRAW_EXPORT_DIR: exportDirectory }, stdio: ['pipe', 'pipe', 'ignore']
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const failed = () => {
      this.closed = true;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Canvas MCP process stopped. Retry the tool call.')); }
      this.pending.clear();
    };
    this.child.on('error', failed); this.child.on('exit', failed);
    this.ready = this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'canvas-workspace', version: '1.0.0' } })
      .then(() => this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'));
    this.ready.catch(() => {});
  }
  rpc(method, params) {
    if (this.closed) return Promise.reject(new Error('Canvas MCP process is unavailable.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Canvas tool call timed out.')); }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async call(name, args) { await this.ready; return this.rpc('tools/call', { name, arguments: args }); }
  close() { this.child.kill(); }
}
