---
description: Work a kata project's ready queue until empty
argument-hint: <project> [label]
---
Work through kata project `$1` until its ready queue has nothing workable left. Optional label filter: `$2` (empty = no filter; add `--label $2` to every `kata ready` below when given).

Your work queue is every ready issue that is unowned OR owned by your own actor. Past sessions run as the same actor, and their unfinished claims stay owned by it, so an `--unowned`-only queue skips them forever.

Setup: run `kata whoami --agent` once and note `actor=<actor>`.

Loop:
1. List the queue: `kata ready --project $1 --unowned --agent` and `kata ready --project $1 --owner <actor> --agent`. Use `ready`, not `next`: `next` returns only the top issue, so skipping it would return the same issue forever.
2. For each issue, run `kata show <ref> --project $1` and classify it:
   - **Parent with open children**: skip until its children are closed, then work it last.
   - **Owned by you, `work.attention` = `needs-human`, and `work.attention_msg` = "session ended without hand-off"**: an earlier session ended mid-work. Resume it: inspect any partial work, then continue as normal.
   - **Owned by you, `needs-human` or `stuck` with any other message**: a deliberate hand-off to a human. Skip it.
   - **Otherwise**: work it.
   Stop when no issue is left to work.
3. `kata claim <ref> --project $1 --agent`, then follow its body AND comments.
4. Do the work, verify it, then `kata close <ref> --project $1 --done -m "<scope and verification>" <evidence> --agent`.
5. If you are blocked and a human must decide, ask a question. Set `work.attention` to `needs-human` (or `stuck`). Set `work.attention_msg` to one concrete question that a human can answer without reading the transcript. Name the options when there are any. For example: "Keep the 5 s FIFO grace or make it configurable? The tests pass with both." Add a comment with the context and what you tried. Then move on. A bare status such as "blocked" or "needs review" is not allowed.

Independent ready issues: fan out to parallel subagents, one issue each. Choose each subagent's agent from the issue body:
- `agent: "sonic"`: only when the body names the exact change (files, symbols, values) and it needs no design or investigation.
- Everything else: omit `agent`, so the default `task` agent runs.

When unsure, use the default `task` agent. Never pass `model` on a task item: omp rejects it for every agent except `seance`; subagent models come from omp's settings (`task.agentModelOverrides`, `modelRoles`).
If a `sonic` subagent ends without closing its issue because the work needed design or investigation (not because it needs human input), re-spawn it as `task` with the issue's comments and `work.attention_msg` as context before leaving it `needs-human`. A subagent that leaves its issue `needs-human` must apply step 5. If its message is not a concrete question, read the issue and write the question yourself.
Siblings that touch the same file must coordinate over IRC (`write agent://<id>`) before editing it; name the shared files and each sibling's id in their assignments so they know whom to message.

Issue refs belong in kata commands only. Never cite them in deliverables (code, tests, docs, file or directory names, commit messages), and do not ask subagents to; describe the change in words, and record commit SHAs and doc paths on the issue instead.

When nothing workable is left, report what you closed. Then list every issue still open in the queue with its ref, its title, and the exact question a human must answer to unblock it. For a parent, the question is the child it is waiting on. Every open issue must have an actionable question in this list.
