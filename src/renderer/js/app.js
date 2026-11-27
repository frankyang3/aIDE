// Main window: session lists, the active terminal, servers, and the file peek panel.
import { $, el, icon, iconButton, statusOf, displayName, subtitle, shortPath, beginRename, formatBytes, modelName } from './common.js';
import { TermView, estimateGrid } from './termview.js';

const aide = window.aide;

const state = {
  sessions: [],
  servers: [],
  activeId: null,
  home: '',
  prefs: {},
  recentDirs: [],
  sideTab: 'servers',
  gitDir: null, // set when an agent shows the Git tab for its own folder
  showOther: false,
  openServers: new Set(),
  confirmKill: null,
  copied: null,
  // The Agents list, top to bottom: a session id, or a group
  // { id, name, collapsed, items: [session ids] }. Groups do not nest.
  layout: [],
  /** Where an agent that is about to appear belongs: id -> { group } or { after }. */
  placing: new Map(),
  pendingSelect: null,
};

/** @type {Map<string, { host: HTMLElement, view: TermView }>} */
const views = new Map();

const dom = {
  root: document.documentElement,
  agents: $('#agents'),
  processes: $('#processes'),
  servers: $('#servers'),
  serversCount: $('#servers-count'),
  filesTab: $('#files'),
  treeRoot: $('#tree-root'),
  tree: $('#tree'),
  headStatus: $('#head-status'),
  headName: $('#head-name'),
  headSub: $('#head-sub'),
  headActions: $('#head-actions'),
  headMeta: $('#head-meta'),
  git: $('#git'),
  workspace: $('#workspace'),
  terminals: $('#terminals'),
  overlay: $('#overlay'),
  exitBar: $('#exit-bar'),
  filePanel: $('#file-panel'),
  fileSplit: $('#split-file'),
  dialog: $('#new-dialog'),
  form: $('#new-form'),
};

const byId = (id) => state.sessions.find((s) => s.id === id) || null;
const active = () => byId(state.activeId);
const basename = (p) => p.split('/').filter(Boolean).pop() || p;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ----------------------------------------------------------------- sessions

/** Update `list` in place so rows keep their identity (and any rename field in progress). */
function reconcile(list, items, create, update) {
  const existing = new Map([...list.children].filter((c) => c.dataset.id).map((c) => [c.dataset.id, c]));
  items.forEach((item, i) => {
    const row = existing.get(item.id) || create(item);
    existing.delete(item.id);
    update(row, item);
    if (list.children[i] !== row) list.insertBefore(row, list.children[i] || null);
  });
  for (const stale of existing.values()) stale.remove();
  for (const extra of [...list.children].slice(items.length)) extra.remove();
}

function createSessionRow(m) {
  return el('div', { class: 'row session', dataset: { id: m.id } },
    el('span', { class: 'status' }),
    el('div', { class: 'row-text' }, el('div', { class: 'row-name' }), el('div', { class: 'row-sub' })),
    el('span', { class: 'tag-float', title: 'In a floating window' }, icon('float')),
    el('div', { class: 'row-actions' },
      iconButton('float', '', { dataset: { act: 'float' } }),
      iconButton('close', 'Close', { dataset: { act: 'close' } })));
}

function updateSessionRow(row, m) {
  row.classList.toggle('active', m.id === state.activeId);
  const st = statusOf(m);
  const status = row.querySelector('.status');
  status.dataset.state = st.state;
  status.title = st.label;
  const name = row.querySelector('.row-name');
  if (!name.classList.contains('editing')) name.textContent = displayName(m);
  row.querySelector('.row-sub').textContent = subtitle(m, state.home);
  row.querySelector('.tag-float').hidden = !m.floating;
  if (row.dataset.floating !== String(m.floating)) {
    row.dataset.floating = String(m.floating);
    const btn = row.querySelector('[data-act="float"]');
    btn.title = m.floating ? 'Return to main window' : 'Float in its own window';
    btn.setAttribute('aria-label', btn.title);
    btn.replaceChildren(icon(m.floating ? 'dock' : 'float'));
  }
}

// ------------------------------------------------------------ agent groups

const isGroup = (entry) => typeof entry !== 'string';
const keyOf = (entry) => (isGroup(entry) ? entry.id : entry);
const groups = () => state.layout.filter(isGroup);
const groupById = (id) => groups().find((g) => g.id === id) || null;
const groupOf = (sessionId) => groups().find((g) => g.items.includes(sessionId)) || null;

/** A layout as it was saved, with anything malformed dropped. */
function readLayout(saved) {
  const out = [];
  for (const entry of Array.isArray(saved) ? saved : []) {
    if (typeof entry === 'string') out.push(entry);
    else if (entry && typeof entry.id === 'string' && Array.isArray(entry.items)) {
      out.push({
        id: entry.id,
        name: String(entry.name || 'Group'),
        collapsed: Boolean(entry.collapsed),
        items: entry.items.filter((i) => typeof i === 'string'),
      });
    }
  }
  return out;
}

function takeOut(sessionId) {
  state.layout = state.layout.filter((e) => e !== sessionId);
  for (const g of groups()) g.items = g.items.filter((i) => i !== sessionId);
}

/** Insert at the top level (no parent) or in a group, before `before` or at the end. */
function putIn(entry, parent, before) {
  const list = (parent && groupById(parent)?.items) || state.layout;
  const at = before == null ? -1 : list.findIndex((e) => keyOf(e) === before);
  list.splice(at < 0 ? list.length : at, 0, entry);
}

function placeAgent(id, { group = null, after = null }) {
  const list = after ? groupOf(after)?.items || state.layout : null;
  const at = list ? list.indexOf(after) : -1;
  if (at >= 0) list.splice(at + 1, 0, id);
  else putIn(id, group, null);
}

let savedLayout = '';
/** Make the layout match the agents that exist, and remember it. */
function syncLayout() {
  const agents = state.sessions.filter((s) => s.kind === 'agent').map((s) => s.id);
  const live = new Set(agents);
  const seen = new Set();
  const keep = (id) => live.has(id) && !seen.has(id) && Boolean(seen.add(id));
  const next = [];
  for (const entry of state.layout) {
    if (isGroup(entry)) {
      entry.items = entry.items.filter(keep);
      next.push(entry);
    } else if (keep(entry)) next.push(entry);
  }
  state.layout = next;
  for (const id of agents) {
    const place = state.placing.get(id);
    if (place) {
      state.placing.delete(id);
      takeOut(id);
      placeAgent(id, place);
    } else if (!seen.has(id)) state.layout.push(id);
  }
  const json = JSON.stringify(state.layout);
  if (json !== savedLayout) {
    savedLayout = json;
    aide.setUi({ agentLayout: state.layout });
  }
}

/** Sessions with a row on screen, top to bottom: what ⌘1–⌘9 count. */
function visibleSessions() {
  const agents = state.layout.flatMap((e) => (isGroup(e) ? (e.collapsed ? [] : e.items) : [e]));
  return [...agents.map(byId).filter(Boolean), ...state.sessions.filter((s) => s.kind === 'process')];
}

/** What a collapsed group has to say for the agents it hides. */
function groupStatus(members) {
  const n = { waiting: 0, busy: 0, unseen: 0 };
  for (const m of members) {
    const { state: st } = statusOf(m);
    if (st in n) n[st]++;
  }
  return {
    state: n.waiting ? 'waiting' : n.busy ? 'busy' : n.unseen ? 'unseen' : '',
    label: [
      n.waiting && `${n.waiting} need${n.waiting === 1 ? 's' : ''} your input`,
      n.busy && `${n.busy} working`,
      n.unseen && `${n.unseen} finished`,
    ].filter(Boolean).join(', '),
  };
}

function createGroupNode(g) {
  return el('div', { class: 'group', dataset: { id: g.id } },
    el('div', { class: 'row group-head' },
      el('button', { type: 'button', class: 'icon-btn twist', dataset: { act: 'toggle' } }, icon('chevron')),
      el('div', { class: 'group-name' }),
      el('span', { class: 'status' }),
      el('span', { class: 'group-count' }),
      el('div', { class: 'row-actions' },
        iconButton('plus', 'New agent in this group', { dataset: { act: 'group-add' } }),
        iconButton('pencil', 'Rename group', { dataset: { act: 'group-rename' } }),
        iconButton('close', 'Remove group (its agents stay)', { dataset: { act: 'group-remove' } }))),
    el('div', { class: 'group-body' }));
}

