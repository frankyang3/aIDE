# aIDE

A small desktop app for running several Claude Code agents at once. macOS, Electron.

```
npm install
npm start
```

To start it with a double-click instead, run `npm run shortcut` once. It puts `aIDE.app` on your Desktop (or in a folder you name: `npm run shortcut -- ~/Applications`); drag it to the Dock if you want it there. The app loads the code in this folder each time it starts, so there is nothing to rebuild after a change. Run the command again if this folder moves or Electron is updated. aIDE runs one copy at a time, so quit an `npm start` copy before opening the app.

## What it does

- **Agents.** Each agent is a real `claude` session in a folder you pick. Run as many as you like; switch with a click or ⌘1–⌘9. The header shows the model of the agent's latest reply and the git branch of its folder.
- **Agents can drive aIDE.** Every agent gets a set of aIDE tools, so you can ask it in plain words: "start the dev server" runs it under Processes (where you can watch, restart and stop it) instead of hiding it in the agent's shell; "spin up another agent to write the tests" starts one under Agents, next to the one you asked, with that as its first message; "show me the page" opens a file in the side panel; "what's merged?" brings up the Git tab. Tools that only look or show are allowed without asking. Claude Code asks you before running a command or starting an agent, as it would for its own shell, unless your permission mode already allows it.
- **Groups.** Keep each project's agents together: add a group with the folder button beside Agents, then drag agents onto it (or right-click an agent → Move to Group). Drag a group by its header to move it with everything inside, and click the header to collapse it; a collapsed group shows how many agents it holds and whether any is working, waiting on you or finished. A group's + starts an agent inside it; removing a group keeps its agents. Dragging also reorders agents, and ⌘1–⌘9 follow the order on screen.
- **Status that survives renaming.** Every session has an indicator that is separate from its name: a spinner while Claude works, an amber dot when it is blocked on a permission prompt, a blue dot when it finished while you were elsewhere. Double-click a name to rename it; Claude's own topic moves to the second line. Clear the name to go back to the automatic one.
- **Floating windows.** Pop any session into a small always-on-top window (⇧⌘F) that stays above your browser and follows you across Spaces. It has its own opacity and pin controls; send it back with the same shortcut. Minimize it (⇧⌘M) to a one-row bar: a spinner while the agent works, a green tick when it finishes, amber when it needs you, and a field that sends one line to the session. Once you send a line to an agent, the bar shrinks to just its spinner, and grows back with a sound when the agent finishes or needs you; click the spinner to open it early, or drag it to move it. Drag the bar by its name; drag its edge to widen it.
- **Processes.** Run a dev server or open a shell next to your agents (⌘T).
- **Servers.** Every listening TCP port on the machine, with the address it is bound to. Anything started by one of your sessions is listed under that session, including servers an agent starts as a background task. A `LAN` tag marks ports bound to every interface. Click a row for the pid, command and folder; open, copy or stop from the row.
- **Files.** A tree of the active session's folder and a side panel for reading or editing a text file or viewing an image. The panel reloads when an agent changes the file.
- **Git.** The Git tab draws the branches of the active session's folder against the main branch: how far each is ahead and behind, what is merged, what is pushed or only local, what exists only on origin, and each branch's pull request (open, draft, merged or closed; click to open it). Below that is a graph of recent history. Fetch updates what is known about origin. Pull requests come from the GitHub CLI (`gh`) when it is installed and signed in; without it, from GitHub's public API, which covers public repositories only.
- **HTML as a page.** An `.html` file opens as the page it makes, not as code: styles, scripts, images and links to other local pages work, and the page reloads when the file or anything it loads changes. The buttons above it switch to the code (and back), reload, and open the file in your browser. Links to the web open in your browser.
- **Sessions are remembered.** Names, folders and groups come back on the next launch, and an agent can resume its conversation.

Other keys: ⌘N new agent, ⌘S save file, ⌘0 show the main window, Shift+Enter for a new line in Claude's prompt, ⌘←/⌘→/⌘⌫ for line editing. Drop a file on a terminal to paste its path.

## How the status indicator works

Claude Code writes its state into the terminal title: `✳ topic` when idle and an animated `◐ topic` / `◑ topic` while working. aIDE reads the title from a headless copy of each terminal, so the spinner is exact even when a turn is interrupted with Esc.

Agents are also started with `--settings <file>` pointing at a small set of hooks (generated at launch, merged with your own settings). The hooks append one line per event to a per-session file and tell aIDE two things the title cannot: that the agent is waiting on a permission prompt, and the conversation id used to resume it. Nothing is written to your Claude Code configuration.

If a future Claude Code release changes its title glyphs, update `BUSY_GLYPH` in `src/main/sessions.js`.

The model in the header is read from the conversation's transcript (each reply records which model wrote it), so it appears after the first reply, or straight away if the agent was started with `--model`.

## How agents control aIDE

aIDE runs a small MCP server on `127.0.0.1` (`src/main/control.js`) and starts every agent with `--mcp-config` pointing at it. Each agent gets its own address, which is how aIDE knows which agent is asking, and the address holds a secret that changes every launch and is written to a file only you can read. Requests that come from a web page are refused. The tools:

| Tool | What it does |
| --- | --- |
| `run_process` | Run a command under Processes and return its first output |
| `list_sessions` | Agents and processes, with their state, folder and ports |
| `read_output` | The latest output of a process or agent |
| `stop_process`, `restart_process` | Stop or rerun a process |
| `start_agent` | Start another agent, optionally with a first message |
| `open_file` | Show a file in the side panel (an HTML file as its page) |
| `git_overview` | Branches, merges, origin and pull requests as text, and the Git tab |

The server also tells each agent to prefer `run_process` for anything long-running. Agents started before this existed get the tools the next time they start or resume.

## Layout

```
src/main/main.js       windows, menu, IPC
src/main/sessions.js   pty sessions, status tracking, hooks
src/main/servers.js    listening-port scan (lsof + ps) and ownership
src/main/files.js      file tree, read, write, watch
src/main/control.js    the aIDE tools agents use (MCP over HTTP on loopback)
src/main/git.js        branches, merges, origin and pull requests for the Git tab
src/main/preview.js    serves an HTML file and what it loads to the rendered view
src/preload/preload.js the API exposed to the windows
src/renderer/          main window (index.html, js/app.js), floating window (float.html, js/float.js)
test/smoke.mjs         end-to-end test
scripts/shortcut.js    makes the double-click app (npm run shortcut)
assets/                the app icon: icon.svg is the drawing, icon.icns is what the app uses
```

A rendered HTML file is shown in a frame and served over a private `aide-preview://` address rooted at the project folder, not from `file://`. That is what lets module scripts, `fetch()` and `localStorage` work, and it limits the page to that folder: it cannot read hidden files such as `.env`, anything outside the folder, or reach aIDE itself, and it is refused the camera, microphone and location.

Sessions live in the main process, so closing the main window does not stop them. A window attaches to a session by replaying a snapshot of its screen and scrollback, then following live output; only one window shows a session at a time so the terminal has one size.

## Testing

```
npm test              # core flows, no Claude Code involved
npm test -- --claude  # also runs real agents (three short prompts on your account)
```

The test launches the app with a throwaway profile, so it never touches your real sessions. Screenshots land in `test/output/`.

State is stored in `~/Library/Application Support/aIDE/state.json`.
