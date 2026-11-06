import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import httpProxy from 'http-proxy';
import { chromium, expect } from 'playwright/test';
import { startWorkspace, stopWorkspace, request, mcp } from './helpers.mjs';

test('library grid fits five canvases across desktop and keeps filtered cards compact', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-grid-'));
  let instance, browser;
  try {
    instance = await startWorkspace(directory);
    for (let i = 0; i < 5; i++) {
      await request(`${instance.url}/api/canvases`, 'POST', { name: `Grid canvas ${i}` });
    }
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1740, height: 1000 } });
    await page.goto(instance.url);
    const cards = page.locator('.canvas-card');
    await expect(cards).toHaveCount(5);
    for (const width of [1740, 2000, 1440, 1024, 768, 601, 600, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      const boxes = await cards.evaluateAll(nodes => nodes.map(node => {
        const { x, y, width, bottom } = node.getBoundingClientRect();
        return { x, y, width, bottom };
      }));
      if (width >= 1740) {
        assert.ok(boxes.every(box => box.y === boxes[0].y), `Five cards should fit in one row at ${width}px: ${JSON.stringify(boxes)}`);
      }
      if (width >= 1024) assert.ok(boxes.at(-1).bottom <= 1000, `Five cards should fit on screen at ${width}px`);
      assert.ok(await page.locator('html').evaluate(node => node.scrollWidth <= node.ownerDocument.defaultView.innerWidth), `No horizontal overflow at ${width}px`);
      const originalWidth = boxes[0].width;
      await page.getByRole('searchbox', { name: 'Search canvases' }).fill('Grid canvas 0');
      await expect(cards).toHaveCount(1);
      const filteredBox = await cards.boundingBox();
      assert.ok(Math.abs(filteredBox.width - originalWidth) < 1, `Filtering should preserve card width at ${width}px`);
      assert.ok(Math.abs(filteredBox.x - boxes[0].x) < 1, `Cards should stay aligned at ${width}px`);
      await page.getByRole('searchbox', { name: 'Search canvases' }).fill('');
      await expect(cards).toHaveCount(5);
    }
  } finally { await browser?.close(); await stopWorkspace(instance); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('browser creation, immediate navigation saves, independent live scenes, rename, archive, import, and responsive layout', { timeout: 120_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-browser-'));
  let instance, browser;
  try {
    instance = await startWorkspace(directory);
    const url = instance.url;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Your canvases' })).toBeVisible();
    async function create(name) {
      await page.getByRole('button', { name: 'New canvas', exact: true }).first().click();
      await page.getByLabel('Canvas name', { exact: true }).fill(name);
      await page.getByRole('button', { name: 'Create canvas', exact: true }).click();
      await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
      return new URL(page.url()).pathname.split('/').at(-1);
    }
    const a = await create('First idea');
    await page.locator('label').filter({ has: page.getByTestId('toolbar-rectangle') }).click();
    await page.mouse.move(500, 350); await page.mouse.down();
    await page.mouse.move(680, 490, { steps: 5 }); await page.mouse.up();
    // Leave before the 500ms autosave debounce. Back must flush, not cancel it.
    await page.getByRole('link', { name: 'All canvases' }).click();
    await expect(page.getByRole('heading', { name: 'Your canvases' })).toBeVisible();
    const sceneA = await request(`${url}/canvases/${a}/api/elements`);
    assert.equal(sceneA.elements.filter(el => !el.isDeleted).length, 1);
    assert.equal(sceneA.elements[0].type, 'rectangle');
    const b = await create('Second idea');
    assert.equal((await request(`${url}/canvases/${b}/api/elements`)).elements.length, 0);
    const frames = [];
    const observer = await context.newPage();
    observer.on('websocket', ws => ws.on('framereceived', frame => frames.push(String(frame.payload))));
    await observer.goto(`${url}/c/${b}`);
    await expect(observer.getByText('All changes saved', { exact: true })).toBeVisible();
    const result = await mcp(url, 'tools/call', { name: 'create_element', arguments: { canvasId: b, id: 'only-in-second', type: 'text', text: 'Second canvas only', x: 300, y: 250, fontSize: 32 } });
    assert.ok(!result.isError, JSON.stringify(result));
    await expect.poll(() => frames.some(frame => frame.includes('only-in-second'))).toBe(true);
    assert.equal((await request(`${url}/canvases/${a}/api/elements`)).elements.some(el => el.id === 'only-in-second'), false);
    await observer.close();
    await page.getByRole('button', { name: 'Second idea', exact: true }).click();
    await page.getByLabel('Canvas name', { exact: true }).fill('Architecture notes');
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Architecture notes', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
    assert.equal(new URL(page.url()).pathname, `/c/${b}`);
    await page.getByRole('link', { name: 'All canvases' }).click();
    await page.getByRole('button', { name: 'Archive Architecture notes', exact: true }).click();
    await page.getByRole('button', { name: 'Archive canvas', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Architecture notes', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Architecture notes', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Restore Architecture notes', exact: true }).click();
    await page.getByRole('button', { name: 'Canvases', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search canvases' }).fill('Architecture');
    await expect(page.getByRole('link', { name: 'First idea', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Architecture notes', exact: true })).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search canvases' }).fill('');
    const imageFile = { id: 'browser-image', dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', mimeType: 'image/png', created: Date.now() };
    const legacyElements = [...sceneA.elements, { ...sceneA.elements[0], id: 'old-image', type: 'image', fileId: imageFile.id, status: 'saved', scale: [1, 1], x: 300 }];
    await page.evaluate(async ({ elements, file }) => {
      localStorage.setItem('excalidraw', JSON.stringify(elements));
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('files-db', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('files-store');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction('files-store', 'readwrite');
          transaction.objectStore('files-store').put(file, file.id);
          transaction.oncomplete = () => { open.result.close(); resolve(null); };
          transaction.onerror = () => reject(transaction.error);
        };
      });
    }, { elements: legacyElements, file: imageFile });
    await page.reload();
    await page.getByRole('button', { name: 'Import previous drawing', exact: true }).click();
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
    const imported = new URL(page.url()).pathname.split('/').at(-1);
    assert.notEqual(imported, a);
    assert.equal((await request(`${url}/canvases/${imported}/api/elements`)).elements.length, 2);
    assert.equal((await request(`${url}/canvases/${imported}/api/files`)).files['browser-image'].dataURL, imageFile.dataURL);
    const preserved = await page.evaluate(() => JSON.parse(localStorage.getItem('excalidraw')));
    assert.equal(preserved.length, 2);
    await page.getByRole('link', { name: 'All canvases' }).click();
    await expect(page.getByRole('button', { name: 'Import previous drawing', exact: true })).toHaveCount(0);
    await page.locator('input[type="file"]').setInputFiles({ name: 'From disk.excalidraw', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ type: 'excalidraw', version: 2, ...sceneA })) });
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
    const fromDisk = new URL(page.url()).pathname.split('/').at(-1);
    assert.notEqual(fromDisk, a);
    assert.equal((await request(`${url}/canvases/${fromDisk}/api/elements`)).elements.length, 1);
    await page.getByRole('link', { name: 'All canvases' }).click();
    await page.screenshot({ path: '/tmp/omarchy-canvas-library-desktop.png' });
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByRole('button', { name: 'New canvas', exact: true }).first()).toBeVisible();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/tmp/omarchy-canvas-library-mobile.png' });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.screenshot({ path: '/tmp/omarchy-canvas-library-dark.png' });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await stopWorkspace(instance); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('theme choice spans library and editor and keeps the header compact', { timeout: 60_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-theme-'));
  let instance, browser;
  try {
    instance = await startWorkspace(directory);
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    await page.goto(instance.url);
    await expect(page.getByRole('heading', { name: 'Your canvases' })).toBeVisible();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click({ timeout: 2500 });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const background = () => page.locator('html').evaluate(node => node.ownerDocument.defaultView.getComputedStyle(node).backgroundColor);
    const darkBackground = await background();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    assert.notEqual(darkBackground, await background());
    await page.getByRole('button', { name: 'New canvas', exact: true }).first().click();
    await page.getByLabel('Canvas name', { exact: true }).fill('Theme and space '.repeat(7).trim());
    await page.getByRole('button', { name: 'Create canvas', exact: true }).click();
    await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
    await expect(page.locator('.excalidraw:not(.theme--dark)')).toBeVisible();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await page.locator('.canvas-container').boundingBox();
      assert.ok(bounds.y <= 50, `Canvas starts at ${bounds.y}px at width ${width}`);
      assert.ok(bounds.height >= 850);
      assert.ok(await page.locator('html').evaluate(node => node.scrollWidth <= node.ownerDocument.defaultView.innerWidth));
      await expect(page.getByRole('link', { name: 'All canvases' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Switch to dark mode', exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click();
    await expect(page.locator('.excalidraw.theme--dark')).toBeVisible();
    await page.getByRole('link', { name: 'All canvases' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Switch to light mode', exact: true })).toBeVisible();
  } finally { await browser?.close(); await stopWorkspace(instance); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('retiring the old PWA opens the library and preserves the previous browser drawing', { timeout: 60_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-pwa-'));
  let instance, browser, server;
  const proxy = httpProxy.createProxyServer();
  let upgraded = false;
  try {
    instance = await startWorkspace(directory);
    const oldHtml = '<!doctype html><title>Old editor</title><h1>Old editor</h1><script>navigator.serviceWorker.register("/sw.js")</script>';
    server = http.createServer((req, res) => {
      if (upgraded) return proxy.web(req, res, { target: instance.url });
      if (req.url === '/sw.js') {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(`self.addEventListener('install',e=>e.waitUntil((async()=>{const c=await caches.open('old-editor');await c.put('/',new Response(${JSON.stringify(oldHtml)},{headers:{'Content-Type':'text/html'}}));await self.skipWaiting()})()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(caches.match('/'))});`);
      } else { res.setHeader('Content-Type', 'text/html'); res.end(oldHtml); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
    const page = await browser.newPage();
    await page.goto(url);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      localStorage.setItem('excalidraw', JSON.stringify([{ id: 'previous-browser-drawing', type: 'rectangle', x: 0, y: 0 }]));
    });
    upgraded = true;
    await page.reload({ waitUntil: 'networkidle' });
    await page.evaluate(async () => { for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.update(); });
    await expect(page.getByRole('heading', { name: 'Your canvases' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Import previous drawing', exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('excalidraw'))[0].id), 'previous-browser-drawing');
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    proxy.close();
    await stopWorkspace(instance);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
