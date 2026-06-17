# ClaudeChat

**Let independent [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions talk to each other.**

Run several Claude Code sessions across terminal tabs/windows — each one a long-lived specialist on its own project — and let them coordinate **peer-to-peer**: share what they're working on, hand off cross-cutting changes, warn each other before breaking a shared build, and message a specific session directly. No daemon, no MCP server, no orchestrator. Just **Claude Code hooks + a tiny CLI + plain files**.

> Each session is a normal, persistent `claude` session (keeps its full context). ClaudeChat is the wire between them — not a spawner. Unlike ephemeral subagents/teams that spin up and die per task, your sessions stay alive and accumulate domain knowledge; ClaudeChat just lets them coordinate when their work overlaps.

---

## Why

When you run multiple Claude Code sessions on the same machine they're fully isolated — no shared context, no way for one to tell another "I changed the API, update your types" or "don't touch these files, I'm mid-migration". You end up being the message bus, copy-pasting between tabs. ClaudeChat removes you from that loop.

## How it works

```
   session A                              session B
   ─────────                              ─────────
   cc-msg fix B "..."  ──►  ~/.claude-chat/bus/inbox/<B>.jsonl
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

Everything is plain files under `~/.claude-chat/bus/`. No background process.

## Install

Requires **Node.js** and **Claude Code**.

```
git clone https://github.com/Dewciak/ClaudeChat.git
cd ClaudeChat
node setup.js          # or: ./install.sh
```

The installer links `cc-msg` onto your PATH (`~/.local/bin`), and **merges** the four hooks + a `Bash(cc-msg *)` permission into `~/.claude/settings.json` (idempotent, makes a `.bak` first — it never clobbers your existing config).

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
| `cc-msg whoami` | this session's name |

`<tab>` is matched by exact name → substring → session-id prefix. `all` broadcasts to every other live session.

### The behavior protocol

The SessionStart hook tells each session how to behave with incoming messages:

- **FIX about your project** → investigate and fix, then `cc-msg done`. For auth/payments/migrations/core logic, propose via `cc-msg ask` and wait.
- **SYNC** → adapt your side to the peer's change, then `cc-msg done`.
- **ASK** → answer it. **INFO / DONE** → absorb, don't reply (loop guard).
- Find a bug in a **peer's** project? Don't fix it — `cc-msg fix` the owner.
- **Don't panic:** before treating a build/type/test failure as yours, run `cc-msg who`; if a peer is `MID-CHANGE` in that area, it's likely transient and theirs.

## Reviving closed sessions

Claude Code keeps a session's transcript on disk even after you close it. If you message a session that's no longer live, ClaudeChat queues the message and tells you to reopen it:

```
cc-msg revive be-orders          # opens a new terminal running `claude --resume <id>`
```

On macOS this opens Terminal.app; elsewhere it prints the `claude --resume` command to run. The queued message is delivered once the revived session is up. (This is deliberately **not** automatic — you trigger it.)

## Known limitation

Waking is reliable for an **active** session (it gets the message immediately). A **fully-idle** session sitting at the prompt receives the message at its **next interaction** rather than starting a turn on its own — this is a Claude Code behavior, not a bug here. For most coordination flows this is fine.

> Want guaranteed wake of idle sessions and one-click revive into clean tabs? That needs a terminal-emulator integration (e.g. WezTerm `cli send-text` / tmux `send-keys`). ClaudeChat keeps the core terminal-agnostic; such integrations are a natural extension.

## Data & uninstall

- All state lives under `~/.claude-chat/bus/`. Delete it to reset.
- To uninstall: remove the four ClaudeChat hook entries and the `Bash(cc-msg *)` permission from `~/.claude/settings.json` (restore the `.bak`), remove the `~/.local/bin/cc-msg` symlink, and delete `~/.claude-chat/`.

## License

MIT — see [LICENSE](LICENSE).
