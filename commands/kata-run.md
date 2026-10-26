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

Independent ready issues: fan out to parallel subagents, one issue each.
When the queue is empty, report what was closed and anything still needing attention.
