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
const state = (process.argv[2] || '').trim();
if (!sid || !state) process.exit(0);
try {
  const e = bus.readEntry(bus.regFile(sid));
  if (e) { e.state = state; e.stateTs = bus.now(); bus.saveEntry(e); }
} catch {}
process.exit(0);
