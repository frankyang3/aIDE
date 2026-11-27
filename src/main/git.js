'use strict';
// The state of a git repository, for the Git tab, the branch in the header and
// the git_overview tool. Everything here only reads, except fetch(), which
// updates the remote-tracking branches the way `git fetch` does.
const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

// aIDE started from Finder gets a bare PATH; git and gh usually live here.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const PR_TTL_MS = 90 * 1000;
const PR_MIN_GAP_MS = 10 * 1000;
const MAX_BRANCHES = 40;
const MAX_REMOTE_ONLY = 20;
const HISTORY = 60;
const MAIN_NAMES = ['main', 'master', 'trunk', 'develop'];

function gitEnv() {
  const PATH = [...new Set([...(process.env.PATH || '').split(':'), ...EXTRA_PATH])].filter(Boolean).join(':');
  // GIT_OPTIONAL_LOCKS=0: looking must never take the index lock from an agent that is committing.
  return { ...process.env, PATH, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}

function run(cmd, cwd, args, { timeout = 8000, detached = false } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env: gitEnv(), timeout, maxBuffer: 16 * 1024 * 1024, detached }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout || '', err: String(stderr || err?.message || '').trim() });
    });
  });
}
const git = (cwd, args, opts) => run('git', cwd, args, opts);

function findOnPath(name) {
  for (const dir of gitEnv().PATH.split(':')) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // keep looking
    }
  }
  return null;
}

/** The branch checked out in `dir`, cheaply: for the header, polled. */
async function head(dir) {
  if (!dir) return null;
  const sym = await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], { timeout: 3000 });
  if (sym.ok && sym.out.trim()) return { branch: sym.out.trim(), detached: false };
  const sha = await git(dir, ['rev-parse', '--short', 'HEAD'], { timeout: 3000 });
  return sha.ok ? { branch: sha.out.trim(), detached: true } : null;
}

// ------------------------------------------------------------ pull requests

const prCache = new Map(); // repo root -> { at, data }

/** owner/repo of a GitHub remote, or null. */
function githubRepo(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url || '');
  return m ? `${m[1]}/${m[2]}` : null;
}

