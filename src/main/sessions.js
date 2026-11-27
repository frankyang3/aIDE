'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

/**
 * Environment that must not leak from wherever aIDE was launched into the
 * sessions it runs: a parent Claude Code session's identity, another terminal's
 * identity, and npm's script variables (npm_config_prefix breaks nvm).
 */
const STRIP_ENV = new RegExp(
  '^(' +
    [
      'CLAUDECODE',
      'CLAUDE_PID',
      'CLAUDE_EFFORT',
      'CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_ID|SESSION_ATTENDED|SSE_PORT|CHILD_.*|MESSAGING_.*)',
      'VSCODE_.*',
      'TERM_PROGRAM.*',
      'TERM_SESSION_ID',
      'ITERM_.*',
      'ELECTRON_RUN_AS_NODE',
      'AIDE_.*',
      'npm_.*',
      'INIT_CWD',
    ].join('|') +
    ')$'
);

/**
 * Claude Code puts its state in the terminal title: "✳ topic" while it waits
 * for you, and an animated glyph ("◐ topic" / "◑ topic", braille dots in older
 * releases) while it works. The title stays truthful when a turn is interrupted
 * with Esc, which the Stop hook does not report, so it is the source of truth
 * for busy/idle.
 */
const IDLE_GLYPH = '✳';
const BUSY_GLYPH = /^[◐-◓◴-◷⠀-⣿]$/u;

function parseTitle(raw) {
  const m = /^(\S)\s+(.*)$/su.exec(raw);
  if (m && (m[1] === IDLE_GLYPH || BUSY_GLYPH.test(m[1]))) {
    return { claude: true, busy: m[1] !== IDLE_GLYPH, text: m[2].trim() };
  }
  return { claude: false, busy: false, text: raw.trim() };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Pause between a pasted line and the Return that sends it; see submit(). */
const SUBMIT_DELAY_MS = 150;

/**
 * Settings passed to every agent with `claude --settings`; they merge with the
 * user's own. The hooks only append a line to a per-session file, which is how
 * aIDE learns two things the title cannot say: the conversation id (to resume
 * it later) and that the agent is blocked on a permission prompt. Events that
 * fire on every tool call are deliberately left out.
 *
 * The permissions let an agent use the aIDE tools that only look or show
 * (see control.js) without asking. The ones that run a command or start an
 * agent are not listed, so Claude Code asks you as it would for its own shell.
 */
function buildHookSettings() {
  const tagOnly = (tag) =>
    `cat >/dev/null; [ -n "$AIDE_EVENTS" ] && printf '${tag}\\n' >> "$AIDE_EVENTS"; exit 0`;
  const withPayload = (tag) =>
    `d=$(cat); [ -n "$AIDE_EVENTS" ] && printf '${tag} %s\\n' "$(printf %s "$d" | tr -d '\\n' | cut -c1-1500)" >> "$AIDE_EVENTS"; exit 0`;
  const entry = (command) => [{ hooks: [{ type: 'command', command }] }];
  return {
    permissions: {
      allow: ['list_sessions', 'read_output', 'open_file', 'git_overview'].map((tool) => `mcp__aide__${tool}`),
    },
    hooks: {
      SessionStart: entry(withPayload('SessionStart')),
      UserPromptSubmit: entry(tagOnly('UserPromptSubmit')),
      PermissionRequest: entry(tagOnly('PermissionRequest')),
      Notification: entry(withPayload('Notification')),
      Stop: entry(tagOnly('Stop')),
    },
  };
}

const PERSISTED = [
  'id', 'kind', 'name', 'defaultName', 'title', 'cwd', 'command', 'extraArgs',
  'claudeSessionId', 'canResume', 'createdAt', 'model',
];

/** `--model x` among an agent's own arguments: what it says it will use before it has answered. */
const modelFromArgs = (args) => /(?:^|\s)--model[=\s]+['"]?([\w.:[\]-]+)/.exec(args || '')?.[1] || '';

/**
 * The model that wrote the latest reply in a Claude Code transcript (a JSONL
 * file). Only the end of the file is read; a reply that holds a large file can
 * push the previous one further back, hence the second, longer look.
 */
async function lastModel(file) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    for (const span of [256 * 1024, 4 * 1024 * 1024]) {
      const length = Math.min(size, span);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, size - length);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= (length < size ? 1 : 0); i--) {
        if (!lines[i].includes('"type":"assistant"')) continue;
        try {
          const entry = JSON.parse(lines[i]);
          const model = entry.type === 'assistant' ? entry.message?.model : null;
          if (typeof model === 'string' && model && !model.startsWith('<')) return model; // not "<synthetic>"
        } catch {
          // a line still being written
        }
      }
      if (length === size) break;
    }
  } catch {
    // no transcript yet
  } finally {
    await fh?.close().catch(() => {});
  }
  return '';
}

