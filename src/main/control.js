'use strict';
// aIDE's tools for the agents it runs.
//
// Every agent is started with `--mcp-config` naming a small MCP server in this
// process, so Claude Code can act in the app and not only in its own shell: run
// a command under Processes, read what it printed, start another agent, show a
// file. The server speaks MCP over HTTP on the loopback interface. Each session
// gets its own address, which is how a call says which agent made it, and the
// address carries a secret, because "run this command" must not be something
// any local page or program can ask for.
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;
const FIRST_OUTPUT_MS = 1500;

const INSTRUCTIONS = `You are running inside aIDE, a desktop app that shows this session next to the user's other agents and processes. These tools act in the app:

- To run a dev server, a watcher or any other long-running command, call run_process instead of running it in the background from your shell. It appears under Processes, where the user can watch it, restart it and stop it, and the ports it opens appear under Servers. Check on it with read_output; change it with restart_process and stop_process.
- When the user asks for another agent or another chat, call start_agent. It starts a separate Claude Code session under Agents, optionally with a first message.
- To show the user a file, such as an HTML page or an image you made, call open_file.
- For the state of the branches (what is merged, what is on origin, pull requests), call git_overview.

Commands whose output you need right away (tests, builds, git) still belong in your own shell.`;

const text = (value) => ({ type: 'string', description: value });

class ControlServer {
  /**
   * @param {{
   *   sessions: import('./sessions').SessionManager,
   *   version: string,
   *   servers: () => Array<{ ownerId: string | null, port: number, internal: boolean }>,
   *   created: (meta: object, callerId: string) => void,
   *   showFile: (file: string, project: string) => Promise<{ ok: boolean, message?: string }>,
   *   git: (dir: string, caller: object) => Promise<string>,
   * }} opts
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.token = crypto.randomBytes(24).toString('hex');
    this.port = 0;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => this.refuse(res, 500, err.message));
    });
    this.tools = this.defineTools();
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  close() {
    this.server.close();
  }

  /** What `claude --mcp-config` is given for one session. */
  configFor(id) {
    if (!this.port) return null;
    return { mcpServers: { aide: { type: 'http', url: `http://127.0.0.1:${this.port}/mcp/${this.token}/${id}` } } };
  }

  // ------------------------------------------------------------------- http