function githubApi(repo) {
  const headers = { 'User-Agent': 'aIDE', Accept: 'application/vnd.github+json' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${repo}/pulls?state=all&per_page=50&sort=updated&direction=desc`,
      { headers, timeout: 10000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 4 * 1024 * 1024) body += c; });
        res.on('end', () => {
          if (res.statusCode === 404) return resolve({ list: null, note: 'To see pull requests of a private repository, install the GitHub CLI (gh) and run “gh auth login”.' });
          if (res.statusCode !== 200) return resolve({ list: null, note: `GitHub did not list the pull requests (${res.statusCode}). With the GitHub CLI (gh) signed in, aIDE asks it instead.` });
          try {
            const list = JSON.parse(body).map((p) => ({
              number: p.number,
              title: p.title,
              state: p.merged_at ? 'MERGED' : String(p.state).toUpperCase(),
              isDraft: Boolean(p.draft),
              branch: p.head?.ref || '',
              url: p.html_url,
            }));
            return resolve({ list, note: null });
          } catch {
            return resolve({ list: null, note: 'GitHub sent something unexpected.' });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ list: null, note: `Could not reach GitHub: ${err.message}` }));
  });
}

async function pullRequests(root, remoteUrl, force) {
  const hit = prCache.get(root);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && (age < PR_MIN_GAP_MS || (!force && age < PR_TTL_MS))) return hit.data;

  let data = { list: null, note: null, source: null };
  const gh = findOnPath('gh');
  if (gh) {
    const r = await run(gh, root, ['pr', 'list', '--state', 'all', '--limit', '50', '--json', 'number,title,state,isDraft,headRefName,url'], { timeout: 15000 });
    if (r.ok) {
      try {
        const list = JSON.parse(r.out).map((p) => ({ number: p.number, title: p.title, state: p.state, isDraft: p.isDraft, branch: p.headRefName, url: p.url }));
        data = { list, note: null, source: 'gh' };
      } catch {
        data.note = 'The GitHub CLI sent something unexpected.';
      }
    } else {
      data.note = /auth login|not logged/i.test(r.err) ? 'Sign the GitHub CLI in (“gh auth login”) to see pull requests.' : r.err.split('\n')[0];
    }
  }
  if (!data.list && !gh) {
    const repo = githubRepo(remoteUrl);
    if (repo) data = { ...(await githubApi(repo)), source: 'api' };
  }
  prCache.set(root, { at: Date.now(), data });
  return data;
}

// ----------------------------------------------------------------- overview

function parseStatus(out) {
  const st = { head: '', oid: '', upstream: '', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) st.head = line.slice(14);
    else if (line.startsWith('# branch.oid ')) st.oid = line.slice(13);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') st.staged++;
      if (line[3] !== '.') st.unstaged++;
    } else if (line.startsWith('u ')) st.conflicts++;
    else if (line.startsWith('? ')) st.untracked++;
  }
  return st;
}

function parseTrack(track) {
  if (!track) return { ahead: 0, behind: 0, gone: false };
  if (track === 'gone') return { ahead: 0, behind: 0, gone: true };
  return { ahead: Number(/ahead (\d+)/.exec(track)?.[1] || 0), behind: Number(/behind (\d+)/.exec(track)?.[1] || 0), gone: false };
}

const FIELDS = ['%(refname)', '%(objectname)', '%(upstream)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(subject)'];

async function readRefs(root, base) {
  const withCounts = base ? [...FIELDS, `%(ahead-behind:${base})`] : FIELDS;
  let r = await git(root, ['for-each-ref', '--sort=-committerdate', `--format=${withCounts.join('%00')}`, 'refs/heads', 'refs/remotes']);
  let counted = Boolean(base);
  if (!r.ok && base) {
    // %(ahead-behind) arrived in git 2.41; count one branch at a time on older ones.
    r = await git(root, ['for-each-ref', '--sort=-committerdate', `--format=${FIELDS.join('%00')}`, 'refs/heads', 'refs/remotes']);
    counted = false;
  }
  const refs = r.out.split('\n').filter(Boolean).map((line) => {
    const [ref, sha, upstream, track, time, subject, ab] = line.split('\0');
    const [ahead, behind] = counted && ab ? ab.split(' ').map(Number) : [null, null];
    return { ref, sha, upstream, track, time: Number(time) * 1000, subject, ahead, behind };
  });
  return { refs, counted };
}

async function countAgainst(root, base, refs) {
  await Promise.all(refs.map(async (r) => {
    const c = await git(root, ['rev-list', '--left-right', '--count', `${base}...${r.sha}`]);
    const [behind, ahead] = c.out.trim().split(/\s+/).map(Number);
    if (c.ok) Object.assign(r, { ahead, behind });
  }));
}

const inflight = new Map();

/**
 * Branches compared with the main branch, what is on the remote, pull requests
 * and recent history. `force` asks GitHub again even if it was asked recently.
 */
function overview(dir, { force = false } = {}) {
  const key = `${dir}\0${force}`;
  if (!inflight.has(key)) inflight.set(key, read(dir, force).finally(() => inflight.delete(key)));
  return inflight.get(key);
}

async function read(dir, force) {
  const top = await git(dir, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  if (!top.ok) {
    return { repo: false, dir, message: /not a git repository/i.test(top.err) ? 'This folder is not in a git repository.' : top.err || 'git could not read this folder.' };
  }
  const [root, gitDir] = top.out.trim().split('\n');

  const [status, remotes, names] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch']),
    git(root, ['remote']),
    git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
  ]);
  const st = parseStatus(status.out);
  const remoteList = remotes.out.split('\n').filter(Boolean);
  const remote = remoteList.includes('origin') ? 'origin' : remoteList[0] || null;
  const refNames = new Set(names.out.split('\n').filter(Boolean));

  // The main branch: what the remote says its default is, else the usual names.
  let main = null;
  if (remote) {
    const sym = await git(root, ['symbolic-ref', '-q', '--short', `refs/remotes/${remote}/HEAD`]);
    if (sym.ok && sym.out.trim()) main = sym.out.trim().slice(remote.length + 1);
  }
  main ||= MAIN_NAMES.find((n) => refNames.has(`refs/heads/${n}`) || (remote && refNames.has(`refs/remotes/${remote}/${n}`))) || null;
  // Compare with the remote's copy, which is what "merged" means to everyone else.
  let base = null;
  if (main && remote && refNames.has(`refs/remotes/${remote}/${main}`)) base = `refs/remotes/${remote}/${main}`;
  else if (main && refNames.has(`refs/heads/${main}`)) base = `refs/heads/${main}`;

  const remoteUrl = remote ? (await git(root, ['remote', 'get-url', remote])).out.trim() : '';
  const [{ refs, counted }, prs, fetchedAt] = await Promise.all([
    readRefs(root, base),
    remote ? pullRequests(root, remoteUrl, force) : Promise.resolve({ list: null, note: null, source: null }),
    fs.promises.stat(path.join(gitDir, 'FETCH_HEAD')).then((s) => s.mtimeMs, () => null),
  ]);
  const baseSha = refs.find((r) => r.ref === base)?.sha || null;

  const remotePrefix = remote ? `refs/remotes/${remote}/` : null;
  const locals = refs.filter((r) => r.ref.startsWith('refs/heads/')).slice(0, MAX_BRANCHES);
  const tracked = new Set(locals.map((r) => r.upstream).filter(Boolean));
  const localNames = new Set(locals.map((r) => r.ref.slice(11)));
  const remoteOnly = remotePrefix
    ? refs.filter((r) => r.ref.startsWith(remotePrefix) && !r.ref.endsWith('/HEAD') && r.ref !== base &&
        !tracked.has(r.ref) && !localNames.has(r.ref.slice(remotePrefix.length))).slice(0, MAX_REMOTE_ONLY)
    : [];
  if (base && !counted) await countAgainst(root, base, [...locals, ...remoteOnly]);

  const prFor = (name) => (prs.list || []).find((p) => p.branch === name) || null;
  const describe = (r, name) => {
    const pr = prFor(name);
    const contained = base && r.ahead === 0;
    return {
      name,
      sha: r.sha,
      subject: r.subject,
      time: r.time,
      ahead: r.ahead,
      behind: r.behind,
      // Every commit of it is in main; a branch level with main has nothing of its own yet.
      merged: Boolean((contained && r.sha !== baseSha) || pr?.state === 'MERGED'),
      level: Boolean(contained && r.sha === baseSha),
      pr,
    };
  };

  const branches = locals.map((r) => {
    const name = r.ref.slice(11);
    const up = r.upstream && remotePrefix && r.upstream.startsWith('refs/remotes/') ? r.upstream.slice(13) : '';
    return {
      ...describe(r, name),
      current: st.head === name,
      isMain: name === main,
      upstream: up,
      ...(() => { const t = parseTrack(r.track); return { pushAhead: t.ahead, pullBehind: t.behind, gone: t.gone }; })(),
    };
  });
  const onRemoteOnly = remoteOnly.map((r) => describe(r, r.ref.slice(remotePrefix.length)));

  // History: the checked-out branch, main and the checked-out branch's upstream.
  const logRefs = [...new Set(['HEAD', base, st.upstream ? `refs/remotes/${st.upstream}` : null].filter(Boolean))];
  const log = st.oid === '(initial)' ? { out: '' } : await git(root, ['log', '--topo-order', `-n${HISTORY}`, '--format=%H%x1f%P%x1f%D%x1f%s%x1f%ct', ...logRefs, '--']);
  const history = log.out.split('\n').filter(Boolean).map((line) => {
    const [hash, parents, refsText, subject, time] = line.split('\x1f');
    return {
      hash,
      parents: parents ? parents.split(' ') : [],
      refs: refsText ? refsText.split(', ').map((x) => x.replace(/^HEAD -> /, '')).filter((x) => x && !x.endsWith('/HEAD')) : [],
      subject,
      time: Number(time) * 1000,
    };
  });

  const prBranches = new Set([...branches, ...onRemoteOnly].map((b) => b.name));
  return {
    repo: true,
    dir,
    root,
    remote,
    remoteUrl,
    github: githubRepo(remoteUrl),
    main,
    base: base ? base.replace(/^refs\/(heads|remotes)\//, '') : null,
    fetchedAt,
    head: { branch: st.head === '(detached)' ? st.oid.slice(0, 7) : st.head, detached: st.head === '(detached)', upstream: st.upstream, ahead: st.ahead, behind: st.behind },
    changes: { staged: st.staged, unstaged: st.unstaged, untracked: st.untracked, conflicts: st.conflicts },
    branches,
    remoteOnly: onRemoteOnly,
    // Open pull requests from branches that are not here at all (forks, branches deleted locally).
    otherPrs: (prs.list || []).filter((p) => p.state === 'OPEN' && !prBranches.has(p.branch)).slice(0, 10),
    prNote: prs.note,
    prSource: prs.source,
    history,
  };
}

/** Update the remote-tracking branches. Never asks for a password: it fails instead. */
async function fetchRemote(dir) {
  const ov = await overview(dir);
  if (!ov.repo || !ov.remote) return { ok: false, message: ov.repo ? 'This repository has no remote.' : ov.message };
  // detached: no terminal to ask for a passphrase on, so ssh gives up instead of hanging.
  const r = await git(ov.root, ['fetch', '--prune', ov.remote], { timeout: 60000, detached: true });
  prCache.delete(ov.root);
  return r.ok ? { ok: true } : { ok: false, message: r.err.split('\n').filter(Boolean).slice(-1)[0] || 'git fetch failed.' };
}

// ------------------------------------------------------------- as text

const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const prText = (pr) => (pr ? `PR #${pr.number} ${pr.isDraft && pr.state === 'OPEN' ? 'draft' : pr.state.toLowerCase()} “${pr.title}”` : '');

/** The overview as text, for an agent. */
function describeOverview(ov) {
  if (!ov.repo) return ov.message;
  const lines = [];
  lines.push(`Repository: ${ov.root}${ov.remote ? ` (${ov.remote}: ${ov.github ? `github.com/${ov.github}` : ov.remoteUrl})` : ', no remote'}`);
  const c = ov.changes;
  const changed = c.staged + c.unstaged + c.untracked + c.conflicts;
  const work = changed
    ? [c.staged && `${c.staged} staged`, c.unstaged && `${c.unstaged} modified`, c.untracked && `${c.untracked} untracked`, c.conflicts && `${c.conflicts} in conflict`].filter(Boolean).join(', ')
    : 'no uncommitted changes';
  const h = ov.head;
  let sync = `; not on ${ov.remote || 'a remote'}`;
  if (h.upstream) {
    sync = h.ahead || h.behind
      ? `; against ${h.upstream}: ${[h.ahead && `${h.ahead} to push`, h.behind && `${h.behind} to pull`].filter(Boolean).join(', ')}`
      : `; in step with ${h.upstream}`;
  }
  lines.push(`Checked out: ${h.detached ? `detached at ${h.branch}` : h.branch} (${work}${h.detached ? '' : sync})`);
  if (ov.base) lines.push(`Main branch: ${ov.main}, compared as ${ov.base}${ov.remote ? `; last fetched ${ov.fetchedAt ? ago(ov.fetchedAt) : 'never'}` : ''}`);

  const vsMain = (b) => {
    if (b.merged) return b.pr?.state === 'MERGED' && b.ahead ? `merged by PR #${b.pr.number}` : 'merged';
    if (b.ahead == null) return '';
    if (b.level) return 'level with main, no commits of its own';
    return [b.ahead && `${b.ahead} ahead of main`, b.behind && `${b.behind} behind`].filter(Boolean).join(', ') || 'merged';
  };
  const origin = (b) => {
    if (b.gone) return `its branch on ${ov.remote} was deleted`;
    if (!b.upstream) return 'local only';
    if (!b.pushAhead && !b.pullBehind) return `on ${ov.remote}`;
    return `on ${ov.remote}, ${[b.pushAhead && `${b.pushAhead} to push`, b.pullBehind && `${b.pullBehind} to pull`].filter(Boolean).join(', ')}`;
  };
  const row = (b) => `- ${b.name}${b.current ? ' (checked out)' : ''}: ${[vsMain(b), origin(b), prText(b.pr)].filter(Boolean).join('; ')}`;
  const open = ov.branches.filter((b) => !b.isMain && !b.merged);
  const merged = ov.branches.filter((b) => !b.isMain && b.merged);
  lines.push('', 'Branches not in main:', ...(open.length ? open.map(row) : ['- none']));
  if (merged.length) lines.push('', 'Merged into main:', ...merged.map(row));
  if (ov.remoteOnly.length) {
    lines.push('', `Only on ${ov.remote}:`, ...ov.remoteOnly.map((b) => `- ${b.name}: ${[vsMain(b), prText(b.pr)].filter(Boolean).join('; ')}`));
  }
  if (ov.otherPrs.length) lines.push('', 'Other open pull requests:', ...ov.otherPrs.map((p) => `- #${p.number} ${p.title} (${p.branch})`));
  if (ov.prNote) lines.push('', `Pull requests: ${ov.prNote}`);
  else if (ov.remote && !ov.prSource && !ov.github) lines.push('', 'Pull requests: only shown for GitHub remotes.');
  lines.push('', `The Git tab in aIDE shows this as a diagram, with the last ${plural(Math.min(HISTORY, ov.history.length), 'commit')}.`);
  return lines.join('\n');
}

module.exports = { head, overview, fetchRemote, describeOverview, githubRepo };
