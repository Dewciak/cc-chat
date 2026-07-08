# cc-chat integrations

The core (`cc-msg`, hooks, `lib.js`) is deliberately terminal-agnostic. These optional
integrations add a visual dashboard and terminal-emulator wake/spawn on top of the same bus
(`~/.cc-chat/bus/`). They read the bus directly — no changes to the core are required to run
them, and skipping them costs you nothing but the extra convenience.

## `cc-bus` — live dashboard

A colored, live view of the whole bus: a legend of live sessions on top, then the message
stream as a chat. `setup.js` links it onto your PATH, so just run:

```
cc-bus
```

Flags: `-n <N>` (history depth), `--no-follow`, `--no-ambient` (hide status/busy/ready),
`--only fix,ask`, `--plain`.

Interactive keys (live TTY):

- `s` — ask everyone for a status update
- `m` — compose a message to everyone
- `t` — switch the send target (all projects ↔ one project; default = the project you launched it in)
- `q` — quit

Messages you send from the dashboard go out **as `operator`** (the human at the console).
Sessions reply with `cc-msg send operator "..."`, which appears live in the stream. `operator`
is a virtual, log-only target — there's no session to wake, it just shows on the dashboard.

## `vscode-cc-bus-waker` — VS Code extension

Solves the core's "idle sessions wake only on next interaction" limitation **inside VS Code**,
and adds tab spawning. An extension may write to a terminal (`Terminal.sendText`) — an external
process can't — which is what makes this possible.

What it does, per VS Code window:

1. **Wake idle terminals.** When a session in this window has unread bus mail and is idle
   (its transcript hasn't changed for `idleSeconds`), it sends a short line so Claude takes a
   turn and the `UserPromptSubmit` hook delivers the message. It skips busy/mid-generation
   sessions and the terminal you're currently typing in. A short toast tells you which session
   got mail (no message body).
2. **Spawn tabs.** `cc-msg spawn [--cwd <dir>] [--resume <sid>] [prompt…]` drops a request into
   `~/.cc-chat/bus/spawn/`; the extension opens a new terminal running `claude` (or
   `claude --resume`), and once the new session registers, types the initial prompt.
3. **Name the tabs.** It renames each terminal tab to its session's bus label (e.g.
   `b9b1-zoom-migration`), so the VS Code terminal list mirrors the bus. This overrides Claude
   Code's own OSC task-title. `Terminal.name` is read-only, so it uses the `renameWithArg`
   command on the active terminal — a background terminal is briefly focused to rename it (a
   short flicker), throttled and capped per poll; the active terminal is renamed in place with
   no flicker. Toggle with `ccBusWaker.renameTerminals`; force a full resync with the command
   *cc-bus Waker: sync terminal names*. With `ccBusWaker.showState` (default on) it also appends
   the session state — `· working` / `· done` / `· afk` — derived from transcript activity, so
   the tab list doubles as a live status view. With `ccBusWaker.stateIcons` it also sets a tab
   icon per state (`play` / `check` / `circle-slash`) — but only if your VS Code exposes a
   `changeIcon`-with-argument command; the extension detects this at startup and logs whether
   it's using it (check the *cc-bus waker* output channel).

Sessions are matched to terminals by process tree: the registry stores each session's `pid`
(the claude process), whose parent is the terminal's shell — compared against
`Terminal.processId`.

### Install

`setup.js` symlinks it into `~/.vscode/extensions/cc-bus-waker` automatically when that folder
exists. Then run **Developer: Reload Window**. To install by hand:

```
ln -s "$PWD/vscode-cc-bus-waker" ~/.vscode/extensions/cc-bus-waker
```

Settings live under `ccBusWaker.*` (enabled / idleSeconds / pollMs / nudgeText /
skipActiveTerminal / notify). The status-bar item `cc-bus: N` shows how many Claude terminals
in the window are connected; click it to toggle.

### Caveat

Only the focused terminal is protected from a nudge. A background terminal with half-typed,
unsubmitted text could get it submitted together with the nudge — VS Code exposes no way to
read a terminal's input buffer, so copy-and-restore isn't possible.
