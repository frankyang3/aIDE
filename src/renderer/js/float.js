// A floating window shows exactly one session, always on top of other apps.
// Minimized, it is a single row: the status, the name and a field that sends
// one line to the session. Once a line is sent to an agent the row shrinks to
// just its spinner, and grows back, with a sound, when the agent finishes or
// needs you.
import { $, el, iconButton, statusOf, displayName, subtitle, beginRename } from './common.js';
import { TermView } from './termview.js';

const aide = window.aide;
const id = new URLSearchParams(location.search).get('id');
const OPACITY_STEPS = [1, 0.85, 0.7, 0.55];
// The main process sizes the window and the layout follows from its height,
// so the two can never disagree. A full window is never this short.
const MINI_MAX_HEIGHT = 60;
const TINY_MAX_WIDTH = 60;
// A line that does not start a turn (a slash command that answers at once) must not leave the spinner up.
const START_WAIT_MS = 5000;
// Clicks on the spinner-only window open it; drags move it.
const DRAG_SLOP = 4;
// A permission prompt also stops the spinner; its notice arrives a moment
// later. Wait that long before calling a turn finished.
const DONE_DELAY_MS = 450;

const dom = {
  status: $('#float-status'),
  name: $('#float-name'),
  sub: $('#float-sub'),
  quickInput: $('#quick-input'),
  quickNote: $('#quick-note'),
  actions: $('#float-actions'),
  exitBar: $('#exit-bar'),
};

let meta = null;
let home = '';
let view = null;
let pinned = true;
let opacity = 0;
let exitSig = '';
let mini = false;
let tiny = false; // shrunk to the spinner while the agent works on a line from the bar
let done = false; // finished a turn while minimized, and you have not answered yet
let doneTimer = null;
let starting = false; // a line was sent and the turn has not visibly begun yet
let startTimer = null;

function rename() {
  if (!meta || mini) return;
  beginRename(dom.name, displayName(meta), (name) => aide.sessions.rename(id, name));
}

function renderActions() {
  if (mini) {
    dom.actions.replaceChildren(iconButton('expand', 'Expand (⇧⌘M)', { onclick: () => aide.float.setMini(false) }));
    return;
  }
  const opacityBtn = el('button', {
    type: 'button',
    class: 'icon-btn opacity-label',
    title: 'Window opacity',
    'aria-label': 'Window opacity',
    onclick: () => {
      opacity = (opacity + 1) % OPACITY_STEPS.length;
      aide.float.setOpacity(OPACITY_STEPS[opacity]);
      renderActions();
    },
  }, `${Math.round(OPACITY_STEPS[opacity] * 100)}%`);
  const pinBtn = iconButton('pin', pinned ? 'Always on top: on' : 'Always on top: off', {
    onclick: () => {
      pinned = !pinned;
      aide.float.setPinned(pinned);
      renderActions();
    },
  });
  pinBtn.classList.toggle('on', pinned);
  pinBtn.setAttribute('aria-pressed', String(pinned));
  dom.actions.replaceChildren(
    opacityBtn,
    pinBtn,
    iconButton('pencil', 'Rename', { onclick: rename }),
    iconButton('minimize', 'Minimize to a small bar (⇧⌘M)', { onclick: () => aide.float.setMini(true) }),
    iconButton('dock', 'Return to main window (⇧⌘F)', { onclick: () => aide.sessions.dock(id) }),
    iconButton('close', 'Hide (the session keeps running in the main window)', { onclick: () => aide.closeWindow() })
  );
}

function clearDone() {
  clearTimeout(doneTimer);
  doneTimer = null;
  done = false;
}

function clearStarting() {
  clearTimeout(startTimer);
  startTimer = null;
  starting = false;
}

/** Back to the bar, and a sound: the agent has finished, or needs you. */
function callBack() {
  clearStarting();
  if (tiny) aide.float.setTiny(false);
  aide.float.chime();
}

/** Notice a turn ending, or a question, while the window is minimized. */
function trackDone(prev, next) {
  if (next.busy) clearStarting();
  if (next.status !== 'running') {
    clearDone();
    clearStarting();
    if (tiny) aide.float.setTiny(false);
    return undefined;
  }
  if (next.waiting) {
    clearDone();
    if (mini && !prev?.waiting) callBack();
    return undefined;
  }
  if (next.busy) return clearDone();
  if (!prev?.busy || !mini) return undefined;
  clearTimeout(doneTimer);
  doneTimer = setTimeout(() => {
    doneTimer = null;
    if (!mini || meta.busy || meta.waiting) return;
    done = true;
    callBack();
    render();
  }, DONE_DELAY_MS);
  return undefined;
}

function renderQuick(state, label) {
  // Nothing to type a line into: a stopped session, or a prompt that wants a choice.
  const blocked = meta.status !== 'running' || meta.waiting;
  dom.quickInput.hidden = blocked;
  dom.quickNote.hidden = !blocked;
  dom.quickNote.textContent = label;
  dom.quickInput.placeholder =
    state === 'busy' ? 'Working…' : state === 'done' ? 'Done. Reply…' : meta.kind === 'agent' ? 'Message…' : 'Command…';
}

