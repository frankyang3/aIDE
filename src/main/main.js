'use strict';
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen, session, nativeTheme, systemPreferences } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Tests point this at a throwaway folder so they never touch real state. It has
// to happen before the single-instance lock, which lives in userData.
if (process.env.AIDE_USER_DATA) app.setPath('userData', process.env.AIDE_USER_DATA);
const TESTING = Boolean(process.env.AIDE_TEST);

const { Store } = require('./store');
const { SessionManager } = require('./sessions');
const { ServerScanner } = require('./servers');
const files = require('./files');
const preview = require('./preview');
const git = require('./git');
const { ControlServer } = require('./control');

preview.registerScheme();

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const BG = '#15161a';

/** @type {Store} */ let store;
/** @type {SessionManager} */ let sessions;
/** @type {ServerScanner} */ let scanner;
/** @type {ControlServer} */ let control;
const watchers = new files.FileWatchers();

/** @type {BrowserWindow | null} */ let mainWin = null;
let mainFocused = false;
let activeId = null; // session shown in the main window
/** @type {Map<string, BrowserWindow>} */ const floats = new Map();
/** @type {Map<string, Set<Electron.WebContents>>} */ const subscribers = new Map();
let quitting = false;

const FLOAT_MIN = { width: 280, height: 140 };
// A minimized floating window: one row. float.js treats any window this short as minimized.
const MINI = { width: 340, height: 40, minWidth: 220, maxWidth: 900 };
/** Minimized floating windows -> the size to give them back. */
/** @type {WeakMap<BrowserWindow, { width: number, height: number }>} */ const minimized = new WeakMap();
// While an agent works on a line sent from the bar, the bar shrinks to its spinner.
const TINY = { width: 44, height: 44 };
/** @type {WeakSet<BrowserWindow>} */ const tiny = new WeakSet();
/** @type {WeakMap<BrowserWindow, number[]>} */ const dragFrom = new WeakMap();
const CHIME = '/System/Library/Sounds/Glass.aiff';
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// What a previewed page may do without being aIDE itself: copy to the clipboard,
// go full screen, capture the pointer. Not the camera, the microphone or other apps.
const FRAME_MAY = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);

const prefs = () => ({ claudeCommand: 'claude', agentArgs: '', ...(store.get('prefs') || {}) });

// ------------------------------------------------------------- broadcasting

function broadcast(channel, ...args) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args);
  }
}

let sessionsQueued = false;
function sessionsChanged() {
  if (sessionsQueued) return;
  sessionsQueued = true;
  setImmediate(() => {
    sessionsQueued = false;
    const list = sessions.list();
    broadcast('sessions:update', list);
    const attention = list.filter((s) => s.waiting || s.unseen).length;
    app.dock?.setBadge(attention ? String(attention) : '');
  });
}

// Terminal output is coalesced per session for a few milliseconds so a chatty
// process costs one IPC message per frame rather than one per chunk.
const pending = new Map();
let flushTimer = null;

function flushSession(id) {
  const chunks = pending.get(id);
  if (!chunks) return;
  pending.delete(id);
  const subs = subscribers.get(id);
  if (!subs || !subs.size) return;
  const data = chunks.join('');
  for (const wc of subs) if (!wc.isDestroyed()) wc.send('session:data', id, data);
}

function flushAll() {
  flushTimer = null;
  for (const id of [...pending.keys()]) flushSession(id);
}

function unsubscribeAll(wc) {
  for (const subs of subscribers.values()) subs.delete(wc);
}

// ------------------------------------------------------------------ windows

function webPreferences() {
  return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true };
}

/**
 * The only frames in a window are HTML previews. A previewed page may move
 * between local pages and embed what it likes; following a link to the web
 * opens the browser instead of loading the site here.
 */
function guardFrame(e) {
  if (e.isMainFrame) return; // will-navigate has it
  if (preview.owns(e.url) || /^(about|blob|data):/i.test(e.url)) return;
  const web = /^https?:\/\//i.test(e.url);
  if (web && e.frame?.parent?.parent) return; // something the page embeds
  e.preventDefault();
  if (web) shell.openExternal(e.url);
}

/** Terminals show links from anywhere; nothing they point at may load inside the app. */
function lockDown(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-frame-navigate', guardFrame);
  // A previewed page that asks "leave this page?" must not be able to keep the window open.
  win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
  win.webContents.on('destroyed', () => {
    unsubscribeAll(win.webContents);
    watchers.unwatch(win.webContents.id);
  });
}

