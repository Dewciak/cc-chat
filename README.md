# cc-chat

**Let independent [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions talk to each other.**

Run several Claude Code sessions across terminal tabs/windows — each one a long-lived specialist on its own project — and let them coordinate **peer-to-peer**: share what they're working on, hand off cross-cutting changes, warn each other before breaking a shared build, and message a specific session directly. No daemon, no MCP server, no orchestrator. Just **Claude Code hooks + a tiny CLI + plain files**.

> Each session is a normal, persistent `claude` session (keeps its full context). cc-chat is the wire between them — not a spawner. Unlike ephemeral subagents/teams that spin up and die per task, your sessions stay alive and accumulate domain knowledge; cc-chat just lets them coordinate when their work overlaps.

---

## Why

When you run multiple Claude Code sessions on the same machine they're fully isolated — no shared context, no way for one to tell another "I changed the API, update your types" or "don't touch these files, I'm mid-migration". You end up being the message bus, copy-pasting between tabs. cc-chat removes you from that loop.

## How it works

```
   session A                              session B
   ─────────                              ─────────
   cc-msg fix B "..."  ──►  ~/.cc-chat/bus/inbox/<B>.jsonl
                                  │  (file change)
                                  ▼
                          FileChanged hook (asyncRewake, exit 2)
                                  │
                                  ▼
                          session B wakes, gets the message as a
                          system reminder, and acts on it
```

Three Claude Code hooks do the work:

- **SessionStart** — registers the session, starts watching its inbox file (`watchPaths`), and injects a short coordination protocol into the session.
- **FileChanged** (`asyncRewake`) — when the inbox changes, delivers new messages and wakes the session.
- **UserPromptSubmit** — injects a live "who's working on what" status board (only when it changed).
- **SessionEnd** — deregisters the session (inbox + archive are kept so it can be revived later).

Everything is plain files under `~/.cc-chat/bus/`. No background process.

## Install

Requires **Node.js** and **Claude Code**.

```
git clone https://github.com/Dewciak/cc-chat.git
cd cc-chat
node setup.js          # or: ./install.sh
```

The installer links `cc-msg` **and `cc-bus`** onto your PATH (`~/.local/bin`), **merges** the four hooks + a `Bash(cc-msg *)` permission into `~/.claude/settings.json` (idempotent, makes a `.bak` first — it never clobbers your existing config), and — if `~/.vscode/extensions` exists — symlinks the optional [cc-bus VS Code integration](integrations/).

**Restart your Claude Code sessions** afterwards — each one registers on start. Make sure `~/.local/bin` is on your `PATH`.

## Usage

From inside any Claude Code session (the agent runs these via Bash; you can too):

| Command | What it does |
|---|---|
| `cc-msg send <tab\|all> "msg"` | share info (no reply expected) |
| `cc-msg ask <tab\|all> "msg"` | ask a question (reply expected) |
| `cc-msg fix <tab\|all> "msg"` | report a problem in their project (they fix it, then `done`) |
| `cc-msg sync <tab\|all> "msg"` | "I changed X, adapt your side" — cross-side hand-off |
| `cc-msg done <tab\|all> "msg"` | report completion (no reply) |
| `cc-msg status "msg"` | publish what you're working on (shared board) |
| `cc-msg busy "msg"` / `cc-msg ready` | flag / clear "mid-change, shared build may break" |
| `cc-msg who` | who is working on what right now |
| `cc-msg list` | live sessions + project paths |
| `cc-msg history [n]` | recent traffic |
| `cc-msg name <handle>` | give this session a short descriptive name |
| `cc-msg inbox` | undelivered messages for this session |
| `cc-msg revive <tab> [msg]` | reopen a **closed** session (`claude --resume`) in a new terminal |
| `cc-msg spawn [--resume sid] "prompt"` | open a **new** claude tab, seeded with a prompt (needs the [cc-bus VS Code integration](integrations/)) |
| `cc-msg whoami` | this session's name |

`<tab>` is matched by exact name → substring → session-id prefix.

**Broadcast scope.** `all` (and `*`, `@all`) reaches only sessions **in the sender's project** (nearest `.git` root) — so a broadcast never wakes sessions in unrelated repos. Other forms:

- `cc-msg send everyone "..."` — every live session, across all projects (rare; use sparingly).
- `cc-msg send proj:<name> "..."` — every session whose project (git-root basename) matches `<name>`.
- Addressing one session by its id always works, across projects.

The **status board** injected on each prompt is likewise scoped to same-project peers, and only re-appears when a peer's name/status/mid-change flag actually changes (not on every heartbeat).

### The behavior protocol

The SessionStart hook tells each session how to behave with incoming messages:

- **FIX about your project** → investigate and fix, then `cc-msg done`. For auth/payments/migrations/core logic, propose via `cc-msg ask` and wait.
- **SYNC** → adapt your side to the peer's change, then `cc-msg done`.
- **ASK** → answer it. **INFO / DONE** → absorb, don't reply (loop guard).
- Find a bug in a **peer's** project? Don't fix it — `cc-msg fix` the owner.
- **Don't panic:** before treating a build/type/test failure as yours, run `cc-msg who`; if a peer is `MID-CHANGE` in that area, it's likely transient and theirs.

## Reviving closed sessions

Claude Code keeps a session's transcript on disk even after you close it. If you message a session that's no longer live, cc-chat queues the message and tells you to reopen it:

```
cc-msg revive be-orders          # opens a new terminal running `claude --resume <id>`
```

On macOS this opens Terminal.app; elsewhere it prints the `claude --resume` command to run. The queued message is delivered once the revived session is up. (This is deliberately **not** automatic — you trigger it.)

## Integrations

The core stays terminal-agnostic. Optional integrations live under [`integrations/`](integrations/):

- **`cc-bus`** — a live, colored dashboard of the whole bus (legend of sessions + chat stream). Interactive: press `s` to ask everyone for a status, `m` to broadcast a message, `t` to switch which project you're broadcasting to. You send AS `operator` (the human at the dashboard); sessions reply with `cc-msg send operator "..."`, which shows up live. Installed onto your PATH by `setup.js` — just run `cc-bus`.
- **`vscode-cc-bus-waker`** — a VS Code extension that (1) **wakes idle Claude terminals** in the window when a message arrives (works around the limitation below), and (2) handles **`cc-msg spawn`** by opening a new `claude` tab and seeding it with a prompt. It only touches sessions in its own window, skips busy/mid-generation sessions and the terminal you're typing in. Symlinked into `~/.vscode/extensions` by `setup.js`; run *Developer: Reload Window* to activate.

## Known limitation

Out of the box, waking is reliable for an **active** session (it gets the message immediately). A **fully-idle** session sitting at the prompt receives the message at its **next interaction** rather than starting a turn on its own — this is a Claude Code behavior, not a bug here.

> Want guaranteed wake of idle sessions in VS Code? Install the `vscode-cc-bus-waker` integration above. For WezTerm/tmux the same idea works via `cli send-text` / `send-keys`.

## Data & uninstall

- All state lives under `~/.cc-chat/bus/`. Delete it to reset.
- To uninstall: remove the four cc-chat hook entries and the `Bash(cc-msg *)` permission from `~/.claude/settings.json` (restore the `.bak`), remove the `~/.local/bin/cc-msg` and `~/.local/bin/cc-bus` symlinks, remove the `~/.vscode/extensions/cc-bus-waker` symlink (if installed), and delete `~/.cc-chat/`.

## License

MIT — see [LICENSE](LICENSE).
