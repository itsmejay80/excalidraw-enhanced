import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function startWorkspace(directory) {
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root, env: { ...process.env, PORT: String(port), PUBLIC_URL: url, CANVAS_WORKSPACE_DATA: directory, INCLUDE_ORIGINAL: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(output);
    try { if ((await fetch(`${url}/workspace-health`)).ok) return { url, child, output: () => output }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill(); throw new Error(`Workspace did not start: ${output}`);
}
export async function stopWorkspace(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  const exited = once(instance.child, 'exit');
  instance.child.kill('SIGTERM');
  await exited;
}
export async function request(url, method = 'GET', body) {
  const response = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
export async function mcp(url, method, params) {
  const response = await fetch(`${url}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  const result = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(body.split('\n').filter(line => line.startsWith('data: ')).at(-1).slice(6))
    : JSON.parse(body);
  assert.ok(!result.error, JSON.stringify(result));
  return result.result;
}