function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
    return mainWin;
  }
  const bounds = store.get('mainBounds') || { width: 1320, height: 840 };
  mainWin = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 440,
    title: 'aIDE',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: BG,
    show: false,
    webPreferences: webPreferences(),
  });
  const win = mainWin;
  lockDown(win);
  win.loadFile(path.join(RENDERER, 'index.html'));
  win.once('ready-to-show', () => win.show());

  let saveTimer = null;
  const saveBounds = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.isFullScreen()) store.set('mainBounds', win.getBounds());
    }, 400);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('focus', () => {
    mainFocused = true;
    if (activeId) sessions.markSeen(activeId);
  });
  win.on('blur', () => {
    mainFocused = false;
  });
  win.on('closed', () => {
    clearTimeout(saveTimer);
    if (mainWin === win) {
      mainWin = null;
      mainFocused = false;
      activeId = null;
    }
  });
  return win;
}

function floatSession(id) {
  const meta = sessions.get(id);
  if (!meta) return;
  const existing = floats.get(id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }

  const size = store.get('floatSize') || { width: 640, height: 400 };
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const step = 30 * (floats.size % 6);
  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: Math.round(area.x + area.width - size.width - 24 - step),
    y: Math.round(area.y + 24 + step),
    minWidth: FLOAT_MIN.width,
    minHeight: FLOAT_MIN.height,
    // A panel floats over other apps (full-screen ones included) and takes
    // keystrokes without pulling the rest of aIDE in front of your browser.
    type: process.platform === 'darwin' ? 'panel' : undefined,
    frame: false,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: BG,
    show: false,
    webPreferences: webPreferences(),
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  lockDown(win);
  floats.set(id, win);
  sessions.setFloating(id, true);

  win.loadFile(path.join(RENDERER, 'float.html'), { query: { id } });
  win.once('ready-to-show', () => win.show());

  let saveTimer = null;
  win.on('resize', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const [width, height] = win.getSize();
      if (tiny.has(win)) return;
      if (minimized.has(win)) store.set('miniWidth', width);
      else store.set('floatSize', { width, height });
    }, 400);
  });
  win.on('closed', () => {
    clearTimeout(saveTimer);
    if (floats.get(id) === win) floats.delete(id);
    sessions.setFloating(id, false);
  });
}

const isFloat = (win) => Boolean(win) && !win.isDestroyed() && [...floats.values()].includes(win);

/**
 * Shrink a floating window to a one-row bar, or bring it back. Only the window
 * changes here: the page lays itself out from the height it is given, so the
 * terminal is never fitted to a size that is about to change.
 */
function setFloatMini(win, mini) {
  if (!isFloat(win)) return;
  if (mini && tiny.has(win)) {
    setFloatTiny(win, false);
    return;
  }
  if (mini === minimized.has(win)) return;
  tiny.delete(win);
  const b = win.getBounds();
  const right = b.x + b.width; // the buttons live on the right, so that corner stays put
  if (mini) {
    minimized.set(win, { width: b.width, height: b.height });
    const width = clamp(Number(store.get('miniWidth')) || MINI.width, MINI.minWidth, MINI.maxWidth);
    win.setMinimumSize(MINI.minWidth, MINI.height);
    win.setBounds({ x: right - width, y: b.y, width, height: MINI.height });
    win.setMaximumSize(MINI.maxWidth, MINI.height); // drag the edge to widen it, never taller
    return;
  }
  const full = minimized.get(win);
  minimized.delete(win);
  // The bar may have been parked in a corner; open back up inside the screen.
  const area = screen.getDisplayMatching(b).workArea;
  const width = Math.min(full.width, area.width);
  const height = Math.min(full.height, area.height);
  win.setMaximumSize(0, 0); // no limit
  win.setBounds({
    x: clamp(right - width, area.x, area.x + area.width - width),
    y: clamp(b.y, area.y, area.y + area.height - height),
    width,
    height,
  });
  win.setMinimumSize(FLOAT_MIN.width, FLOAT_MIN.height);
}

