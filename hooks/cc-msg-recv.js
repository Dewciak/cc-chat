#!/usr/bin/env node
'use strict';
// FileChanged hook (asyncRewake): inbox changed -> deliver new messages and wake Claude.
const path = require('path');
const bus = require(path.join(process.env.HOME, '.claude', 'msgbus', 'lib.js'));

const input = bus.readStdinJson();
const sid = input.session_id;
if (!sid) { process.exit(0); }

// Only react to changes of THIS tab's inbox.
const expected = bus.inboxFile(sid);
if (input.file_path && path.resolve(input.file_path) !== path.resolve(expected)) {
  process.exit(0);
}

const msgs = bus.drainInbox(sid);
if (!msgs.length) { process.exit(0); }

bus.touch(sid); // heartbeat

const GUIDE = {
  fix: 'ACTION REQUIRED — investigate this in your project and fix it now. When resolved, run: cc-msg done <from> "what you fixed". For auth/payments/migrations/core business logic, reply with a proposed fix via cc-msg ask <from> and wait for confirmation instead of auto-applying.',
  sync: 'CROSS-SIDE CHANGE — a peer changed something on their side that your project must match (API shape, types, contract, props, data format). Adapt your side accordingly now, then cc-msg done <from>. If the required change is unclear, ask via cc-msg ask <from>.',
  ask: 'A reply is expected — answer with: cc-msg send <from> "answer" (or cc-msg done <from> if it is resolved).',
  info: 'FYI only — no reply needed unless it actually requires action on your side.',
  done: 'Completion report — no reply needed. Do NOT acknowledge (prevents ping-pong loops).',
};

const lines = msgs.map((m) => {
  const when = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
  const intent = (m.intent || 'info').toUpperCase();
  return `  • [${intent}] from "${m.from || 'unknown'}"${when ? ` at ${when}` : ''}: ${m.text}\n    → ${GUIDE[m.intent] || GUIDE.info}`;
});

const header = msgs.length === 1
  ? `📨 Incoming coordination message from another Claude Code tab:`
  : `📨 ${msgs.length} incoming coordination messages from other Claude Code tabs:`;

// stderr + exit 2 => shown to Claude as a system reminder, session is woken.
process.stderr.write(
  `${header}\n${lines.join('\n')}\n` +
  `Replace <from> with the sender's tab name. Keep replies specific; never send acknowledgement-only messages.\n`
);
process.exit(2);
