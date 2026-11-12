---
description: Work a kata project's ready queue until empty
argument-hint: <project> [label]
---
Work through kata project `$1` until its ready queue has nothing workable left. Optional label filter: `$2` (empty = no filter; add `--label $2` to every `kata ready` below when given).

Your work queue is every ready issue that is unowned OR owned by your own actor. Past sessions run as the same actor, and their unfinished claims stay owned by it, so an `--unowned`-only queue skips them forever.

## Branch layout

All work of this run goes to one **integration branch**. Every issue is done on its own **task branch** that starts from the integration branch. When task branches are finished, you merge them back in groups until only the integration branch is left. The user decides at the end what happens to the integration branch.

```
<base> ── kata/<run>                         integration branch (destination of all work)
            ├── kata-task/<run>/<task-slug>  one per issue, one per subagent
            ├── kata-task/<run>/<task-slug>
            └── kata-merge/<run>/<group-slug> temporary, one per merge group
```

Rules for every branch of the run:
- **Local only.** Never `git push` these branches, never set an upstream, never open a PR. Create branches with `--no-track`. The branch leaves the machine only if the user says so at the end.
- **Semantic names.** `<run>` is a short kebab-case name for the theme of this run, for example `billing-retry-hardening`. `<task-slug>` describes the issue's change, for example `cap-retry-backoff`. `<group-slug>` describes what a merge group contains. Never put a kata ref in a branch name: branch names end up in merge commit messages.
- **One branch per worker.** Each task branch has its own git worktree at `<repo-root>/.kata-worktrees/<run>/<task-slug>`, so parallel subagents never share a working tree. All edits, builds, tests, and commits for the issue happen in that worktree, on that branch.
- **The main checkout stays on `kata/<run>`.** Use it only for merges and for fixes to failures found after a merge. Issue work always happens in a task worktree.
- **Keep history.** Merge with `git merge --no-ff`. Never rebase, squash, amend, or force-update a task branch or `kata/<run>`: issues record commit SHAs as evidence, and those SHAs must stay reachable from `kata/<run>`.

## Setup

1. Run `kata whoami --agent` once and note `actor=<actor>`.
2. Note the base: `git branch --show-current` (if empty, HEAD is detached; use `git rev-parse HEAD`). Run `git status --porcelain`. If it shows changes, stop and ask the user whether to commit, stash, or abort them. Do not carry uncommitted changes into the run.
3. List the queue (step 1 of the loop) and pick `<run>` from what the queue is about. If `kata/<run>` already exists, pick another name.
4. Create the integration branch and ignore the worktree directory locally (this does not change any tracked file):
   ```
   git switch --no-track -c kata/<run>
   exclude=$(git rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$exclude")" \
     && { grep -qxF '/.kata-worktrees/' "$exclude" 2>/dev/null || echo '/.kata-worktrees/' >> "$exclude"; }
   ```

## Loop

1. List the queue: `kata ready --project $1 --unowned --agent` and `kata ready --project $1 --owner <actor> --agent`. Use `ready`, not `next`: `next` returns only the top issue, so skipping it would return the same issue forever.
2. For each issue, run `kata show <ref> --project $1` and classify it:
   - **Parent with open children**: skip until its children are closed, then work it last.
   - **Owned by you, `work.attention` = `needs-human`, and `work.attention_msg` = "session ended without hand-off"**: an earlier session ended mid-work. Resume it: inspect any partial work, then continue as normal. If its `work.branch` names a branch that still exists, continue on that branch (`git worktree add <path> <branch>` if it has no worktree) instead of creating a new one. That branch may start from an older base: check `git log kata/<run>..<branch>` and ask the user before merging if it contains commits that are not part of this issue.
   - **Owned by you, `needs-human` or `stuck` with any other message**: a deliberate hand-off to a human. Skip it.
   - **Otherwise**: work it.
   Stop when no issue is left to work.
3. Create the issue's task branch and worktree from the current tip of `kata/<run>`:
   ```
   git worktree add --no-track -b kata-task/<run>/<task-slug> \
     <repo-root>/.kata-worktrees/<run>/<task-slug> kata/<run>
   ```
   Do this for issues you work yourself too, not only for subagents. A new worktree has no untracked files: install dependencies or other local prerequisites in it before you build or test.
4. `kata claim <ref> --project $1 --agent`, then `kata meta set <ref> work.branch kata-task/<run>/<task-slug> --project $1 --agent`. Follow the issue's body AND comments.
5. Do the work in the worktree and commit it to the task branch. Verify it there. Then `kata close <ref> --project $1 --done -m "<scope and verification>" <evidence> --agent`, with the task branch's commit SHAs as `--commit` evidence.
6. If you are blocked and a human must decide, ask a question. Set `work.attention` to `needs-human` (or `stuck`). Set `work.attention_msg` to one concrete question that a human can answer without reading the transcript. Name the options when there are any. For example: "Keep the 5 s FIFO grace or make it configurable? The tests pass with both." Add a comment with the context and what you tried. Commit any partial work to the task branch so the next session can resume it, then move on. A bare status such as "blocked" or "needs review" is not allowed.
7. Collapse finished task branches into `kata/<run>` (see below) before you start any issue that depends on them. An issue that depends on another issue's change must branch from a `kata/<run>` that already contains that change.

## Parallel subagents