function updateGroupNode(node, g) {
  const members = g.items.map(byId).filter(Boolean);
  node.classList.toggle('collapsed', g.collapsed);
  node.classList.toggle('has-active', g.items.includes(state.activeId));
  const toggle = node.querySelector('[data-act="toggle"]');
  toggle.title = g.collapsed ? 'Expand' : 'Collapse';
  toggle.setAttribute('aria-label', `${toggle.title} ${g.name}`);
  toggle.setAttribute('aria-expanded', String(!g.collapsed));
  const name = node.querySelector('.group-name');
  if (!name.classList.contains('editing')) name.textContent = g.name;
  const sum = groupStatus(members);
  const status = node.querySelector('.group-head .status');
  status.hidden = !g.collapsed || !sum.state;
  status.dataset.state = sum.state;
  status.title = sum.label;
  node.querySelector('.group-count').textContent = String(members.length);
  const body = node.querySelector('.group-body');
  body.querySelector('.list-empty')?.remove();
  reconcile(body, members, createSessionRow, updateSessionRow);
  if (!members.length) body.append(el('div', { class: 'list-empty' }, 'Drag an agent here.'));
}

function renderSessions() {
  syncLayout();
  const agents = state.layout.map((e) => (isGroup(e) ? e : byId(e)));
  dom.agents.querySelector(':scope > .list-empty')?.remove();
  reconcile(dom.agents, agents,
    (item) => (item.items ? createGroupNode(item) : createSessionRow(item)),
    (node, item) => (item.items ? updateGroupNode(node, item) : updateSessionRow(node, item)));
  if (!agents.length) dom.agents.append(el('div', { class: 'list-empty' }, 'No agents yet.'));

  const processes = state.sessions.filter((s) => s.kind === 'process');
  dom.processes.querySelector('.list-empty')?.remove();
  reconcile(dom.processes, processes, createSessionRow, updateSessionRow);
  if (!processes.length) dom.processes.append(el('div', { class: 'list-empty' }, 'Run a dev server or open a shell.'));
}

function renameGroup(id) {
  const g = groupById(id);
  const target = dom.agents.querySelector(`.group[data-id="${id}"] .group-name`);
  if (!g || !target) return;
  beginRename(target, g.name, (name) => {
    if (!name) return; // a group has no automatic name to fall back to
    g.name = name.slice(0, 60);
    renderSessions();
  });
}

const makeGroup = (name = 'New group') => ({ id: `g-${Math.random().toString(36).slice(2, 10)}`, name, collapsed: false, items: [] });

/** Show a group that was just made and start naming it. */
function introduceGroup(g) {
  renderSessions();
  dom.agents.querySelector(`.group[data-id="${g.id}"]`)?.scrollIntoView({ block: 'nearest' });
  renameGroup(g.id);
}

/** Add a group: around one agent, or empty at the end of the list. */
function newGroup(sessionId = null) {
  const g = makeGroup();
  if (sessionId) {
    const from = groupOf(sessionId);
    const at = state.layout.indexOf(from || sessionId);
    takeOut(sessionId);
    g.items.push(sessionId);
    state.layout.splice(from ? at + 1 : at, 0, g);
  } else {
    state.layout.push(g);
  }
  introduceGroup(g);
}

/** One agent dropped on another: the two become a group where the first one was. */
function pairUp(targetId, sessionId) {
  const target = byId(targetId);
  const dropped = byId(sessionId);
  if (!target || !dropped || !state.layout.includes(targetId)) return;
  // Two agents in the same folder are usually one project, so offer its name.
  const g = makeGroup(target.cwd === dropped.cwd ? basename(target.cwd) : undefined);
  takeOut(sessionId);
  g.items.push(targetId, sessionId);
  state.layout.splice(state.layout.indexOf(targetId), 1, g);
  introduceGroup(g);
}

/** From the session menu: into a group, into a new one ('new'), or out of its group (null). */
function moveToGroup(sessionId, target) {
  if (byId(sessionId)?.kind !== 'agent') return;
  if (target === 'new') return newGroup(sessionId);
  const from = groupOf(sessionId);
  if ((from?.id ?? null) === target || (target && !groupById(target))) return;
  const at = state.layout.indexOf(from);
  takeOut(sessionId);
  if (target) putIn(sessionId, target, null);
  else state.layout.splice(at + 1, 0, sessionId); // just below the group it left
  renderSessions();
}

function wireGroups() {
  $('#new-group').addEventListener('click', () => newGroup());
  dom.agents.addEventListener('click', (e) => {
    const head = e.target.closest('.group-head');
    if (!head || e.target.closest('.rename-input')) return;
    const g = groupById(head.parentElement.dataset.id);
    if (!g) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'group-add') openNewDialog('agent', g.id);
    else if (act === 'group-rename') renameGroup(g.id);
    else {
      if (act === 'group-remove') state.layout.splice(state.layout.indexOf(g), 1, ...g.items);
      else g.collapsed = !g.collapsed;
      renderSessions();
    }
  });
}

/**
 * Drag an agent to reorder it, onto a group to put it inside, onto another
 * agent to start a group with it, or out again; drag a group by its header to
 * move it with everything in it.
 */
function wireAgentDrag() {
  const list = dom.agents;
  const pane = $('#sessions-pane');
  const line = el('div', { class: 'drop-line', hidden: true });
  document.body.append(line);
  let drag = null;
  let scrollTimer = null;

  /** Where a release at height y would land: { parent, before, y }, { parent, into } or { pair, into }. */
  function targetAt(y) {
    const nodes = [...list.children].filter((n) => n.dataset.id);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const r = node.getBoundingClientRect();
      if (y >= r.bottom) continue;
      const id = node.dataset.id;
      const next = nodes[i + 1]?.dataset.id ?? null;
      if (drag.group || !node.classList.contains('group')) {
        // The middle of a lone agent takes another agent to make a group of the
        // two. Groups do not nest, so a dragged group only lands above or below.
        const edge = drag.group || node === drag.source ? r.height / 2 : r.height * 0.3;
        if (y < r.top + edge) return { parent: null, before: id, y: r.top };
        if (y >= r.bottom - edge) return { parent: null, before: next, y: r.bottom };
        return { pair: id, into: node };
      }
      const head = node.querySelector('.group-head').getBoundingClientRect();
      if (y < head.top + head.height * 0.3) return { parent: null, before: id, y: r.top };
      const rows = node.classList.contains('collapsed') ? [] : [...node.querySelectorAll('.group-body > .session')];
      if (y < head.bottom || !rows.length) return { parent: id, before: null, into: node };
      for (const row of rows) {
        const rr = row.getBoundingClientRect();
        if (y < rr.top + rr.height / 2) return { parent: id, before: row.dataset.id, y: rr.top };
      }
      return { parent: id, before: null, y: rows[rows.length - 1].getBoundingClientRect().bottom };
    }
    const last = nodes[nodes.length - 1];
    return { parent: null, before: null, y: (last || list).getBoundingClientRect()[last ? 'bottom' : 'top'] };
  }

  function clearMarks() {
    line.hidden = true;
    for (const n of list.querySelectorAll('.drop-into')) n.classList.remove('drop-into');
  }

  function track() {
    const t = (drag.target = targetAt(drag.y));
    clearMarks();
    if (t.into) return t.into.classList.add('drop-into');
    const box = list.getBoundingClientRect();
    const view = pane.getBoundingClientRect();
    const body = t.parent && list.querySelector(`.group[data-id="${t.parent}"] .group-body`);
    const left = body ? body.getBoundingClientRect().left : box.left + 6;
    line.style.left = `${left}px`;
    line.style.width = `${box.right - 6 - left}px`;
    line.style.top = `${clamp(t.y, view.top, view.bottom) - 1}px`;
    line.hidden = false;
    return undefined;
  }

  /** -1 or 1 while the pointer sits at the top or bottom edge of the list, to scroll it. */
  const edge = () => {
    const view = pane.getBoundingClientRect();
    return drag.y < view.top + 24 ? -1 : drag.y > view.bottom - 24 ? 1 : 0;
  };

  function finish(apply) {
    const d = drag;
    drag = null;
    clearInterval(scrollTimer);
    scrollTimer = null;
    if (!d?.moving) return;
    clearMarks();
    list.classList.remove('dragging');
    d.source.classList.remove('drag-source');
    // The click that ends a drag is part of the drag, not a selection.
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', swallow, true);
    setTimeout(() => window.removeEventListener('click', swallow, true), 0);

    const t = d.target;
    if (!apply || !t || t.before === d.id) return; // cancelled, or dropped where it already was
    if (t.pair) return pairUp(t.pair, d.id);
    if (d.group) {
      const g = groupById(d.id);
      if (!g) return;
      state.layout = state.layout.filter((e) => e !== g);
      putIn(g, null, t.before);
    } else {
      if (!byId(d.id)) return;
      takeOut(d.id);
      putIn(d.id, t.parent, t.before);
    }
    renderSessions();
  }

  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    const node = e.target.closest('.session, .group-head');
    if (!node) return;
    const group = node.classList.contains('group-head');
    const source = group ? node.parentElement : node;
    drag = { id: source.dataset.id, group, source, x: e.clientX, y: e.clientY, moving: false, target: null };
  });
  list.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.moving) {
      // A press only becomes a drag once it has travelled; until then it is still a click.
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      drag.moving = true;
      list.setPointerCapture(e.pointerId);
      list.classList.add('dragging');
      drag.source.classList.add('drag-source');
    }
    drag.y = e.clientY;
    track();
    if (edge() && !scrollTimer) {
      scrollTimer = setInterval(() => {
        if (!drag || !edge()) {
          clearInterval(scrollTimer);
          scrollTimer = null;
          return;
        }
        pane.scrollTop += edge() * 10;
        track();
      }, 30);
    }
  });
  window.addEventListener('pointerup', () => finish(true));
  window.addEventListener('pointercancel', () => finish(false));
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !drag?.moving) return;
    // Escape cancels the drag and must not also reach the terminal, where it would interrupt an agent.
    e.stopPropagation();
    e.preventDefault();
    finish(false);
  }, true);
}

