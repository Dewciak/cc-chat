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
  bus.saveEntry({ sessionId: sid, label: bus.uniqueLabel(bus.defaultBase(cwd), sid), cwd });
} else {
  bus.touch(sid);
}

const peers = bus.listTabs().filter((t) => t.sessionId !== sid);
const sig = JSON.stringify(peers.map((p) => ({ l: p.label, s: p.status || '', u: !!p.unstable, t: p.statusTs || 0 }))
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
