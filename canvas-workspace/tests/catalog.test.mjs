import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Catalog } from '../server/catalog.mjs';

test('separate canvas IDs and names survive reopening, renaming, and archiving', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-catalog-'));
  try {
    const catalog = new Catalog(directory);
    const first = catalog.create('Same name');
    const second = catalog.create('Same name');
    assert.notEqual(first.id, second.id);
    catalog.update(first.id, { name: 'Renamed' });
    catalog.update(second.id, { archived: true });
    const reopened = new Catalog(directory);
    assert.equal(reopened.get(first.id).name, 'Renamed');
    assert.equal(reopened.list().length, 2); // Original canvas + first.
    assert.equal(reopened.list({ archived: true })[0].id, second.id);
    reopened.update(second.id, { archived: false });
    assert.equal(reopened.list().length, 3);
    assert.throws(() => reopened.get('../outside'), /not found/);
    assert.throws(() => reopened.create('  '), /between 1 and 120/);
    assert.throws(() => reopened.create('a'.repeat(121)), /between 1 and 120/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a damaged catalog fails closed without overwriting saved metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-catalog-'));
  const filename = path.join(directory, 'canvases.json');
  try {
    fs.writeFileSync(filename, '{"version":99,"canvases":[]}');
    assert.throws(() => new Catalog(directory), /Invalid canvas catalog/);
    assert.equal(fs.readFileSync(filename, 'utf8'), '{"version":99,"canvases":[]}');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