function renameSession(id, target) {
  const m = byId(id);
  if (!m || !target) return;
  beginRename(target, displayName(m), (name) => aide.sessions.rename(id, name));
}

function toggleFloat(id) {
  const m = byId(id);
  if (!m) return;
  if (m.floating) aide.sessions.dock(id);
  else aide.sessions.float(id);
}

function wireSessionList(list) {
  const rowOf = (e) => e.target.closest('.session');
  list.addEventListener('click', (e) => {
    const row = rowOf(e);
    if (!row || e.target.closest('.rename-input')) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'float') toggleFloat(row.dataset.id);
    else if (act === 'close') aide.sessions.remove(row.dataset.id);
    else select(row.dataset.id);
  });
  list.addEventListener('dblclick', (e) => {
    const row = rowOf(e);
    if (!row || e.target.closest('[data-act]')) return;
    renameSession(row.dataset.id, row.querySelector('.row-name'));
  });
  list.addEventListener('contextmenu', (e) => {
    const row = rowOf(e);
    if (!row) return;
    e.preventDefault();
    aide.sessions.menu(row.dataset.id, {
      groups: groups().map(({ id, name }) => ({ id, name })),
      groupId: groupOf(row.dataset.id)?.id ?? null,
    });
  });
}

function select(id, { focus = true } = {}) {
  if (!byId(id)) {
    // Created a moment ago in the main process; the list that includes it is on its way.
    state.pendingSelect = id;
    return;
  }
  state.pendingSelect = null;
  syncLayout();
  const group = groupOf(id);
  if (group) group.collapsed = false;
  const changed = state.activeId !== id;
  state.activeId = id;
  aide.sessions.setActive(id);
  if (changed) aide.setUi({ activeId: id });
  renderSessions();
  renderMain();
  if (changed) activeMoved();
  if (focus) views.get(id)?.view.focus();
}

// --------------------------------------------------------------- main area

/** Size for a session about to start: the active terminal's grid, or an estimate of the empty area. */
function gridForNew() {
  const current = views.get(state.activeId)?.view.term;
  if (current) return { cols: current.cols, rows: current.rows };
  const probe = el('div', { class: 'term-host' });
  dom.terminals.append(probe);
  const grid = estimateGrid(probe);
  probe.remove();
  return grid;
}

function startSession(id, resume = false) {
  const term = views.get(id)?.view.term;
  const size = term ? { cols: term.cols, rows: term.rows } : gridForNew();
  aide.sessions.start(id, { resume, ...size });
  views.get(id)?.view.focus();
}

let headSig = '';
function renderHeader() {
  const m = active();
  dom.headStatus.hidden = !m;
  renderHeadMeta();
  if (!m) {
    dom.headName.textContent = '';
    dom.headSub.textContent = '';
    dom.headActions.replaceChildren();
    headSig = '';
    return;
  }
  const st = statusOf(m);
  dom.headStatus.dataset.state = st.state;
  dom.headStatus.title = st.label;
  if (!dom.headName.classList.contains('editing')) dom.headName.textContent = displayName(m);
  dom.headSub.textContent = subtitle(m, state.home);

  // Rebuild buttons only when what they do changes, so a click is never lost to a re-render.
  const sig = [m.id, m.status, m.floating, m.canResume].join('|');
  if (sig === headSig) return;
  headSig = sig;
  const id = m.id;
  const buttons = [];
  if (m.status === 'running') {
    buttons.push(iconButton('stop', 'Stop', { onclick: () => aide.sessions.kill(id) }));
  } else {
    buttons.push(iconButton('restart', m.kind === 'agent' ? 'Start fresh' : 'Run again', { onclick: () => startSession(id) }));
  }
  buttons.push(
    iconButton('pencil', 'Rename', { onclick: () => renameSession(id, dom.headName) }),
    iconButton(m.floating ? 'dock' : 'float', m.floating ? 'Return to main window (⇧⌘F)' : 'Float in its own window (⇧⌘F)', {
      onclick: () => toggleFloat(id),
    }),
    iconButton('close', 'Close session', { onclick: () => aide.sessions.remove(id) })
  );
  dom.headActions.replaceChildren(...buttons);
}

// The branch checked out in the active session's folder. Polled: agents switch branches.
const headGit = { dir: '', info: null };
let headMetaSig = '';

async function refreshHeadGit() {
  const dir = active()?.cwd || '';
  const info = dir ? await aide.git.head(dir) : null;
  if ((active()?.cwd || '') !== dir) return;
  Object.assign(headGit, { dir, info });
  renderHeadMeta();
}

/** The model the agent is answering with, and the branch, beside the session's name. */
function renderHeadMeta() {
  const m = active();
  const branch = m && headGit.dir === m.cwd ? headGit.info : null;
  const model = m?.kind === 'agent' ? modelName(m.model) : '';
  const sig = JSON.stringify([branch, model, m?.model]);
  if (sig === headMetaSig) return;
  headMetaSig = sig;
  dom.headMeta.replaceChildren(
    ...(branch
      ? [el('button', {
          type: 'button',
          class: 'meta-chip branch',
          title: `${branch.detached ? `Detached at ${branch.branch}` : `On branch ${branch.branch}`}. Click for the Git tab.`,
          onclick: () => showGitTab(),
        }, icon('branch'), el('span', {}, branch.branch))]
      : []),
    ...(model ? [el('span', { class: 'meta-chip model', title: `Model of the latest reply: ${m.model}` }, model)] : []));
}

/** The active session changed: the panels that follow its folder catch up. */
function activeMoved() {
  state.gitDir = null;
  refreshTree();
  refreshGit();
  refreshHeadGit();
}

function ensureView(m) {
  if (views.has(m.id) || m.floating) return;
  const host = el('div', { class: 'term-host', dataset: { session: m.id } });
  dom.terminals.append(host);
  views.set(m.id, { host, view: new TermView(host, m.id) });
}