/** Shrink a minimized bar to just its spinner, or grow it back into the bar. */
function setFloatTiny(win, on) {
  if (!isFloat(win) || on === tiny.has(win) || !minimized.has(win)) return;
  const b = win.getBounds();
  const right = b.x + b.width;
  // The old limits would clamp the new size, so lift them for the move.
  win.setMinimumSize(0, 0);
  win.setMaximumSize(0, 0);
  if (on) {
    tiny.add(win);
    win.setBounds({ x: right - TINY.width, y: b.y, width: TINY.width, height: TINY.height });
    win.setMinimumSize(TINY.width, TINY.height);
    win.setMaximumSize(TINY.width, TINY.height);
    return;
  }
  tiny.delete(win);
  const width = clamp(Number(store.get('miniWidth')) || MINI.width, MINI.minWidth, MINI.maxWidth);
  const area = screen.getDisplayMatching(b).workArea;
  win.setBounds({ x: clamp(right - width, area.x, area.x + area.width - width), y: b.y, width, height: MINI.height });
  win.setMinimumSize(MINI.minWidth, MINI.height);
  win.setMaximumSize(MINI.maxWidth, MINI.height);
}

let chimes = 0;
function chime() {
  chimes++;
  if (TESTING) return;
  execFile('/usr/bin/afplay', [CHIME], () => {}); // the system volume, and no sound at all if the file is missing
}

/** Send to the main window without pulling it in front of whatever you are doing. */
function deliverToMain(channel, ...args) {
  if (mainWin && !mainWin.isDestroyed()) {
    const wc = mainWin.webContents;
    if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(channel, ...args));
    else wc.send(channel, ...args);
    return;
  }
  sendToMain(channel, ...args);
}

function dockSession(id) {
  const win = floats.get(id);
  if (win && !win.isDestroyed()) win.close();
  // Reopens the main window if it was closed while the session floated.
  sendToMain('ui:select', id);
}

// ---------------------------------------------------------------------- IPC

