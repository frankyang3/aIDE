// Helpers shared by the main window and the floating windows.

export const $ = (selector, root = document) => root.querySelector(selector);

/** Create an element: el('button', { class: 'x', onclick: fn }, 'label'). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child);
  }
  return node;
}

const ICONS = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  float: '<path d="M7 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 2h4v4M14 2L8 8"/>',
  dock: '<path d="M7 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M12.5 8H8V3.500M8 8l6-6"/>',
  restart: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.500V5h-2.500"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.500"/>',
  external: '<path d="M6.500 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9.500"/><path d="M9.500 3H13v3.500M13 3L7.500 8.500"/>',
  copy: '<rect x="5.500" y="5.500" width="8" height="8" rx="1.500"/><path d="M10.500 3.500V3A1 1 0 0 0 9.500 2H3a1 1 0 0 0-1 1v6.500a1 1 0 0 0 1 1h.500"/>',
  check: '<path d="M3 8.500l3.200 3L13 4.500"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  minimize: '<path d="M3.500 11.500h9"/>',
  expand: '<path d="M9.500 3H13v3.500M13 3L9 7M6.500 13H3V9.500M3 13l4-4"/>',
  pencil: '<path d="M3 13l.600-2.700 7.400-7.400 2.100 2.100-7.400 7.400z"/>',
  pin: '<path d="M6 2h4M6.500 2l-.400 4.500L4.500 9h7L9.900 6.500 9.500 2M8 9v5"/>',
  opacity: '<circle cx="8" cy="8" r="5.500"/><path d="M8 2.500a5.500 5.500 0 0 1 0 11z" fill="currentColor" stroke="none"/>',
  folder: '<path d="M2 4.500A1.500 1.500 0 0 1 3.500 3h2.700l1.500 1.500h4.800A1.500 1.500 0 0 1 14 6v5.500a1.500 1.500 0 0 1-1.500 1.500h-9A1.500 1.500 0 0 1 2 11.500z"/>',
  folderPlus: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.7l1.5 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/><path d="M8 7.2v3.6M6.2 9h3.6"/>',
  file: '<path d="M4.500 2h4.500l3 3v8a1 1 0 0 1-1 1h-6.500a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9 2v3h3"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="1.500"/><circle cx="5.700" cy="6.500" r="1"/><path d="M2.500 11.500l3.300-2.800 2.400 1.900 2-1.500 3.300 2.600"/>',
  terminal: '<path d="M3 4.500l3.500 3.500L3 11.500M8.500 12H13"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="1.500"/><path d="M9.500 3v10"/>',
  globe: '<circle cx="8" cy="8" r="5.500"/><path d="M2.500 8h11M8 2.500c2 1.700 2 9.300 0 11M8 2.500c-2 1.700-2 9.300 0 11"/>',
  eye: '<path d="M1.500 8S4 3.500 8 3.500 14.500 8 14.500 8 12 12.500 8 12.500 1.500 8 1.500 8z"/><circle cx="8" cy="8" r="1.800"/>',
  code: '<path d="M5.500 4.500L2 8l3.500 3.500M10.500 4.500L14 8l-3.500 3.500"/>',
  branch: '<circle cx="5" cy="3.800" r="1.500"/><circle cx="5" cy="12.200" r="1.500"/><circle cx="11" cy="5.500" r="1.500"/><path d="M5 5.300v5.400M11 7c0 2.300-2.200 3-5.300 3.700"/>',
  download: '<path d="M8 2.500v8M4.500 7.500L8 11l3.500-3.500M3 13.500h10"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML =
    `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.400" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}

export function iconButton(name, title, props = {}) {
  return el('button', { type: 'button', class: 'icon-btn', title, 'aria-label': title, ...props }, icon(name));
}

/**
 * The one place that decides what a session's indicator shows. The indicator
 * is separate from the name, so renaming a session never hides it.
 */
export function statusOf(meta) {
  if (meta.status !== 'running') {
    if (meta.status === 'exited' && meta.exitCode) {
      return { state: 'failed', label: `Exited with code ${meta.exitCode}` };
    }
    return { state: 'stopped', label: meta.status === 'exited' ? 'Exited' : 'Not running' };
  }
  if (meta.waiting) return { state: 'waiting', label: 'Needs your input' };
  if (meta.busy) return { state: 'busy', label: 'Working' };
  if (meta.unseen) return { state: 'unseen', label: 'Finished while you were away' };
  return meta.kind === 'agent' ? { state: 'idle', label: 'Idle' } : { state: 'running', label: 'Running' };
}

/** Your name for the session if you gave one, else Claude's topic, else "Agent 3". */
export function displayName(meta) {
  return meta.name || (meta.kind === 'agent' && meta.title) || meta.defaultName;
}

export function shortPath(p, home) {
  if (!p) return '';
  let out = p;
  if (home && (out === home || out.startsWith(`${home}/`))) out = `~${out.slice(home.length)}`;
  if (out.length > 34) {
    const parts = out.split('/');
    out = `…/${parts.slice(-2).join('/')}`;
  }
  return out;
}

/** Secondary line: Claude's own topic once you have renamed the session, then the folder. */
export function subtitle(meta, home) {
  const parts = [];
  if (meta.name) {
    if (meta.kind === 'agent' && meta.title) parts.push(meta.title);
    else if (meta.kind === 'process' && meta.command) parts.push(meta.command);
  }
  parts.push(shortPath(meta.cwd, home));
  return parts.join('  ·  ');
}

/**
 * Turn a label into an inline text field. Commits on Enter or blur, cancels on
 * Escape. An empty value is committed too: it means "go back to the automatic name".
 */
export function beginRename(target, value, onCommit) {
  if (target.classList.contains('editing')) return;
  const shown = target.textContent;
  const input = el('input', { class: 'rename-input', value, spellcheck: false, 'aria-label': 'Session name' });
  target.textContent = '';
  target.classList.add('editing');
  target.append(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    target.classList.remove('editing');
    target.textContent = save && next ? next : shown;
    if (save && next !== value) onCommit(next);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  for (const type of ['click', 'dblclick', 'mousedown']) input.addEventListener(type, (e) => e.stopPropagation());
}

/** "claude-opus-5-5" -> "Opus 5.5", "claude-3-5-sonnet-20241022" -> "Sonnet 3.5", "opus" -> "Opus". */
export function modelName(id) {
  if (!id) return '';
  const raw = String(id).replace(/\[[^\]]*\]$/, '');
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(raw);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  m = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(raw);
  if (m) return `${cap(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ''}`;
  return /^[a-z]+$/.test(raw) ? cap(raw) : raw;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
