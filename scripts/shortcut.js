'use strict';
// Puts aIDE.app on the Desktop, or in a folder you name, so it starts with a
// double-click instead of `npm start`:
//
//   npm run shortcut
//   npm run shortcut -- ~/Applications
//
// The app is this folder's Electron under aIDE's name and icon. It holds no
// copy of aIDE itself: it loads the code in this folder each time it starts,
// so it always runs what `npm start` would. Run this again if the folder moves
// or Electron is updated.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ID = 'local.aide.app'; // how an app made here is recognised later
const root = path.join(__dirname, '..');
const electronApp = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const pkg = require(path.join(root, 'package.json'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== 'darwin') fail('The shortcut is a macOS app. On this system, use `npm start`.');
if (!fs.existsSync(electronApp)) fail('Electron is not installed yet. Run `npm install` first.');

const home = os.homedir();
const dest = path.resolve((process.argv[2] || path.join(home, 'Desktop')).replace(/^~(?=\/|$)/, home));
if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) fail(`Not a folder: ${dest}`);

const bundle = path.join(dest, 'aIDE.app');
const plist = path.join(bundle, 'Contents', 'Info.plist');
const resources = path.join(bundle, 'Contents', 'Resources');
if (fs.existsSync(bundle)) {
  // Only ever replace an app this script made.
  const ours = fs.existsSync(plist) && fs.readFileSync(plist, 'latin1').includes(ID);
  if (!ours) fail(`${bundle} already exists and was not made by this script. Move it away, or name another folder.`);
  fs.rmSync(bundle, { recursive: true });
}

// -c makes an APFS clone: instant, and it takes no extra disk space.
execFileSync('/bin/cp', ['-Rc', electronApp, bundle]);

const info = {
  CFBundleName: 'aIDE',
  CFBundleDisplayName: 'aIDE',
  CFBundleIdentifier: ID,
  CFBundleIconFile: 'aIDE.icns',
  CFBundleShortVersionString: pkg.version,
  CFBundleVersion: pkg.version,
};
for (const [key, value] of Object.entries(info)) execFileSync('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);

// Electron runs Resources/app when there is one, and its own welcome screen otherwise.
fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
fs.rmSync(path.join(resources, 'electron.icns'), { force: true });
fs.copyFileSync(path.join(root, 'assets', 'icon.icns'), path.join(resources, 'aIDE.icns'));
fs.mkdirSync(path.join(resources, 'app'));
// The same productName as this folder's package.json, so both keep their state in one place.
fs.writeFileSync(
  path.join(resources, 'app', 'package.json'),
  `${JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: 'main.js' }, null, 2)}\n`
);
fs.writeFileSync(path.join(resources, 'app', 'main.js'), `'use strict';
// Starts aIDE from its source folder. Made by \`npm run shortcut\` in that folder.
const path = require('path');
const { app, dialog } = require('electron');

const root = ${JSON.stringify(root)};
let main = '';
let problem = '';
try {
  main = path.join(root, require(path.join(root, 'package.json')).main);
  const wanted = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
  if (wanted !== process.versions.electron) {
    problem = \`This shortcut was made with Electron \${process.versions.electron}, and aIDE now uses \${wanted}.\`;
  }
} catch {
  problem = \`aIDE's folder has moved or is missing its packages:\\n\${root}\`;
}

if (problem) {
  dialog.showErrorBox('aIDE needs its shortcut made again', \`\${problem}\\n\\nRun "npm run shortcut" in aIDE's folder.\`);
  app.exit(1);
} else {
  require(main);
}
`);

// Finder shows a new icon for a folder it has already seen only once the folder changes.
const now = new Date();
fs.utimesSync(bundle, now, now);

console.log(`aIDE is at ${bundle}. Double-click it to start; drag it to the Dock to keep it there.`);