function confirm(win, { message, detail, action }) {
  if (TESTING) return true;
  const choice = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: 'warning',
    message,
    detail,
    buttons: [action, 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  return choice === 0;
}

function removeSession(id, win) {
  const meta = sessions.get(id);
  if (!meta) return false;
  if (meta.status === 'running') {
    const name = meta.name || meta.title || meta.defaultName;
    const ok = confirm(win, {
      message: `Close “${name}”?`,
      detail: meta.kind === 'agent'
        ? 'The agent is still running and will be stopped. Its conversation is saved and can be resumed from Claude Code later.'
        : 'The process is still running and will be stopped.',
      action: 'Close',
    });
    if (!ok) return false;
  }
  sessions.remove(id);
  return true;
}

function rememberDir(dir) {
  const recent = [dir, ...(store.get('recentDirs') || []).filter((d) => d !== dir)].slice(0, 8);
  store.set('recentDirs', recent);
}

function registerIpc() {
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('app:init', () => ({
    sessions: sessions.list(),
    servers: scanner.list(),
    prefs: prefs(),
    ui: store.get('ui') || {},
    recentDirs: store.get('recentDirs') || [],
    home: os.homedir(),
  }));

  ipcMain.handle('prefs:set', (_e, patch) => {
    store.set('prefs', { ...(store.get('prefs') || {}), ...patch });
    return prefs();
  });
  ipcMain.handle('ui:set', (_e, patch) => {
    store.set('ui', { ...(store.get('ui') || {}), ...patch });
  });

  // Sessions
  ipcMain.handle('session:create', (_e, opts) => {
    try {
      const meta = sessions.create(opts);
      rememberDir(meta.cwd);
      if (meta.kind === 'agent') store.set('prefs', { ...(store.get('prefs') || {}), agentArgs: meta.extraArgs });
      return { ok: true, meta, recentDirs: store.get('recentDirs') };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('session:start', (_e, id, opts) => sessions.start(id, opts || {}));
  ipcMain.handle('session:kill', (_e, id) => sessions.kill(id));
  ipcMain.handle('session:remove', (e, id) => removeSession(id, winOf(e)));
  ipcMain.handle('session:rename', (_e, id, name) => sessions.rename(id, name));
  ipcMain.handle('session:float', (_e, id) => floatSession(id));
  ipcMain.handle('session:dock', (_e, id) => dockSession(id));

  ipcMain.handle('session:attach', (e, id) => {
    const wc = e.sender;
    return new Promise((resolve) => {
      sessions.snapshot(id, (snap) => {
        if (!snap || wc.isDestroyed()) return resolve(null);
        // Everything up to here is in the snapshot: hand older output to the
        // existing subscribers first, then add this one, so it sees each byte once.
        flushSession(id);
        if (!subscribers.has(id)) subscribers.set(id, new Set());
        subscribers.get(id).add(wc);
        resolve(snap);
      });
    });
  });
  ipcMain.on('session:detach', (e, id) => subscribers.get(id)?.delete(e.sender));
  ipcMain.on('session:input', (_e, id, data) => {
    if (typeof data === 'string') sessions.write(id, data);
  });
  ipcMain.on('session:submit', (_e, id, text) => {
    if (typeof text === 'string') sessions.submit(id, text);
  });
  ipcMain.on('session:resize', (_e, id, cols, rows) => sessions.resize(id, cols, rows));
  ipcMain.on('session:active', (e, id) => {
    if (!mainWin || e.sender !== mainWin.webContents) return;
    activeId = id || null;
    if (activeId && mainFocused) sessions.markSeen(activeId);
  });

  ipcMain.handle('session:menu', (e, id, opts) => {
    const meta = sessions.get(id);
    const win = winOf(e);
    if (!meta || !win) return;
    const running = meta.status === 'running';
    const template = [
      { label: 'Rename…', click: () => e.sender.send('ui:rename', id) },
      meta.floating
        ? { label: 'Return to Main Window', click: () => dockSession(id) }
        : { label: 'Float in Its Own Window', click: () => floatSession(id) },
    ];
    // The main window owns the grouping of its Agents list; it says what the
    // groups are and carries out the move it is sent back.
    if (meta.kind === 'agent' && Array.isArray(opts?.groups)) {
      const moveTo = (target) => e.sender.send('ui:move-to-group', id, target);
      const groups = opts.groups.filter((g) => g && typeof g.id === 'string').slice(0, 100);
      template.push({
        label: 'Move to Group',
        submenu: [
          ...groups.map((g) => ({
            label: String(g.name || 'Group').slice(0, 60),
            type: 'checkbox',
            checked: g.id === opts.groupId,
            click: () => moveTo(g.id),
          })),
          ...(groups.length ? [{ type: 'separator' }] : []),
          { label: 'New Group', click: () => moveTo('new') },
          ...(opts.groupId ? [{ label: 'Remove from Group', click: () => moveTo(null) }] : []),
        ],
      });
    }
    template.push({ type: 'separator' });
    if (running) {
      template.push({ label: 'Stop', click: () => sessions.kill(id) });
    } else {
      if (meta.kind === 'agent' && meta.canResume) {
        template.push({ label: 'Resume Conversation', click: () => sessions.start(id, { resume: true }) });
      }
      template.push({ label: meta.kind === 'agent' ? 'Start Fresh' : 'Run Again', click: () => sessions.start(id) });
    }
    template.push(
      {
        label: meta.kind === 'agent' ? 'New Agent in Same Folder' : 'New Shell in Same Folder',
        click: () => {
          const res = sessions.create({ kind: meta.kind, cwd: meta.cwd, extraArgs: meta.kind === 'agent' ? meta.extraArgs : '' });
          sendToMain('ui:select', res.id, { after: id }); // next to the one it was made from
        },
      },
      { label: 'Reveal Folder in Finder', click: () => shell.openPath(meta.cwd) },
      { type: 'separator' },
      { label: 'Close', click: () => removeSession(id, win) }
    );
    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // Servers
  ipcMain.handle('servers:refresh', () => scanner.scan());
  ipcMain.handle('servers:kill', async (_e, pid) => {
    // Only ever signal something the scanner currently reports as listening.
    if (!scanner.list().some((s) => s.pid === pid)) return { ok: false, error: 'No longer running.' };
    try {
      process.kill(pid, 'SIGTERM');
    } catch (err) {
      return { ok: false, error: err.message };
    }
    setTimeout(() => scanner.scan(), 400);
    return { ok: true };
  });

  // Shell integration
  ipcMain.handle('shell:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) return shell.openExternal(url);
    return undefined;
  });
  ipcMain.handle('shell:reveal', (_e, target) => shell.showItemInFolder(target));
  ipcMain.handle('preview:url', (_e, file, projectDir) => {
    if (!preview.canPreview(file)) return null;
    return {
      url: preview.urlFor(file, typeof projectDir === 'string' ? projectDir : null),
      // aIDE is always dark; a page should get what the browser would give it,
      // which is the system's setting.
      dark: systemPreferences.getUserDefault('AppleInterfaceStyle', 'string') === 'Dark',
    };
  });
  ipcMain.handle('preview:open-in-browser', async (_e, file) => {
    if (!preview.canPreview(file)) return;
    try {
      // The default browser, even when .html files belong to an editor.
      const browser = await app.getApplicationInfoForProtocol('https://');
      if (TESTING) return browser.path;
      await new Promise((resolve, reject) => {
        execFile('/usr/bin/open', ['-a', browser.path, file], (err) => (err ? reject(err) : resolve()));
      });
    } catch {
      if (!TESTING) shell.openPath(file);
    }
    return undefined;
  });
  ipcMain.handle('dialog:pick-folder', async (e, defaultPath) => {
    const res = await dialog.showOpenDialog(winOf(e), {
      defaultPath: defaultPath || os.homedir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });

  // Files
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      return { kind: 'error', ok: false, message: err.message };
    }
  };
  ipcMain.handle('fs:list', (_e, dir) => guard(async () => ({ ok: true, entries: await files.listDir(dir) })));
  ipcMain.handle('fs:read', (_e, file) => guard(() => files.readFile(file)));
  ipcMain.handle('fs:write', (_e, file, content, mtimeMs, force) => guard(() => files.writeFile(file, content, mtimeMs, force)));
  ipcMain.on('fs:watch', (e, file) => {
    const wc = e.sender;
    if (!file) return watchers.unwatch(wc.id);
    watchers.watch(wc.id, file, (changed) => {
      if (!wc.isDestroyed()) wc.send('fs:changed', changed);
    });
    return undefined;
  });

  // Floating window chrome
  ipcMain.on('float:pin', (e, pinned) => {
    const win = winOf(e);
    if (win) win.setAlwaysOnTop(Boolean(pinned), 'floating');
  });
  ipcMain.on('float:opacity', (e, value) => {
    const win = winOf(e);
    if (win) win.setOpacity(Math.min(1, Math.max(0.3, Number(value) || 1)));
  });
  ipcMain.handle('float:mini', (e, mini) => setFloatMini(winOf(e), Boolean(mini)));
  ipcMain.handle('float:tiny', (e, on) => setFloatTiny(winOf(e), Boolean(on)));
  ipcMain.on('float:chime', (e) => {
    if (isFloat(winOf(e))) chime();
  });
  // The spinner-only window is too small for a title bar to drag it by.
  ipcMain.on('float:drag', (e, phase, dx, dy) => {
    const win = winOf(e);
    if (!isFloat(win) || !tiny.has(win)) return;
    if (phase === 'start') dragFrom.set(win, win.getPosition());
    const from = dragFrom.get(win);
    if (phase === 'move' && from && Number.isFinite(dx) && Number.isFinite(dy)) win.setPosition(Math.round(from[0] + dx), Math.round(from[1] + dy));
  });

  // Git
  const dirArg = (dir) => (typeof dir === 'string' && path.isAbsolute(dir) ? dir : null);
  ipcMain.handle('git:head', (_e, dir) => (dirArg(dir) ? git.head(dir) : null));
  ipcMain.handle('git:overview', (_e, dir, force) => (dirArg(dir) ? git.overview(dir, { force: Boolean(force) }) : null));
  ipcMain.handle('git:fetch', (_e, dir) => (dirArg(dir) ? git.fetchRemote(dir) : { ok: false, message: 'No folder.' }));
  ipcMain.on('window:close', (e) => winOf(e)?.close());
}

// --------------------------------------------------------------------- menu

function sendToMain(channel, ...args) {
  const win = createMainWindow();
  const deliver = () => win.webContents.send(channel, ...args);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', deliver);
  else deliver();
}

function buildMenu() {
  const selectItems = Array.from({ length: 9 }, (_, i) => ({
    label: `Session ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => sendToMain('ui:select-index', i),
  }));
  const template = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Agent…', accelerator: 'CmdOrCtrl+N', click: () => sendToMain('ui:new', 'agent') },
        { label: 'New Process or Shell…', accelerator: 'CmdOrCtrl+T', click: () => sendToMain('ui:new', 'process') },
        { type: 'separator' },
        { label: 'Save File', accelerator: 'CmdOrCtrl+S', click: () => sendToMain('ui:save') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Float or Return Current Session',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: (_item, win) => {
            // From a floating window the shortcut sends that session home.
            for (const [id, floatWin] of floats) if (floatWin === win) return dockSession(id);
            return sendToMain('ui:toggle-float');
          },
        },
        {
          label: 'Minimize or Expand Floating Window',
          accelerator: 'CmdOrCtrl+Shift+M',
          click: (_item, win) => setFloatMini(win, !minimized.has(win)),
        },
        { label: 'Show Main Window', accelerator: 'CmdOrCtrl+0', click: () => createMainWindow() },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { label: 'Session', submenu: selectItems },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- lifecycle

async function startControl() {
  control = new ControlServer({
    sessions,
    version: app.getVersion(),
    servers: () => scanner.list(),
    created: (meta, callerId) => {
      rememberDir(meta.cwd);
      // A new agent goes next to the one that asked for it, in the same group.
      if (meta.kind === 'agent') deliverToMain('ui:place', meta.id, { after: callerId });
    },
    showFile: async (file, project) => {
      let st;
      try {
        st = await fs.promises.stat(file);
      } catch {
        return { ok: false, message: `There is no file at ${file}.` };
      }
      if (!st.isFile()) return { ok: false, message: `${file} is a folder, not a file.` };
      deliverToMain('ui:open-file', file, project);
      return { ok: true };
    },
    git: async (dir) => {
      const ov = await git.overview(dir, { force: true });
      if (ov.repo) deliverToMain('ui:show-git', ov.root);
      return git.describeOverview(ov);
    },
  });
  try {
    await control.listen();
    sessions.toolsConfig = (id) => control.configFor(id);
  } catch (err) {
    console.error(`aIDE tools for agents are off: ${err.message}`);
  }
}

async function boot() {
  nativeTheme.themeSource = 'dark';
  const userData = app.getPath('userData');
  store = new Store(path.join(userData, 'state.json'));
  sessions = new SessionManager({ runtimeDir: path.join(userData, 'runtime'), store, getPrefs: prefs });
  sessions.isViewed = (id) => floats.has(id) || (mainFocused && activeId === id);

  sessions.on('meta', sessionsChanged);
  sessions.on('removed', (id) => {
    const win = floats.get(id);
    if (win && !win.isDestroyed()) win.close();
    subscribers.delete(id);
    pending.delete(id);
    sessionsChanged();
  });
  sessions.on('data', (id, data) => {
    let chunks = pending.get(id);
    if (!chunks) pending.set(id, (chunks = []));
    chunks.push(data);
    if (!flushTimer) flushTimer = setTimeout(flushAll, 6);
  });

  scanner = new ServerScanner({
    getRoots: () => sessions.rootPids(),
    getSessionName: (id) => {
      const m = sessions.get(id);
      return m ? m.name || m.title || m.defaultName : null;
    },
  });
  scanner.on('update', (list) => broadcast('servers:update', list));
  scanner.start();

  // aIDE's own pages keep every permission, as before. A frame is a previewed
  // page, and gets only the harmless ones.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) => {
    done(details.isMainFrame !== false || FRAME_MAY.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    return details.isMainFrame !== false || FRAME_MAY.has(permission);
  });
  preview.start();

  await startControl();
  if (TESTING) global.aideTest = { control, chimes: () => chimes };

  registerIpc();
  buildMenu();
  createMainWindow();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => createMainWindow());
  app.whenReady().then(boot);

  app.on('activate', () => {
    if (store) createMainWindow();
  });

  // Agents live in this process, not in a window: closing the main window
  // leaves them (and any floating windows) running.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (e) => {
    if (quitting || !sessions) return;
    const running = sessions.list().filter((s) => s.status === 'running');
    if (running.length) {
      const agents = running.filter((s) => s.kind === 'agent').length;
      const others = running.length - agents;
      const parts = [];
      if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
      if (others) parts.push(`${others} process${others === 1 ? '' : 'es'}`);
      const ok = confirm(mainWin, {
        message: `Quit aIDE and stop ${parts.join(' and ')}?`,
        detail: 'Agent conversations are saved and can be resumed next time.',
        action: 'Quit',
      });
      if (!ok) {
        e.preventDefault();
        return;
      }
    }
    quitting = true;
    control?.close();
    scanner.stop();
    sessions.dispose();
    store.flush();
  });
}
