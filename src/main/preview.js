'use strict';
// Rendered previews of local HTML files.
//
// A page is shown in an <iframe> of the main window. It is served over a private
// scheme rather than file://, so it behaves like a page on a small web server:
// relative links, module scripts, fetch() and localStorage all work, and the
// page can read only what is under the folder it is served from. (A file:// page
// inside Electron could read any file on the disk.)
//
// Every file a preview loads is remembered, and the preview reloads when one of
// them changes: an agent editing the stylesheet shows up without a click.
const crypto = require('crypto');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { protocol, net, webContents } = require('electron');

const SCHEME = 'aide-preview';
const HTML_EXT = /\.html?$/i;
const POLL_MS = 800;
const GRACE_MS = 5000; // a preview that was just asked for counts as open while it loads
const MAX_TRACKED = 400;

/**
 * One entry per served folder. The host of a preview address names the entry.
 * @type {Map<string, { root: string, opened: Set<string>, seen: Map<string, string>, touched: number }>}
 */
const roots = new Map();

const canPreview = (file) => typeof file === 'string' && HTML_EXT.test(file);
const owns = (url) => typeof url === 'string' && url.startsWith(`${SCHEME}://`);
const inside = (dir, target) => target === dir || target.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const hidden = (rel) => rel.split(path.sep).some((part) => part.startsWith('.'));
const signature = (st) => `${st.mtimeMs}:${st.size}`;

/** Must run before the app is ready. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

/**
 * The folder a page is served from: the project folder, so `../shared/site.css`
 * and `/assets/logo.png` resolve, unless that would hand the page too much.
 */
function rootFor(file, projectDir) {
  const dir = path.dirname(file);
  if (!projectDir || !inside(projectDir, file)) return dir;
  if (inside(projectDir, os.homedir())) return dir; // the home folder, or something above it
  if (hidden(path.relative(projectDir, dir))) return dir; // e.g. a report inside .claude/
  return projectDir;
}

/** The address that shows `file` rendered. */
function urlFor(file, projectDir) {
  const root = rootFor(file, projectDir);
  // The same folder always gets the same host, so a page keeps its localStorage.
  const host = `p${crypto.createHash('sha256').update(root).digest('hex').slice(0, 24)}`;
  let entry = roots.get(host);
  if (!entry) roots.set(host, (entry = { root, opened: new Set(), seen: new Map(), touched: 0 }));
  entry.opened.add(file);
  entry.touched = Date.now();
  const rel = path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/');
  return `${SCHEME}://${host}/${rel}`;
}

function plain(status, message) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function remember(entry, file, sig) {
  if (entry.seen.has(file) || entry.seen.size < MAX_TRACKED) entry.seen.set(file, sig);
}

async function serve(request) {
  const url = new URL(request.url);
  const entry = roots.get(url.host);
  if (!entry) return plain(404, 'This preview is no longer open.');
  entry.touched = Date.now();

  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return plain(400, 'That address is not valid.');
  }
  if (rel.includes('\0')) return plain(400, 'That address is not valid.');
  let file = path.join(entry.root, rel);
  if (!inside(entry.root, file)) return plain(403, 'That is outside the folder this page is shown from.');

  try {
    let st = await fsp.stat(file);
    if (st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await fsp.stat(file);
    }
    // Hidden files hold things like .env and .git; a page has no business reading them.
    if (hidden(path.relative(entry.root, file)) && !entry.opened.has(file)) return plain(403, 'Hidden files are not shown in a preview.');
    remember(entry, file, signature(st));
  } catch {
    remember(entry, file, 'missing'); // so the preview reloads once the file exists
    return plain(404, `Nothing at ${rel}`);
  }

  const range = request.headers.get('range');
  const res = await net.fetch(pathToFileURL(file).toString(), range ? { headers: { range } } : undefined);
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-store'); // a reload must show the file as it is now
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Preview frames on screen right now, by host. */
function liveFrames() {
  const live = new Map();
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed() || !wc.mainFrame) continue;
    for (const frame of wc.mainFrame.frames) {
      if (!owns(frame.url)) continue;
      const host = new URL(frame.url).host;
      if (!live.has(host)) live.set(host, []);
      live.get(host).push(frame);
    }
  }
  return live;
}

async function changed(entry) {
  const checks = [...entry.seen].map(async ([file, was]) => {
    try {
      return signature(await fsp.stat(file)) !== was;
    } catch {
      return was !== 'missing';
    }
  });
  return (await Promise.all(checks)).includes(true);
}

let polling = false;
async function poll() {
  if (polling || !roots.size) return;
  polling = true;
  try {
    const live = liveFrames();
    for (const [host, entry] of roots) {
      const frames = live.get(host);
      if (!frames) {
        if (Date.now() - entry.touched > GRACE_MS) entry.seen.clear();
      } else if (entry.seen.size && (await changed(entry))) {
        entry.seen.clear(); // the reload asks for everything again
        for (const frame of frames) frame.reload();
      }
    }
  } catch {
    // A frame went away mid-check; the next round sorts it out.
  } finally {
    polling = false;
  }
}

/** Call once the app is ready. */
function start() {
  protocol.handle(SCHEME, (request) => serve(request).catch((err) => plain(500, err.message)));
  setInterval(poll, POLL_MS).unref();
}

module.exports = { SCHEME, canPreview, owns, registerScheme, start, urlFor };
