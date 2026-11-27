// End-to-end smoke test. Launches the real app against a throwaway profile and
// drives it like a user would.
//
//   npm test              core flows (no Claude Code involved)
//   npm test -- --claude  also runs real agents: three short prompts on your account
import { _electron as electron } from 'playwright-core';
import electronPath from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'output');
fs.mkdirSync(out, { recursive: true });
const withClaude = process.argv.includes('--claude');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aide-profile-'));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aide-work-')));
fs.writeFileSync(path.join(work, 'notes.txt'), 'first line\nsecond line\n');
fs.mkdirSync(path.join(work, 'assets'));
// A 2x2 red PNG.
fs.writeFileSync(
  path.join(work, 'assets', 'pixel.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8DAwMDAxAAGAA0GAQOWAc2YAAAAAElFTkSuQmCC', 'base64')
);
// A small page with a stylesheet, a module script and a link, plus a hidden file it must not be able to read.
fs.writeFileSync(path.join(work, '.env'), 'TOKEN=secret\n');
fs.writeFileSync(path.join(work, 'assets', 'report.css'), 'h1 { color: rgb(1, 2, 3); }\n');
fs.writeFileSync(path.join(work, 'assets', 'report.js'), 'export const total = 6 * 7;\n');
fs.writeFileSync(path.join(work, 'more.html'), '<h1>More</h1>\n');
fs.writeFileSync(
  path.join(work, 'report.html'),
  `<!doctype html>
<meta charset="utf-8">
<title>Report</title>
<link rel="stylesheet" href="assets/report.css">
<h1>Report</h1>
<p id="total"></p>
<a id="more" href="more.html">More</a>
<a id="web" href="https://example.com/aide-test">Web</a>
<script type="module">
  import { total } from './assets/report.js';
  document.querySelector('#total').textContent = String(total);
  localStorage.setItem('seen', 'yes');
  let reach = 'blocked';
  try { reach = typeof parent.aide; } catch {}
  window.probe = {
    stored: localStorage.getItem('seen'),
    aide: typeof window.aide,
    parent: reach,
    hidden: await fetch('/.env').then((r) => r.status),
    disk: await fetch('file:///etc/hosts').then(() => 'read', () => 'refused'),
  };
</script>
`
);

// A git repository with a branch of each kind and an "origin" beside it, and a
// stand-in for the GitHub CLI that reports pull requests for some of them.
const gitHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aide-git-')));
const repo = path.join(gitHome, 'repo');
const bin = path.join(gitHome, 'bin');
fs.mkdirSync(repo);
fs.mkdirSync(bin);
{
  const id = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const g = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...id }, stdio: 'pipe' });
  const commit = (file, msg) => {
    fs.writeFileSync(path.join(repo, file), `${msg}\n`);
    g('add', file);
    g('commit', '-q', '-m', msg);
  };
  g('init', '-q', '-b', 'main');
  commit('readme.md', 'Start the project');
  execFileSync('git', ['init', '-q', '--bare', path.join(gitHome, 'origin.git')]);
  g('remote', 'add', 'origin', path.join(gitHome, 'origin.git'));
  g('push', '-q', '-u', 'origin', 'main');
  g('remote', 'set-head', 'origin', 'main');
  g('checkout', '-q', '-b', 'old-thing');
  commit('old.txt', 'Old thing');
  g('checkout', '-q', 'main');
  g('merge', '-q', '--no-ff', '-m', 'Merge old-thing', 'old-thing');
  g('push', '-q', 'origin', 'main');
  g('checkout', '-q', '-b', 'experiment');
  commit('exp.txt', 'Try an experiment');
  g('push', '-q', 'origin', 'experiment');
  g('checkout', '-q', 'main');
  g('branch', '-q', '-D', 'experiment');
  g('checkout', '-q', '-b', 'fix/typo');
  commit('typo.txt', 'Fix a typo');
  g('checkout', '-q', '-b', 'feature/login', 'main');
  commit('login.js', 'Add login form');
  g('push', '-q', '-u', 'origin', 'feature/login');
  commit('login2.js', 'Remember me');
  fs.writeFileSync(path.join(repo, 'readme.md'), 'edited\n');
  fs.writeFileSync(path.join(repo, 'shown.html'), '<h1>Shown by an agent</h1>\n');
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
cat <<'JSON'
[{"number":14,"title":"Login form","state":"OPEN","isDraft":false,"headRefName":"feature/login","url":"https://github.com/example/repo/pull/14"},
 {"number":9,"title":"Old thing","state":"MERGED","isDraft":false,"headRefName":"old-thing","url":"https://github.com/example/repo/pull/9"},
 {"number":15,"title":"Experiment","state":"OPEN","isDraft":true,"headRefName":"experiment","url":"https://github.com/example/repo/pull/15"}]
