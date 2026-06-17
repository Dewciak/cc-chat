#!/usr/bin/env node
'use strict';
// SessionStart hook: register this session, watch its inbox, inject the coordination
// protocol, and deliver any messages that arrived while it was away.
const path = require('path');
const fs = require('fs');
const bus = require(path.join(__dirname, '..', 'lib.js'));

const input = bus.readStdinJson();
const sid = input.session_id;
if (!sid) { process.exit(0); }

const cwd = input.cwd || process.cwd();
bus.ensure();

// Dynamic name = "<id>-<role>-<activity>". id is stable (addressing); role is b/f;
// activity tracks the current focus (updated by `cc-msg status`). On resume we keep
// the prior role/activity so the name is stable across restarts.
const prior = bus.readEntry(bus.regFile(sid)) || bus.listArchive().find((e) => e.sessionId === sid);
const ccTab = process.env.CC_TAB && process.env.CC_TAB.trim();
const entry = {
  sessionId: sid, cwd,
  id: bus.shortId(sid),
  role: bus.roleFor(cwd, ccTab) || (prior && prior.role) || '',
  activity: bus.slugActivity(ccTab || (prior && prior.activity) || bus.defaultBase(cwd)),
};
entry.label = bus.composeLabel(entry);
const label = entry.label;
bus.saveEntry(entry);
try { fs.closeSync(fs.openSync(bus.inboxFile(sid), 'a')); } catch {}

// Deliver anything queued while this session was gone (e.g. messages sent while closed,
// then resumed). drainInbox advances the cursor past them.
const pending = bus.drainInbox(sid);

// Make identity available to the shell so `cc-msg` knows the sender even before rename.
if (process.env.CLAUDE_ENV_FILE) {
  try {
    fs.appendFileSync(process.env.CLAUDE_ENV_FILE,
      `export CC_TAB=${JSON.stringify(label)}\nexport CC_SELF_SESSION=${JSON.stringify(sid)}\n`);
  } catch {}
}

const others = bus.listTabs().filter((t) => t.sessionId !== sid);
const otherList = others.length
  ? others.map((t) => `  - "${t.label}" -> ${t.cwd}${t.status ? `  | currently: ${t.status}` : ''}`).join('\n')
  : '  (none yet — peers register as they start)';

let ctx =
  `CROSS-SESSION COORDINATION (ClaudeChat) is active. You are session "${label}" working in ${cwd}.\n` +
  `Other live sessions (name -> project, current focus):\n${otherList}\n` +
  `\n` +
  `Your name is "<id>-<role>-<activity>" (e.g. "${label}"). The id is fixed — peers address\n` +
  `you by it. The activity = your MAIN / thematic task. Set it with cc-msg name, and change it\n` +
  `ONLY when the main task changes — NOT for sub-steps ("change this section, then that"):\n` +
  `  general front -> cc-msg name "fe-general"    admin front -> cc-msg name "fe-admin"\n` +
  `  a feature     -> cc-msg name "fe-<feature>"  backend API -> cc-msg name "be-orders"\n` +
  `Use cc-msg status "<one-line>" for granular progress — it shows on the board but does NOT rename you.\n` +
  `\n` +
  `DON'T PANIC over breakage that isn't yours. Before you stop / "fix" a build/type/test\n` +
  `failure, run: cc-msg who. If a peer is MID-CHANGE in the failing area, it's likely\n` +
  `transient and THEIRS — don't stop, don't edit their files, don't undo your work.\n` +
  `Before changes that may transiently break shared build/types/tests: cc-msg busy "..." (then cc-msg ready).\n` +
  `\n` +
  `Coordinate via Bash:\n` +
  `  cc-msg fix <tab> "problem + where"  cc-msg ask <tab> "question"  cc-msg sync <tab> "I changed X; adapt Y"\n` +
  `  cc-msg send <tab> "info"            cc-msg done <tab> "what you did"   cc-msg who / list / history\n` +
  `If you find a bug in a PEER's project, don't fix it yourself — cc-msg fix the owner (precise).\n` +
  `\n` +
  `Incoming messages arrive automatically as system reminders:\n` +
  `  FIX about your project -> fix it, then cc-msg done. (auth/payments/migrations: propose via cc-msg ask, wait.)\n` +
  `  SYNC -> adapt your side, then cc-msg done.   ASK -> answer.   INFO/DONE -> absorb, do NOT reply (loop guard).`;

if (pending.length) {
  const lines = pending.map((m) => {
    const when = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
    return `  • [${(m.intent || 'info').toUpperCase()}] from "${m.from || 'unknown'}"${when ? ` at ${when}` : ''}: ${m.text}`;
  });
  ctx += `\n\n[${pending.length}] message(s) arrived while you were away — act on them per the rules above:\n` + lines.join('\n');
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx, watchPaths: [bus.inboxFile(sid)] },
}));
process.exit(0);
