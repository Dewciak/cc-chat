#!/usr/bin/env node
'use strict';
// Records the session's live state into the registry so integrations (the cc-bus VS Code
// waker) can show it. Wired by setup.js to:
//   UserPromptSubmit -> working   Stop -> done   Notification -> waiting
// usage (hook command):  node cc-msg-state.js <working|done|waiting>
const path = require('path');
let bus;
try { bus = require(path.join(__dirname, '..', 'lib.js')); } catch { process.exit(0); }

const input = bus.readStdinJson();
const sid = input && input.session_id;
const arg = (process.argv[2] || '').trim();   // working | done | waiting
if (!sid || !arg) process.exit(0);
try {
  const e = bus.readEntry(bus.regFile(sid));
  if (!e) process.exit(0);
  // "waiting" (Notification) fires BOTH for a real mid-turn pause (permission / question =
  // decision) AND after a normal turn end (idle nudge). Only the mid-turn one is a decision:
  // it happens BEFORE Stop. Gate it on `turnEnded` — set by Stop, cleared by UserPromptSubmit.
  if (arg === 'working') { e.state = 'working'; e.turnEnded = false; }
  else if (arg === 'done') { e.state = 'done'; e.turnEnded = true; }
  else if (arg === 'waiting') { if (e.turnEnded) process.exit(0); e.state = 'waiting'; }
  else { e.state = arg; }
  e.stateTs = bus.now();
  bus.saveEntry(e);
} catch {}
process.exit(0);