JSON
`, { mode: 0o755 });
}

const PORT = 18473;
const AGENT_PORT = 18474;
let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
  }
}
const step = (title) => console.log(`\n${title}`);

const problems = [];
const watch = (p, label) => {
  p.on('pageerror', (e) => problems.push(`${label}: ${e.message}`));
  p.on('console', (m) => {
    // What a previewed page logs is that page's business, not a fault in aIDE.
    if (m.type() === 'error' && !/^(aide-preview|file:\/\/\/etc)/.test(m.location().url)) problems.push(`${label} console: ${m.text()}`);
  });
};

let app;
let page;
async function launch() {
  app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AIDE_USER_DATA: userData, AIDE_TEST: '1' },
  });
  page = await app.firstWindow();
  watch(page, 'main');
  await page.waitForFunction(() => window.__aide);
}

const sessions = () => page.evaluate(() => window.__aide.state.sessions);
const viewText = (sid) => (window.__aide.views ? window.__aide.views.get(sid)?.view.text() : window.__aide.view?.text()) || '';
const termText = (p, id) => p.evaluate(viewText, id);
const waitTerm = (p, id, needle, timeout = 20000) =>
  p.waitForFunction(
    ([sid, n]) => ((window.__aide.views ? window.__aide.views.get(sid)?.view.text() : window.__aide.view?.text()) || '').includes(n),
    [id, needle],
    { timeout }
  );
const rowState = (id) => page.getAttribute(`.session[data-id="${id}"] .status`, 'data-state');
const waitState = (id, state, timeout = 20000) =>
  page.waitForFunction(([sid, st]) => document.querySelector(`.session[data-id="${sid}"] .status`)?.dataset.state === st, [id, state], { timeout });
const dockBadge = () => app.evaluate(({ app: a }) => a.dock.getBadge());
// "Finished while you were away" depends on whether aIDE is the focused app,
// which a test cannot assume: these accept either resting state.
const RESTING = ['idle', 'running', 'unseen'];
const waitResting = (id, timeout = 20000) =>
  page.waitForFunction(([sid, ok]) => ok.includes(document.querySelector(`.session[data-id="${sid}"] .status`)?.dataset.state), [id, RESTING], { timeout });
/** Bring the main window to the front for real; false if macOS would not hand over focus. */
const takeFocus = () =>
  app.evaluate(async ({ app: a, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html'));
    a.focus({ steal: true });
    w.focus();
    await new Promise((r) => setTimeout(r, 500));
    return w.isFocused();
  });

async function newSession(kind, { command = '', name = '', cwd = work, extraArgs = null, open = null } = {}) {
  const before = new Set((await sessions()).map((s) => s.id));
  if (open) await open();
  else await page.click(kind === 'agent' ? '#new-agent' : '#new-process');
  await page.waitForSelector('#new-dialog[open]');
  if (kind === 'process') await page.fill('input[name="command"]', command);
  await page.fill('input[name="cwd"]', cwd);
  await page.fill('input[name="name"]', name);
  if (extraArgs !== null) await page.fill('input[name="extraArgs"]', extraArgs);
  await page.click('#new-submit');
  await page.waitForSelector('#new-dialog:not([open])', { state: 'attached' });
  const created = (await sessions()).find((s) => !before.has(s.id));
  if (!created) throw new Error('session was not created');
  return created.id;
}

async function renameInSidebar(id, name) {
  await page.dblclick(`.session[data-id="${id}"] .row-name`);
  await page.waitForSelector(`.session[data-id="${id}"] .rename-input`);
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await page.waitForFunction(([sid, n]) => document.querySelector(`.session[data-id="${sid}"] .row-name`)?.textContent === n, [id, name]);
}

/** Start a real agent and wait until Claude Code is at its prompt. */
async function startAgent(extraArgs) {
  const id = await newSession('agent', { cwd: root, extraArgs }); // this repo: a folder Claude Code already trusts
  await page.waitForFunction((sid) => /trust|Claude Code v/i.test(window.__aide.views.get(sid)?.view.text() || ''), id, { timeout: 40000 });
  if (!/Claude Code v/.test(await termText(page, id))) {
    await page.click(`.term-host[data-session="${id}"]`);
    await page.keyboard.press('Enter'); // accept the folder-trust question
  }
  await waitTerm(page, id, 'Claude Code v', 40000);
  await waitResting(id, 30000);
  return id;
}

async function prompt(id, text) {
  await page.click(`.term-host[data-session="${id}"]`);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

// Stand-ins for Claude Code's terminal titles: "✳ topic" when idle, "◐ topic" / "◑ topic" while working.
const title = (glyphOctal, text) => `printf '\\033]0;${glyphOctal} ${text}\\007'`;
const IDLE = '\\342\\234\\263';
const WORK_A = '\\342\\227\\220';
const WORK_B = '\\342\\227\\221';

try {
  await launch();

  step('Empty state');
  check('welcome card is shown', await page.isVisible('#overlay .card'));
  await page.screenshot({ path: path.join(out, '01-welcome.png') });

  step('Run a server and see it listed');
  const webId = await newSession('process', { command: `python3 -m http.server ${PORT} --bind 127.0.0.1`, name: 'web' });
  await waitTerm(page, webId, 'Serving HTTP');
  await page.waitForFunction((port) => window.__aide.state.servers.some((s) => s.port === port), PORT, { timeout: 15000 });
  const server = await page.evaluate((port) => window.__aide.state.servers.find((s) => s.port === port), PORT);
  check('server is attributed to the session that started it', server.ownerId === webId, JSON.stringify(server));
  check('server reports its bind address', server.host === '127.0.0.1' && server.scope === 'local');
  check('server row shows IP and port', (await page.textContent(`.server[data-key="${server.key}"] .addr`)).includes(`127.0.0.1:${PORT}`));
  check('server row names the owner', (await page.textContent(`.server[data-key="${server.key}"] .row-sub`)).includes('web'));
  check('servers tab counts it', (await page.textContent('#servers-count')) === '1');
  await page.click(`.server[data-key="${server.key}"] .row-text`);
  check('details expand', (await page.textContent(`.server[data-key="${server.key}"] .server-details`)).includes('http.server'));

  step('Status indicator follows the terminal title and survives a rename');
  const fake = [
    title(IDLE, 'Fake task'), 'sleep 2',
    `for i in 1 2 3 4; do ${title(WORK_A, 'Fake task')}; sleep 1; ${title(WORK_B, 'Fake task')}; sleep 1; done`,
    title(IDLE, 'Fake task'), 'echo fake-done', 'sleep 600',
  ].join('; ');
  const fakeId = await newSession('process', { command: fake });
  await waitState(fakeId, 'busy');
  check('spinner appears while the title animates', (await rowState(fakeId)) === 'busy');
  await renameInSidebar(fakeId, 'Renamed while busy');
  check('rename applied', (await sessions()).find((s) => s.id === fakeId).name === 'Renamed while busy');
  check('spinner still showing after rename', (await rowState(fakeId)) === 'busy');
  check('header shows the same spinner and name', (await page.getAttribute('#head-status', 'data-state')) === 'busy' && (await page.textContent('#head-name')) === 'Renamed while busy');
  await waitTerm(page, fakeId, 'fake-done');
  await waitResting(fakeId);
  check('spinner stops when the title goes idle', RESTING.includes(await rowState(fakeId)));

  step('Finishing while you look elsewhere');
  const quick = [title(WORK_A, 'Quick'), 'sleep 3', title(IDLE, 'Quick'), 'sleep 600'].join('; ');
  const quickId = await newSession('process', { command: quick, name: 'quick' });
  await waitState(quickId, 'busy');
  await page.click(`.session[data-id="${fakeId}"]`);
  await waitState(quickId, 'unseen');
  check('a session that finishes in the background is flagged', true);
  check('dock badge counts it', Number(await dockBadge()) >= 1, await dockBadge());
  if (await takeFocus()) {
    await page.click(`.session[data-id="${quickId}"]`);
    await waitState(quickId, 'running');
    check('looking at it clears the flag', true);
  } else {
    console.log('  skip  looking at it clears the flag (could not take window focus)');
  }

  step('Shell, floating window, and docking back');
  const shellId = await newSession('process', {});
  await page.click(`.term-host[data-session="${shellId}"]`);
  await page.waitForTimeout(1500); // shell startup files
  await page.keyboard.type('echo aide-$((6*7))\n');
  await waitTerm(page, shellId, 'aide-42');
  check('typing reaches the shell', true);
  const mainCols = await page.evaluate((sid) => window.__aide.views.get(sid).view.term.cols, shellId);

  const [floatPage] = await Promise.all([app.waitForEvent('window'), page.click('#head-actions [title^="Float"]')]);
  watch(floatPage, 'float');
  await floatPage.waitForFunction(() => window.__aide?.view?.term);
  await waitTerm(floatPage, shellId, 'aide-42');
  check('floating window replays the session so far', true);
  const flags = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('float.html'));
    w.focus();
    await new Promise((r) => setTimeout(r, 400));
    return { top: w.isAlwaysOnTop(), spaces: w.isVisibleOnAllWorkspaces(), visible: w.isVisible(), focused: w.isFocused() };
  });
  check('floating window is always on top', flags.top && flags.visible, JSON.stringify(flags));
  check('floating window follows you across Spaces', flags.spaces);
  check('floating window can hold keyboard focus', flags.focused && (await floatPage.evaluate(() => document.hasFocus())), JSON.stringify(flags));
  check('main window shows the placeholder', (await page.textContent('#overlay')).includes('floating window'));
  check('main window released its view', await page.evaluate((sid) => !window.__aide.views.has(sid), shellId));

  await floatPage.click('#float-term');
  await floatPage.keyboard.type('echo float-$((5*5))\n');
  await waitTerm(floatPage, shellId, 'float-25');
  check('typing works in the floating window', true);
  const floatCols = await floatPage.evaluate(() => window.__aide.view.term.cols);
  check('pty resized to the floating window', floatCols !== mainCols && floatCols > 20, `main ${mainCols}, float ${floatCols}`);

  await floatPage.dblclick('#float-name');
  await floatPage.waitForSelector('#float-name .rename-input');
  await floatPage.keyboard.type('scratch shell');
  await floatPage.keyboard.press('Enter');
  await page.waitForFunction((sid) => document.querySelector(`.session[data-id="${sid}"] .row-name`)?.textContent === 'scratch shell', shellId);
  check('rename in the floating window reaches the sidebar', true);
  await floatPage.screenshot({ path: path.join(out, '03-float.png') });

  step('Minimized floating window');
  const floatBounds = () =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('float.html')).getBounds());
  const floatState = () => floatPage.getAttribute('#float-status', 'data-state');
  const waitFloatState = (state) => floatPage.waitForFunction((st) => document.querySelector('#float-status').dataset.state === st, state, { timeout: 15000 });
  const sendLine = async (line) => {
    await floatPage.fill('#quick-input', line);
    await floatPage.press('#quick-input', 'Enter');
  };
  const fullBounds = await floatBounds();
  await floatPage.click('#float-actions [title^="Minimize"]');
  await floatPage.waitForFunction(() => window.__aide.mini);
  const miniBounds = await floatBounds();
  check('minimizing shrinks the window to one row', miniBounds.height <= 48 && miniBounds.width < fullBounds.width, JSON.stringify(miniBounds));
  check('it stays in the same corner', miniBounds.y === fullBounds.y && miniBounds.x + miniBounds.width === fullBounds.x + fullBounds.width, JSON.stringify([fullBounds, miniBounds]));
  check('only the bar is shown', (await floatPage.isVisible('#quick-input')) && !(await floatPage.isVisible('#float-term')));
  check('the field is ready to type into', await floatPage.evaluate(() => document.activeElement?.id === 'quick-input'));
  await sendLine('echo mini-$((3*3))');
  await waitTerm(floatPage, shellId, 'mini-9');
  check('a line typed into the bar runs in the session', (await floatPage.inputValue('#quick-input')) === '');
  await sendLine(`${title(WORK_A, 'Mini job')}; sleep 3; ${title(IDLE, 'Mini job')}`);
  await waitFloatState('busy');
  check('the bar shows a spinner while the session works', true);
  await waitFloatState('done');
  check('and says so when it finishes', (await floatPage.getAttribute('#quick-input', 'placeholder')).startsWith('Done'));
  await floatPage.screenshot({ path: path.join(out, '03-float-mini.png') });
  check('the hidden terminal kept its size', (await floatPage.evaluate(() => window.__aide.view.term.cols)) === floatCols);
  await sendLine('echo mini-again');
  await waitTerm(floatPage, shellId, 'mini-again');
  check('answering clears the finished mark', (await floatState()) !== 'done', await floatState());
  await floatPage.click('#float-actions [title^="Expand"]');
  await floatPage.waitForFunction(() => !window.__aide.mini);
  check('expanding puts the window back where it was', JSON.stringify(await floatBounds()) === JSON.stringify(fullBounds), JSON.stringify(await floatBounds()));
  await floatPage.waitForTimeout(300); // past the terminal's fit debounce
  check('the terminal is the size it was', (await floatPage.evaluate(() => window.__aide.view.term.cols)) === floatCols);
  check('and has the keyboard again', await floatPage.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea')));

  await Promise.all([floatPage.waitForEvent('close'), floatPage.click('#float-actions [title^="Return"]')]);
  await page.waitForFunction((sid) => window.__aide.views.get(sid)?.view.term, shellId);
  await waitTerm(page, shellId, 'float-25');
  check('docking back restores the terminal in the main window', true);
  await page.waitForFunction(([sid, cols]) => window.__aide.views.get(sid).view.term.cols === cols, [shellId, mainCols]);
  check('pty resized back to the main window', true);

  step('Agent groups');
  // Agents here run a stand-in for Claude Code: it sets a title the way Claude Code does, then waits.
  const fakeClaude = path.join(userData, 'fake-claude.sh');
  fs.writeFileSync(fakeClaude, `#!/bin/sh\ncase "$*" in *busy*) g='${WORK_A}';; *) g='${IDLE}';; esac\nprintf "\\033]0;$g Fake\\007"\nexec sleep 600\n`, { mode: 0o755 });
  await page.evaluate((cmd) => window.aide.setPrefs({ claudeCommand: cmd }), `'${fakeClaude}'`);
  const alpha = await newSession('agent', { name: 'alpha', extraArgs: '' });
  const beta = await newSession('agent', { name: 'beta', extraArgs: 'busy' });
  const gamma = await newSession('agent', { name: 'gamma', extraArgs: '' });
  await waitState(beta, 'busy');
  const layout = () => page.evaluate(() => window.__aide.state.layout.map((e) => (typeof e === 'string' ? e : [e.name, ...e.items])));
  const row = (sid) => `.session[data-id="${sid}"]`;
  /** Press on one row, travel, and let go at a point a fraction of the way down another. */
  const dragOnto = async (from, to, fraction) => {
    const a = await page.locator(from).boundingBox();
    const b = await page.locator(to).boundingBox();
    await page.mouse.move(a.x + 44, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(a.x + 44, a.y + a.height / 2 + 9, { steps: 2 });
    await page.mouse.move(b.x + 44, b.y + b.height * fraction, { steps: 8 });
    await page.mouse.up();
  };

  await page.click('#new-group');
  await page.waitForSelector('.group .group-name .rename-input');
  await page.keyboard.type('Project X');
  await page.keyboard.press('Enter');
  const groupId = await page.evaluate(() => window.__aide.state.layout.find((e) => typeof e !== 'string').id);
  const head = `.group[data-id="${groupId}"] .group-head`;
  check('a new group is added and named', JSON.stringify(await layout()) === JSON.stringify([alpha, beta, gamma, ['Project X']]), JSON.stringify(await layout()));

  await dragOnto(row(alpha), head, 0.6);
  await dragOnto(row(beta), head, 0.6);
  check('dropping agents on a group puts them inside', JSON.stringify(await layout()) === JSON.stringify([gamma, ['Project X', alpha, beta]]), JSON.stringify(await layout()));
  check('they are drawn inside it', (await page.locator(`.group[data-id="${groupId}"] .group-body > .session`).count()) === 2);
  check('a drag does not count as a click', (await page.evaluate(() => window.__aide.state.activeId)) === gamma);
  await dragOnto(row(beta), row(alpha), 0.25);
  check('agents reorder inside a group', JSON.stringify(await layout()) === JSON.stringify([gamma, ['Project X', beta, alpha]]), JSON.stringify(await layout()));
  await page.screenshot({ path: path.join(out, '07-groups.png') });

  await page.click(`${head} [data-act="toggle"]`);
  check('collapsing hides its agents', !(await page.isVisible(row(alpha))) && !(await page.isVisible(row(beta))));
  check('a collapsed group shows that an agent inside is working', (await page.getAttribute(`${head} .status`, 'data-state')) === 'busy' && (await page.isVisible(`${head} .status`)));
  check('and how many it holds', (await page.textContent(`${head} .group-count`)) === '2');
  await dragOnto(head, row(gamma), 0.25);
  check('dragging the header moves the whole group', JSON.stringify(await layout()) === JSON.stringify([['Project X', beta, alpha], gamma]), JSON.stringify(await layout()));
  await page.screenshot({ path: path.join(out, '07-groups-collapsed.png') });

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html')).webContents.send('ui:select-index', 0));
  await page.waitForFunction((sid) => window.__aide.state.activeId === sid, gamma);
  check('⌘1 picks the first row on screen', true);
  await page.evaluate((sid) => window.__aide.select(sid), alpha);
  check('selecting a hidden agent opens its group', await page.isVisible(row(alpha)));
  const saved = await page.evaluate(async () => (await window.aide.init()).ui.agentLayout);
  check('groups are saved', JSON.stringify(saved) === JSON.stringify(await page.evaluate(() => window.__aide.state.layout)) && saved[0].collapsed === false, JSON.stringify(saved));

  const delta = await newSession('agent', {
    name: 'delta',
    extraArgs: '',
    open: async () => {
      await page.hover(head);
      await page.click(`${head} [data-act="group-add"]`);
    },
  });
  check('the group’s + starts an agent inside it', JSON.stringify(await layout()) === JSON.stringify([['Project X', beta, alpha, delta], gamma]), JSON.stringify(await layout()));
  await dragOnto(row(alpha), row(gamma), 0.75);
  check('dragging an agent out returns it to the main list', JSON.stringify(await layout()) === JSON.stringify([['Project X', beta, delta], gamma, alpha]), JSON.stringify(await layout()));
  await page.hover(head);
  await page.click(`${head} [data-act="group-remove"]`);
  check('removing a group keeps its agents', JSON.stringify(await layout()) === JSON.stringify([beta, delta, gamma, alpha]) && (await sessions()).filter((s) => s.kind === 'agent').length === 4, JSON.stringify(await layout()));

  await dragOnto(row(alpha), row(gamma), 0.5);
  await page.waitForSelector('.group .group-name .rename-input');
  const project = path.basename(work);
  check('dropping one agent on another groups the two', JSON.stringify(await layout()) === JSON.stringify([beta, delta, [project, gamma, alpha]]), JSON.stringify(await layout()));
  check('the new group is offered their folder as its name', (await page.inputValue('.group .rename-input')) === project);
  await page.keyboard.type('Pair');
  await page.keyboard.press('Enter');
  await dragOnto(row(beta), row(delta), 0.85);
  check('the edges of a row still reorder', JSON.stringify(await layout()) === JSON.stringify([delta, beta, ['Pair', gamma, alpha]]), JSON.stringify(await layout()));

  for (const sid of [alpha, beta, gamma, delta]) await page.evaluate((x) => window.aide.sessions.remove(x), sid);
  await page.waitForFunction(() => !window.__aide.state.sessions.some((s) => s.kind === 'agent'));
  check('a group outlives its agents until you remove it', JSON.stringify(await layout()) === JSON.stringify([['Pair']]), JSON.stringify(await layout()));
  await page.hover('.group .group-head');
  await page.click('.group [data-act="group-remove"]');
  check('then the list is empty again', (await layout()).length === 0 && (await page.textContent('#agents')).includes('No agents yet'), JSON.stringify(await layout()));
  await page.evaluate(() => window.aide.setPrefs({ claudeCommand: 'claude', agentArgs: '' }));
  await page.click(row(shellId));

  step('Layout');
  const widthOf = () => page.evaluate(() => document.querySelector('#sidebar').getBoundingClientRect().width);
  const w0 = await widthOf();
  const bar = await page.locator('#split-sidebar').boundingBox();
  await page.mouse.move(bar.x + 0.5, bar.y + 300);
  await page.mouse.down();
  await page.mouse.move(bar.x + 60, bar.y + 300, { steps: 6 });
  await page.mouse.up();
  const w1 = await widthOf();
  check('dragging the divider resizes the sidebar', Math.abs(w1 - w0 - 60) < 4, `${w0} -> ${w1}`);

  step('Files');
  await page.click('.tabs [data-tab="files"]');
  await page.click('.tree-item:has-text("notes.txt")');
  await page.waitForSelector('#file-panel textarea');
  check('text file opens', (await page.inputValue('#file-panel textarea')) === 'first line\nsecond line\n');
  await page.click('#file-panel textarea');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('typed in aide\n');
  check('edit marks the file as changed', (await page.textContent('#file-state')) === 'Edited');
  await page.click('#file-save');
  await page.waitForFunction(() => document.querySelector('#file-state').textContent !== 'Edited');
  check('save writes to disk', fs.readFileSync(path.join(work, 'notes.txt'), 'utf8') === 'first line\nsecond line\ntyped in aide\n');
  fs.writeFileSync(path.join(work, 'notes.txt'), 'rewritten by an agent\n');
  await page.waitForFunction(() => document.querySelector('#file-panel textarea')?.value === 'rewritten by an agent\n', null, { timeout: 8000 });
  check('an outside edit reloads the open file', true);
  await page.click('.tree-item:has-text("assets")');
  await page.click('.tree-item:has-text("pixel.png")');
  await page.waitForFunction(() => document.querySelector('#file-panel img')?.naturalWidth === 2);
  await page.waitForFunction(() => document.querySelector('#file-state').textContent.includes('2 × 2'), null, { timeout: 5000 });
  check('image opens with its dimensions', true);
  await page.screenshot({ path: path.join(out, '02-main.png') });
  await page.click('#file-close');

  step('HTML files open as the page they make');
  // Links to the web go to the browser; here they are only noted.
  await app.evaluate(({ shell }) => {
    global.opened = [];
    shell.openExternal = async (url) => void global.opened.push(url);
  });
  const shown = async () => {
    for (let i = 0; i < 80; i++) {
      const frame = page.frames().find((f) => f.url().startsWith('aide-preview://'));
      if (frame) return frame;
      await page.waitForTimeout(100);
    }
    throw new Error('no rendered page appeared');
  };
  await page.click('.tree-item:has-text("report.html")');
  await page.waitForSelector('#file-panel iframe.page-view');
  let report = await shown();
  await report.waitForFunction(() => window.probe);
  check('an HTML file opens rendered, with its code out of sight',
    (await report.textContent('h1')) === 'Report' && (await page.isHidden('#file-panel textarea')) && (await page.isHidden('#file-save')));
  const headColor = () => getComputedStyle(document.querySelector('h1')).color;
  check('its stylesheet and scripts load', (await report.evaluate(headColor)) === 'rgb(1, 2, 3)' && (await report.textContent('#total')) === '42');
  const probe = await report.evaluate(() => window.probe);
  check('the page keeps its own storage', probe.stored === 'yes');
  check('the page cannot reach aIDE, hidden files or the rest of the disk',
    probe.aide === 'undefined' && probe.parent === 'blocked' && probe.hidden === 403 && probe.disk === 'refused', JSON.stringify(probe));

  fs.writeFileSync(path.join(work, 'assets', 'report.css'), 'h1 { color: rgb(9, 8, 7); }\n');
  await report.waitForFunction(() => getComputedStyle(document.querySelector('h1')).color === 'rgb(9, 8, 7)', null, { timeout: 8000 });
  check('the page reloads when a file it uses changes', true);
  await page.screenshot({ path: path.join(out, '08-html.png') });

  await report.click('#more');
  await report.waitForFunction(() => document.querySelector('h1')?.textContent === 'More');
  check('links between local pages work', report.url().endsWith('/more.html'));
  await page.click('#file-actions [title="Reload the page"]');
  report = await shown();
  await report.waitForFunction(() => document.querySelector('h1')?.textContent === 'Report' && window.probe);
  await report.click('#web');
  await page.waitForTimeout(600);
  const opened = await app.evaluate(() => global.opened);
  check('a link to the web opens the browser and leaves the page up',
    opened.join() === 'https://example.com/aide-test' && report.url().endsWith('/report.html') && (await report.textContent('h1')) === 'Report', opened.join());

  await page.click('#file-actions [title="Show the code"]');
  check('the code is one click away', (await page.inputValue('#file-panel textarea')).includes('<h1>Report</h1>') && (await page.locator('#file-panel iframe').count()) === 0);
  await page.click('#file-panel textarea');
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.type('<p id="added">added in aide</p>');
  await page.click('#file-save');
  await page.waitForFunction(() => document.querySelector('#file-state').textContent !== 'Edited');
  await page.click('#file-actions [title="Show the page"]');
  report = await shown();
  await report.waitForSelector('#added');
  check('an edit saved from the code shows in the page', (await report.textContent('#added')) === 'added in aide');
  await page.click('#file-close');
  await page.waitForFunction(() => !window.frames.length);
  check('closing the file ends the page', !page.frames().some((f) => f.url().startsWith('aide-preview://')));

  step('Agents can drive aIDE');
  // A stand-in agent that notes its arguments, then answers each line the way
  // Claude Code's title does: working for a moment, then idle.
  const lineAgent = path.join(userData, 'line-agent.sh');
  fs.writeFileSync(lineAgent, `#!/bin/sh
printf '%s\\n' "$@" > "${userData}/args-$AIDE_SESSION"
idle() { printf '\\033]0;${IDLE} Fake\\007'; }
busy() { printf '\\033]0;${WORK_A} Fake\\007'; }
idle
while IFS= read -r line; do busy; echo "got: $line"; sleep 1.2; idle; done
`, { mode: 0o755 });
  await page.evaluate((cmd) => window.aide.setPrefs({ claudeCommand: cmd }), `'${lineAgent}'`);
  const caller = await newSession('agent', { name: 'caller', cwd: repo, extraArgs: '' });
  const argsOf = async (sid) => {
    const file = path.join(userData, `args-${sid}`);
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await page.waitForTimeout(100);
    return fs.readFileSync(file, 'utf8').split('\n');
  };
  const callerArgs = await argsOf(caller);
  const toolsFile = callerArgs[callerArgs.indexOf('--mcp-config') + 1];
  const toolsUrl = JSON.parse(fs.readFileSync(toolsFile, 'utf8')).mcpServers.aide.url;
  check('every agent is given aIDE’s tools', toolsUrl.endsWith(`/${caller}`) && (fs.statSync(toolsFile).mode & 0o077) === 0, toolsUrl);

  let rpcId = 0;
  const rpc = async (method, params = {}, { url = toolsUrl, headers = {} } = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    return { status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { error: Boolean(r.result?.isError), text: r.result?.content?.[0]?.text || '' };
  };
  const hello = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  const tools = (await rpc('tools/list')).result?.tools.map((t) => t.name) || [];
  check('the tool server introduces itself and its tools', hello.result?.serverInfo?.name === 'aide' && /run_process/.test(hello.result.instructions) && tools.length === 8, tools.join());
  const stranger = await rpc('ping', {}, { url: toolsUrl.replace(/\/mcp\/[0-9a-f]+\//, `/mcp/${'0'.repeat(48)}/`) });
  const webPage = await rpc('ping', {}, { headers: { origin: 'https://example.com' } });
  check('it refuses callers without the secret, and web pages', stranger.status === 404 && webPage.status === 403, `${stranger.status} ${webPage.status}`);

  const ran = await tool('run_process', { command: "printf 'tool-%s\\n' ok; sleep 30", name: 'from the agent' });
  const procId = /process (\w{8})/.exec(ran.text)?.[1];
  await page.waitForSelector(`#processes .session[data-id="${procId}"]`, { timeout: 5000 });
  check('run_process starts it under Processes and returns its first output',
    ran.text.includes('tool-ok') && (await page.textContent(`#processes .session[data-id="${procId}"] .row-name`)) === 'from the agent', ran.text);
  check('the agent is still the one on screen', (await page.evaluate(() => window.__aide.state.activeId)) === caller);
  const listed = JSON.parse((await tool('list_sessions')).text);
  check('list_sessions shows the agent itself and the process', listed.some((x) => x.id === caller && x.you) && listed.some((x) => x.id === procId && x.state === 'running'));
  check('read_output reads what it printed', (await tool('read_output', { id: procId })).text.includes('tool-ok'));
  const stopped = await tool('stop_process', { id: procId });
  await waitState(procId, 'failed').catch(() => {});
  check('stop_process stops it', /Stopped/.test(stopped.text) && ['failed', 'stopped'].includes(await rowState(procId)), stopped.text);
  check('a wrong id gets an answer the agent can act on', (await tool('read_output', { id: 'nope' })).error);

  const startedAgent = await tool('start_agent', { prompt: "Say 'hi' -- then stop", name: 'helper' });
  const helper = /agent (\w{8})/.exec(startedAgent.text)?.[1];
  await page.waitForSelector(`#agents .session[data-id="${helper}"]`, { timeout: 5000 });
  const helperArgs = await argsOf(helper);
  check('start_agent starts another agent with its first message', helperArgs.slice(-3).join('|') === "--|Say 'hi' -- then stop|", helperArgs.join(' '));
  await page.waitForFunction(([a, b]) => { const l = window.__aide.state.layout; return l.indexOf(b) === l.indexOf(a) + 1; }, [caller, helper], { timeout: 3000 });
  check('next to the agent that asked, without switching to it', (await page.evaluate(() => window.__aide.state.activeId)) === caller);

  const fileShown = await tool('open_file', { path: 'shown.html' });
  await page.waitForSelector('#file-panel iframe.page-view', { timeout: 5000 });
  check('open_file shows a file in the panel', !fileShown.error && (await page.textContent('#file-name')) === 'shown.html', fileShown.text);
  check('a missing file is an error, not a blank panel', (await tool('open_file', { path: 'missing.html' })).error);
  await page.click('#file-close');

  step('Git');
  await page.waitForSelector('#head-meta .meta-chip.branch', { timeout: 8000 });
  check('the header shows the branch the agent is on', (await page.textContent('#head-meta .branch')) === 'feature/login');
  await page.click('.tabs [data-tab="git"]');
  await page.waitForSelector('#git .git-branch', { timeout: 10000 });
  const branchRow = (name) => page.locator('#git .git-branch', { has: page.locator(`.git-name:text-is("${name}")`) }).first();
  check('the Git tab heads with the checked-out branch and its changes',
    /feature\/login/.test(await page.textContent('#git .git-title')) && /2 changed files.*↑1 to push/.test(await page.textContent('#git .git-head')), await page.textContent('#git .git-head'));
  const loginRow = await branchRow('feature/login').innerText();
  check('a branch shows how far it is from main, what is unpushed, and its pull request', /↑1/.test(loginRow) && /#14 open/.test(loginRow) && /2 ahead main/.test(loginRow), loginRow);
  check('a branch never pushed says so', /local only/.test(await branchRow('fix/typo').innerText()));
  check('one only on origin is listed apart, with its draft PR', /#15 draft/.test(await branchRow('experiment').innerText()));
  await page.click('#git [data-act="toggle-merged"]');
  check('merged branches are folded away under their own heading', /#9 merged/.test(await page.locator('#git .git-branch.merged').first().innerText()));
  check('history draws the recent commits', (await page.locator('#git .commit').count()) >= 4 && (await page.locator('#git .commit svg.graph circle').count()) >= 4);
  await page.click('#git .tag.pr.open');
  check('a pull request opens in the browser', (await app.evaluate(() => global.opened)).includes('https://github.com/example/repo/pull/14'));
  await page.screenshot({ path: path.join(out, '09-git.png') });
  await page.click('.tabs [data-tab="servers"]');
  const overviewText = (await tool('git_overview')).text;
  check('agents can read the same overview', /feature\/login \(checked out\): 2 ahead of main; on origin, 1 to push; PR #14 open/.test(overviewText), overviewText);
  await page.waitForFunction(() => window.__aide.state.sideTab === 'git', null, { timeout: 3000 });
  check('and asking for it brings up the Git tab', true);
  await page.click('#git [data-act="fetch"]');
  await page.waitForFunction(() => /fetched just now/.test(document.querySelector('#git .git-head')?.textContent || ''), null, { timeout: 15000 });
  check('Fetch updates what is known about origin', true);

  step('Minimized bar while an agent works');
  const [agentFloat] = await Promise.all([app.waitForEvent('window'), page.click('#head-actions [title^="Float"]')]);
  watch(agentFloat, 'float');
  await agentFloat.waitForFunction(() => window.__aide?.meta);
  await agentFloat.click('#float-actions [title^="Minimize"]');
  await agentFloat.waitForFunction(() => window.__aide.mini);
  const barBounds = await floatBounds();
  const chimes = () => app.evaluate(() => global.aideTest.chimes());
  const chimesBefore = await chimes();
  await agentFloat.fill('#quick-input', 'a quick question');
  await agentFloat.press('#quick-input', 'Enter');
  await agentFloat.waitForFunction(() => window.__aide.tiny, null, { timeout: 3000 });
  const tinyBounds = await floatBounds();
  check('sending a line shrinks the bar to its spinner', tinyBounds.width <= 48 && tinyBounds.height <= 48 && (await agentFloat.getAttribute('#float-status', 'data-state')) === 'busy', JSON.stringify(tinyBounds));
  check('in the same corner', tinyBounds.x + tinyBounds.width === barBounds.x + barBounds.width && tinyBounds.y === barBounds.y);
  await agentFloat.screenshot({ path: path.join(out, '03-float-tiny.png') });
  await agentFloat.waitForFunction(() => !window.__aide.tiny && document.body.dataset.state === 'done', null, { timeout: 10000 });
  check('when the agent finishes it grows back into the bar', JSON.stringify(await floatBounds()) === JSON.stringify(barBounds), JSON.stringify(await floatBounds()));
  check('with a sound', (await chimes()) === chimesBefore + 1, `${await chimes()} vs ${chimesBefore}`);
  await Promise.all([agentFloat.waitForEvent('close'), page.evaluate((sid) => window.aide.sessions.dock(sid), caller)]);
  await page.evaluate(() => window.aide.setPrefs({ claudeCommand: 'claude' }));

  step('Stop a server from the list');
  await page.click('.tabs [data-tab="servers"]');
  await page.hover(`.server[data-key="${server.key}"] .row`);
  await page.click(`.server[data-key="${server.key}"] [data-act="kill"]`);
  await page.click(`.server[data-key="${server.key}"] [data-act="kill-confirm"]`);
  await page.waitForFunction((port) => !window.__aide.state.servers.some((s) => s.port === port), PORT, { timeout: 10000 });
  check('server disappears once stopped', true);
  await waitState(webId, 'failed').catch(() => {});
  check('its session shows as exited', ['failed', 'stopped'].includes(await rowState(webId)), await rowState(webId));

  if (withClaude) {
    step('Real Claude Code agent');
    const agentId = await startAgent('');
    check('agent starts and shows as idle', true);
    await page.waitForFunction((sid) => window.__aide.state.sessions.find((s) => s.id === sid)?.claudeSessionId, agentId, { timeout: 15000 });
    check('hooks report the conversation id', true);

    await prompt(agentId, `Start "python3 -m http.server ${AGENT_PORT} --bind 127.0.0.1" as a background task and leave it running, then reply with just: started`);
    await waitState(agentId, 'busy', 30000);
    check('spinner shows while the agent works', true);
    await renameInSidebar(agentId, 'server agent');
    const afterRename = await rowState(agentId);
    check('renaming a working agent keeps its indicator', ['busy', 'waiting'].includes(afterRename), afterRename);

    // If this account asks before running commands, approve the prompt.
    const seen = await Promise.race([
      page.waitForFunction((port) => window.__aide.state.servers.some((s) => s.port === port), AGENT_PORT, { timeout: 120000 }).then(() => 'server'),
      waitState(agentId, 'waiting', 120000).then(() => 'waiting'),
    ]);
    if (seen === 'waiting') {
      await page.click(`.term-host[data-session="${agentId}"]`);
      await page.keyboard.press('Enter');
      await page.waitForFunction((port) => window.__aide.state.servers.some((s) => s.port === port), AGENT_PORT, { timeout: 120000 });
    }
    const bg = await page.evaluate((port) => window.__aide.state.servers.find((s) => s.port === port), AGENT_PORT);
    check('background server started by the agent is listed under it', bg.ownerId === agentId && !bg.internal, JSON.stringify(bg));
    await waitResting(agentId, 120000);
    check('indicator stops when the turn ends', true);
    const meta = (await sessions()).find((s) => s.id === agentId);
    check('subtitle keeps Claude’s own topic next to your name', meta.name === 'server agent' && meta.title.length > 0, JSON.stringify(meta));
    await page.screenshot({ path: path.join(out, '04-agent.png') });
    await page.evaluate((pid) => window.aide.servers.kill(pid), bg.pid);
    await page.waitForFunction((port) => !window.__aide.state.servers.some((s) => s.port === port), AGENT_PORT, { timeout: 10000 });

    step('Agent blocked on a permission prompt');
    const askId = await startAgent('--permission-mode manual');
    const marker = path.join(work, 'approved.txt');
    // Typed as two lines: Shift+Enter must add a line break rather than send the first line alone.
    await page.click(`.term-host[data-session="${askId}"]`);
    await page.keyboard.type('Run exactly the shell command on the next line, then reply with just: done');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(`touch ${marker}`);
    await page.waitForTimeout(1500);
    check('Shift+Enter adds a line instead of sending', (await rowState(askId)) !== 'busy' && !(await termText(page, askId)).includes('Bash command'));
    await page.keyboard.press('Enter');
    await waitState(askId, 'waiting', 90000);
    check('indicator switches to "needs your input"', !fs.existsSync(marker));
    await page.screenshot({ path: path.join(out, '05-waiting.png') });
    await page.click(`.term-host[data-session="${askId}"]`);
    await page.keyboard.press('Enter'); // "Yes"
    await page.waitForFunction((sid) => document.querySelector(`.session[data-id="${sid}"] .status`)?.dataset.state !== 'waiting', askId, { timeout: 15000 });
    for (let i = 0; i < 120 && !fs.existsSync(marker); i++) await page.waitForTimeout(250);
    check('approving runs the command', fs.existsSync(marker));
    await waitTerm(page, askId, 'done', 90000);
    await waitResting(askId, 90000);
    check('the turn completes and the indicator settles', true);

    step('Relaunch and resume');
    await app.close();
    await launch();
    const restored = (await sessions()).find((s) => s.id === agentId);
    check('agents are remembered with their names', restored?.status === 'stopped' && restored?.name === 'server agent' && restored?.canResume, JSON.stringify(restored));
    await page.click(`.session[data-id="${agentId}"]`);
    await page.click('#overlay button:has-text("Resume conversation")');
    await waitTerm(page, agentId, 'started', 60000);
    await waitResting(agentId, 60000);
    check('resume restores the earlier conversation', (await termText(page, agentId)).includes('http.server'));
    await page.screenshot({ path: path.join(out, '06-resumed.png') });
  }

  check('no renderer errors', problems.length === 0, problems.join(' | '));
} catch (err) {
  failures.push(`crashed: ${err.message}`);
  console.log(`\n  CRASH ${err.stack}`);
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  if (problems.length) console.log(`  renderer problems: ${problems.join(' | ')}`);
} finally {
  await app?.close().catch(() => {});
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(gitHome, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
