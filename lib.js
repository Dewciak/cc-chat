'use strict';
// Cross-tab message bus for Claude Code — shared helpers.
// Storage layout under ~/.claude/msgbus/:
//   registry/<sessionId>.json   one entry per live tab  { sessionId, label, cwd, pid, ts }
//   inbox/<sessionId>.jsonl     append-only messages for that tab
//   inbox/<sessionId>.cursor    number of inbox lines already delivered to that tab

const fs = require('fs');
const os = require('os');
const path = require('path');

const BUS = path.join(os.homedir(), '.claude', 'msgbus');
const REG = path.join(BUS, 'registry');
const INBOX = path.join(BUS, 'inbox');
const SEEN = path.join(BUS, 'board-seen'); // per-tab signature of the last board it was shown
const SESSIONS = path.join(BUS, 'sessions'); // persistent archive of every session ever seen (for resume)
const REVIVING = path.join(BUS, 'reviving'); // dedup markers: a resurrection is in flight

// Claude Code's own auto-generated session title (the "ai-title" transcript entry) — the
// name shown natively on the terminal tab. Used to answer "which tab is <id>?".
function aiTitle(cwd, sid) {
  try {
    const tp = path.join(os.homedir(), '.claude', 'projects', String(cwd || '').replace(/\//g, '-'), `${sid}.jsonl`);
    let title = null;
    for (const l of fs.readFileSync(tp, 'utf8').split('\n')) {
      if (!l.includes('ai-title')) continue;
      try { const j = JSON.parse(l); if (j.type === 'ai-title' && j.aiTitle) title = j.aiTitle; } catch {}
    }
    return title;
  } catch { return null; }
}

const STALE_MS = 24 * 60 * 60 * 1000; // drop registry entries not refreshed in 24h
const ARCHIVE_STALE_MS = 7 * 24 * 60 * 60 * 1000; // forget archived sessions after 7 days

function ensure() {
  for (const d of [BUS, REG, INBOX, SEEN, SESSIONS, REVIVING]) fs.mkdirSync(d, { recursive: true });
}

function now() {
  return Date.now();
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function regFile(sid) {
  return path.join(REG, `${sid}.json`);
}
function inboxFile(sid) {
  return path.join(INBOX, `${sid}.jsonl`);
}
function cursorFile(sid) {
  return path.join(INBOX, `${sid}.cursor`);
}

// Default tab name from a working directory: the git repo name, else the dir name,
// else "tab" when it's a bare home dir (which carries no useful info).
function defaultBase(cwd) {
  let root = null;
  try {
    const { execFileSync } = require('child_process');
    root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim() || null;
  } catch {}
  let base = path.basename(root || cwd || 'tab');
  if (!root && (cwd === os.homedir() || base === path.basename(os.homedir()))) base = 'tab';
  return base || 'tab';
}

function readEntry(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Returns live entries, pruning stale ones from disk as a side effect.
function listTabs() {
  ensure();
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(REG).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    const full = path.join(REG, f);
    const e = readEntry(full);
    if (!e || !e.sessionId) {
      try { fs.unlinkSync(full); } catch {}
      continue;
    }
    // Liveness is by freshness only. Process-pid checks are unreliable here: the
    // SessionStart hook's parent is a transient shell that dies right after, so a
    // pid check would prune live tabs. Clean exits are removed by the SessionEnd
    // hook; crashes linger until they go stale. Active tabs refresh ts (heartbeat).
    const stale = now() - (e.ts || 0) > STALE_MS;
    if (stale) {
      try { fs.unlinkSync(full); } catch {}
      continue;
    }
    out.push(e);
  }
  return out;
}

function saveEntry(entry) {
  ensure();
  entry.ts = now();
  fs.writeFileSync(regFile(entry.sessionId), JSON.stringify(entry, null, 2));
  // Mirror into the persistent archive so a closed tab can still be resumed by id.
  try {
    fs.writeFileSync(
      path.join(SESSIONS, `${entry.sessionId}.json`),
      // include identity (id/role/activity/pinned) so a self-heal can restore the SAME name
      // instead of resetting to a default and losing a pinned name.
      JSON.stringify({ sessionId: entry.sessionId, label: entry.label, cwd: entry.cwd, lastSeen: now(),
        id: entry.id, role: entry.role, activity: entry.activity, pinned: entry.pinned, agent: entry.agent })
    );
  } catch {}
}

// All archived sessions (pruned past ARCHIVE_STALE_MS), most-recent first.
function listArchive() {
  ensure();
  const out = [];
  let files = [];
  try { files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const full = path.join(SESSIONS, f);
    const e = readEntry(full);
    if (!e || !e.sessionId) { try { fs.unlinkSync(full); } catch {}; continue; }
    if (now() - (e.lastSeen || 0) > ARCHIVE_STALE_MS) { try { fs.unlinkSync(full); } catch {}; continue; }
    out.push(e);
  }
  return out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

// A session is resumable only if Claude still has its transcript on disk.
// Transcript path: ~/.claude/projects/<cwd with / -> ->/<sid>.jsonl
function transcriptPath(cwd, sid) {
  return path.join(os.homedir(), '.claude', 'projects', String(cwd || '').replace(/\//g, '-'), `${sid}.jsonl`);
}
function isResumable(cwd, sid) {
  try { return fs.existsSync(transcriptPath(cwd, sid)); } catch { return false; }
}

// Resolve a name to DEAD sessions: archived, not currently live, AND resumable
// (transcript still on disk). Most-recent first.
function resolveDead(name, excludeSid) {
  if (!name) return [];
  const liveIds = new Set(listTabs().map((t) => t.sessionId));
  const dead = listArchive().filter((e) =>
    e.sessionId !== excludeSid && !liveIds.has(e.sessionId) && isResumable(e.cwd, e.sessionId));
  const n = String(name).toLowerCase();
  let m = dead.filter((e) => (e.label || '').toLowerCase() === n);
  if (!m.length) m = dead.filter((e) => (e.label || '').toLowerCase().includes(n));
  if (!m.length) m = dead.filter((e) => e.sessionId.startsWith(name));
  return m;
}

function recentlyRevived(sid, windowMs) {
  try {
    const t = parseInt(fs.readFileSync(path.join(REVIVING, sid), 'utf8'), 10) || 0;
    return now() - t < (windowMs || 60000);
  } catch { return false; }
}

function markReviving(sid) {
  ensure();
  try { fs.writeFileSync(path.join(REVIVING, sid), String(now())); } catch {}
}

function labelOf(sid) {
  const e = readEntry(regFile(sid));
  return e ? e.label : null;
}

// Return `base`, or base-2 / base-3 ... if another live tab already uses it.
function uniqueLabel(base, excludeSid) {
  const taken = new Set(
    listTabs().filter((t) => t.sessionId !== excludeSid).map((t) => (t.label || '').toLowerCase())
  );
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`.toLowerCase())) i++;
  return `${base}-${i}`;
}

// Rename a tab; returns the actual (collision-resolved) label, or null if not registered.
function setLabel(sid, label) {
  const e = readEntry(regFile(sid));
  if (!e) return null;
  const final = uniqueLabel(label, sid);
  e.label = final;
  saveEntry(e);
  return final;
}

function touch(sid) {
  const e = readEntry(regFile(sid));
  if (e) saveEntry(e);
}

function removeEntry(sid) {
  for (const f of [regFile(sid), inboxFile(sid), cursorFile(sid), seenFile(sid)]) {
    try { fs.unlinkSync(f); } catch {}
  }
}

function seenFile(sid) {
  return path.join(SEEN, `${sid}.sig`);
}

// Set this tab's "what I'm working on" status (also acts as a heartbeat).
// unstable=true means "mid-change, shared build/types/tests may be transiently broken".
function setStatus(sid, text, unstable, noRename) {
  const e = readEntry(regFile(sid));
  if (!e) return false;
  e.status = text;
  e.unstable = !!unstable;
  e.statusTs = now();
  // Name auto-follows the status so same-repo tabs differ by what they DO —
  // unless pinned (`cc-msg name`) or this is a flag update (busy/ready -> noRename).
  if (!noRename && !e.pinned && e.id) {
    const a = slugActivity(text);
    if (a && a !== 'idle') { e.activity = a; e.label = composeLabel(e); }
  }
  saveEntry(e);
  return true;
}

// Project key for a working dir: the nearest ancestor containing a `.git` (repo
// root), so a backend in /repo/api and a frontend in /repo/web map to the same
// project. Falls back to the resolved cwd if no .git is found. Used to keep
// broadcasts ("all") from waking Claude tabs in UNRELATED projects.
const _projCache = new Map();
function projectKey(cwd) {
  const start = path.resolve(cwd || '.');
  if (_projCache.has(start)) return _projCache.get(start);
  let dir = start;
  for (let i = 0; i < 20 && dir && dir !== path.dirname(dir); i++) {
    try { if (fs.existsSync(path.join(dir, '.git'))) { _projCache.set(start, dir); return dir; } } catch {}
    dir = path.dirname(dir);
  }
  _projCache.set(start, start);
  return start;
}

// Resolve a target name to a list of live registry entries.
// "all" / "@all" / "*" -> every tab IN THE SENDER'S PROJECT (excl. excludeSid).
// "everyone" / "global" / "all-projects" -> truly every live tab (cross-project).
// otherwise: exact label match (case-insensitive), else substring match,
// else match by sessionId prefix (these may cross projects — addressing a
// specific tab by id is always allowed).
function resolveTargets(name, excludeSid) {
  const tabs = listTabs().filter((t) => t.sessionId !== excludeSid);
  if (!name) return [];
  const n = String(name).toLowerCase();
  if (n === 'everyone' || n === 'global' || n === 'all-projects' || n === '*global' || n === 'all!') return tabs;
  // "proj:<name>" / "project:<name>" -> every tab whose project (git-root basename)
  // matches <name> (exact or substring, case-insensitive). Lets the cc-bus operator
  // broadcast to ONE project without waking the others.
  if (n.startsWith('proj:') || n.startsWith('project:')) {
    const key = n.replace(/^proj(ect)?:/, '').trim();
    if (!key) return [];
    return tabs.filter((t) => {
      const b = path.basename(projectKey(t.cwd || '')).toLowerCase();
      return b === key || b.includes(key);
    });
  }
  if (n === 'all' || n === '@all' || n === '*') {
    const self = excludeSid ? readEntry(regFile(excludeSid)) : null;
    if (self && self.cwd) {
      const pk = projectKey(self.cwd);
      return tabs.filter((t) => projectKey(t.cwd) === pk);
    }
    return tabs; // sender unknown -> don't silently drop, fall back to all
  }
  let m = tabs.filter((t) => (t.label || '').toLowerCase() === n);
  if (m.length) return m;
  m = tabs.filter((t) => (t.label || '').toLowerCase().includes(n));
  if (m.length) return m;
  m = tabs.filter((t) => t.sessionId.startsWith(name));
  return m;
}

function appendMessage(toSid, msg) {
  ensure();
  fs.appendFileSync(inboxFile(toSid), JSON.stringify(msg) + '\n');
}

const LOG = path.join(BUS, 'log.jsonl');

function appendLog(entry) {
  ensure();
  try { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch {}
}

function readLog(limit) {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.abs(limit || 20)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// Read messages not yet delivered to `sid`; advances cursor.
function drainInbox(sid) {
  const ib = inboxFile(sid);
  let lines = [];
  try {
    lines = fs.readFileSync(ib, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  let cur = 0;
  try { cur = parseInt(fs.readFileSync(cursorFile(sid), 'utf8'), 10) || 0; } catch {}
  if (cur >= lines.length) return [];
  const fresh = lines.slice(cur).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  fs.writeFileSync(cursorFile(sid), String(lines.length));
  return fresh;
}

// ---- Dynamic name: label = "<id>-<role>-<activity>" ----
// id = WezTerm pane (stable, addressable) or short session-id prefix. activity = MAIN
// thematic task (set via applyName / cc-msg name), NOT every micro status update.

// WEZTERM_PANE is only OURS when we actually run under WezTerm. VS Code's integrated
// terminal (and other terminals launched from a WezTerm pane) INHERIT a stale
// WEZTERM_PANE from the parent env — so several unrelated tabs would all claim the
// same pane id. That caused (a) every VS Code tab colliding on the same `id` (1:1
// addressing broke) and (b) `nudgePane` typing into a foreign physical pane while the
// inbox path was skipped (messages silently lost). Trust WEZTERM_PANE only when
// TERM_PROGRAM confirms WezTerm; otherwise treat it as absent.
function wezPane() {
  return process.env.TERM_PROGRAM === 'WezTerm' ? (process.env.WEZTERM_PANE || null) : null;
}
function shortId(sid) {
  return wezPane() || String(sid || '').replace(/-/g, '').slice(0, 4) || 'id';
}
function roleFor(cwd, name) {
  const n = String(name || '').toLowerCase();
  if (/^(be|b|backend|api|server)([-_.]|$)/.test(n)) return 'b';
  if (/^(fe|f|front|frontend|web|client)([-_.]|$)/.test(n)) return 'f';
  const c = String(cwd || '').toLowerCase();
  if (/(front|client|web|frontend|[-/]fe[-/])/.test(c)) return 'f';
  if (/(backend|server|[-/.]api|[-/]be[-/])/.test(c)) return 'b';
  return '';
}
function slugActivity(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/^(done|wip|todo|fix|fixed|robi[eę]|adding|dodaj[eę])\s*[:\-]?\s*/i, '');
  const words = s.split(' ').filter(Boolean).slice(0, 4).join('-');
  let out = words.replace(/[^a-z0-9ąćęłńóśźż-]/gi, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (out.length > 28) out = out.slice(0, 28).replace(/-+$/, '');
  return out || 'idle';
}
function composeLabel(e) {
  return [e.id, e.role, e.activity].filter(Boolean).join('-') || (e.id || 'tab');
}
// Set NAME from the MAIN task (role from prefix/cwd + thematic activity). Recomposes label.
function applyName(sid, text) {
  const e = readEntry(regFile(sid));
  if (!e) return null;
  const r = roleFor(e.cwd, text);
  if (r) e.role = r;
  const rest = String(text).replace(/^(be|b|backend|api|server|fe|f|front|frontend|web|client)[-_.]\s*/i, '');
  e.activity = slugActivity(rest || text);
  if (!e.id) e.id = shortId(sid);
  e.pinned = true;   // explicit name = pin; status no longer auto-changes it
  e.label = composeLabel(e);
  saveEntry(e);
  return e.label;
}

module.exports = {
  BUS, REG, INBOX,
  ensure, readStdinJson, listTabs, saveEntry, touch, removeEntry,
  resolveTargets, appendMessage, drainInbox, inboxFile, cursorFile, now,
  appendLog, readLog, setStatus, seenFile,
  labelOf, uniqueLabel, setLabel, defaultBase, regFile, readEntry,
  listArchive, resolveDead, recentlyRevived, markReviving, isResumable, transcriptPath,
  shortId, wezPane, roleFor, slugActivity, composeLabel, applyName, projectKey, aiTitle,
};
