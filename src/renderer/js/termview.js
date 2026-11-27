// One xterm.js view of a session that lives in the main process. A view can be
// thrown away and recreated at any time (switching windows, floating, docking):
// it attaches, replays a snapshot of the screen and scrollback, then follows
// live output.
import { Terminal } from '../../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebLinksAddon } from '../../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';

const aide = window.aide;

const FONT_FAMILY = "ui-monospace, 'SF Mono', Menlo, Monaco, monospace";
const FONT_SIZE = 12.5;
const LINE_HEIGHT = 1.0;

const THEME = {
  background: '#15161a',
  foreground: '#dcdde2',
  cursor: '#dcdde2',
  cursorAccent: '#15161a',
  selectionBackground: '#3a4a6b',
  black: '#1c1d22',
  red: '#f47067',
  green: '#57ab5a',
  yellow: '#c69026',
  blue: '#539bf5',
  magenta: '#b083f0',
  cyan: '#39c5cf',
  white: '#adbac7',
  brightBlack: '#636e7b',
  brightRed: '#ff938a',
  brightGreen: '#6bc46d',
  brightYellow: '#daaa3f',
  brightBlue: '#6cb6ff',
  brightMagenta: '#dcbdfb',
  brightCyan: '#56d4dd',
  brightWhite: '#cdd9e5',
};

/** @type {Map<string, TermView>} */
const views = new Map();
aide.sessions.onData((id, data) => views.get(id)?.receive(data));

/** Quote a path for pasting at a shell or Claude Code prompt. */
const quotePath = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

export class TermView {
  /**
   * @param {HTMLElement} host element the terminal fills
   * @param {string} id session id
   * @param {{ beforeFit?: () => void }} [opts] beforeFit runs just before the
   *   host is measured, so the owner can bring its layout up to date first
   */
  constructor(host, id, opts = {}) {
    this.host = host;
    this.id = id;
    this.beforeFit = opts.beforeFit;
    this.term = null;
    this.queue = []; // live output that arrives before the snapshot has been written
    this.disposed = false;
    this.wantFocus = false;
    views.get(id)?.dispose();
    views.set(id, this);
    this.ready = this.init();
  }

  async init() {
    const snap = await aide.sessions.attach(this.id);
    if (this.disposed || !snap) return;

    const term = new Terminal({
      cols: snap.cols,
      rows: snap.rows,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: LINE_HEIGHT,
      theme: THEME,
      cursorBlink: false,
      scrollback: 5000,
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
    });
    this.term = term;
    this.fitAddon = new FitAddon();
    term.loadAddon(this.fitAddon);
    term.loadAddon(new WebLinksAddon((_event, uri) => aide.openExternal(uri)));
    term.open(this.host);

    term.write(snap.data);
    for (const chunk of this.queue) term.write(chunk);
    this.queue = null;

    term.onData((data) => aide.sessions.input(this.id, data));
    term.onResize(({ cols, rows }) => aide.sessions.resize(this.id, cols, rows));
    term.attachCustomKeyEventHandler((e) => this.handleKey(e));

    this.host.addEventListener('dragover', (e) => e.preventDefault());
    this.host.addEventListener('drop', (e) => {
      e.preventDefault();
      const paths = [...(e.dataTransfer?.files || [])].map((f) => aide.files.pathOf(f)).filter(Boolean);
      if (paths.length) {
        term.paste(`${paths.map(quotePath).join(' ')} `);
        term.focus();
      }
    });

    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(this.host);
    this.fit();
    if (this.wantFocus) term.focus();
  }

  /** Keys a Mac user expects that a raw terminal does not provide. */
  handleKey(e) {
    const send = (seq) => {
      if (e.type === 'keydown') aide.sessions.input(this.id, seq);
      e.preventDefault();
      return false;
    };
    // Shift+Enter inserts a newline in Claude Code's prompt instead of sending it.
    if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) return send('\x1b\r');
    if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (e.key === 'ArrowLeft') return send('\x01'); // start of line
      if (e.key === 'ArrowRight') return send('\x05'); // end of line
      if (e.key === 'Backspace') return send('\x15'); // delete to start of line
    }
    return true;
  }

  receive(data) {
    if (this.queue) this.queue.push(data);
    else this.term?.write(data);
  }

  fit() {
    if (!this.term || this.disposed) return;
    this.beforeFit?.();
    // A hidden host has no size; fitting it would shrink the pty to nothing.
    if (!this.host.offsetParent) return;
    try {
      this.fitAddon.fit();
    } catch {
      // Renderer not measured yet; the next resize tick retries.
    }
  }

  scheduleFit() {
    clearTimeout(this.fitTimer);
    this.fitTimer = setTimeout(() => this.fit(), 40);
  }

  focus() {
    this.wantFocus = true;
    this.term?.focus();
  }

  /** Visible screen + scrollback as plain text. */
  text() {
    if (!this.term) return '';
    const buf = this.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.fitTimer);
    if (views.get(this.id) === this) views.delete(this.id);
    this.observer?.disconnect();
    this.term?.dispose();
    aide.sessions.detach(this.id);
  }
}

/**
 * Roughly how many columns and rows fit in `host`, measured without a
 * terminal. Used to start a new session at about the right size; the first
 * real fit corrects any off-by-one.
 */
export function estimateGrid(host) {
  const probe = document.createElement('span');
  probe.textContent = 'W'.repeat(40);
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font-family:${FONT_FAMILY};font-size:${FONT_SIZE}px;`;
  document.body.append(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  const cellW = rect.width / 40 || 7.5;
  const cellH = Math.ceil((rect.height || 15) * LINE_HEIGHT);
  const style = getComputedStyle(host);
  const w = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 14; // scrollbar
  const h = host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return {
    cols: Math.max(20, Math.floor(w / cellW)),
    rows: Math.max(5, Math.floor(h / cellH)),
  };
}
