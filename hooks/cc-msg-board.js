#!/usr/bin/env node
'use strict';
// UserPromptSubmit hook: inject the peer status board into this session, but only when it
// changed since last shown. Also self-heals (re-registers if the entry went missing) and
// refreshes the heartbeat so an active session never goes stale.
const fs = require('fs');
const path = require('path');
const bus = require(path.join(__dirname, '..', 'lib.js'));

const input = bus.readStdinJson();
const sid = input.session_id;
if (!sid) { process.exit(0); }

const existing = bus.readEntry(bus.regFile(sid));
if (!existing) {
  const cwd = input.cwd || process.env.HOME;
  // Restore prior identity from the archive so a transient drop doesn't reset the name or
  // lose a pinned name (which would let the next cc-msg status rename the tab).
  const prior = bus.listArchive().find((a) => a.sessionId === sid);
  const e = { sessionId: sid, cwd, pid: process.ppid,
    id: (prior && prior.id) || bus.shortId(sid),
    role: (prior && prior.role) || bus.roleFor(cwd),
    activity: (prior && prior.activity) || bus.slugActivity(bus.defaultBase(cwd)),
    pinned: !!(prior && prior.pinned) };
  e.label = (prior && prior.label) || bus.composeLabel(e);
  bus.saveEntry(e);
} else {
  // Refresh pid every turn to the CURRENT live claude process (not just when missing): a
  // SPAWNED tab's start-time pid can die when claude re-execs, leaving a stale-but-present
  // pid that terminal integrations can't resolve -> the tab stays stuck as "claude +".
  if (existing.pid !== process.ppid) { existing.pid = process.ppid; bus.saveEntry(existing); }
  else bus.touch(sid);
}

// Show only SAME-PROJECT peers: a session cares about peers sharing its repo (shared
// build/types/tests, the don't-panic case). This also stops status churn in UNRELATED
// projects from re-injecting the board on every prompt. Project key = nearest .git ancestor.
const selfEntry = bus.readEntry(bus.regFile(sid));
const selfProj = selfEntry ? bus.projectKey(selfEntry.cwd || '') : null;
const peers = bus.listTabs().filter((t) =>
  t.sessionId !== sid && (!selfProj || bus.projectKey(t.cwd || '') === selfProj));
// Signature excludes volatile fields (statusTs/age): re-inject only when a peer's label,
// status TEXT, or mid-change flag actually changes — not on heartbeats.
const sig = JSON.stringify(peers.map((p) => ({ l: p.label, s: p.status || '', u: !!p.unstable }))
  .sort((a, b) => (a.l < b.l ? -1 : 1)));

let prev = '';
try { prev = fs.readFileSync(bus.seenFile(sid), 'utf8'); } catch {}
if (sig === prev) { process.exit(0); }
bus.ensure();
try { fs.writeFileSync(bus.seenFile(sid), sig); } catch {}
if (!peers.length) { process.exit(0); }

const lines = peers.map((p) => {
  const age = p.statusTs ? ` [${Math.round((bus.now() - p.statusTs) / 1000)}s ago]` : '';
  const flag = p.unstable ? '! MID-CHANGE — ' : '';
  return `  - "${p.label}" (${path.basename(p.cwd)}): ${flag}${p.status || '(no status yet)'}${age}`;
});
const anyUnstable = peers.some((p) => p.unstable);

const ctx =
  `Peer status board — what other Claude Code sessions are working on:\n` + lines.join('\n') +
  (anyUnstable ? `\n! A peer is MID-CHANGE. If you hit a build/type/test failure from their area, don't stop or edit their files — it's likely transient and theirs.` : ``) +
  `\nUse cc-msg who anytime. If your focus changed, post it: cc-msg status "<one line>".`;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }));
process.exit(0);
