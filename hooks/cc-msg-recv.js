#!/usr/bin/env node
'use strict';
// FileChanged hook (asyncRewake): this session's inbox changed -> deliver new messages
// and wake the session. Waking works for an ACTIVE session immediately; a fully-idle
// session receives the message at its next interaction (Claude Code limitation).
const path = require('path');
const bus = require(path.join(__dirname, '..', 'lib.js'));

const input = bus.readStdinJson();
const sid = input.session_id;
if (!sid) { process.exit(0); }

const expected = bus.inboxFile(sid);
if (input.file_path && path.resolve(input.file_path) !== path.resolve(expected)) { process.exit(0); }

const msgs = bus.drainInbox(sid);
if (!msgs.length) { process.exit(0); }
bus.touch(sid);

const GUIDE = {
  fix: 'ACTION REQUIRED — investigate and fix in your project, then cc-msg done <from>. For auth/payments/migrations/core logic, propose via cc-msg ask <from> and wait.',
  sync: 'CROSS-SIDE CHANGE — adapt your side to match (types/contract/calls), then cc-msg done <from>.',
  ask: 'A reply is expected — answer with cc-msg send <from> "answer" (or cc-msg done <from>).',
  info: 'FYI only — no reply needed unless it requires action on your side.',
  done: 'Completion report — do NOT reply (prevents ping-pong loops).',
};

const lines = msgs.map((m) => {
  const when = m.ts ? new Date(m.ts).toLocaleTimeString() : '';
  return `  • [${(m.intent || 'info').toUpperCase()}] from "${m.from || 'unknown'}"${when ? ` at ${when}` : ''}: ${m.text}\n    -> ${GUIDE[m.intent] || GUIDE.info}`;
});

process.stderr.write(
  `${msgs.length === 1 ? 'Incoming coordination message' : `${msgs.length} incoming messages`} from another Claude Code session:\n` +
  lines.join('\n') + `\nReplace <from> with the sender's name. Keep replies specific; never send acknowledgement-only chatter.\n`
);
process.exit(2); // exit 2 => stderr shown to Claude as a system reminder, session woken
