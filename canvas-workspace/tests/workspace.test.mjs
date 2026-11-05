import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startWorkspace, stopWorkspace, request, mcp } from './helpers.mjs';

test('HTTP MCP, canvas APIs, images, snapshots, and restart recovery remain isolated', { timeout: 90_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-workspace-'));
  let instance;
  try {
    instance = await startWorkspace(directory);
    let url = instance.url;
    const init = await mcp(url, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } });
    assert.equal(init.serverInfo.name, 'omarchy-canvases');
    const tools = await mcp(url, 'tools/list', {});
    assert.ok(tools.tools.find(tool => tool.name === 'create_canvas'));
    assert.ok(tools.tools.find(tool => tool.name === 'create_element').inputSchema.required.includes('canvasId'));
    const created = await mcp(url, 'tools/call', { name: 'create_canvas', arguments: { name: 'Canvas A' } });
    assert.ok(!created.isError, JSON.stringify(created));
    const a = JSON.parse(created.content[0].text);
    const b = await request(`${url}/api/canvases`, 'POST', { name: 'Canvas B' });
    const results = await Promise.all([a, b].map((canvas, i) => mcp(url, 'tools/call', {
      name: 'create_element', arguments: { canvasId: canvas.id, id: 'same-element-id', type: i ? 'ellipse' : 'rectangle', x: 100, y: 100, width: 150, height: 100 }
    })));
    for (const result of results) assert.ok(!result.isError, JSON.stringify(result));
    const scene = async id => request(`${url}/canvases/${id}/api/elements`);
    assert.equal((await scene(a.id)).elements[0].type, 'rectangle');
    assert.equal((await scene(b.id)).elements[0].type, 'ellipse');
    const missing = await mcp(url, 'tools/call', { name: 'create_element', arguments: { type: 'rectangle', x: 0, y: 0 } });
    assert.ok(missing.isError);
    const fileA = { id: 'same-file-id', dataURL: 'data:image/png;base64,YQ==', mimeType: 'image/png', created: 1 };
    const fileB = { ...fileA, dataURL: 'data:image/png;base64,Yg==' };
    await request(`${url}/canvases/${a.id}/api/files`, 'POST', { files: [fileA] });
    await request(`${url}/canvases/${b.id}/api/files`, 'POST', { files: [fileB] });
    await request(`${url}/canvases/${a.id}/api/snapshots`, 'POST', { name: 'Only in A' });
    assert.equal((await request(`${url}/canvases/${b.id}/api/snapshots`)).snapshots.length, 0);
    const foreign = await fetch(`${url}/api/canvases`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unwanted' }) });
    assert.equal(foreign.status, 403);
    await request(`${url}/api/canvases/${a.id}`, 'PATCH', { name: 'Renamed canvas' });
    await stopWorkspace(instance);
    instance = await startWorkspace(directory); url = instance.url;
    assert.equal((await request(`${url}/api/canvases/${a.id}`)).name, 'Renamed canvas');
    assert.equal((await scene(a.id)).elements[0].type, 'rectangle');
    assert.equal((await scene(b.id)).elements[0].type, 'ellipse');
    assert.equal((await request(`${url}/canvases/${a.id}/api/files`)).files['same-file-id'].dataURL, fileA.dataURL);
    assert.equal((await request(`${url}/canvases/${b.id}/api/files`)).files['same-file-id'].dataURL, fileB.dataURL);
    await request(`${url}/api/canvases/${a.id}`, 'PATCH', { archived: true });
    assert.deepEqual((await request(`${url}/api/canvases`)).canvases.map(c => c.id), [b.id]);
    await request(`${url}/api/canvases/${a.id}`, 'PATCH', { archived: false });
    assert.equal((await scene(a.id)).elements.length, 1);
    assert.equal((await fetch(`${url}/c/${a.id}`)).status, 200);
    assert.equal((await fetch(`${url}/api/canvases/not-a-canvas`)).status, 404);
    const preview = await fetch(`${url}/api/canvases/${b.id}/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
  } finally { await stopWorkspace(instance); fs.rmSync(directory, { recursive: true, force: true }); }
});
