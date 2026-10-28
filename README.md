# omp-kata

[kata](https://github.com/kenn-io/kata) integration for [omp](https://github.com/can1357/oh-my-pi), packaged as an omp plugin.
No MCP server, no files written into your repositories: everything is an omp extension plus one skill.

## What it does

Inside a kata workspace (a directory with `.kata.toml` at or above the session cwd) it:

1. **Injects the kata agent contract** into the system prompt (`kata agent-contract-hook`), as its own `<kata_contract>` block, once, for the main agent and every subagent.
2. **Gives every agent its own kata identity** through a `kata` shim on `PATH` that reads the calling agent's session id, so each subagent is attributed and addressable separately without any change to the commands the model writes.
3. **Delivers the kata inbox** (`kata inbox --context`) as `<kata_inbox>` messages: with every prompt, between tool calls (throttled), and optionally waking an idle session.
4. **Manages attention.** `kata claim <ref>` starts attention tracking; closing stops tracking; when a session ends, anything still claimed becomes `needs-human` ("session ended without hand-off").
5. Shows a footer status line and provides a `/kata` command.
6. Ships an omp-specific **`kata` skill** (delegation recipe for subagents) and a **`/kata-run` command** that works a project's ready queue.

Outside a kata workspace it does nothing, except that `/kata` reports that.

## Install

```sh
git clone https://github.com/nszceta/omp-kata ~/src/omp-kata
cd ~/src/omp-kata && bun install   # types only; runtime has no dependencies
omp plugin link ~/src/omp-kata
```

Requirements: omp ≥ 18.12 (Bun runtime) and `kata` ≥ 0.20 on `PATH` (or set `executable`).

`omp --plugin-dir <path>` is **not** enough: it treats the directory as a Claude-style plugin root (skills, commands) and does not load `omp.extensions`. To try the extension without installing use `omp -e <path-to-this-repo>`.

## Settings

Resolution order per setting: environment variable `OMP_KATA_<NAME>` > plugin setting > default. An unparsable value falls through to the next source.
Set plugin settings with `omp plugin config set omp-kata <key> <value>`. Settings are read at session start and again on `/new`, `/resume` and fork.

| setting | env var | type | default | meaning |
|---|---|---|---|---|
| `executable` | `OMP_KATA_EXECUTABLE` | string | `kata` | kata binary |
| `contract` | `OMP_KATA_CONTRACT` | boolean | `true` | inject the contract into the system prompt |
| `contractSource` | `OMP_KATA_CONTRACT_SOURCE` | string | `""` | passed as `--source` to `kata agent-contract-hook` when non-empty (replaces the built-in text; relative paths are resolved by kata against the workspace root) |
| `inbox` | `OMP_KATA_INBOX` | boolean | `true` | inbox delivery |
| `inboxPollSeconds` | `OMP_KATA_INBOX_POLL_SECONDS` | number ≥ 0 | `15` | minimum seconds between mid-turn checks; the idle watcher runs every `max(value, 5)` seconds; `0` checks after every tool result |
| `wakeOnInbox` | `OMP_KATA_WAKE_ON_INBOX` | boolean | `false` | idle main session starts a turn when new requests arrive instead of only notifying |
| `attention` | `OMP_KATA_ATTENTION` | boolean | `true` | attention lifecycle |
| `identity` | `OMP_KATA_IDENTITY` | boolean | `true` | per-agent kata identity via the `PATH` shim; `false` leaves kata completely untouched (the shim passes through) |
| `refGuard` | `OMP_KATA_REF_GUARD` | `block` \| `warn` \| `off` | `block` | stop kata issue refs from being written into repository content (see [Ref hygiene](#ref-hygiene)) |

Booleans accept `true`/`false`/`1`/`0`.

## Semantics

### Identity

omp runs subagents **in the same process** as the main agent, so `process.env` cannot carry per-agent identity, and rewriting the model's commands makes the model see (and imitate) text it never wrote. The plugin therefore delivers identity out of band, with a `kata` shim:

1. On first use the plugin creates a private per-process directory (`$TMPDIR/omp-kata-<pid>-XXXXXX`, mode 0700; leftovers of dead pids are swept on the next install) containing a copy of `bin/kata` and prepends it to `PATH` (once, shared by all sessions of the process); it also exports `OMP_KATA_STATE_DIR` and `OMP_KATA_REAL` (the real kata's absolute path, found on `PATH` outside the shim directory).
2. For every agent session it writes `<state dir>/<session id>.env` (atomically) with that agent's `KATA_AUTHOR`, `KATA_TEAMMATE` (or `unset`) and `KATA_INBOX_USER`. The file is removed at session shutdown (the old session's file on `/new`, `/resume`, fork), and the whole directory when the process exits.
3. omp sets `PI_SESSION_ID` for every bash command of an agent session (main and subagents differ). The shim sources `$OMP_KATA_STATE_DIR/$PI_SESSION_ID.env` if it exists and execs the real kata; otherwise it is a plain pass-through (first `kata` on `PATH` that is not the shim's own directory, never itself).

Identity is applied at exec time, so a model-authored `export KATA_AUTHOR=…` before `kata` cannot override it (explicit flags such as `--as` still win). Limits: only commands that resolve `kata` through `PATH` are covered, not absolute-path calls. omp rebuilds `PATH` from the user's rc files (`~/.bashrc`, `~/.zshrc`, `~/.profile`) before each command, which can put the real kata ahead of the shim (for example `export PATH="$HOME/.local/bin:$PATH"`); the plugin therefore also sets `PI_SHELL_PREFIX`, which omp's bash executor applies to every command (it does not appear in tool-call history), to strip and re-prepend the shim directory. An existing `PI_SHELL_PREFIX` (or `CLAUDE_CODE_SHELL_PREFIX`) is preserved and runs after ours.

| agent | `KATA_AUTHOR` | `KATA_TEAMMATE` | `KATA_INBOX_USER` |
|---|---|---|---|
| main | `kata whoami` actor (honors `KATA_AUTHOR`) | `$KATA_TEAMMATE` or none | `$KATA_INBOX_USER`, else `actor[/teammate]` |
| subagent | same actor | its agent id (e.g. `HandicappedSailfish`) | `actor/<agent id>` |

Subagents never read `KATA_TEAMMATE`, `KATA_INBOX_USER` or `KATA_REF` from the environment (they are shared with the main agent). A teammate-less identity unsets `KATA_TEAMMATE` (kata treats an empty value like an unset one — verified). With `identity=false` no file is written and nothing about kata changes.

The contract block injected into the system prompt ends with a short omp addendum giving this agent's actor/teammate/inbox address and telling agents not to export those variables or put them in task assignments. For the main agent only, it adds a line telling it to keep kata current as it works: close each issue its work resolves right away with evidence, but only after verifying every acceptance criterion; unverified or partial work gets a progress comment instead.

### Inbox

`kata inbox --context --for <inbox user>` is checked:

- before every prompt (`before_agent_start`), delivered as a `kata-inbox` message;
- after tool results, at most every `inboxPollSeconds`, delivered as extra context on that tool result;
- in an **idle main session** every `max(inboxPollSeconds, 5)` seconds: by default a one-time notification per distinct inbox text (the next prompt carries the content); with `wakeOnInbox` the request is delivered immediately and a turn starts.

Only changes are delivered. When a non-empty inbox becomes empty the agent gets one "now empty" notice. kata errors and timeouts change nothing and are retried at the next check.

### Attention

- Main session started with `KATA_REF` set: attention starts for that issue (skipped if the issue is already closed).
- A successful bash `kata claim <ref…>` (also in chains, with global flags, via a path, behind env prefixes) starts attention and tracks the ref, in main sessions and subagents.
- A successful `kata close <ref>` stops tracking (kata's `end` would downgrade a healthy `ok` to `needs-human`, which is wrong for closed issues).
- Session shutdown ends every tracked ref; `/new`, `/resume` and fork end the old session's refs and restart `KATA_REF` for the new session. Ending uses detached processes because the shutdown handler budget is 2 s.
- kata derives the attention owner from the host pid and silently does nothing if that pid is gone, which would make a detached `end` after omp exits a no-op. Every attention call therefore also sets `KATA_SESSION_ID=omp-<omp session id>` (kata's launcher-id override) so start and end address the same owner regardless of pid liveness.
- A hard crash or `SIGKILL` cannot run the shutdown hook; kata has no watcher, so such issues keep `ok` until someone notices.

Detection is based on the bash command text and exit status; a chain `kata claim a; kata claim b` whose last command fails is reported by omp as an error and is not tracked.

### Status line and `/kata`

With a UI, the footer shows `kata <inbox user>`, plus ` · <tracked refs>` and ` · inbox N`.

- `/kata` or `/kata status`: workspace root, actor, teammate, inbox user, tracked refs, contract status, inbox count, effective settings.
- `/kata inbox`: fetch and show the inbox.
- `/kata refresh`: drop the cached contract and actor.

### `/kata-run <project> [label]`

Markdown slash command (`commands/kata-run.md`, discovered from the linked plugin root). It prompts the agent to loop `kata next --project <project> --unowned` (filtered by `--label` when given) → claim → follow body and comments → verify → close, leaving parents with open children for last, flagging blocked issues `needs-human`/`stuck`, and fanning independent issues out to subagents, until the ready queue is empty. Without a label it works every ready issue in the project. Each fanned-out subagent gets a tier chosen per issue: ordinary issues omit `model`, so omp's subagent settings apply (`task.agentModelOverrides`, then `modelRoles.task`); narrowly specified mechanical issues get `@smol`; open-ended or cross-cutting ones get `@slow`. When unsure the agent takes the higher tier, it never passes a concrete model id, and a child that fails at its tier is re-spawned one tier up before the issue is left `needs-human`. Siblings that touch the same file are told to coordinate over IRC (`write agent://<id>`) before editing it.

### Ref hygiene

Kata refs are handles that only work with the local tracker. Links go one way: kata issues cite commits and doc paths, and repository content never cites kata issues. The omp addendum, `/kata-run` and the `kata` skill all tell agents this.

The `refGuard` setting enforces it on `tool_call`. It checks:

- `write` content and `edit` `+` lines for files in the workspace;
- `ast_edit` replacement text for paths in the workspace;
- `git commit` messages given with `-m` or `-F-`.

It flags `<project>#<id>` and bare short ids that the session has already seen in kata commands or their output. Ids the session has not seen pass, so ordinary 4-character tokens are not caught. With `block`, the call is refused. With `warn`, it goes through with a warning. Files written by shell redirection or `eval` are not checked.

## Why no MCP server

`kata mcp serve` fixes the actor and project per process, so it cannot express per-agent identity when subagents share one process; it would start a kata daemon in every omp session; and it duplicates the CLI, which agents already drive through bash. Everything this plugin needs is a hook point, not a tool surface.

## Failure behavior

Every kata call has a timeout (contract 10 s, inbox/attention 5 s, whoami 10 s) and never throws into omp. If the contract cannot be fetched, the system prompt gets a `<kata_contract>` stub saying so (and one warning notification per session); failures are not cached, so the next prompt retries. If `kata whoami` fails, bash commands run unchanged and identity resolution is retried after 10 s.

## Development and testing

```sh
bun install
bun run typecheck
bun test test/unit     # hand-rolled fake ExtensionAPI + a fake `kata` script + real kata in an isolated KATA_HOME
bun test test/e2e      # real omp binary + real kata + a scripted fake model provider (no network, no API keys)
```

All tests run with a private `HOME`, `PI_CODING_AGENT_DIR` and `KATA_HOME` and stop the kata daemon they start; nothing touches `~/.omp` or your real kata data. Environment overrides: `KATA_BIN` (kata binary), `OMP_BIN` (omp binary).

Layout: `src/index.ts` (event wiring) · `session.ts` (per-session behavior) · `config.ts` · `kata.ts` (process runner) · `shim.ts` + `bin/kata` (identity delivery) · `workspace.ts` · `identity.ts` · `contract.ts` · `inbox.ts` · `attention.ts` · `refs.ts` (claim/close parser) · `status.ts` · `commands.ts` · `skills/kata/SKILL.md` · `commands/kata-run.md`.