class SessionManager extends EventEmitter {
  /**
   * @param {{ runtimeDir: string, store: import('./store').Store, getPrefs: () => object }} opts
   */
  constructor({ runtimeDir, store, getPrefs }) {
    super();
    this.store = store;
    this.getPrefs = getPrefs;
    this.eventsDir = path.join(runtimeDir, 'events');
    fs.mkdirSync(this.eventsDir, { recursive: true });
    this.toolsDir = path.join(runtimeDir, 'tools');
    fs.mkdirSync(this.toolsDir, { recursive: true });
    this.hooksFile = path.join(runtimeDir, 'claude-hooks.json');
    fs.writeFileSync(this.hooksFile, JSON.stringify(buildHookSettings(), null, 2));

    /** @type {Map<string, any>} */
    this.sessions = new Map();
    this.counters = { agent: 0, process: 0 };
    /** Set by the window layer: is this session on screen right now? */
    this.isViewed = () => false;
    /** Set once aIDE's tool server is up: the `--mcp-config` contents for a session. */
    this.toolsConfig = () => null;

    this._restore();
    this._poll = setInterval(() => this._pollEvents(), 300);
  }

  // ---------------------------------------------------------------- queries

  list() {
    return [...this.sessions.values()].map((s) => ({ ...s.meta }));
  }

  get(id) {
    const s = this.sessions.get(id);
    return s ? { ...s.meta } : null;
  }

  /** pid of each running session's root process -> { id, kind }. */
  rootPids() {
    const out = new Map();
    for (const s of this.sessions.values()) {
      if (s.pty) out.set(s.pty.pid, { id: s.meta.id, kind: s.meta.kind });
    }
    return out;
  }

  // -------------------------------------------------------------- lifecycle

  /** `prompt` is a first message for a new agent; it is sent once and not kept. */
  create({ kind, cwd, name = '', command = '', extraArgs = '', prompt = '', cols, rows }) {
    if (kind !== 'agent' && kind !== 'process') throw new Error(`Unknown session kind: ${kind}`);
    let stat;
    try {
      stat = fs.statSync(cwd);
    } catch {
      throw new Error(`Folder not found: ${cwd}`);
    }
    if (!stat.isDirectory()) throw new Error(`Not a folder: ${cwd}`);

    const n = ++this.counters[kind];
    command = command.trim();
    const meta = {
      id: crypto.randomUUID().slice(0, 8),
      kind,
      name: name.trim(),
      defaultName: kind === 'agent' ? `Agent ${n}` : command || `Shell ${n}`,
      title: '',
      cwd,
      command,
      extraArgs: extraArgs.trim(),
      claudeSessionId: null,
      canResume: false,
      createdAt: Date.now(),
      model: '',
    };
    const s = this._adopt(meta);
    this.start(meta.id, { cols, rows, prompt });
    return { ...s.meta };
  }

  /** Wrap persisted or new metadata in a live record with its own terminal. */
  _adopt(saved) {
    const meta = {
      ...saved,
      status: 'stopped', // 'running' | 'exited' | 'stopped' (never started this launch)
      exitCode: null,
      pid: null,
      busy: false,
      waiting: false,
      unseen: false,
      floating: false,
    };
    const term = new Terminal({ cols: 100, rows: 30, scrollback: 5000, allowProposedApi: true });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    const s = {
      meta,
      term,
      serializer,
      pty: null,
      eventsFile: path.join(this.eventsDir, `${meta.id}.log`),
      toolsFile: path.join(this.toolsDir, `${meta.id}.json`),
      eventsOffset: 0,
      titleSeen: false,
      waitingSince: 0,
      transcript: '', // Claude Code's record of the conversation; says which model answered
    };
    term.onTitleChange((t) => this._onTitle(s, t));
    this.sessions.set(meta.id, s);
    return s;
  }

