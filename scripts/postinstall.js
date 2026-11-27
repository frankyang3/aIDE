'use strict';
// Two fix-ups that a plain `npm install` leaves undone:
//  1. node-pty ships its macOS `spawn-helper` without the executable bit, which
//     makes every pty spawn fail with "posix_spawnp failed".
//  2. Recent Electron releases download their binary on demand rather than at
//     install time; fetch it now so the first `npm start` is instant.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

const prebuilds = path.join(root, 'node_modules', 'node-pty', 'prebuilds');
if (fs.existsSync(prebuilds)) {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}

const electronDir = path.join(root, 'node_modules', 'electron');
const installer = path.join(electronDir, 'install.js');
if (fs.existsSync(installer) && !fs.existsSync(path.join(electronDir, 'dist'))) {
  const r = spawnSync(process.execPath, [installer], { stdio: 'inherit', cwd: electronDir });
  if (r.status !== 0) console.warn('Electron download failed; run `npx install-electron` to retry.');
}
