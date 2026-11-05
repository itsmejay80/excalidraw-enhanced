import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function atomicWrite(filename, data) {
  const temp = `${filename}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, filename);
    const dir = fs.openSync(path.dirname(filename), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

export class Catalog {
  constructor(directory, { includeOriginal = true } = {}) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filename = path.join(directory, 'canvases.json');
    if (fs.existsSync(this.filename)) {
      const stored = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.canvases)) throw new Error('Invalid canvas catalog; refusing to replace it.');
      this.canvases = new Map();
      for (const canvas of stored.canvases) {
        if (!/^(default|[a-f0-9-]{36})$/.test(canvas.id) || typeof canvas.name !== 'string' || !canvas.createdAt || !canvas.updatedAt || this.canvases.has(canvas.id)) {
          throw new Error('Invalid canvas record; refusing to replace the catalog.');
        }
        this.canvases.set(canvas.id, canvas);
      }
    } else {
      this.canvases = new Map();
      if (includeOriginal) {
        const now = new Date().toISOString();
        this.canvases.set('default', { id: 'default', name: 'Original canvas', createdAt: now, updatedAt: now });
      }
      this.save();
    }
  }
  save() { atomicWrite(this.filename, JSON.stringify({ version: 1, canvases: [...this.canvases.values()] }, null, 2)); }
  get(id) {
    const canvas = this.canvases.get(id);
    if (!canvas) throw new HttpError(404, 'Canvas not found.');
    return { ...canvas };
  }
  list({ archived = false } = {}) {
    return [...this.canvases.values()].filter(c => Boolean(c.archivedAt) === archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(c => ({ ...c }));
  }
  name(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new HttpError(400, 'Use a canvas name between 1 and 120 characters.');
    return value.trim();
  }
  create(name) {
    name = this.name(name);
    const now = new Date().toISOString();
    const canvas = { id: randomUUID(), name, createdAt: now, updatedAt: now };
    this.canvases.set(canvas.id, canvas);
    try { this.save(); } catch (error) { this.canvases.delete(canvas.id); throw error; }
    return { ...canvas };
  }
  update(id, changes) {
    const old = this.get(id);
    const next = { ...old, updatedAt: new Date().toISOString() };
    if (changes.name !== undefined) next.name = this.name(changes.name);
    if (changes.archived !== undefined) {
      if (typeof changes.archived !== 'boolean') throw new HttpError(400, 'Invalid archive state.');
      if (changes.archived) next.archivedAt = new Date().toISOString();
      else delete next.archivedAt;
    }
    this.canvases.set(id, next);
    try { this.save(); } catch (error) { this.canvases.set(id, old); throw error; }
    return { ...next };
  }
  dataDirectory(id) { this.get(id); return path.join(this.directory, id); }
}