let overlaySig = '';
function renderOverlay() {
  const m = active();
  const sig = JSON.stringify([m?.id, m?.floating, m?.status, m?.exitCode, m?.canResume, m?.kind, state.sessions.length, state.recentDirs]);
  if (sig === overlaySig) return;
  overlaySig = sig;

  let card = null;
  if (!state.sessions.length) {
    const recent = state.recentDirs.slice(0, 5).map((dir) =>
      el('button', { type: 'button', title: `Start an agent in ${dir}`, onclick: () => createSession({ kind: 'agent', cwd: dir, extraArgs: state.prefs.agentArgs || '' }) },
        icon('folder'), el('span', {}, shortPath(dir, state.home))));
    card = el('div', { class: 'card' },
      el('h3', {}, 'Start an agent'),
      el('p', {}, 'Each agent is a Claude Code session in a folder you pick. Run several at once, and float the ones you want to keep watching over other apps.'),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'text-btn primary', onclick: () => openNewDialog('agent') }, 'New agent…'),
        el('button', { type: 'button', class: 'text-btn', onclick: () => openNewDialog('process') }, 'New process or shell…')),
      recent.length ? el('div', { class: 'recent' }, el('h4', {}, 'Recent folders'), recent) : null);
  } else if (m?.floating) {
    const id = m.id;
    card = el('div', { class: 'card' },
      el('h3', {}, 'In a floating window'),
      el('p', {}, 'This session stays on top of your other apps. Bring it back here whenever you like.'),
      el('div', { class: 'actions' },
        el('button', { type: 'button', class: 'text-btn primary', onclick: () => aide.sessions.dock(id) }, 'Bring it back'),
        el('button', { type: 'button', class: 'text-btn', onclick: () => aide.sessions.float(id) }, 'Show the window')));
  } else if (m?.status === 'stopped') {
    const id = m.id;
    const agent = m.kind === 'agent';
    card = el('div', { class: 'card' },
      el('h3', {}, 'Not running'),
      el('p', {}, agent
        ? (m.canResume ? 'This agent was open last time. Pick up its conversation where it left off, or start a new one in the same folder.' : 'This agent was open last time but had no conversation yet.')
        : 'This was open last time. Run it again in the same folder.'),
      el('div', { class: 'actions' },
        agent && m.canResume ? el('button', { type: 'button', class: 'text-btn primary', onclick: () => startSession(id, true) }, 'Resume conversation') : null,
        el('button', { type: 'button', class: `text-btn${agent && m.canResume ? '' : ' primary'}`, onclick: () => startSession(id) }, agent ? 'Start fresh' : (m.command ? 'Run again' : 'Open shell')),
        el('button', { type: 'button', class: 'text-btn', onclick: () => aide.sessions.remove(id) }, 'Remove')));
  }
  dom.overlay.hidden = !card;
  dom.overlay.replaceChildren(...(card ? [card] : []));

  const exited = m && !m.floating && m.status === 'exited';
  dom.exitBar.hidden = !exited;
  if (exited) {
    const id = m.id;
    const agent = m.kind === 'agent';
    dom.exitBar.replaceChildren(
      el('span', { class: 'msg' }, m.exitCode ? `Exited with code ${m.exitCode}` : 'Exited'),
      agent && m.canResume ? el('button', { type: 'button', class: 'text-btn', onclick: () => startSession(id, true) }, 'Resume conversation') : null,
      el('button', { type: 'button', class: 'text-btn primary', onclick: () => startSession(id) }, agent ? 'Start fresh' : 'Run again'));
  }
}

function renderMain() {
  const m = active();
  if (m) ensureView(m);
  for (const [id, v] of views) v.host.classList.toggle('inactive', id !== state.activeId);
  renderHeader();
  renderOverlay();
}

function onSessions(list) {
  state.sessions = list;
  syncLayout();
  for (const [id, v] of views) {
    const m = byId(id);
    // A floating session is drawn by its own window; only one view may size the pty.
    if (!m || m.floating) {
      v.view.dispose();
      v.host.remove();
      views.delete(id);
    }
  }
  if (!byId(state.activeId)) {
    state.activeId = (visibleSessions()[0] || list[0])?.id ?? null;
    aide.sessions.setActive(state.activeId);
    activeMoved();
  }
  renderSessions();
  renderMain();
  renderServers();
  if (byId(state.pendingSelect)) select(state.pendingSelect);
}

// --------------------------------------------------------------- new dialog

let dialogKind = 'agent';
let dialogGroup = null; // the group whose + opened the dialog

function openNewDialog(kind, groupId = null) {
  dialogKind = kind;
  dialogGroup = groupId;
  const group = groupById(groupId);
  const f = dom.form.elements;
  $('#new-title').textContent = kind !== 'agent' ? 'New process or shell' : group ? `New agent in “${group.name}”` : 'New agent';
  $('#field-command').hidden = kind !== 'process';
  $('#field-args').hidden = kind !== 'agent';
  $('#new-error').hidden = true;
  f.cwd.value = byId(group?.items[0])?.cwd || active()?.cwd || state.recentDirs[0] || state.home;
  f.name.value = '';
  f.command.value = '';
  f.extraArgs.value = state.prefs.agentArgs || '';
  $('#new-recent').replaceChildren(...state.recentDirs.slice(0, 5).map((dir) =>
    el('button', { type: 'button', title: dir, onclick: () => { f.cwd.value = dir; } }, shortPath(dir, state.home))));
  if (!dom.dialog.open) dom.dialog.showModal();
  const first = kind === 'process' ? f.command : f.cwd;
  first.focus();
  first.select();
}

async function createSession(opts, place = null) {
  const res = await aide.sessions.create({ ...opts, ...gridForNew() });
  if (!res.ok) return res;
  if (place) state.placing.set(res.meta.id, place);
  state.recentDirs = res.recentDirs || state.recentDirs;
  if (opts.kind === 'agent') state.prefs.agentArgs = opts.extraArgs || '';
  // The reply can beat the broadcast that announces the new session.
  if (!byId(res.meta.id)) state.sessions.push(res.meta);
  select(res.meta.id);
  return res;
}

function wireDialog() {
  const f = dom.form.elements;
  $('#new-browse').addEventListener('click', async () => {
    const dir = await aide.pickFolder(f.cwd.value || state.home);
    if (dir) f.cwd.value = dir;
  });
  $('#new-cancel').addEventListener('click', () => dom.dialog.close());
  dom.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    let cwd = f.cwd.value.trim();
    if (cwd === '~' || cwd.startsWith('~/')) cwd = state.home + cwd.slice(1);
    const error = $('#new-error');
    if (!cwd) {
      error.textContent = 'Choose a folder.';
      error.hidden = false;
      return;
    }
    $('#new-submit').disabled = true;
    const res = await createSession({
      kind: dialogKind,
      cwd,
      name: f.name.value,
      command: dialogKind === 'process' ? f.command.value : '',
      extraArgs: dialogKind === 'agent' ? f.extraArgs.value : '',
    }, dialogGroup ? { group: dialogGroup } : null);
    $('#new-submit').disabled = false;
    if (!res.ok) {
      error.textContent = res.error || 'Could not start.';
      error.hidden = false;
      return;
    }
    dom.dialog.close();
    views.get(res.meta.id)?.view.focus();
  });
}

// ------------------------------------------------------------------ servers

const hostText = (host) => (host.includes(':') ? `[${host}]` : host);

function serverRow(s) {
  const open = state.openServers.has(s.key);
  const owner = s.ownerId ? byId(s.ownerId) : null;
  const ownerName = owner ? displayName(owner) : s.ownerName;
  const confirming = state.confirmKill === s.key;

  const sub = el('div', { class: 'row-sub' }, s.label);
  if (ownerName && !s.internal) sub.append('  ·  ', el('span', { class: 'owner' }, ownerName));
  else if (s.cwd && s.cwd !== '/') sub.append('  ·  ', shortPath(s.cwd, state.home));

  const row = el('div', { class: 'row', title: s.command },
    el('span', { class: `dot${s.internal ? ' internal' : ''}`, dataset: { scope: s.scope } }),
    el('div', { class: 'row-text' },
      el('div', { class: 'row-name addr' },
        el('span', { class: 'host' }, `${hostText(s.host)}:`),
        el('span', { class: 'port' }, String(s.port)),
        s.scope === 'all'
          ? el('span', { class: 'chip', title: `Listening on every network interface${s.lan ? ` — other devices can reach it at ${s.lan}:${s.port}` : ''}` }, 'LAN')
          : null),
      sub),
    el('div', { class: `row-actions${confirming ? ' sticky' : ''}` },
      confirming
        ? el('button', { type: 'button', class: 'icon-btn danger', dataset: { act: 'kill-confirm' } }, 'Stop?')
        : [
            iconButton('external', `Open ${s.url}`, { dataset: { act: 'open' } }),
            iconButton(state.copied === s.key ? 'check' : 'copy', 'Copy address', { dataset: { act: 'copy' } }),
            iconButton('stop', `Stop this process (pid ${s.pid})`, { dataset: { act: 'kill' } }),
          ]));

  const node = el('div', { class: `server${open ? ' open' : ''}`, dataset: { key: s.key } }, row);
  if (open) {
    const dl = el('dl', { class: 'server-details' });
    const add = (label, value) => dl.append(el('dt', {}, label), el('dd', {}, value));
    add('Address', s.hosts.map((h) => `${hostText(h)}:${s.port}`).join(', '));
    add('Reach', s.scope === 'local' ? 'This Mac only' : s.scope === 'all' ? 'Every network interface' : 'One interface');
    add('Local', el('a', { dataset: { url: s.url } }, s.url));
    if (s.lan) add('Network', el('a', { dataset: { url: `http://${s.lan}:${s.port}` } }, `http://${s.lan}:${s.port}`));
    add('Process', `${s.pid}`);
    add('Command', s.command);
    if (s.cwd) add('Folder', s.cwd);
    if (ownerName) add('Session', ownerName);
    node.append(dl);
  }
  return node;
}

