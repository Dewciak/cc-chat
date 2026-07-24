#!/usr/bin/env node
'use strict';
// cc-chat installer. Run: node setup.js
// - makes cc-msg + hooks executable
// - links `cc-msg` onto your PATH (~/.local/bin)
// - merges the 4 hooks (SessionStart / FileChanged / UserPromptSubmit / SessionEnd) and the
//   `Bash(cc-msg *)` permission into ~/.claude/settings.json (idempotent, with a backup)
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = __dirname;
const NODE = process.execPath;                 // absolute node path -> robust hook commands
const HOME = os.homedir();
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const BIN_DIR = path.join(HOME, '.local', 'bin');
const CC = path.join(REPO, 'bin', 'cc-msg');
const CB = path.join(REPO, 'integrations', 'cc-bus');   // live dashboard (integration)

function log(m) { process.stdout.write(m + '\n'); }

// 1. chmod +x
for (const f of [CC, CB, ...fs.readdirSync(path.join(REPO, 'hooks')).map((h) => path.join(REPO, 'hooks', h))]) {
  try { fs.chmodSync(f, 0o755); } catch {}
}

// 2. link cc-msg + cc-bus onto PATH
fs.mkdirSync(BIN_DIR, { recursive: true });
function linkBin(src, name) {
  const link = path.join(BIN_DIR, name);
  try { fs.unlinkSync(link); } catch {}
  try { fs.symlinkSync(src, link); log(`✓ linked ${name} -> ${link}`); }
  catch (e) { log(`! could not link ${name} (${e.message}); add to PATH manually: ${src}`); }
}
linkBin(CC, 'cc-msg');
linkBin(CB, 'cc-bus');
linkBin(CB, 'cc-chat');   // `cc-chat` = the UI dashboard, matching the project name (alias of cc-bus)
if (!(process.env.PATH || '').split(':').includes(BIN_DIR)) {
  log(`! ${BIN_DIR} is not on your PATH — add to your shell rc:\n    export PATH="$HOME/.local/bin:$PATH"`);
}

// 3. merge hooks + permission into settings.json
let cfg = {};
if (fs.existsSync(SETTINGS)) {
  try { cfg = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) { log(`✗ ${SETTINGS} is not valid JSON — aborting hook merge: ${e.message}`); process.exit(1); }
  fs.copyFileSync(SETTINGS, SETTINGS + '.bak');
  log(`✓ backed up settings -> ${SETTINGS}.bak`);
} else {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
}

cfg.hooks = cfg.hooks || {};
cfg.permissions = cfg.permissions || {};
cfg.permissions.allow = cfg.permissions.allow || [];

function hookCmd(file) { return `${NODE} ${path.join(REPO, 'hooks', file)}`; }
function addHook(event, command, extra) {
  cfg.hooks[event] = cfg.hooks[event] || [];
  const present = JSON.stringify(cfg.hooks[event]).includes('cc-chat') ||
    cfg.hooks[event].some((g) => (g.hooks || []).some((h) => (h.command || '').includes(path.join(REPO, 'hooks'))));
  if (present) { log(`= ${event} already has a cc-chat hook (skipped)`); return; }
  cfg.hooks[event].push({ hooks: [Object.assign({ type: 'command', command }, extra || {})] });
  log(`✓ added ${event} hook`);
}

addHook('SessionStart', hookCmd('cc-msg-start.js'), { timeout: 10, statusMessage: 'cc-chat: registering session...' });
addHook('FileChanged', hookCmd('cc-msg-recv.js'), { timeout: 10, asyncRewake: true });
addHook('UserPromptSubmit', hookCmd('cc-msg-board.js'), { timeout: 10 });
addHook('SessionEnd', hookCmd('cc-msg-end.js'), { timeout: 10 });

if (!cfg.permissions.allow.includes('Bash(cc-msg *)')) {
  cfg.permissions.allow.push('Bash(cc-msg *)');
  log('✓ added permission: Bash(cc-msg *)');
} else {
  log('= permission Bash(cc-msg *) already present');
}

fs.writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2));
log(`✓ wrote ${SETTINGS}`);

// 4. optional: install the cc-bus VS Code integration (wake idle tabs + cc-msg spawn)
const EXT_SRC = path.join(REPO, 'integrations', 'vscode-cc-bus-waker');
const EXT_ROOT = path.join(HOME, '.vscode', 'extensions');
if (fs.existsSync(EXT_ROOT)) {
  const dst = path.join(EXT_ROOT, 'cc-bus-waker');
  try { fs.rmSync(dst, { recursive: true, force: true }); } catch {}
  try { fs.symlinkSync(EXT_SRC, dst); log(`✓ linked VS Code integration -> ${dst} (Reload Window to activate)`); }
  catch (e) { log(`! could not link VS Code integration (${e.message}); copy ${EXT_SRC} into ${EXT_ROOT} manually`); }
} else {
  log(`i VS Code integration lives at ${EXT_SRC} — symlink it into ~/.vscode/extensions to enable idle-tab waking + cc-msg spawn`);
}

log('\nDone. RESTART your Claude Code sessions so the hooks load (each session registers on start).');
log('Then: `cc-msg who` to see live sessions, `cc-msg send <name> "hi"` to message one, `cc-bus` for the live dashboard.');
log('If you installed the VS Code integration, run "Developer: Reload Window" to activate it.');
