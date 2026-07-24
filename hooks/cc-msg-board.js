#!/usr/bin/env node
'use strict';
// UserPromptSubmit hook: inject the peer status board into this tab — but only when it
// changed since this tab last saw it, so identical boards aren't re-injected every turn.
const fs = require('fs');
const path = require('path');
const bus = require(path.join(process.env.HOME, '.claude', 'msgbus', 'lib.js'));

// Agent kind (claude | codex) — passed as argv[2] by the Codex hook; only used as a
// fallback when self-healing a registry entry that vanished (so a Codex tab isn't
// relabelled as claude). Normal turns just refresh the existing entry untouched.
const AGENT = (process.argv[2] || 'claude').toLowerCase();
const input = bus.readStdinJson();
const sid = input.session_id;
if (!sid) { process.exit(0); }

// Self-heal + heartbeat: if this tab's registry entry is gone (e.g. it went stale),
// re-register it; otherwise refresh ts so an active tab never goes stale.
const existing = bus.readEntry(bus.regFile(sid));
if (!existing) {
  const cwd = input.cwd || process.env.HOME;
  // Restore prior identity from the archive so a transient drop doesn't reset the name or
  // lose a pinned name (which would let the next cc-msg status rename the tab).
  const prior = bus.listArchive().find((a) => a.sessionId === sid);
  const e = { sessionId: sid, cwd, pid: process.ppid, pane: process.env.WEZTERM_PANE || null,
    id: (prior && prior.id) || bus.shortId(sid),
    role: (prior && prior.role) || bus.roleFor(cwd),
    activity: (prior && prior.activity) || bus.slugActivity(bus.defaultBase(cwd)),
    pinned: !!(prior && prior.pinned),
    agent: (prior && prior.agent) || AGENT };
  e.label = (prior && prior.label) || bus.composeLabel(e);
  bus.saveEntry(e);
} else {
  // Refresh pid every turn to the CURRENT live claude process (not just when missing): a
  // SPAWNED tab's start-time pid can die when claude re-execs, leaving a stale-but-present
  // pid that terminal integrations can't resolve -> the tab stays stuck as "claude +".
  // Keeping it current lets the VS Code extension match the session to its terminal + rename.
  if (existing.pid !== process.ppid) { existing.pid = process.ppid; bus.saveEntry(existing); }
  else bus.touch(sid);
}

// Deliver any inbox messages addressed to this tab. This is the RELIABLE delivery
// path: the FileChanged/asyncRewake wake doesn't fire for a fully idle session, so we
// also drain the inbox here on every prompt the user submits. drainInbox advances the
// cursor, so each message is injected exactly once no matter which hook drains it.
const GUIDE = {
  fix: 'ACTION REQUIRED — investigate in your project and fix it now, then: cc-msg done <from> "what you fixed". For auth/payments/migrations/core logic, propose via cc-msg ask <from> and wait.',
  sync: 'CROSS-SIDE CHANGE — adapt your side to the peer\'s change now, then cc-msg done <from>. If unclear, cc-msg ask <from>.',
  ask: 'A reply is expected — answer with cc-msg send <from> "answer" (or cc-msg done <from> if resolved).',
  info: 'FYI only — no reply needed unless it actually requires action on your side.',
  done: 'Completion report — no reply needed. Do NOT acknowledge (prevents ping-pong loops).',
};
// Drain the inbox so the cursor advances (model awareness + exactly-once). The user-facing
// card below is built from the LOG, not from this — so the watcher's separate marker and
// this cursor never starve each other.
let msgBlock = '';     // for the model (additionalContext)
let cardForUser = '';  // for the user (systemMessage — shown gray in the UI)
const drained = bus.drainInbox(sid);
const esc = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/').trim();
const myLabel = (bus.labelOf(sid) || '').trim();
// Find the NEWEST message addressed to this tab, plus the reply this tab sent to that
// sender afterwards (if any). Show it as a card: [Od | Do] / [pełna Treść] / [pełna Odpowiedź].
let log = [];
try { log = bus.readLog(160).filter((r) => r && r.intent && !['status', 'busy', 'ready'].includes(r.intent)); } catch {}
const incoming = [...log].reverse().find((r) => (r.to || []).includes(myLabel) && r.from !== myLabel);
if (incoming) {
  const reply = [...log].reverse().find((r) =>
    r.from === myLabel && (r.to || []).includes(incoming.from) && (r.ts || 0) >= (incoming.ts || 0));
  const sig = `${incoming.ts || ''}|${reply ? reply.ts : 0}`;
  const msgSeen = bus.seenFile(sid).replace(/\.sig$/, '.msgsig');
  let prevSig = '';
  try { prevSig = fs.readFileSync(msgSeen, 'utf8'); } catch {}
  if (sig !== prevSig || drained.length) {
    bus.ensure();
    try { fs.writeFileSync(msgSeen, sig); } catch {}
    const sep = '─'.repeat(56);
    cardForUser =
      `cc-msg — najnowsza wiadomość\n${sep}\n` +
      `Od kogo:   ${esc(incoming.from)}${incoming.fromAgent === 'codex' ? ' [CODEX]' : ''}\n` +
      `Do kogo:   ${esc((incoming.to || []).join(', '))}\n` +
      `Typ:       ${(incoming.intent || 'info').toUpperCase()}\n${sep}\n` +
      `TREŚĆ:\n${esc(incoming.text)}\n${sep}\n` +
      `ODPOWIEDŹ:\n${reply ? esc(reply.text) : '(jeszcze nie odpowiedziano)'}\n${sep}`;
    msgBlock = cardForUser + `\n\n${(incoming.intent || 'info').toUpperCase()}: ${GUIDE[incoming.intent] || GUIDE.info}\n\n`;
  }
}

