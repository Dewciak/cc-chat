# Codex CLI integration

`cc-chat` works with **Codex CLI** as a first-class bus participant, alongside Claude Code.
Codex 0.145+ ships a hook system whose I/O is nearly identical to Claude Code's:

- same event names (`SessionStart`, `UserPromptSubmit`, `SessionEnd`, …),
- stdin payload carries `session_id` + `cwd` (same field names),
- output uses `hookSpecificOutput.{hookEventName, additionalContext}` + `systemMessage`.

So the **same hook scripts** (`hooks/cc-msg-start.js`, `cc-msg-board.js`) drive both agents —
the agent kind is passed as an argv (`codex`).

## What gets installed

`node setup.js` auto-detects `~/.codex` and merges into `~/.codex/hooks.json`:

| Event | Handler | Why |
|-------|---------|-----|
| `SessionStart` | `cc-msg-start.js codex` | register the tab (`agent: "codex"`) + inject a **lean, once-per-session** protocol |
| `SessionEnd`   | inline node | deregister the tab |

**No `UserPromptSubmit` hook is installed for Codex — on purpose.** On Claude Code that hook
injects the board + inbox on *every* turn; on Codex that would burn tokens each message. So:

- a Codex tab **WRITES freely** — `cc-msg send/ask/fix/done/status/who`,
- a Codex tab **READS on demand** — `cc-msg inbox` (unread), `cc-msg who` (board), or
  `cc-msg watch` in the background (exits when a message lands, so it can be woken without polling).

## Identity

Codex has no `CLAUDE_ENV_FILE`, but injects `CODEX_THREAD_ID` into every tool shell — the same
UUID its hooks register the tab under. `cc-msg` resolves its own identity from
`CLAUDE_CODE_SESSION_ID || CODEX_THREAD_ID || CC_SELF_SESSION`, so `cc-msg` run from a Codex
shell knows who it is with no env file.

## `[CODEX]` tag

Every message/status a Codex tab sends carries `fromAgent: "codex"`; `cc-msg` (inbox/history/
transcript), the recipient card, the pending block, and the dashboard render `[CODEX]` next to
the sender so peers can tell Codex traffic apart. On the board, Codex tabs show a `[codex]` tag.

## spawn / revive across agents

`cc-msg spawn` inherits the parent tab's CLI (a Codex tab spawns Codex), overridable with
`--codex` / `--claude`. `cc-msg revive` uses the right resume syntax per the dead tab's agent:
`codex resume <uuid>` vs `claude --resume <sid>`.

## One-time trust

Codex marks newly-added hooks **Untrusted** — approve them once on your next interactive
`codex` launch (the hash is derived from a normalized hook identity via Codex's internal
digest, so it can't be pre-seeded safely). Existing hooks in `~/.codex/hooks.json` are preserved.

## Known limitation

Spawning a Codex tab **through the VS Code extension** (cc-bus-waker) still opens `claude` —
the extension doesn't yet read the `agent` field from the spawn request (it's already in
`req.agent`, awaiting support). Spawning outside VS Code (WezTerm/Terminal) launches `codex`
correctly.
