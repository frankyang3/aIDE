'use strict';
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');

const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';

function run(cmd, args) {
  return new Promise((resolve) => {
    // lsof exits non-zero when it finds nothing, so the exit code is not an error signal here.
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, timeout: 8000 }, (_err, stdout) => resolve(stdout || ''));
  });
}

/** Parse `lsof -F pcnt` output into one record per listening socket. */
function parseLsof(out) {
  const sockets = [];
  let pid = null;
  let name = '';
  let type = '';
  for (const line of out.split('\n')) {
    const tag = line[0];
    const val = line.slice(1);
    if (tag === 'p') {
      pid = Number(val);
      name = '';
    } else if (tag === 'c') {
      name = val;
    } else if (tag === 'f') {
      type = '';
    } else if (tag === 't') {
      type = val;
    } else if (tag === 'n') {
      const m = /^(\*|\[[^\]]*\]|[^:]+):(\d+)$/.exec(val);
      if (!m || pid === null) continue;
      let host = m[1].replace(/^\[|\]$/g, '');
      if (host === '*') host = type === 'IPv6' ? '::' : '0.0.0.0';
      sockets.push({ pid, name, host, port: Number(m[2]) });
    }
  }
  return sockets;
}

/** Parse `ps -axo pid=,ppid=,command=` into pid -> { ppid, command }. */
function parsePs(out) {
  const procs = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
  }
  return procs;
}

/** Parse `lsof -a -d cwd -Fn -p ...` into pid -> working directory. */
function parseCwds(out) {
  const cwds = new Map();
  let pid = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid !== null) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

const isLoopback = (host) => host === '::1' || host.startsWith('127.');
const isWildcard = (host) => host === '0.0.0.0' || host === '::';
const INTERPRETERS = /^(node|bun|deno|python[\d.]*|ruby|php|java|tsx|ts-node)$/i;

/** A short human label, e.g. "node · vite" or "Python · -m http.server". */
function describe(name, command) {
  if (/\/claude\/versions\/|(^|\/)claude( |$)/.test(command) || /^claude$/i.test(name)) {
    return { label: 'Claude Code', claude: true };
  }
  if (!INTERPRETERS.test(name)) return { label: name, claude: false };
  // Everything after the executable; paths with spaces make exact argv recovery
  // impossible from ps, so this is a best-effort reading.
  const at = command.toLowerCase().indexOf(name.toLowerCase());
  const rest = at === -1 ? '' : command.slice(at + name.length).replace(/^\S*/, '').trim();
  const args = rest.split(/\s+/).filter(Boolean);
  let detail = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-m' && args[i + 1]) {
      detail = `-m ${args[i + 1]}`;
      break;
    }
    if (a.startsWith('-')) continue;
    detail = path.basename(a);
    // `node_modules/next/dist/bin/next` and `.bin/vite` both name the tool.
    const pkg = /node_modules\/(?:\.bin\/)?((?:@[^/]+\/)?[^/]+)/.exec(a);
    if (pkg) detail = pkg[1];
    break;
  }
  return { label: detail ? `${name} · ${detail}` : name, claude: false };
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

/**
 * Polls for TCP listeners and attributes each to the aIDE session whose
 * process tree it belongs to. Attribution is remembered for as long as the
 * process lives, so a server that outlives the agent that started it (and gets
 * re-parented to launchd) is still shown as that agent's.
 */
class ServerScanner extends EventEmitter {
  /**
   * @param {{ getRoots: () => Map<number, { id: string, kind: string }>, getSessionName: (id: string) => string | null, intervalMs?: number }} opts
   */
  constructor({ getRoots, getSessionName, intervalMs = 2000 }) {
    super();
    this.getRoots = getRoots;
    this.getSessionName = getSessionName;
    this.intervalMs = intervalMs;
    this.servers = [];
    this.owners = new Map(); // pid -> { id, name }
    this.cwds = new Map(); // pid -> cwd
    this.timer = null;
    this.scanning = false;
    this.lastJson = '[]';
  }