function renderServers() {
  const mine = state.servers.filter((s) => s.ownerId && !s.internal);
  const other = state.servers.filter((s) => !(s.ownerId && !s.internal));
  dom.serversCount.textContent = mine.length ? String(mine.length) : '';
  const scroll = dom.servers.scrollTop;
  dom.servers.replaceChildren(
    el('div', { class: 'group-label' }, 'From your sessions'),
    ...(mine.length
      ? mine.map(serverRow)
      : [el('div', { class: 'hint' }, 'Nothing is listening. Any port opened by an agent or process here shows up within a couple of seconds, including servers an agent starts in the background.')]),
    el('button', { type: 'button', class: `group-label${state.showOther ? ' open' : ''}`, dataset: { act: 'toggle-other' }, 'aria-expanded': String(state.showOther) },
      icon('chevron'), `Elsewhere on this Mac (${other.length})`),
    ...(state.showOther ? other.map(serverRow) : []));
  dom.servers.scrollTop = scroll;
}

function wireServers() {
  dom.servers.addEventListener('click', async (e) => {
    const link = e.target.closest('a[data-url]');
    if (link) return aide.openExternal(link.dataset.url);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle-other') {
      state.showOther = !state.showOther;
      aide.setUi({ showOther: state.showOther });
      return renderServers();
    }
    const node = e.target.closest('.server');
    if (!node) return undefined;
    const s = state.servers.find((x) => x.key === node.dataset.key);
    if (!s) return undefined;

    if (act === 'open') return aide.openExternal(s.url);
    if (act === 'copy') {
      await navigator.clipboard.writeText(`${hostText(s.host === '0.0.0.0' || s.host === '::' ? 'localhost' : s.host)}:${s.port}`);
      state.copied = s.key;
      setTimeout(() => { if (state.copied === s.key) { state.copied = null; renderServers(); } }, 1200);
    } else if (act === 'kill') {
      // Stopping takes a second click, so a slip of the mouse cannot take a server down.
      state.confirmKill = s.key;
      setTimeout(() => { if (state.confirmKill === s.key) { state.confirmKill = null; renderServers(); } }, 3000);
    } else if (act === 'kill-confirm') {
      state.confirmKill = null;
      await aide.servers.kill(s.pid);
    } else if (!e.target.closest('.server-details')) {
      if (state.openServers.has(s.key)) state.openServers.delete(s.key);
      else state.openServers.add(s.key);
    } else {
      return undefined;
    }
    return renderServers();
  });
}

// ---------------------------------------------------------------- file tree

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const HTML_EXT = /\.html?$/i;
const fileIcon = (name) => (IMAGE_EXT.test(name) ? 'image' : HTML_EXT.test(name) ? 'globe' : 'file');
const tree = { root: '', expanded: new Set(), children: new Map(), sig: '' };

const treeRootDir = () => active()?.cwd || state.recentDirs[0] || state.home;

async function refreshTree() {
  if (state.sideTab !== 'files') return;
  const root = treeRootDir();
  tree.root = root;
  const dirs = [root, ...[...tree.expanded].filter((d) => d.startsWith(`${root}/`))];
  const results = await Promise.all(dirs.map(async (d) => [d, await aide.files.list(d)]));
  if (tree.root !== root) return; // the selection moved on while we were reading
  for (const [dir, res] of results) {
    if (res.ok) tree.children.set(dir, res.entries);
    else {
      tree.children.delete(dir);
      tree.expanded.delete(dir);
    }
  }
  renderTree();
}

function treeRows(dir, depth, out) {
  for (const entry of tree.children.get(dir) || []) {
    const expanded = entry.isDir && tree.expanded.has(entry.path);
    out.push({ ...entry, depth, expanded });
    if (expanded) treeRows(entry.path, depth + 1, out);
  }
  return out;
}

function renderTree() {
  const rows = treeRows(tree.root, 0, []);
  const sig = JSON.stringify([tree.root, file.path, rows]);
  if (sig === tree.sig) return;
  tree.sig = sig;

  dom.treeRoot.replaceChildren(icon('folder'), el('span', { title: tree.root }, shortPath(tree.root, state.home)));
  const scroll = dom.filesTab.scrollTop;
  dom.tree.replaceChildren(...(rows.length
    ? rows.map((r) =>
        el('div', {
          class: `tree-item${r.expanded ? ' expanded' : ''}${r.name.startsWith('.') ? ' dim' : ''}${r.path === file.path ? ' open-file' : ''}`,
          style: `padding-left:${6 + r.depth * 14}px`,
          dataset: { path: r.path, dir: r.isDir ? '1' : '' },
          title: r.path,
        },
          r.isDir ? Object.assign(icon('chevron'), { className: 'icon twist' }) : el('span', { class: 'icon twist' }),
          icon(r.isDir ? 'folder' : fileIcon(r.name)),
          el('span', { class: 'label' }, r.name)))
    : [el('div', { class: 'hint' }, 'This folder is empty.')]));
  dom.filesTab.scrollTop = scroll;
}

function wireTree() {
  dom.tree.addEventListener('click', async (e) => {
    const item = e.target.closest('.tree-item');
    if (!item) return;
    const { path, dir } = item.dataset;
    if (!dir) return openFile(path);
    if (tree.expanded.has(path)) tree.expanded.delete(path);
    else {
      tree.expanded.add(path);
      const res = await aide.files.list(path);
      if (res.ok) tree.children.set(path, res.entries);
    }
    return renderTree();
  });
  // Agents create and delete files constantly; keep the open folders current.
  setInterval(() => { if (!document.hidden) refreshTree(); }, 3000);
}

function setSideTab(tab) {
  state.sideTab = tab;
  for (const btn of document.querySelectorAll('.tabs [data-tab]')) btn.setAttribute('aria-selected', String(btn.dataset.tab === tab));
  dom.servers.hidden = tab !== 'servers';
  dom.filesTab.hidden = tab !== 'files';
  dom.git.hidden = tab !== 'git';
  if (tab === 'files') refreshTree();
  if (tab === 'git') refreshGit();
}

// ---------------------------------------------------------------------- git

const gitTab = { data: null, sig: '', fetching: false, note: '', showMerged: false, busy: false };
const gitDir = () => state.gitDir || active()?.cwd || state.recentDirs[0] || state.home;
const SVG_NS = 'http://www.w3.org/2000/svg';
const LANE_COLORS = ['#5a9cf5', '#4cb964', '#d97757', '#b48ef0', '#e2a93b', '#4fc1c9', '#f0655c'];

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)}d ago`;
  return `${Math.round(s / 86400 / 30)}mo ago`;
}

/** Show the Git tab, for `dir` if given (an agent asked), else for the active session. */
function showGitTab(dir = null) {
  state.gitDir = dir;
  gitTab.data = null;
  setSideTab('git');
  aide.setUi({ sideTab: 'git' });
  refreshGit(true);
}

async function refreshGit(force = false) {
  if (state.sideTab !== 'git' || (gitTab.busy && !force)) return;
  const dir = gitDir();
  gitTab.busy = true;
  try {
    const data = await aide.git.overview(dir, force);
    if (gitDir() !== dir || !data) return;
    gitTab.data = data;
    renderGit();
  } finally {
    gitTab.busy = false;
  }
}

async function fetchGit() {
  const dir = gitDir();
  gitTab.fetching = true;
  gitTab.note = '';
  renderGit();
  const res = await aide.git.fetch(dir);
  gitTab.fetching = false;
  gitTab.note = res.ok ? '' : `Fetch failed: ${res.message}`;
  renderGit();
  refreshGit(true);
}

const chip = (text, kind, title = '') => el('span', { class: `tag ${kind}`, title }, text);

function prChip(pr) {
  const state = pr.state === 'OPEN' && pr.isDraft ? 'draft' : pr.state.toLowerCase();
  return el('button', { type: 'button', class: `tag pr ${state}`, dataset: { url: pr.url }, title: `${pr.title}\nOpen on GitHub` }, `#${pr.number} ${state}`);
}