  _restore() {
    for (const saved of this.store.get('sessions') || []) {
      if (!saved || !saved.id || this.sessions.has(saved.id)) continue;
      this._adopt(saved);
      const n = Number(/^(?:Agent|Shell) (\d+)$/.exec(saved.defaultName || '')?.[1] || 0);
      this.counters[saved.kind] = Math.max(this.counters[saved.kind] || 0, n);
    }
  }

  start(id, { resume = false, prompt = '', cols, rows } = {}) {
    const s = this.sessions.get(id);
    if (!s || s.pty) return;
    const m = s.meta;

    if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 1 && rows > 1) s.term.resize(cols, rows);
    // Clear whatever the previous run left on screen, here and in attached views.
    s.term.reset();
    this.emit('data', id, '\x1bc');

    try {
      fs.writeFileSync(s.eventsFile, '');
    } catch {
      // Hooks just won't report; the title still drives the spinner.
    }
    s.eventsOffset = 0;
    s.titleSeen = false;

    const shell = process.env.SHELL || '/bin/zsh';
    let args;
    if (m.kind === 'agent' && !resume) m.model = modelFromArgs(m.extraArgs);
    if (m.kind === 'agent') {
      const parts = [this.getPrefs().claudeCommand || 'claude'];
      // --mcp-config takes any number of values, so an option has to follow it.
      if (this._writeTools(s)) parts.push('--mcp-config', shq(s.toolsFile));
      parts.push('--settings', shq(this.hooksFile));
      if (resume && m.claudeSessionId && m.canResume) parts.push('--resume', shq(m.claudeSessionId));
      if (m.extraArgs) parts.push(m.extraArgs);
      if (prompt && !resume) parts.push('--', shq(prompt));
      args = ['-l', '-i', '-c', `exec ${parts.join(' ')}`];
    } else if (m.command) {
      args = ['-l', '-i', '-c', m.command];
    } else {
      args = ['-l', '-i'];
    }