  start() {
    if (this.timer) return;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  list() {
    return this.servers;
  }

  async scan() {
    if (this.scanning) return this.servers;
    this.scanning = true;
    try {
      const [lsofOut, psOut] = await Promise.all([
        run(LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcnt', '+c', '0']),
        run(PS, ['-axo', 'pid=,ppid=,command=']),
      ]);
      const sockets = parseLsof(lsofOut);
      const procs = parsePs(psOut);
      const roots = this.getRoots();

      // One row per (pid, port), collecting every address it is bound to.
      const rows = new Map();
      for (const sock of sockets) {
        const key = `${sock.pid}:${sock.port}`;
        let row = rows.get(key);
        if (!row) rows.set(key, (row = { key, pid: sock.pid, port: sock.port, name: sock.name, hosts: new Set() }));
        row.hosts.add(sock.host);
      }

      // Forked workers inherit the listening socket; keep only the topmost holder.
      for (const row of [...rows.values()]) {
        const parent = procs.get(row.pid)?.ppid;
        if (parent && rows.has(`${parent}:${row.port}`)) rows.delete(row.key);
      }

      const livePids = new Set([...rows.values()].map((r) => r.pid));
      for (const pid of this.owners.keys()) if (!livePids.has(pid)) this.owners.delete(pid);
      for (const pid of this.cwds.keys()) if (!livePids.has(pid)) this.cwds.delete(pid);

      const needCwd = [...livePids].filter((pid) => !this.cwds.has(pid));
      if (needCwd.length) {
        const found = parseCwds(await run(LSOF, ['-a', '-d', 'cwd', '-Fn', '-p', needCwd.join(',')]));
        for (const pid of needCwd) this.cwds.set(pid, found.get(pid) || '');
      }

      const lan = lanAddress();
      const servers = [];
      for (const row of rows.values()) {
        const proc = procs.get(row.pid);
        const command = proc?.command || row.name;

        // Walk up the process tree looking for a session's root process.
        for (let pid = row.pid, hops = 0; pid > 1 && hops < 64; hops++) {
          const root = roots.get(pid);
          if (root) {
            this.owners.set(row.pid, {
              id: root.id,
              name: this.getSessionName(root.id) || '',
              // The agent process itself, as opposed to something it launched.
              isAgent: pid === row.pid && root.kind === 'agent',
            });
            break;
          }
          pid = procs.get(pid)?.ppid ?? 0;
        }
        const owner = this.owners.get(row.pid) || null;
        if (owner) owner.name = this.getSessionName(owner.id) || owner.name;

        const hosts = [...row.hosts].sort();
        const exposed = hosts.some(isWildcard);
        const scope = exposed ? 'all' : hosts.every(isLoopback) ? 'local' : 'specific';
        const { label, claude } = describe(row.name, command);
        // The address to show first: the wildcard if there is one, IPv4 before IPv6.
        const primary =
          hosts.find((h) => h === '0.0.0.0') || hosts.find((h) => h === '::') ||
          hosts.find((h) => !h.includes(':')) || hosts[0];
        const urlHost = scope === 'specific' ? (primary.includes(':') ? `[${primary}]` : primary) : 'localhost';

        servers.push({
          key: row.key,
          pid: row.pid,
          port: row.port,
          hosts,
          host: primary,
          scope,
          lan: exposed ? lan : null,
          label,
          command,
          cwd: this.cwds.get(row.pid) || '',
          ownerId: owner?.id || null,
          ownerName: owner?.name || '',
          // Claude Code keeps a loopback port of its own; that is plumbing, not a server it started for you.
          internal: claude || row.pid === process.pid || Boolean(owner?.isAgent),
          url: `http://${urlHost}:${row.port}`,
        });
      }
      servers.sort((a, b) => a.port - b.port || a.pid - b.pid);

      this.servers = servers;
      const json = JSON.stringify(servers);
      if (json !== this.lastJson) {
        this.lastJson = json;
        this.emit('update', servers);
      }
      return servers;
    } finally {
      this.scanning = false;
    }
  }
}

module.exports = { ServerScanner, parseLsof, parsePs, describe };