function originChips(b, d) {
  if (!d.remote) return [];
  if (b.gone) return [chip(`deleted on ${d.remote}`, 'faint', `The branch it tracked is gone from ${d.remote}, usually because it was merged`)];
  if (!b.upstream) return [chip('local only', 'faint', `Not pushed to ${d.remote}`)];
  const out = [];
  if (b.pushAhead) out.push(chip(`↑${b.pushAhead}`, 'amber', `${b.pushAhead} commit${b.pushAhead === 1 ? '' : 's'} to push to ${b.upstream}`));
  if (b.pullBehind) out.push(chip(`↓${b.pullBehind}`, 'blue', `${b.pullBehind} commit${b.pullBehind === 1 ? '' : 's'} on ${b.upstream} to pull`));
  if (!out.length) out.push(chip(`on ${d.remote}`, 'ok', `In step with ${b.upstream}`));
  return out;
}

/** The little diagram at the start of a branch row: the main line, and this branch leaving it. */
function laneGlyph(kind, color, first, last) {
  const s = svg('svg', { class: 'lane', width: 26, height: 38, viewBox: '0 0 26 38', 'aria-hidden': 'true', style: `--c:${color}` });
  s.append(svg('path', { class: 'trunk', d: `M7 ${first ? 19 : 0}V${last ? 30 : 38}` }));
  if (kind === 'main') s.append(svg('circle', { class: 'node', cx: 7, cy: 19, r: 4 }));
  else if (kind === 'merged') {
    s.append(svg('path', { class: 'arm', d: 'M7 4C7 13 19 11 19 19C19 27 7 25 7 34' }), svg('circle', { class: 'node hollow', cx: 19, cy: 19, r: 3.5 }));
  } else {
    s.append(svg('path', { class: `arm${kind === 'remote' ? ' dashed' : ''}`, d: 'M7 4C7 13 19 11 19 19' }),
      svg('circle', { class: `node${kind === 'remote' || kind === 'level' ? ' hollow' : ''}`, cx: 19, cy: 19, r: 4 }));
  }
  return s;
}

function gitBranchRow(b, kind, d, first, last) {
  const color = b.current ? 'var(--accent)'
    : kind === 'merged' ? 'var(--purple)'
    : kind === 'main' ? 'var(--text)'
    : b.pr?.state === 'OPEN' ? 'var(--green)'
    : kind === 'remote' ? 'var(--muted)'
    : 'var(--blue)';
  let vs = '';
  if (kind === 'main') vs = b.subject;
  else if (b.level) vs = 'no commits of its own yet';
  else if (kind === 'merged') vs = b.pr?.state === 'MERGED' && b.ahead ? `merged by PR #${b.pr.number}` : 'merged into main';
  else if (b.ahead != null) vs = [b.ahead && `${b.ahead} ahead`, b.behind && `${b.behind} behind`].filter(Boolean).join(' · ') + ' main';
  const glyph = laneGlyph(kind === 'open' && b.level ? 'level' : kind, color, first, last);
  return el('div', { class: `git-branch${b.current ? ' current' : ''}${kind === 'merged' ? ' merged' : ''}`, title: `${b.name}${b.current ? ' (checked out)' : ''}\n${b.subject}` },
    glyph,
    el('div', { class: 'row-text' },
      el('div', { class: 'git-line' },
        el('span', { class: 'git-name' }, b.name),
        ...(kind === 'remote' ? [] : originChips(b, d)),
        ...(b.pr ? [prChip(b.pr)] : [])),
      el('div', { class: 'row-sub' }, [vs, ago(b.time)].filter(Boolean).join('  ·  '))));
}

function branchBlock(list, kindOf, d) {
  return list.map((b, i) => gitBranchRow(b, kindOf(b), d, i === 0, i === list.length - 1));
}

/** Lanes for a commit graph: which column each commit sits in and the lines between rows. */
function layoutGraph(commits) {
  const lanes = []; // the commit each column is waiting for
  const rows = [];
  let width = 1;
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    const top = lanes.slice();
    if (col === -1) {
      col = lanes.indexOf(null);
      if (col === -1) col = lanes.length;
    }
    for (let i = 0; i < lanes.length; i++) if (lanes[i] === c.hash) lanes[i] = null;
    const [first, ...rest] = c.parents;
    lanes[col] = first ?? null;
    const forks = rest.map((p) => {
      let at = lanes.indexOf(p);
      if (at === -1) {
        at = lanes.indexOf(null);
        if (at === -1) at = lanes.length;
        lanes[at] = p;
      }
      return at;
    });
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    rows.push({ col, top, forks, hasFirst: first != null });
    width = Math.max(width, top.length, lanes.length, col + 1);
  }
  return { rows, width };
}