Independent ready issues: fan out to parallel subagents, one issue and one task branch each. Create every subagent's task branch and worktree (loop step 3) before you spawn it. Its assignment must include: the issue ref, the task branch name, and the absolute worktree path. Tell it to:
- claim the issue and set `work.branch` (loop step 4);
- edit, build, test, and commit only inside its worktree, on its own task branch;
- never switch branches, merge, rebase, push, or touch another branch or worktree (reading a sibling's diff with `git diff kata/<run>...<sibling-branch>` is allowed);
- close the issue with its commit SHAs as evidence, or hand off with a question (loop step 6).

The `agent` field picks the subagent's model; omp rejects `model` on task items (only `seance` takes it). Choose from the issue body:
- `task` (omit `agent`, task role): the general-purpose subagent and the default for issue work.
- `sonic` (smol role): only when the body names the exact change (files, symbols, values) and it needs no design or investigation.
- `reviewer` (slow role, read-only, cannot edit): review only. After a `task` subagent reports a non-trivial issue done, have `reviewer` check its task branch diff (`git diff kata/<run>...kata-task/<run>/<task-slug>`); on `incorrect`, fix the findings on that task branch or re-spawn `task` on it with the findings.
- `scout` (smol role, read-only): investigation only; never assign it an issue to close.

When unsure between `sonic` and `task`, use `task`.
If a `sonic` subagent ends without closing its issue because the work needed design or investigation (not because it needs human input), re-spawn it as `task` on the same task branch and worktree, with the issue's comments and `work.attention_msg` as context, before leaving it `needs-human`. A subagent that leaves its issue `needs-human` must apply loop step 6. If its message is not a concrete question, read the issue and write the question yourself.

Parallel subagents must coordinate file edits together over IRC (`write agent://<id>`), whether or not you expect their files to overlap. Give every sibling the ids of all the others. Separate worktrees keep siblings from overwriting each other's files, but every overlap becomes a merge conflict later, so coordinate to keep their branches compatible. Before editing a file, a subagent tells its siblings what it will change there. Siblings working in the same file agree on how their changes fit together: who adds a shared helper or interface, its name and signature, and where each change goes. A subagent never duplicates, reverts, or works against a sibling's change; if a sibling's change looks wrong, it raises it with that sibling. If a subagent needs a change that a sibling is making, it tells you: that is a dependency, and the dependent work waits until the sibling's branch is in `kata/<run>`.

## Collapsing task branches into the integration branch

Collapse when a batch of task branches is finished: after a wave of parallel subagents ends, before work that depends on them starts, and always before the final report. A task branch is finished when its issue is closed. Leave the branch of an issue that was handed off (`needs-human`, `stuck`) out of the collapse and keep it, so a later session can resume it; list it in the final report.

Merge recursively, in groups, until one branch is left:
1. **Group** the branches to merge. Put branches together that are likely to interact, so each conflict is resolved once, by someone who sees both sides: branches that change the same files (`git diff --name-only kata/<run>...<branch>`), siblings under the same parent issue, and branches in the same subsystem. Use groups of 2 to 4 branches. Branches with disjoint files can go in larger groups, because they merge cleanly. A branch with no natural partner forms a group of one and goes up to the next level unchanged.
2. **Merge each group** into a new merge branch that starts from the current `kata/<run>`:
   ```
   git worktree add --no-track -b kata-merge/<run>/<group-slug> \
     <repo-root>/.kata-worktrees/<run>/<group-slug> kata/<run>
   ```
   In that worktree, `git merge --no-ff -m "<what this branch adds>" <branch>` for each member, one at a time, so every conflict belongs to one known pair of changes. Run the builds and tests that cover the group. Fix any breakage with a new commit on the merge branch. Groups on the same level are independent: delegate them to parallel `task` subagents (one group, one merge branch, one worktree each) when there are several.
3. **Repeat** on the resulting branches: group them again by how they interact, and merge each group into a new merge branch. Stop when one branch is left.
4. **Collapse into the integration branch.** In the main checkout (on `kata/<run>`): `git merge --no-ff -m "<what this batch adds>" <last-branch>`. If the batch had only one task branch, merge it directly, without merge branches. Run the full test suite on `kata/<run>`. Fix failures with a new commit on `kata/<run>`.
5. **Clean up.** For every merged task and merge branch: `git worktree remove <path>`, then `git branch -d <branch>`. Use `-d`, never `-D`: `-d` refuses to delete a branch that is not merged into `kata/<run>`, which tells you that something was not collapsed.

Resolving conflicts: keep the intent of both sides. Read both issues (`kata show`) and both diffs first. Never take one side wholesale (`-X ours`, `-X theirs`, `git checkout --ours/--theirs`) unless the other side's change is fully contained in it. If you cannot tell how the two changes combine, give the conflict to a `task` subagent with both issues and both diffs as context, or ask the user. Never edit or rewrite the task branches themselves to avoid a conflict.

## Final report

When nothing workable is left and every finished task branch is in `kata/<run>`:
1. Report what you closed.
2. List every issue still open in the queue with its ref, its title, its task branch if it has one, and the exact question a human must answer to unblock it. For a parent, the question is the child it is waiting on. Every open issue must have an actionable question in this list.
3. Show the integration branch: its name, the base it started from, `git log --oneline --first-parent <base>..kata/<run>`, `git diff --stat <base>...kata/<run>`, and the test result on `kata/<run>`.
4. Ask the user what to do with `kata/<run>` (use the `ask` tool) and wait for the answer. Offer at least: merge it into `<base>`; squash it into one commit on `<base>` (the SHAs recorded on issues then exist only on `kata/<run>`, so keep that branch or the evidence is lost); push it and open a PR; keep it as is; delete it (`git branch -D`; the work and the recorded SHAs are lost unless merged elsewhere). Do nothing to `kata/<run>` or `<base>` until the user answers, then do exactly what they chose.

Issue refs belong in kata commands only. Never cite them in deliverables (code, tests, docs, file or directory names, branch names, commit and merge messages), and do not ask subagents to; describe the change in words, and record commit SHAs and doc paths on the issue instead.