  refuse(res, status, message) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
  }

  async handle(req, res) {
    const m = /^\/mcp\/([0-9a-f]+)\/([0-9a-f]{8})$/.exec(String(req.url).split('?')[0]);
    const given = Buffer.from(m ? m[1] : '');
    const wanted = Buffer.from(this.token);
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return this.refuse(res, 404, 'Not found.');
    // A browser always says where a cross-site request came from; Claude Code never does.
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${this.port}`) return this.refuse(res, 403, 'Not allowed.');
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }); // no server-to-client stream is offered
      return res.end();
    }
    const caller = this.sessions.get(m[2]);
    if (!caller) return this.refuse(res, 404, 'That session has been closed.');

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) return this.refuse(res, 413, 'Too large.');
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return this.refuse(res, 400, 'Not JSON.');
    }

    const replies = [];
    for (const msg of Array.isArray(body) ? body : [body]) {
      // Notifications and replies carry nothing to answer.
      if (!msg || typeof msg.method !== 'string' || msg.id === undefined || msg.id === null) continue;
      replies.push({ jsonrpc: '2.0', id: msg.id, ...(await this.answer(msg, caller)) });
    }
    if (!replies.length) {
      res.writeHead(202);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(Array.isArray(body) ? replies : replies[0]));
  }

  async answer(msg, caller) {
    const params = msg.params || {};
    switch (msg.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'aide', title: 'aIDE', version: this.version },
            instructions: INSTRUCTIONS,
          },
        };
      case 'ping':
        return { result: {} };
      case 'tools/list':
        return { result: { tools: this.tools.map(({ run, ...tool }) => tool) } };
      case 'tools/call': {
        const tool = this.tools.find((t) => t.name === params.name);
        if (!tool) return { error: { code: -32602, message: `Unknown tool: ${params.name}` } };
        try {
          const out = await tool.run(params.arguments || {}, caller);
          return { result: { content: [{ type: 'text', text: out }] } };
        } catch (err) {
          return { result: { content: [{ type: 'text', text: err.message }], isError: true } };
        }
      }
      default:
        return { error: { code: -32601, message: `Method not found: ${msg.method}` } };
    }
  }

  // ------------------------------------------------------------------ tools

  /** A folder named by an agent: absolute, or relative to the agent's own. */
  resolve(target, caller) {
    if (typeof target !== 'string' || !target.trim()) return caller.cwd;
    const home = os.homedir();
    const given = target.trim().replace(/^~(?=\/|$)/, home);
    return path.resolve(caller.cwd, given);
  }

  /** A session by id, or a clear refusal the model can act on. */
  need(id, kind) {
    const meta = typeof id === 'string' ? this.sessions.get(id.trim()) : null;
    if (!meta) throw new Error(`No session with id "${id}". Call list_sessions to see the ids.`);
    if (kind && meta.kind !== kind) throw new Error(`${meta.id} is ${meta.kind === 'agent' ? 'an agent' : 'a process'}; this tool works on ${kind === 'agent' ? 'agents' : 'processes'} only.`);
    return meta;
  }

  describe(meta, caller) {
    const name = meta.name || (meta.kind === 'agent' && meta.title) || meta.defaultName;
    let state = 'not running';
    if (meta.status === 'running') state = meta.kind !== 'agent' ? 'running' : meta.waiting ? 'waiting for the user' : meta.busy ? 'working' : 'idle';
    else if (meta.status === 'exited') state = `exited with code ${meta.exitCode}`;
    const ports = this.servers().filter((s) => s.ownerId === meta.id && !s.internal).map((s) => s.port);
    return {
      id: meta.id,
      kind: meta.kind,
      name,
      state,
      folder: meta.cwd,
      ...(meta.command ? { command: meta.command } : {}),
      ...(ports.length ? { ports } : {}),
      ...(meta.id === caller.id ? { you: true } : {}),
    };
  }

  /** Wait for a process to print something or stop, then say where it stands. */
  async report(id, lead) {
    const until = Date.now() + FIRST_OUTPUT_MS;
    while (Date.now() < until && this.sessions.get(id)?.status === 'running') await new Promise((r) => setTimeout(r, 100));
    const meta = this.sessions.get(id);
    const out = (await this.sessions.tail(id, 40)) || '(nothing yet)';
    const state = meta.status === 'running' ? 'It is running.' : `It has already stopped, with exit code ${meta.exitCode}.`;
    return `${lead} ${state}\n\nOutput so far:\n${out}`;
  }

  async stop(id) {
    this.sessions.kill(id);
    const until = Date.now() + 3000;
    while (Date.now() < until && this.sessions.get(id)?.status === 'running') await new Promise((r) => setTimeout(r, 50));
    return this.sessions.get(id)?.status !== 'running';
  }

  defineTools() {
    const id = text('The session id, as given by run_process, start_agent or list_sessions.');
    const readOnly = { readOnlyHint: true, openWorldHint: false };
    return [
      {
        name: 'run_process',
        description:
          'Run a shell command as a process in aIDE. It is listed under Processes, where the user can watch its output, restart it and stop it, and any port it opens is listed under Servers. Use this for dev servers, watchers and anything else long-running, instead of running it in the background from your own shell. Returns the id of the process and its first output.',
        inputSchema: {
          type: 'object',
          properties: {
            command: text('The command line, for example "npm run dev".'),
            cwd: text('The folder to run it in. Defaults to your own working folder.'),
            name: text('A short name for the list. Defaults to the command.'),
          },
          required: ['command'],
        },
        run: async (args, caller) => {
          const command = typeof args.command === 'string' ? args.command.trim() : '';
          if (!command) throw new Error('Give the command to run.');
          const meta = this.sessions.create({ kind: 'process', cwd: this.resolve(args.cwd, caller), command, name: String(args.name || '') });
          this.created(meta, caller.id);
          return this.report(meta.id, `Started process ${meta.id} in ${meta.cwd}; it is listed under Processes in aIDE.`);
        },
      },
      {
        name: 'list_sessions',
        description:
          'List everything running in aIDE: the agents (Claude Code sessions, including you) and the processes, each with its id, name, state, folder, command and the ports it is listening on.',
        inputSchema: { type: 'object', properties: {} },
        annotations: readOnly,
        run: async (_args, caller) => JSON.stringify(this.sessions.list().map((meta) => this.describe(meta, caller)), null, 2),
      },
      {
        name: 'read_output',
        description: 'Read the latest terminal output of a process (or of another agent) in aIDE, as plain text.',
        inputSchema: {
          type: 'object',
          properties: { id, lines: { type: 'integer', description: 'How many lines from the end. Defaults to 80.', minimum: 1, maximum: 1000 } },
          required: ['id'],
        },
        annotations: readOnly,
        run: async (args) => {
          const meta = this.need(args.id);
          const lines = Math.max(1, Math.min(1000, Number.isInteger(args.lines) ? args.lines : 80));
          const out = await this.sessions.tail(meta.id, lines);
          return out || '(no output)';
        },
      },
      {
        name: 'stop_process',
        description: 'Stop a process running in aIDE. It stays in the list, so it can be run again.',
        inputSchema: { type: 'object', properties: { id }, required: ['id'] },
        run: async (args) => {
          const meta = this.need(args.id, 'process');
          if (meta.status !== 'running') return `Process ${meta.id} was not running.`;
          return (await this.stop(meta.id)) ? `Stopped process ${meta.id}.` : `Asked process ${meta.id} to stop, but it is still running.`;
        },
      },
      {
        name: 'restart_process',
        description: 'Stop a process in aIDE if it is running, then run its command again. Returns its first output.',
        inputSchema: { type: 'object', properties: { id }, required: ['id'] },
        run: async (args) => {
          const meta = this.need(args.id, 'process');
          if (meta.status === 'running' && !(await this.stop(meta.id))) throw new Error(`Process ${meta.id} did not stop, so it was not restarted.`);
          this.sessions.start(meta.id);
          return this.report(meta.id, `Restarted process ${meta.id}.`);
        },
      },
      {
        name: 'start_agent',
        description:
          'Start another agent in aIDE: a separate Claude Code session with its own conversation, listed under Agents next to you. Use it when the user asks for another agent or chat. It works on its own; you are not told when it finishes, though list_sessions shows its state.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: text('The first message to give the new agent. Without one it starts and waits for the user.'),
            cwd: text('The folder it works in. Defaults to your own working folder.'),
            name: text('A short name for the list.'),
          },
        },
        run: async (args, caller) => {
          const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
          const meta = this.sessions.create({
            kind: 'agent',
            cwd: this.resolve(args.cwd, caller),
            name: String(args.name || ''),
            extraArgs: caller.kind === 'agent' ? caller.extraArgs || '' : '',
            prompt,
          });
          this.created(meta, caller.id);
          return `Started agent ${meta.id} in ${meta.cwd}; it is listed under Agents in aIDE${prompt ? ' and has been given its first message' : ', waiting for the user'}.`;
        },
      },
      {
        name: 'open_file',
        description:
          "Show a file to the user in aIDE's file panel, beside the terminal. An HTML file is shown as the rendered page, an image as the picture, anything else as text.",
        inputSchema: { type: 'object', properties: { path: text('The file, absolute or relative to your working folder.') }, required: ['path'] },
        annotations: readOnly,
        run: async (args, caller) => {
          if (typeof args.path !== 'string' || !args.path.trim()) throw new Error('Give the path of the file to show.');
          const file = this.resolve(args.path, caller);
          const res = await this.showFile(file, caller.cwd);
          if (!res.ok) throw new Error(res.message || `Could not show ${file}.`);
          return `${file} is now showing in aIDE.`;
        },
      },
      {
        name: 'git_overview',
        description:
          'The state of the git branches in a folder: the current branch and uncommitted changes, and for each branch how far it is ahead of and behind the main branch, whether it is merged, whether it is on origin, and its pull request if it has one. Also brings up the Git tab in aIDE, which draws the same thing for the user.',
        inputSchema: { type: 'object', properties: { cwd: text('The folder. Defaults to your own working folder.') } },
        annotations: readOnly,
        run: async (args, caller) => this.git(this.resolve(args.cwd, caller), caller),
      },
    ];
  }
}

module.exports = { ControlServer };
