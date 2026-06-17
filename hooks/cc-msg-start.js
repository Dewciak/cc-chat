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

// On resume the session keeps its id — reuse its previous name so addressing stays stable.
const prior = bus.readEntry(bus.regFile(sid)) || bus.listArchive().find((e) => e.sessionId === sid);
let label;
if (process.env.CC_TAB && process.env.CC_TAB.trim()) label = bus.uniqueLabel(process.env.CC_TAB.trim(), sid);
else if (prior && prior.label) label = prior.label;
else label = bus.uniqueLabel(bus.defaultBase(cwd), sid);

bus.saveEntry({ sessionId: sid, label, cwd });
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
  `As soon as you understand your task, name yourself + announce it so peers stay aware:\n` +
  `  cc-msg name "<short-handle>"      e.g. "be-orders", "fe-checkout"\n` +
  `  cc-msg status "<one-line focus>"  (update whenever your focus changes)\n` +
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
