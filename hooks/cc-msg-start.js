#!/usr/bin/env node
'use strict';
// SessionStart hook: register this tab, watch its inbox, tell the agent how to use the bus.
// Works for both Claude Code and Codex CLI — their SessionStart payloads share the same
// shape (session_id + cwd). Pass the agent kind as argv[2] ("codex"); defaults to "claude".
const path = require('path');
const fs = require('fs');
const bus = require(path.join(process.env.HOME, '.claude', 'msgbus', 'lib.js'));

const AGENT = (process.argv[2] || 'claude').toLowerCase();
const input = bus.readStdinJson();
const sid = input.session_id;
if (!sid) { process.exit(0); }

const cwd = input.cwd || process.cwd();
bus.ensure();

// Dynamic name = "<id>-<role>-<activity>". id = WezTerm pane (stable, addressable).
// activity = MAIN thematic task (updated via `cc-msg name`), NOT micro status updates.
// On resume, keep prior role/activity so the name is stable across restarts.
const prior = bus.readEntry(bus.regFile(sid)) || bus.listArchive().find((e) => e.sessionId === sid);
const ccTab = process.env.CC_TAB && process.env.CC_TAB.trim();
const entry = {
  sessionId: sid, cwd, pid: process.ppid, pane: bus.wezPane(),
  id: bus.shortId(sid),
  role: bus.roleFor(cwd, ccTab) || (prior && prior.role) || '',
  activity: bus.slugActivity(ccTab || (prior && prior.activity) || bus.defaultBase(cwd)),
  pinned: !ccTab && !!(prior && prior.pinned),   // keep a pinned name across resume (unless CC_TAB overrides)
  agent: AGENT,                                   // which CLI owns this tab (claude | codex)
};
entry.label = bus.composeLabel(entry);
const label = entry.label;
// WEZTERM_PANE lets cc-msg wake an idle tab via `wezterm cli send-text`.
bus.saveEntry(entry);
// Tytuł taba WezTerm = nazwa z magistrali (żeby tab pokrywał się z nazwą sesji na czacie,
// zamiast auto-tytułu rozmowy Claude). set-tab-title ma priorytet nad tytułem panelu.
if (bus.wezPane()) {
  try {
    require('child_process').execFileSync('/Applications/WezTerm.app/Contents/MacOS/wezterm',
      ['cli', 'set-tab-title', '--pane-id', bus.wezPane(), label], { stdio: 'ignore' });
  } catch {}
}
// Make sure the inbox file exists (delivery target for peers' messages).
try { fs.closeSync(fs.openSync(bus.inboxFile(sid), 'a')); } catch {}

// Deliver any messages that arrived while this tab was gone (e.g. resumed after a peer
// sent something to it while closed). drainInbox advances the cursor past them.
const pending = bus.drainInbox(sid);

// Persist identity into the session shell env so `cc-msg` knows who is sending.
if (process.env.CLAUDE_ENV_FILE) {
  try {
    fs.appendFileSync(process.env.CLAUDE_ENV_FILE,
      `export CC_TAB=${JSON.stringify(label)}\nexport CC_SELF_SESSION=${JSON.stringify(sid)}\n`);
  } catch {}
}

const others = bus.listTabs().filter((t) => t.sessionId !== sid);
const otherList = others.length
  ? others.map((t) => `  - "${t.label}" → ${t.cwd}${t.status ? `  | currently: ${t.status}` : ''}`).join('\n')
  : '  (none yet — peers register as they start)';

const AGENT_NAME = AGENT === 'codex' ? 'Codex' : 'Claude Code';
const myId = label.split('-')[0];

// Codex: LEAN, PULL-BASED protocol. No UserPromptSubmit hook is installed for Codex (it
// would inject the board every turn and burn tokens), so incoming messages do NOT arrive
// automatically — Codex READS them on demand. It can still SEND freely. This context is
// injected ONCE at session start (not per message), so it stays cheap.
const codexCtx =
  `CROSS-TAB COORDINATION is active (Codex). You are tab "${label}" (id "${myId}") in ${cwd}.\n` +
  `Other live tabs:\n${otherList}\n` +
  `\n` +
  `You can COORDINATE with other agent tabs (Claude Code + Codex) over the shared cc-msg bus.\n` +
  `NAME YOURSELF on your first turn (2-3 words, theme of your work): cc-msg name "<krotki-temat>"\n` +
  `\n` +
  `WRITE (send) freely:\n` +
  `  cc-msg who                     see what every tab is working on\n` +
  `  cc-msg status "..."            publish what YOU are working on\n` +
  `  cc-msg send/ask/fix/done <tab> "..."   message a tab (by id) or "all"\n` +
  `\n` +
  `READ ON DEMAND — messages do NOT arrive automatically for Codex (to save tokens):\n` +
  `  cc-msg inbox                   print messages sent to you since you last checked\n` +
  `  cc-msg who                     the live board\n` +
  `Check cc-msg inbox when you expect a reply or at natural breakpoints. To be actively woken\n` +
  `instead of polling, run \`cc-msg watch\` in the BACKGROUND (it exits when a message lands).\n` +
  `Your outgoing messages are tagged [CODEX] so peers know they came from a Codex tab.`;

