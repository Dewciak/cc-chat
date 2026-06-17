'use strict';
// ClaudeChat — shared engine for cross-session messaging between Claude Code instances.
// Pure filesystem, no daemon. Storage under ~/.claude-chat/bus/:
//   registry/<sessionId>.json   one entry per live session  { sessionId, label, cwd, ts, status, unstable, statusTs }
//   inbox/<sessionId>.jsonl     append-only messages for that session
//   inbox/<sessionId>.cursor    number of inbox lines already delivered
//   board-seen/<sessionId>.sig  signature of the last status board shown to that session
//   sessions/<sessionId>.json   persistent archive of every session ever seen (for `revive`)
//   reviving/<sessionId>        dedup marker: a revive is in flight
//   log.jsonl                   full traffic log

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(os.homedir(), '.claude-chat');
const BUS = path.join(ROOT, 'bus');
const REG = path.join(BUS, 'registry');
const INBOX = path.join(BUS, 'inbox');
const SEEN = path.join(BUS, 'board-seen');
const SESSIONS = path.join(BUS, 'sessions');
const REVIVING = path.join(BUS, 'reviving');
const LOG = path.join(BUS, 'log.jsonl');

const STALE_MS = 24 * 60 * 60 * 1000;          // drop live entries not refreshed in 24h
const ARCHIVE_STALE_MS = 7 * 24 * 60 * 60 * 1000; // forget archived sessions after 7 days

function ensure() {
  for (const d of [ROOT, BUS, REG, INBOX, SEEN, SESSIONS, REVIVING]) fs.mkdirSync(d, { recursive: true });
}
function now() { return Date.now(); }

function readStdinJson() {
  try { const raw = fs.readFileSync(0, 'utf8'); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}

function regFile(sid) { return path.join(REG, `${sid}.json`); }
function inboxFile(sid) { return path.join(INBOX, `${sid}.jsonl`); }
function cursorFile(sid) { return path.join(INBOX, `${sid}.cursor`); }
function seenFile(sid) { return path.join(SEEN, `${sid}.sig`); }

function readEntry(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Default session name: git repo name, else dir name, else "tab" for a bare home dir.
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

// Live sessions (prunes stale entries from disk). Liveness = freshness only; clean exits
// are removed by the SessionEnd hook, crashes linger until stale.
function listTabs() {
  ensure();
  const out = [];
  let files = [];
  try { files = fs.readdirSync(REG).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const full = path.join(REG, f);
    const e = readEntry(full);
    if (!e || !e.sessionId) { try { fs.unlinkSync(full); } catch {}; continue; }
    if (now() - (e.ts || 0) > STALE_MS) { try { fs.unlinkSync(full); } catch {}; continue; }
    out.push(e);
  }
  return out;
}

function saveEntry(entry) {
  ensure();
  entry.ts = now();
  fs.writeFileSync(regFile(entry.sessionId), JSON.stringify(entry, null, 2));
  // Mirror to the persistent archive so a closed session can still be revived by id.
  try {
    fs.writeFileSync(path.join(SESSIONS, `${entry.sessionId}.json`),
      JSON.stringify({ sessionId: entry.sessionId, label: entry.label, cwd: entry.cwd, lastSeen: now() }));
  } catch {}
}

function touch(sid) { const e = readEntry(regFile(sid)); if (e) saveEntry(e); }

function removeEntry(sid) {
  // Removes only the LIVE entry — keeps inbox + archive (for revive).
  try { fs.unlinkSync(regFile(sid)); } catch {}
}

function labelOf(sid) { const e = readEntry(regFile(sid)); return e ? e.label : null; }

function uniqueLabel(base, excludeSid) {
  const taken = new Set(listTabs().filter((t) => t.sessionId !== excludeSid).map((t) => (t.label || '').toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`.toLowerCase())) i++;
  return `${base}-${i}`;
}

function setLabel(sid, label) {
  const e = readEntry(regFile(sid));
  if (!e) return null;
  const final = uniqueLabel(label, sid);
  e.label = final;
  saveEntry(e);
  return final;
}

// unstable=true => "mid-change, shared build/types/tests may be transiently broken".
function setStatus(sid, text, unstable) {
  const e = readEntry(regFile(sid));
  if (!e) return false;
  e.status = text;
  e.unstable = !!unstable;
  e.statusTs = now();
  saveEntry(e);
  return true;
}

// Resolve a name to LIVE sessions. "all"/"*" => everyone except excludeSid;
// else exact label, then substring, then sessionId prefix.
function resolveTargets(name, excludeSid) {
  const tabs = listTabs().filter((t) => t.sessionId !== excludeSid);
  if (!name) return [];
  const n = String(name).toLowerCase();
  if (n === 'all' || n === '@all' || n === '*') return tabs;
  let m = tabs.filter((t) => (t.label || '').toLowerCase() === n);
  if (m.length) return m;
  m = tabs.filter((t) => (t.label || '').toLowerCase().includes(n));
  if (m.length) return m;
  return tabs.filter((t) => t.sessionId.startsWith(name));
}

function appendMessage(toSid, msg) { ensure(); fs.appendFileSync(inboxFile(toSid), JSON.stringify(msg) + '\n'); }

// Read messages not yet delivered to `sid`; advances the cursor.
function drainInbox(sid) {
  let lines = [];
  try { lines = fs.readFileSync(inboxFile(sid), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  let cur = 0;
  try { cur = parseInt(fs.readFileSync(cursorFile(sid), 'utf8'), 10) || 0; } catch {}
  if (cur >= lines.length) return [];
  const fresh = lines.slice(cur).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  fs.writeFileSync(cursorFile(sid), String(lines.length));
  return fresh;
}

function appendLog(entry) { ensure(); try { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch {} }
function readLog(limit) {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.abs(limit || 20)).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ---- Archive / revive support ----
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
function transcriptPath(cwd, sid) {
  return path.join(os.homedir(), '.claude', 'projects', String(cwd || '').replace(/\//g, '-'), `${sid}.jsonl`);
}
function isResumable(cwd, sid) { try { return fs.existsSync(transcriptPath(cwd, sid)); } catch { return false; } }

// Resolve a name to DEAD sessions (archived, not live, still resumable). Most-recent first.
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
  try { const t = parseInt(fs.readFileSync(path.join(REVIVING, sid), 'utf8'), 10) || 0; return now() - t < (windowMs || 60000); }
  catch { return false; }
}
function markReviving(sid) { ensure(); try { fs.writeFileSync(path.join(REVIVING, sid), String(now())); } catch {} }

module.exports = {
  ROOT, BUS, REG, INBOX, SESSIONS, REVIVING,
  ensure, now, readStdinJson, regFile, inboxFile, cursorFile, seenFile, readEntry,
  defaultBase, listTabs, saveEntry, touch, removeEntry, labelOf, uniqueLabel, setLabel,
  setStatus, resolveTargets, appendMessage, drainInbox, appendLog, readLog,
  listArchive, resolveDead, recentlyRevived, markReviving,
};
