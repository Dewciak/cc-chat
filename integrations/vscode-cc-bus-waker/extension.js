'use strict';
// cc-bus-waker — VS Code integration for cc-chat.
//
// Two jobs:
//  1) WAKE idle Claude Code terminals in THIS window when a cc-chat message is waiting.
//     VS Code's integrated terminal can't be woken from outside the editor, but an
//     extension may write to a Terminal via sendText — that's the enabling capability.
//  2) SPAWN new claude tabs on request (`cc-msg spawn`): open a terminal, run claude
//     (optionally `--resume <sid>`), and seed an initial prompt once it registers.
//
// Safety: only sessions whose terminal is in THIS window (matched by process tree) are
// touched; only IDLE sessions (transcript untouched for idleSeconds) — never mid-generation;
// the focused terminal is skipped by default; each pending message triggers at most one nudge.
// The inbox stays the source of truth: we only make Claude TAKE A TURN, then the cc-chat
// UserPromptSubmit hook delivers the content exactly once. We never drain it.
//
// Self-contained: it talks to ~/.cc-chat/bus directly, no dependency on the repo path.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const BUS = path.join(os.homedir(), '.cc-chat', 'bus');
const REG = path.join(BUS, 'registry');
const INBOX = path.join(BUS, 'inbox');
const SPAWN = path.join(BUS, 'spawn');

let out = null;
let statusBar = null;
let timer = null;
let draining = false;
const lastNudged = new Map();   // sid -> inbox line-count we last nudged for
const ppidCache = new Map();    // claudePid -> shellPid

function log(m) { if (out) out.appendLine(`[${new Date().toLocaleTimeString()}] ${m}`); }
function cfg() { return vscode.workspace.getConfiguration('ccBusWaker'); }