const claudeCtx =
  `CROSS-TAB COORDINATION is active (${AGENT_NAME}). You are tab "${label}" working in ${cwd}.\n` +
  `Other live tabs (name → project, current focus):\n${otherList}\n` +
  `\n` +
  `Your id is "${label.split('-')[0]}" (FIXED — peers address you by it, e.g. cc-msg send ${label.split('-')[0]} "...").\n` +
  `NAME YOURSELF as soon as you understand your task — this is REQUIRED, do it on your first turn.\n` +
  `Pick a SHORT, human-readable name: 2-3 words, kebab-case, the THEME of your work — NOT a sentence,\n` +
  `NOT your status. Good: "zoom-migracja", "galeria-wideo", "naglowki-i18n", "bilety-komunikat".\n` +
  `Bad: "faza-2-done-pipeline-ffmpeg" (that's a status, too long). Then:\n` +
  `  cc-msg name "<2-3 words>"\n` +
  `This PINS your name so it stays clean and readable on the board. Re-name ONLY when your main topic\n` +
  `genuinely changes (new task), never on routine progress. Your full label becomes "<id>-<name>".\n` +
  `\n` +
  `IMPORTANT — announce granular progress so peers stay aware (this does NOT rename you):\n` +
  `  cc-msg status "<one-line description of what you're working on right now>"\n` +
  `Update it whenever your focus changes. Peers see this board automatically.\n` +
  `\n` +
  `DON'T PANIC over breakage that isn't yours. Two tabs share the same code/build/types/tests. ` +
  `BEFORE you stop, raise an alarm, or try to "fix" a build error, type error, failing test, or broken dev server, ` +
  `run: cc-msg who. If a peer is MID-CHANGE (or their focus covers the failing area), the breakage is most likely transient and THEIRS — ` +
  `do NOT stop, do NOT edit their files, do NOT undo your own work. Note it, continue your own task or wait, then re-check.\n` +
  `\n` +
  `When you are about to make changes that may transiently break the shared build/types/tests, warn peers first:\n` +
  `  cc-msg busy "refactoring X — build/types may be red for a bit"   (then cc-msg ready when stable again)\n` +
  `\n` +
  `When a change on YOUR side requires the OTHER side to adapt (e.g. you changed a backend API/contract and the frontend must follow):\n` +
  `  cc-msg sync <tab> "I changed <what>; on your side update <what to change>"\n` +
  `\n` +
  `Coordination commands (Bash):\n` +
  `  cc-msg status "..."   publish current focus      cc-msg who            see everyone's focus\n` +
  `  cc-msg busy "..."     warn: mid-change/unstable   cc-msg ready          clear the mid-change flag\n` +
  `  cc-msg sync <tab> ".." cross-side change to adapt  cc-msg fix <tab> ".." report a problem in their project\n` +
  `  cc-msg ask <tab> "..." question (reply expected)   cc-msg done <tab> ".." report a fix complete\n` +
  `  cc-msg send <tab> "..." non-actionable info        cc-msg list / history see tabs / traffic\n` +
  `  cc-msg spawn [--watch] [--codex|--claude] [--resume <sid>] "<prompt>"  open a NEW agent tab (inherits your CLI unless overridden; seeds it with <prompt>)\n` +
  `\n` +
  `TIGHT COORDINATION (you + a peer ping-pong, e.g. you spawned a helper): each of you should keep a\n` +
  `background WATCHER armed so you wake each other's messages promptly instead of going idle. Run\n` +
  `\`cc-msg watch\` as a BACKGROUND Bash task (run_in_background) — Claude Code re-invokes you when it exits\n` +
  `with a message; handle it, then RE-ARM \`cc-msg watch\` in the background again. When you spawn the peer,\n` +
  `pass \`cc-msg spawn --watch "<prompt>"\` — it seeds the peer to arm its own watcher and coordinate with you.\n` +
  `\n` +
  `Broadcast scope: "all" reaches ONLY tabs in YOUR project (same git repo) — it will NOT wake Claude tabs in other projects. To address one specific tab anywhere, use its id (cross-project is allowed). To deliberately broadcast across EVERY project, use "everyone" (rare — avoid it, it interrupts unrelated work).\n` +
  `\n` +
  `When YOU need a change in a PEER's project (match the paths above), SIZE IT before acting — a peer owning a repo does NOT make it off-limits, and delegating or spawning a specialist for a small change is waste. Default to fixing it yourself; delegate only when the change is genuinely heavy.\n` +
  `  • SIMPLE & low-risk (small/obvious edit, copy/style/config tweak, known area, no cross-side contract change) → JUST MAKE IT YOURSELF. First run cc-msg who: if a live peer's focus covers that file/area, coordinate first (or hand it over with cc-msg fix) so you don't clobber active work; otherwise edit it and note it with cc-msg send <tab> so they stay aware.\n` +
  `  • COMPLEX or risky (unfamiliar architecture, wide blast radius, or auth/payments/migrations/core business logic) → do NOT edit blind: delegate via cc-msg fix to a live tab in that repo, or spawn a specialist — precise: symptom, file/area, expected behaviour.\n` +
  `\n` +
  `Incoming messages arrive automatically as system reminders. Rules:\n` +
  `  FIX about your project → investigate and fix, then cc-msg done back. For auth/payments/migrations/core logic, propose via cc-msg ask and wait.\n` +
  `  SYNC → adapt your side to the peer's change, then cc-msg done.\n` +
  `  ASK → answer it.   INFO / DONE → absorb, do NOT reply (prevents endless back-and-forth).\n` +
  `Keep every message concrete and actionable. One DONE per fix. Never send acknowledgement-only chatter.`;

const ctx = AGENT === 'codex' ? codexCtx : claudeCtx;

let pendingBlock = '';
if (pending.length) {
  const lines = pending.map((m) => {
    const when = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
    const tag = m.fromAgent === 'codex' ? ' [CODEX]' : '';
    return `  • [${(m.intent || 'info').toUpperCase()}] from "${m.from || 'unknown'}"${tag}${when ? ` at ${when}` : ''}: ${m.text}`;
  });
  pendingBlock =
    `\n\n📨 ${pending.length} message(s) arrived while this tab was closed — act on them per the rules above:\n` +
    lines.join('\n');
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: ctx + pendingBlock,
  },
}));
process.exit(0);