// Show only SAME-PROJECT peers: a tab cares about peers sharing its repo (shared
// build/types/tests, the don't-panic case). This stops status churn in UNRELATED
// projects from re-injecting the board on every prompt. Messages addressed to this
// tab (the card above) stay global. Project key = nearest .git ancestor.
const selfEntry = bus.readEntry(bus.regFile(sid));
const selfProj = selfEntry ? bus.projectKey(selfEntry.cwd || '') : null;
const peers = bus.listTabs().filter((t) =>
  t.sessionId !== sid && (!selfProj || bus.projectKey(t.cwd || '') === selfProj));
// Signature excludes volatile fields (statusTs/age) — re-inject only when a peer's
// label, status TEXT, or mid-change flag actually changes, not on heartbeats.
const sig = JSON.stringify(
  peers.map((p) => ({ l: p.label, s: p.status || '', u: !!p.unstable }))
       .sort((a, b) => (a.l < b.l ? -1 : 1))
);

let prev = '';
try { prev = fs.readFileSync(bus.seenFile(sid), 'utf8'); } catch {}
const boardChanged = sig !== prev;
if (boardChanged) {
  bus.ensure();
  try { fs.writeFileSync(bus.seenFile(sid), sig); } catch {}
}

// Nothing fresh to say: board unchanged AND no pending messages.
if (!boardChanged && !msgBlock) { process.exit(0); }

// Messages but no (changed) board to show -> deliver just the messages.
if (!peers.length || !boardChanged) {
  if (msgBlock) {
    process.stdout.write(JSON.stringify({
      systemMessage: cardForUser,
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msgBlock.trimEnd() },
    }));
  }
  process.exit(0);
}

const lines = peers.map((p) => {
  const age = p.statusTs ? ` [${Math.round((bus.now() - p.statusTs) / 1000)}s ago]` : '';
  const flag = p.unstable ? '⚠ MID-CHANGE — ' : '';
  return `  - "${p.label}" (${path.basename(p.cwd)}): ${flag}${p.status || '(no status posted yet)'}${age}`;
});

const anyUnstable = peers.some((p) => p.unstable);
const ctx =
  `Peer status board — what other Claude Code tabs are working on right now:\n` +
  lines.join('\n') +
  (anyUnstable
    ? `\n⚠ A peer is MID-CHANGE. If you hit a build/type/test failure that could stem from their area, do NOT stop or try to fix their files — it is likely transient and theirs. Continue your own work or wait, then re-check with cc-msg who.`
    : ``) +
  `\nUse cc-msg who anytime for the live board. If your own task changed, post it: cc-msg status "<one line>".`;

process.stdout.write(JSON.stringify({
  ...(cardForUser ? { systemMessage: cardForUser } : {}),
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msgBlock + ctx },
}));
process.exit(0);