// --- cc-chat bus access (inlined, no lib dependency) ---
function listTabs() {
  const tabs = [];
  try {
    for (const f of fs.readdirSync(REG)) {
      if (!f.endsWith('.json')) continue;
      try { tabs.push(JSON.parse(fs.readFileSync(path.join(REG, f), 'utf8'))); } catch {}
    }
  } catch {}
  return tabs;
}
const inboxFile = (sid) => path.join(INBOX, `${sid}.jsonl`);
const cursorFile = (sid) => path.join(INBOX, `${sid}.cursor`);
// Claude Code's own transcript (independent of cc-chat) — used only for idle detection.
const transcriptPath = (cwd, sid) =>
  path.join(os.homedir(), '.claude', 'projects', String(cwd || '').replace(/\//g, '-'), `${sid}.jsonl`);

function countLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; }
}
function readCursor(sid) {
  try { return parseInt(fs.readFileSync(cursorFile(sid), 'utf8'), 10) || 0; } catch { return 0; }
}
function transcriptMtime(cwd, sid) {
  try { return fs.statSync(transcriptPath(cwd, sid)).mtimeMs; } catch { return 0; }
}
function newestUnreadMeta(sid, cursor) {
  try {
    const fresh = fs.readFileSync(inboxFile(sid), 'utf8').split('\n').filter(Boolean).slice(cursor);
    if (!fresh.length) return null;
    const m = JSON.parse(fresh[fresh.length - 1]);
    return { from: m.from, intent: m.intent };
  } catch { return null; }
}
function shellPidOf(claudePid) {
  if (!claudePid) return null;
  if (ppidCache.has(claudePid)) return ppidCache.get(claudePid);
  let ppid = null;
  try { ppid = parseInt(cp.execFileSync('ps', ['-o', 'ppid=', '-p', String(claudePid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(), 10) || null; } catch {}
  ppidCache.set(claudePid, ppid);
  return ppid;
}

// Submit a prompt to a Claude Code TUI. Text + trailing newline in ONE write is treated as
// a paste (lands in the input but does NOT submit) — so type the text, then send a SEPARATE
// Enter after a short gap, which registers as a real keypress.
function typeAndEnter(term, text) {
  try {
    term.sendText(text, false);
    setTimeout(() => { try { term.sendText('\r', false); } catch {} }, 400);
  } catch {}
}

// pid -> Terminal for every terminal in THIS window (processId is the shell pid).
async function terminalsByShellPid() {
  const map = new Map();
  await Promise.all(vscode.window.terminals.map(async (t) => {
    try { const pid = await t.processId; if (pid) map.set(pid, t); } catch {}
  }));
  return map;
}

// --- spawn: open a NEW claude terminal on request (cc-msg spawn) ---
function cwdInThisWindow(cwd) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) return false;               // need a workspace to scope which window opens it
  const c = path.resolve(cwd || '');
  return folders.some((f) => {
    const root = path.resolve(f.uri.fsPath);
    return c === root || c.startsWith(root + path.sep);
  });
}

async function sendPromptWhenReady(term, prompt) {
  let shellPid = null;
  try { shellPid = await term.processId; } catch {}
  if (!shellPid) { setTimeout(() => typeAndEnter(term, prompt), 6000); return; }
  const deadline = Date.now() + 45000;
  const poll = () => {
    const alive = listTabs().some((e) => shellPidOf(e.pid) === shellPid);
    if (alive) { setTimeout(() => typeAndEnter(term, prompt), 1200); return; }
    if (Date.now() < deadline) setTimeout(poll, 700);
    else typeAndEnter(term, prompt);   // fallback: send anyway
  };
  setTimeout(poll, 1500);
}

function scanSpawnRequests() {
  let files = [];
  try { files = fs.readdirSync(SPAWN).filter((f) => f.endsWith('.json')); } catch { return; }
  for (const f of files) {
    const reqPath = path.join(SPAWN, f);
    let req; try { req = JSON.parse(fs.readFileSync(reqPath, 'utf8')); } catch { continue; }
    if (!cwdInThisWindow(req.cwd)) continue;          // another window owns this project
    const claimed = reqPath + '.claimed';
    try { fs.renameSync(reqPath, claimed); } catch { continue; }   // lost the race to another window
    const launch = req.resume ? `claude --resume ${req.resume}` : 'claude';
    const term = vscode.window.createTerminal({ cwd: req.cwd, name: 'claude' + (req.resume ? ' ⟳' : ' +') });
    term.show();
    term.sendText(launch, true);   // shell command — a normal newline submits fine
    log(`spawn: new terminal in ${req.cwd} (${launch})${req.prompt ? ' + initial prompt' : ''} [from ${req.from || '?'}]`);
    if (cfg().get('notify', true)) {
      vscode.window.showInformationMessage(`🆕 opened a new claude tab in ${path.basename(req.cwd)}${req.resume ? ' (resumed)' : ''}`);
    }
    if (req.prompt) sendPromptWhenReady(term, req.prompt);
    try { fs.unlinkSync(claimed); } catch {}
  }
}

async function tick() {
  if (draining) return;
  if (!cfg().get('enabled', true)) { updateBar(0); return; }
  try { scanSpawnRequests(); } catch (e) { log(`spawn scan error: ${e.message}`); }
  draining = true;
  try {
    const idleMs = Math.max(0, (cfg().get('idleSeconds', 15)) * 1000);
    const skipActive = cfg().get('skipActiveTerminal', true);
    const nudgeText = cfg().get('nudgeText', 'read the pending cc-chat message(s)');
    const active = vscode.window.activeTerminal;

    const byShell = await terminalsByShellPid();
    let connected = 0;
    const woken = [];   // {label, from, intent} nudged this tick — for the user toast

    for (const entry of listTabs()) {
      const sid = entry.sessionId;
      const shellPid = shellPidOf(entry.pid);
      const term = shellPid ? byShell.get(shellPid) : null;
      if (!term) continue;          // session not in THIS window — another window handles it
      connected++;

      const lines = countLines(inboxFile(sid));
      const cursor = readCursor(sid);
      const unread = lines - cursor;
      if (unread <= 0) { lastNudged.set(sid, lines); continue; }   // nothing pending
      if (lines <= (lastNudged.get(sid) || 0)) continue;           // already nudged for this batch

      const mtime = transcriptMtime(entry.cwd, sid);
      if (mtime && (Date.now() - mtime) < idleMs) {
        log(`skip ${entry.label}: busy (transcript ${Math.round((Date.now() - mtime) / 1000)}s ago)`);
        continue;
      }
      if (skipActive && active && term === active) {
        log(`skip ${entry.label}: active terminal (protecting your input)`);
        continue;
      }

      log(`waking ${entry.label} (${unread} pending)`);
      const meta = newestUnreadMeta(sid, cursor);
      try {
        typeAndEnter(term, nudgeText);
        lastNudged.set(sid, lines);
        woken.push({ label: entry.label, from: meta && meta.from, intent: meta && meta.intent });
      } catch (e) { log(`sendText error: ${e.message}`); }
    }
    updateBar(connected);

    if (woken.length && cfg().get('notify', true)) {
      const parts = woken.map((w) =>
        `${String(w.label).split('-')[0]} <- ${w.from || '?'}${w.intent ? ` [${w.intent}]` : ''}`);
      const msg = woken.length === 1
        ? `📨 ${parts[0]} got a message`
        : `📨 ${woken.length} sessions got messages: ${parts.join(',  ')}`;
      vscode.window.showInformationMessage(msg);
    }
  } catch (e) {
    log(`tick error: ${e.message}`);
  } finally {
    draining = false;
  }
}

function updateBar(connected) {
  if (!statusBar) return;
  const on = cfg().get('enabled', true);
  statusBar.text = on ? `$(broadcast) cc-bus: ${connected}` : `$(circle-slash) cc-bus: off`;
  statusBar.tooltip = on
    ? `cc-bus waker active — ${connected} Claude terminal(s) in this window connected to the bus. Click to disable.`
    : 'cc-bus waker disabled. Click to enable.';
}

function activate(context) {
  out = vscode.window.createOutputChannel('cc-bus waker');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.command = 'ccBusWaker.toggle';
  statusBar.show();
  updateBar(0);

  context.subscriptions.push(
    out, statusBar,
    vscode.commands.registerCommand('ccBusWaker.toggle', async () => {
      const c = cfg();
      const next = !c.get('enabled', true);
      await c.update('enabled', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`cc-bus waker: ${next ? 'enabled' : 'disabled'}`);
      updateBar(0);
    }),
    vscode.commands.registerCommand('ccBusWaker.status', () => out.show())
  );

  const schedule = () => {
    if (timer) clearInterval(timer);
    const ms = Math.max(800, cfg().get('pollMs', 2500));
    timer = setInterval(tick, ms);
  };
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });
  vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('ccBusWaker')) schedule(); }, null, context.subscriptions);
  schedule();
  tick();
  log('cc-bus waker started.');
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