function historyRows(d) {
  const { rows, width } = layoutGraph(d.history);
  const cols = Math.min(width, 8);
  const W = 10 + cols * 10;
  const X = (i) => 7 + i * 10;
  const H = 22;
  const M = 11;
  const colour = (i) => LANE_COLORS[i % LANE_COLORS.length];
  const edge = (x1, y1, x2, y2, i) => svg('path', {
    class: 'edge',
    stroke: colour(i),
    d: x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`,
  });
  const headName = d.head.branch;
  const remotePrefix = d.remote ? `${d.remote}/` : null;
  return d.history.map((c, n) => {
    const r = rows[n];
    const g = svg('svg', { class: 'graph', width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    r.top.forEach((hash, i) => {
      if (hash == null) return;
      g.append(hash === c.hash ? edge(X(i), 0, X(r.col), M, i) : edge(X(i), 0, X(i), H, i));
    });
    if (r.hasFirst) g.append(edge(X(r.col), M, X(r.col), H, r.col));
    for (const at of r.forks) g.append(edge(X(r.col), M, X(at), H, at));
    g.append(svg('circle', { class: `node${c.refs.length ? ' tip' : ''}`, cx: X(r.col), cy: M, r: c.refs.length ? 4 : 3, fill: colour(r.col) }));
    const refs = c.refs.map((ref) => {
      const kind = ref.startsWith('tag: ') ? 'faint' : ref === headName ? 'accent' : remotePrefix && ref.startsWith(remotePrefix) ? 'remote' : 'blue';
      return chip(ref.replace(/^tag: /, ''), kind);
    });
    return el('div', { class: 'commit', title: `${c.hash.slice(0, 10)}  ${c.subject}` },
      g,
      el('div', { class: 'commit-text' }, ...refs, el('span', { class: 'commit-subject' }, c.subject)),
      el('span', { class: 'commit-time' }, ago(c.time)));
  });
}

function gitContent(d) {
  if (!d) return [el('div', { class: 'hint' }, 'Reading the repository…')];
  if (!d.repo) return [el('div', { class: 'git-empty' }, el('p', {}, d.message), el('p', { class: 'faint' }, shortPath(d.dir, state.home)))];
  const h = d.head;
  const c = d.changes;
  const changed = c.staged + c.unstaged + c.untracked + c.conflicts;
  const status = [changed ? `${changed} changed file${changed === 1 ? '' : 's'}` : 'No changes'];
  if (c.conflicts) status.push(`${c.conflicts} in conflict`);
  if (h.upstream) {
    if (h.ahead) status.push(`↑${h.ahead} to push`);
    if (h.behind) status.push(`↓${h.behind} to pull`);
    if (!h.ahead && !h.behind) status.push(`in step with ${h.upstream}`);
  } else if (!h.detached && d.remote) status.push(`not on ${d.remote}`);

  const out = [
    el('div', { class: 'git-head' },
      el('div', { class: 'git-title' },
        icon('branch'),
        el('span', { class: 'git-current', title: d.root }, h.branch),
        ...(h.detached ? [chip('detached', 'faint')] : []),
        el('span', { class: 'spacer' }),
        ...(d.remote ? [iconButton('download', gitTab.fetching ? 'Fetching…' : `Fetch from ${d.remote}`, { class: `icon-btn${gitTab.fetching ? ' spinning' : ''}`, disabled: gitTab.fetching, dataset: { act: 'fetch' } })] : []),
        iconButton('restart', 'Refresh', { dataset: { act: 'refresh' } })),
      el('div', { class: 'git-sub' }, status.join('  ·  ')),
      ...(d.base ? [el('div', { class: 'git-sub faint' }, `Compared with ${d.base}${d.remote ? `  ·  fetched ${d.fetchedAt ? ago(d.fetchedAt) : 'never'}` : ''}`)] : [])),
  ];
  if (gitTab.note) out.push(el('div', { class: 'git-note' }, gitTab.note));

  const mainRow = d.branches.filter((b) => b.isMain);
  const open = d.branches.filter((b) => !b.isMain && !b.merged);
  const merged = d.branches.filter((b) => !b.isMain && b.merged);
  out.push(el('div', { class: 'group-label' }, 'Branches'),
    el('div', { class: 'git-block' }, ...branchBlock([...mainRow, ...open], (b) => (b.isMain ? 'main' : 'open'), d)));
  if (merged.length) {
    out.push(el('button', { type: 'button', class: `group-label${gitTab.showMerged ? ' open' : ''}`, dataset: { act: 'toggle-merged' }, 'aria-expanded': String(gitTab.showMerged) },
      icon('chevron'), `Merged into ${d.main} (${merged.length})`));
    if (gitTab.showMerged) out.push(el('div', { class: 'git-block' }, ...branchBlock(merged, () => 'merged', d)));
  }
  if (d.remoteOnly.length) {
    out.push(el('div', { class: 'group-label' }, `Only on ${d.remote}`),
      el('div', { class: 'git-block' }, ...branchBlock(d.remoteOnly, (b) => (b.merged ? 'merged' : 'remote'), d)));
  }
  if (d.otherPrs.length) {
    out.push(el('div', { class: 'group-label' }, 'Other open pull requests'),
      ...d.otherPrs.map((p) => el('div', { class: 'git-pr' }, prChip(p), el('span', { class: 'commit-subject', title: p.title }, p.title))));
  }
  if (d.prNote) out.push(el('div', { class: 'hint' }, d.prNote));
  if (d.history.length) out.push(el('div', { class: 'group-label' }, 'History'), el('div', { class: 'git-history' }, ...historyRows(d)));
  return out;
}

function renderGit() {
  const d = gitTab.data;
  const sig = JSON.stringify([d, gitTab.fetching, gitTab.note, gitTab.showMerged, Math.floor(Date.now() / 60000)]);
  if (sig === gitTab.sig) return;
  gitTab.sig = sig;
  const scroll = dom.git.scrollTop;
  dom.git.replaceChildren(...gitContent(d));
  dom.git.scrollTop = scroll;
}

function wireGit() {
  dom.git.addEventListener('click', (e) => {
    const link = e.target.closest('[data-url]');
    if (link) return aide.openExternal(link.dataset.url);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'fetch') return fetchGit();
    if (act === 'refresh') return refreshGit(true);
    if (act === 'toggle-merged') {
      gitTab.showMerged = !gitTab.showMerged;
      return renderGit();
    }
    return undefined;
  });
  setInterval(() => {
    if (document.hidden) return;
    refreshHeadGit();
    if (state.sideTab === 'git') refreshGit();
  }, 4000);
}

// --------------------------------------------------------------- file panel

const file = {
  path: null, kind: null, original: '', mtimeMs: 0, size: 0, dirty: false, textarea: null, info: '',
  project: '', // the folder tree it was opened from
  html: false, // an HTML file: it has a rendered page as well as its code
  page: false, // the rendered page is what is showing
  frame: null,
  turn: 0,
};

const confirmDiscard = () => !file.dirty || window.confirm(`Discard unsaved changes to ${basename(file.path)}?`);

function setNotice(text, actions = []) {
  const notice = $('#file-notice');
  notice.hidden = !text;
  notice.replaceChildren(...(text
    ? [el('span', {}, text), ...actions.map(([label, fn]) => el('button', { type: 'button', class: 'text-btn', onclick: fn }, label))]
    : []));
}

function updateFileState() {
  const stateEl = $('#file-state');
  stateEl.textContent = file.dirty ? 'Edited' : file.info;
  stateEl.classList.toggle('dirty', file.dirty);
  // The page shows what is on disk, so Save stays in reach while there are edits it does not show.
  $('#file-save').hidden = file.kind !== 'text' || (file.page && !file.dirty);
  $('#file-save').disabled = !file.dirty;
}

function renderFileActions() {
  const box = $('#file-actions');
  if (!file.html) return box.replaceChildren();
  const mode = (page, name, title) =>
    iconButton(name, title, {
      class: `icon-btn${file.page === page ? ' on' : ''}`,
      'aria-pressed': String(file.page === page),
      onclick: () => file.page !== page && setPage(page),
    });
  return box.replaceChildren(
    ...(file.page ? [iconButton('restart', 'Reload the page', { onclick: () => setPage(true) })] : []),
    iconButton('external', 'Open in your browser', { onclick: () => aide.files.openInBrowser(file.path) }),
    // A file too large for the editor still renders; it just has no code side.
    ...(file.textarea ? [el('span', { class: 'seg' }, mode(true, 'eye', 'Show the page'), mode(false, 'code', 'Show the code'))] : []));
}

/**
 * An HTML file shows as the page it makes, or as its code. The code keeps its
 * place (and any unsaved edits) while the page is up; the page is dropped while
 * the code is up, so nothing keeps running out of sight.
 */
async function setPage(page) {
  const turn = ++file.turn;
  file.page = page;
  file.frame?.remove();
  file.frame = null;
  if (file.textarea) file.textarea.hidden = page;
  renderFileActions();
  updateFileState();
  if (!page) return file.textarea.focus();

  const where = await aide.files.previewUrl(file.path, file.project);
  if (turn !== file.turn || !where) return undefined;
  file.frame = el('iframe', {
    class: `page-view${where.dark ? ' dark' : ''}`,
    src: where.url,
    title: `${basename(file.path)}, as a page`,
    allow: 'clipboard-write; fullscreen',
  });
  $('#file-body').append(file.frame);
  return undefined;
}

function showFile(res) {
  Object.assign(file, { path: res.path, kind: res.kind, mtimeMs: res.mtimeMs || 0, size: res.size || 0, dirty: false, textarea: null });
  Object.assign(file, { html: HTML_EXT.test(res.path) && ['text', 'too-large'].includes(res.kind), page: false, frame: null, turn: file.turn + 1 });
  file.original = res.kind === 'text' ? res.content : '';
  file.info = res.size != null ? formatBytes(res.size) : '';

  $('#file-icon').replaceChildren(icon(fileIcon(res.path)));
  $('#file-name').textContent = basename(res.path);
  $('#file-path').textContent = shortPath(res.path.slice(0, res.path.lastIndexOf('/')) || '/', state.home);
  $('#file-path').title = res.path;
  setNotice('');

  const body = $('#file-body');
  if (res.kind === 'text') {
    const ta = el('textarea', { spellcheck: false, wrap: 'off', 'aria-label': `Contents of ${basename(res.path)}` });
    ta.value = res.content;
    ta.addEventListener('input', () => {
      const dirty = ta.value !== file.original;
      if (dirty !== file.dirty) {
        file.dirty = dirty;
        updateFileState();
      }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        document.execCommand('insertText', false, '  ');
      }
    });
    file.textarea = ta;
    body.replaceChildren(ta);
  } else if (res.kind === 'image') {
    const img = el('img', { alt: basename(res.path), src: res.dataUrl });
    img.addEventListener('load', () => {
      if (file.path !== res.path) return;
      file.info = `${img.naturalWidth} × ${img.naturalHeight}  ·  ${formatBytes(res.size)}`;
      updateFileState();
    });
    body.replaceChildren(el('div', { class: 'image-view' }, img));
  } else if (file.html) {
    body.replaceChildren();
  } else {
    const text = {
      binary: 'This looks like a binary file, so there is nothing readable to show.',
      'too-large': `This file is ${formatBytes(res.size || 0)}, which is too large to open here.`,
    }[res.kind] || res.message || 'Could not open this file.';
    body.replaceChildren(el('div', { class: 'file-message' },
      el('div', {}, el('p', {}, text),
        el('button', { type: 'button', class: 'text-btn', onclick: () => aide.reveal(res.path) }, 'Reveal in Finder'))));
  }
  if (file.html) setPage(true); // the page first: that is what an HTML file is for
  else renderFileActions();
  updateFileState();
}

async function openFile(path, project = tree.root) {
  if (file.path && file.path !== path && !confirmDiscard()) return;
  const res = await aide.files.read(path);
  file.project = project;
  dom.filePanel.hidden = false;
  dom.fileSplit.hidden = false;
  showFile({ path, ...res });
  aide.files.watch(path);
  tree.sig = '';
  renderTree();
}

function closeFile() {
  if (!file.path || !confirmDiscard()) return;
  Object.assign(file, { path: null, kind: null, dirty: false, textarea: null, html: false, page: false, frame: null, turn: file.turn + 1 });
  $('#file-body').replaceChildren(); // a previewed page stops here rather than running on unseen
  aide.files.watch(null);
  dom.filePanel.hidden = true;
  dom.fileSplit.hidden = true;
  tree.sig = '';
  renderTree();
  views.get(state.activeId)?.view.focus();
}

async function reloadFile() {
  if (!file.path) return;
  const path = file.path;
  const res = await aide.files.read(path);
  if (file.path !== path) return;
  const ta = file.textarea;
  if (res.kind === 'text' && file.kind === 'text' && ta) {
    // Refresh in place so the scroll position and caret survive an agent's edit.
    const keep = { top: ta.scrollTop, left: ta.scrollLeft, start: ta.selectionStart, end: ta.selectionEnd };
    if (ta.value !== res.content) ta.value = res.content;
    Object.assign(file, { original: res.content, mtimeMs: res.mtimeMs, size: res.size, dirty: false, info: formatBytes(res.size) });
    ta.scrollTop = keep.top;
    ta.scrollLeft = keep.left;
    ta.setSelectionRange(Math.min(keep.start, ta.value.length), Math.min(keep.end, ta.value.length));
    setNotice('');
    updateFileState();
  } else if (file.frame && res.kind === file.kind) {
    // Only the page is up (the file is too large to edit), and that reloads by itself.
    Object.assign(file, { mtimeMs: res.mtimeMs, size: res.size, info: formatBytes(res.size) });
    updateFileState();
  } else {
    showFile({ path, ...res });
  }
}

async function saveFile(force = false) {
  if (!file.path || file.kind !== 'text' || !file.textarea || (!file.dirty && !force)) return;
  const content = file.textarea.value;
  const res = await aide.files.write(file.path, content, file.mtimeMs, force);
  if (res.conflict) {
    setNotice('This file changed on disk after you opened it.', [['Overwrite', () => saveFile(true)], ['Reload', reloadFile]]);
    return;
  }
  if (!res.ok) {
    setNotice(`Could not save: ${res.message || 'unknown error'}`);
    return;
  }
  Object.assign(file, { original: content, mtimeMs: res.mtimeMs, size: res.size, dirty: false, info: formatBytes(res.size) });
  setNotice('');
  updateFileState();
}

async function onFileChanged(path) {
  if (path !== file.path) return;
  const res = await aide.files.read(path);
  if (file.path !== path || res.mtimeMs === file.mtimeMs) return; // our own save
  if (file.dirty) {
    setNotice('This file changed on disk while you were editing.', [['Reload', reloadFile], ['Keep mine', () => setNotice('')]]);
  } else {
    reloadFile();
  }
}

// ---------------------------------------------------------------- splitters

function wireSplitter(handle, onDrag, onDone) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    const move = (ev) => onDrag(ev);
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      onDone();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function wireSplitters(ui) {
  const set = (name, px) => dom.root.style.setProperty(name, `${Math.round(px)}px`);
  if (ui.sidebarW) set('--sidebar-w', ui.sidebarW);
  if (ui.sideTop) set('--side-top', ui.sideTop);
  if (ui.fileW) set('--file-w', ui.fileW);

  const sizes = {};
  const save = () => aide.setUi(sizes);
  wireSplitter($('#split-sidebar'), (e) => {
    sizes.sidebarW = clamp(e.clientX, 210, Math.min(560, window.innerWidth - 360));
    set('--sidebar-w', sizes.sidebarW);
  }, save);
  wireSplitter($('#split-side'), (e) => {
    const side = $('#sidebar').getBoundingClientRect();
    const top = $('#sessions-pane').getBoundingClientRect().top;
    sizes.sideTop = clamp(e.clientY - top, 90, side.bottom - top - 120);
    set('--side-top', sizes.sideTop);
  }, save);
  wireSplitter(dom.fileSplit, (e) => {
    const ws = dom.workspace.getBoundingClientRect();
    sizes.fileW = clamp(ws.right - e.clientX, 220, ws.width - 240);
    set('--file-w', sizes.fileW);
  }, save);
}

// --------------------------------------------------------------------- boot

async function boot() {
  const init = await aide.init();
  Object.assign(state, {
    sessions: init.sessions,
    servers: init.servers,
    home: init.home,
    prefs: init.prefs,
    recentDirs: init.recentDirs,
    showOther: Boolean(init.ui.showOther),
    layout: readLayout(init.ui.agentLayout),
  });
  savedLayout = JSON.stringify(state.layout);

  $('#new-group').append(icon('folderPlus'));
  $('#new-agent').append(icon('plus'));
  $('#new-process').append(icon('plus'));
  $('#file-close').append(icon('close'));
  $('#new-agent').addEventListener('click', () => openNewDialog('agent'));
  $('#new-process').addEventListener('click', () => openNewDialog('process'));
  $('#file-close').addEventListener('click', closeFile);
  $('#file-save').addEventListener('click', () => saveFile());
  dom.headName.addEventListener('dblclick', () => state.activeId && renameSession(state.activeId, dom.headName));
  for (const btn of document.querySelectorAll('.tabs [data-tab]')) {
    btn.addEventListener('click', () => {
      setSideTab(btn.dataset.tab);
      aide.setUi({ sideTab: btn.dataset.tab });
    });
  }

  wireSessionList(dom.agents);
  wireSessionList(dom.processes);
  wireGroups();
  wireAgentDrag();
  wireDialog();
  wireServers();
  wireTree();
  wireGit();
  wireSplitters(init.ui);

  // Nothing dropped on the window chrome may navigate it away from the app.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());
  window.addEventListener('focus', () => {
    if (document.activeElement === document.body) views.get(state.activeId)?.view.focus();
  });

  aide.sessions.onUpdate(onSessions);
  aide.servers.onUpdate((list) => {
    state.servers = list;
    renderServers();
  });
  aide.files.onChanged(onFileChanged);
  aide.ui.onSelect((id, place) => {
    if (place) state.placing.set(id, place);
    select(id);
  });
  aide.ui.onSelectIndex((i) => {
    const m = visibleSessions()[i];
    if (m) select(m.id);
  });
  aide.ui.onMoveToGroup(moveToGroup);
  // An agent started another one: put it beside the agent that asked, without switching to it.
  aide.ui.onPlace((id, place) => {
    state.placing.set(id, place);
    syncLayout();
    renderSessions();
  });
  aide.ui.onOpenFile((path, project) => openFile(path, project || treeRootDir()));
  aide.ui.onShowGit((dir) => showGitTab(dir));
  aide.ui.onRename((id) => renameSession(id, document.querySelector(`.session[data-id="${id}"] .row-name`)));
  aide.ui.onNew((kind) => openNewDialog(kind));
  aide.ui.onSave(() => saveFile());
  aide.ui.onToggleFloat(() => state.activeId && toggleFloat(state.activeId));

  state.activeId = byId(init.ui.activeId)?.id ?? state.sessions[0]?.id ?? null;
  aide.sessions.setActive(state.activeId);
  setSideTab(['files', 'git'].includes(init.ui.sideTab) ? init.ui.sideTab : 'servers');
  renderSessions();
  renderMain();
  renderServers();
  refreshHeadGit();
  views.get(state.activeId)?.view.focus();

  // For the smoke test and for poking around in DevTools.
  window.__aide = { state, views, file, select };
}

boot();