function renderExit() {
  const exited = meta.status !== 'running';
  const sig = [exited, meta.exitCode, meta.canResume].join('|');
  if (sig === exitSig) return;
  exitSig = sig;
  dom.exitBar.hidden = !exited;
  if (!exited) return;
  const agent = meta.kind === 'agent';
  const start = (resume) => {
    const term = view?.term;
    aide.sessions.start(id, { resume, ...(term ? { cols: term.cols, rows: term.rows } : {}) });
    view?.focus();
  };
  dom.exitBar.replaceChildren(
    el('span', { class: 'msg' }, meta.status === 'stopped' ? 'Not running' : meta.exitCode ? `Exited with code ${meta.exitCode}` : 'Exited'),
    agent && meta.canResume ? el('button', { type: 'button', class: 'text-btn', onclick: () => start(true) }, 'Resume') : null,
    el('button', { type: 'button', class: 'text-btn primary', onclick: () => start(false) }, agent ? 'Start fresh' : 'Run again'));
}

function render() {
  if (!meta) return;
  const st = statusOf(meta);
  // Between sending a line and the agent's title starting to spin, show it working already.
  const state = mini && done ? 'done' : starting && st.state !== 'waiting' ? 'busy' : st.state;
  const label = state === 'done' ? 'Finished' : state === 'busy' ? 'Working' : st.label;
  dom.status.dataset.state = state;
  dom.status.title = label;
  document.body.dataset.state = state;
  if (!dom.name.classList.contains('editing')) dom.name.textContent = displayName(meta);
  dom.sub.textContent = subtitle(meta, home);
  document.title = displayName(meta);
  renderQuick(state, label);
  renderExit();
}

function focusDefault() {
  if (!mini) view?.focus();
  else if (!dom.quickInput.hidden) dom.quickInput.focus();
}

function syncMode() {
  // The viewport height, not outerHeight: that one can still hold the old
  // size when the resize event fires.
  const next = aide.float.height() <= MINI_MAX_HEIGHT;
  const nextTiny = next && aide.float.width() <= TINY_MAX_WIDTH;
  if (nextTiny !== tiny) {
    tiny = nextTiny;
    document.body.classList.toggle('tiny', tiny);
  }
  if (next === mini) return;
  mini = next;
  document.body.classList.toggle('mini', mini);
  clearDone();
  if (!mini) clearStarting();
  renderActions();
  render();
  focusDefault();
}

function sendQuick(e) {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  const text = dom.quickInput.value.trim();
  if (!text) return;
  aide.sessions.submit(id, text);
  dom.quickInput.value = '';
  clearDone();
  // An agent says when it is done; a shell does not, so only an agent's bar gets out of the way.
  if (meta.kind === 'agent') {
    clearStarting();
    starting = true;
    startTimer = setTimeout(() => {
      startTimer = null;
      starting = false;
      if (!meta.busy && tiny) aide.float.setTiny(false);
      render();
    }, START_WAIT_MS);
    aide.float.setTiny(true);
  }
  render();
}

/** The spinner-only window: a click opens it back into the bar, a drag moves it. */
function wireTiny() {
  let start = null;
  document.body.addEventListener('pointerdown', (e) => {
    if (!tiny || e.button !== 0) return;
    start = { x: e.screenX, y: e.screenY, moved: false, id: e.pointerId };
    document.body.setPointerCapture(e.pointerId);
    aide.float.drag('start');
  });
  document.body.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.screenX - start.x;
    const dy = e.screenY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    start.moved = true;
    aide.float.drag('move', dx, dy);
  });
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const clicked = !start.moved;
    start = null;
    if (clicked && tiny) {
      clearStarting();
      aide.float.setTiny(false);
    }
  };
  document.body.addEventListener('pointerup', end);
  document.body.addEventListener('pointercancel', end);
}

async function boot() {
  const init = await aide.init();
  home = init.home;
  meta = init.sessions.find((s) => s.id === id) || null;
  if (!meta) return aide.closeWindow();

  dom.name.addEventListener('dblclick', rename);
  dom.quickInput.addEventListener('keydown', sendQuick);
  dom.quickNote.addEventListener('click', () => aide.float.setMini(false));
  wireTiny();
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());
  renderActions();
  render();

  // A fit can run between the window changing size and the resize event, so
  // it settles the mode first and never measures the terminal in a one-row window.
  view = new TermView($('#float-term'), id, { beforeFit: syncMode });
  view.focus();
  window.addEventListener('focus', () => {
    if (document.activeElement === document.body) focusDefault();
  });
  window.addEventListener('resize', syncMode);
  syncMode();

  aide.sessions.onUpdate((list) => {
    const next = list.find((s) => s.id === id);
    if (!next) return aide.closeWindow();
    trackDone(meta, next);
    meta = next;
    return render();
  });

  window.__aide = { view, get meta() { return meta; }, get mini() { return mini; }, get tiny() { return tiny; } };
  return undefined;
}

boot();
