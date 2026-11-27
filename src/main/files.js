'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMAGE = 40 * 1024 * 1024;

async function listDir(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name === '.DS_Store') continue;
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = (await fsp.stat(full)).isDirectory();
      } catch {
        isDir = false; // dangling link
      }
    }
    out.push({ name: e.name, path: full, isDir });
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.isDir ? -1 : 1));
  return out;
}

async function readFile(file) {
  const st = await fsp.stat(file);
  if (st.isDirectory()) return { kind: 'error', message: 'This is a folder.' };
  const base = { path: file, size: st.size, mtimeMs: st.mtimeMs };
  const mime = IMAGE_TYPES[path.extname(file).toLowerCase()];

  // SVG is both an image and text; show the picture, since that is the quick check.
  if (mime) {
    if (st.size > MAX_IMAGE) return { ...base, kind: 'too-large' };
    const buf = await fsp.readFile(file);
    return { ...base, kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  }
  if (st.size > MAX_TEXT) return { ...base, kind: 'too-large' };
  const buf = await fsp.readFile(file);
  if (buf.subarray(0, 8192).includes(0)) return { ...base, kind: 'binary' };
  return { ...base, kind: 'text', content: buf.toString('utf8') };
}

/**
 * Save text. `expectedMtimeMs` is the modification time the editor loaded; if
 * the file has changed on disk since (an agent edited it), nothing is written
 * and the caller is told, unless `force` is set.
 */
async function writeFile(file, content, expectedMtimeMs, force = false) {
  if (!force && expectedMtimeMs != null) {
    try {
      const st = await fsp.stat(file);
      if (Math.abs(st.mtimeMs - expectedMtimeMs) > 1) return { ok: false, conflict: true };
    } catch {
      // File was deleted meanwhile; saving recreates it.
    }
  }
  await fsp.writeFile(file, content, 'utf8');
  const st = await fsp.stat(file);
  return { ok: true, mtimeMs: st.mtimeMs, size: st.size };
}

/** Watches the single file each window has open, by polling its stat. */
class FileWatchers {
  constructor() {
    this.byOwner = new Map(); // owner key -> { file, listener }
  }

  watch(owner, file, onChange) {
    this.unwatch(owner);
    const listener = (cur, prev) => {
      if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) onChange(file);
    };
    fs.watchFile(file, { interval: 700 }, listener);
    this.byOwner.set(owner, { file, listener });
  }

  unwatch(owner) {
    const w = this.byOwner.get(owner);
    if (!w) return;
    fs.unwatchFile(w.file, w.listener);
    this.byOwner.delete(owner);
  }
}

module.exports = { listDir, readFile, writeFile, FileWatchers };
