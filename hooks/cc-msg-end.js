#!/usr/bin/env node
'use strict';
// SessionEnd hook: remove the LIVE registry entry on clean exit. Inbox + archive are
// kept so the session can still be revived later (cc-msg revive).
const path = require('path');
const bus = require(path.join(__dirname, '..', 'lib.js'));

const input = bus.readStdinJson();
if (input.session_id) bus.removeEntry(input.session_id);
process.exit(0);
