---
description: Work a kata project's ready queue until empty
argument-hint: <project> [label]
---
Work through kata project `$1` until its ready queue is empty. Optional label filter: `$2` (empty = no filter).

Loop:
1. `kata next --project $1 --unowned --agent`, adding `--label $2` when a label was given. Stop when it prints `found=false`.
2. Skip parent issues that still have open children; work them last.
3. `kata claim <ref> --project $1 --agent`, then `kata show <ref> --project $1` and follow its body AND comments.
4. Do the work, verify it, then `kata close <ref> --project $1 --done -m "<scope and verification>" <evidence> --agent`.
5. If blocked, set `work.attention` to `needs-human` or `stuck` with `work.attention_msg`, then move on.

Independent ready issues: fan out to parallel subagents, one issue each. Choose each subagent's model tier from the issue body:
- Ordinary implementation: omit the task item's `model`, so omp applies the configured subagent model (`task.agentModelOverrides`, then `modelRoles.task`).
- `model: "@smol"`: only when the body names the exact change (files, symbols, values) and it needs no design or investigation.
- `model: "@slow"`: open-ended design, debugging without a repro, or changes spanning several subsystems.

When unsure between two tiers, take the higher one. Never pass a concrete `provider/model` id: it drops the role.
If a subagent ends without closing its issue because the work was harder than its tier (not because it needs human input), re-spawn it one tier up with the issue's comments and `work.attention_msg` as context before leaving it `needs-human`.
Siblings that touch the same file must coordinate over IRC (`write agent://<id>`) before editing it; name the shared files and each sibling's id in their assignments so they know whom to message.

Issue refs belong in kata commands only. Never cite them in deliverables (code, tests, docs, file or directory names, commit messages), and do not ask subagents to; describe the change in words, and record commit SHAs and doc paths on the issue instead.

When the queue is empty, report what was closed and anything still needing attention.