    let child;
    try {
      child = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: s.term.cols,
        rows: s.term.rows,
        cwd: m.cwd,
        env: this._env(s),
      });
    } catch (err) {
      const msg = `\x1b[31mCould not start: ${err.message}\x1b[0m\r\n`;
      s.term.write(msg);
      this.emit('data', id, msg);
      Object.assign(m, { status: 'exited', exitCode: -1, pid: null, busy: false, waiting: false });
      this._changed(s);
      return;
    }

    s.pty = child;
    Object.assign(m, { status: 'running', exitCode: null, pid: child.pid, busy: false, waiting: false, unseen: false });

    child.onData((data) => {
      s.term.write(data);
      this.emit('data', id, data);
    });
    child.onExit(({ exitCode }) => {
      if (s.pty !== child) return;
      s.pty = null;
      const note = `\r\n\x1b[2m[exited with code ${exitCode}]\x1b[0m\r\n`;
      s.term.write(note);
      this.emit('data', id, note);
      Object.assign(m, { status: 'exited', exitCode, pid: null, busy: false, waiting: false });
      this._changed(s);
    });
    this._changed(s);
  }

  /** The address of this session's aIDE tools; it holds a secret, so only you may read it. */
  _writeTools(s) {
    const config = this.toolsConfig(s.meta.id);
    if (!config) return false;
    try {
      fs.writeFileSync(s.toolsFile, JSON.stringify(config), { mode: 0o600 });
      fs.chmodSync(s.toolsFile, 0o600);
      return true;
    } catch {
      return false; // the agent still runs, without the aIDE tools
    }
  }

  _env(s) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !STRIP_ENV.test(k)) env[k] = v;
    }
    // `npm start` prepends its own bin folders to PATH; sessions should not see them.
    if (env.PATH) {
      env.PATH = env.PATH.split(':')
        .filter((p) => !/\/node_modules\/\.bin$|node-gyp-bin/.test(p))
        .join(':');
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'aIDE';
    env.AIDE_SESSION = s.meta.id;
    env.AIDE_EVENTS = s.eventsFile;
    return env;
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return;
    const pid = s.pty.pid;
    // The pty child leads its own process group; signal the group so that
    // whatever it started in the foreground goes with it.
    try {
      process.kill(-pid, 'SIGHUP');
    } catch {
      // Group already gone.
    }
    try {
      s.pty.kill();
    } catch {
      // Already exited.
    }
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.kill(id);
    s.pty = null; // ignore the exit that follows
    this.sessions.delete(id);
    s.term.dispose();
    fs.rm(s.eventsFile, { force: true }, () => {});
    fs.rm(s.toolsFile, { force: true }, () => {});
    this._persist();
    this.emit('removed', id);
  }

  dispose() {
    clearInterval(this._poll);
    for (const id of this.sessions.keys()) this.kill(id);
    this._persist();
  }

  // -------------------------------------------------------------------- I/O

  write(id, data) {
    const s = this.sessions.get(id);
    if (!s || !s.pty) return;
    s.pty.write(data);
    // Typing into a session that was waiting on you means you have seen it.
    // (Focus in/out reports are not typing.)
    if (s.meta.waiting && data !== '\x1b[I' && data !== '\x1b[O') {
      s.meta.waiting = false;
      this._changed(s);
    }
  }

  /**
   * Send one line as if it had been pasted and then Return pressed. Return goes
   * in a write of its own, a moment later: a full-screen program such as Claude
   * Code reads a line break that arrives with the text as part of the paste.
   */
  submit(id, text) {
    const s = this.sessions.get(id);
    // Control characters would let the text end the paste early or act as keys.
    const line = String(text).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    if (!s || !s.pty || !line) return;
    const send = () => {
      const child = s.pty;
      if (!child) return undefined;
      this.write(id, s.term.modes.bracketedPasteMode ? `\x1b[200~${line}\x1b[201~` : line);
      return new Promise((resolve) => {
        setTimeout(() => {
          if (s.pty === child) child.write('\r');
          resolve();
        }, SUBMIT_DELAY_MS);
      });
    };
    // One at a time, so a second line cannot land between a first and its Return.
    s.submitting = (s.submitting || Promise.resolve()).then(send);
  }

  /** The last `count` lines of a session's screen and scrollback, as plain text. */
  tail(id, count = 80) {
    const s = this.sessions.get(id);
    if (!s) return Promise.resolve(null);
    return new Promise((resolve) => {
      // An empty write runs its callback once everything before it has been parsed.
      s.term.write('', () => {
        const buffer = s.term.buffer.active;
        const lines = [];
        for (let i = 0; i < buffer.length; i++) {
          const line = buffer.getLine(i);
          const str = line.translateToString(true);
          if (line.isWrapped && lines.length) lines[lines.length - 1] += str;
          else lines.push(str);
        }
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        resolve(lines.slice(-count).join('\n'));
      });
    });
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 2 || rows < 2 || cols > 1000 || rows > 1000) return;
    if (cols === s.term.cols && rows === s.term.rows) return;
    s.term.resize(cols, rows);
    try {
      s.pty?.resize(cols, rows);
    } catch {
      // Raced with exit.
    }
  }

  /**
   * Serialized screen + scrollback, delivered once everything written so far
   * has been parsed. The callback runs synchronously at that point so a caller
   * can subscribe to live data without a gap or an overlap.
   */
  snapshot(id, cb) {
    const s = this.sessions.get(id);
    if (!s) return cb(null);
    s.term.write('', () => {
      cb({ data: s.serializer.serialize(), cols: s.term.cols, rows: s.term.rows });
    });
  }

  // ------------------------------------------------------------------ state

  rename(id, name) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.meta.name = String(name || '').trim().slice(0, 120);
    this._changed(s);
  }

  setFloating(id, floating) {
    const s = this.sessions.get(id);
    if (!s || s.meta.floating === floating) return;
    s.meta.floating = floating;
    if (floating) s.meta.unseen = false;
    this._changed(s);
  }

  markSeen(id) {
    const s = this.sessions.get(id);
    if (!s || !s.meta.unseen) return;
    s.meta.unseen = false;
    this._changed(s);
  }

  _setBusy(s, busy) {
    const m = s.meta;
    const was = m.busy;
    m.busy = busy;
    if (busy) m.unseen = false;
    else if (was && !this.isViewed(m.id)) m.unseen = true;
  }

  _onTitle(s, raw) {
    if (!raw) return; // Claude Code clears the title on exit; keep the last topic.
    const { claude, busy, text } = parseTitle(raw);
    const m = s.meta;
    let changed = false;
    if (claude) {
      s.titleSeen = true;
      if (m.busy !== busy) {
        this._setBusy(s, busy);
        changed = true;
        if (!busy) this._readModel(s);
      }
      // A permission prompt idles the title, so a title that keeps animating
      // after the hook fired means the prompt has been answered. The grace
      // period covers the hook landing just before the title goes idle.
      if (busy && m.waiting && Date.now() - s.waitingSince > 1200) {
        m.waiting = false;
        changed = true;
      }
    }
    const title = claude && text === 'Claude Code' ? '' : text;
    if (m.title !== title) {
      m.title = title;
      changed = true;
    }
    if (changed) this._changed(s);
  }

  _pollEvents() {
    for (const s of this.sessions.values()) {
      if (s.meta.kind !== 'agent' || !s.pty) continue;
      fs.stat(s.eventsFile, (err, st) => {
        if (err || st.size <= s.eventsOffset || s.reading) return;
        s.reading = true;
        const start = s.eventsOffset;
        const length = st.size - start;
        fs.open(s.eventsFile, 'r', (openErr, fd) => {
          if (openErr) {
            s.reading = false;
            return;
          }
          fs.read(fd, Buffer.alloc(length), 0, length, start, (readErr, n, buf) => {
            fs.close(fd, () => {});
            s.reading = false;
            if (readErr || s.eventsOffset !== start) return;
            // Only consume whole lines; a hook may be mid-write. Offsets are
            // counted in bytes so a truncated multi-byte character cannot skew them.
            const end = buf.subarray(0, n).lastIndexOf(0x0a);
            if (end === -1) return;
            s.eventsOffset = start + end + 1;
            for (const line of buf.toString('utf8', 0, end).split('\n')) if (line) this._onHook(s, line);
          });
        });
      });
    }
  }

  _onHook(s, line) {
    const sp = line.indexOf(' ');
    const tag = sp === -1 ? line : line.slice(0, sp);
    const rest = sp === -1 ? '' : line.slice(sp + 1);
    const m = s.meta;
    const before = JSON.stringify(m);

    const waitNow = () => {
      if (m.status !== 'running') return;
      m.waiting = true;
      s.waitingSince = Date.now();
    };

    switch (tag) {
      case 'SessionStart': {
        const sid = /"session_id"\s*:\s*"([0-9a-fA-F-]{36})"/.exec(rest)?.[1];
        if (sid && sid !== m.claudeSessionId) {
          m.claudeSessionId = sid;
          // A brand-new conversation has no transcript to resume until its first prompt.
          m.canResume = /"source"\s*:\s*"resume"/.test(rest);
        }
        const transcript = /"transcript_path"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(rest)?.[1];
        if (transcript) {
          try {
            s.transcript = JSON.parse(`"${transcript}"`);
          } catch {
            s.transcript = transcript;
          }
          this._readModel(s); // a resumed conversation already says
        }
        break;
      }
      case 'UserPromptSubmit':
        m.canResume = true;
        m.waiting = false;
        if (!s.titleSeen) this._setBusy(s, true); // titles disabled: fall back to hooks
        break;
      case 'PermissionRequest':
        waitNow();
        break;
      case 'Notification': {
        const type = /"notification_type"\s*:\s*"(\w+)"/.exec(rest)?.[1];
        if (type === 'permission_prompt' || type === 'elicitation_dialog') waitNow();
        break;
      }
      case 'Stop':
        m.waiting = false;
        if (!s.titleSeen) this._setBusy(s, false);
        this._readModel(s);
        break;
      default:
        break;
    }
    if (JSON.stringify(m) !== before) this._changed(s);
  }

  async _readModel(s) {
    if (!s.transcript || s.readingModel) return;
    s.readingModel = true;
    const model = await lastModel(s.transcript);
    s.readingModel = false;
    if (model && model !== s.meta.model && this.sessions.get(s.meta.id) === s) {
      s.meta.model = model;
      this._changed(s);
    }
  }

  _changed(s) {
    this._persist();
    this.emit('meta', { ...s.meta });
  }

  _persist() {
    this.store.set(
      'sessions',
      [...this.sessions.values()].map((s) => Object.fromEntries(PERSISTED.map((k) => [k, s.meta[k]])))
    );
  }
}

module.exports = { SessionManager, parseTitle };
