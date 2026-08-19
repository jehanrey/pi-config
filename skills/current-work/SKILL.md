---
name: current-work
description: Establish context from the current branch and working-tree changes before investigating a bug or code improvement. Use when a fresh agent needs to catch up on work already in progress while keeping its initial exploration narrowly scoped to that work.
argument-hint: "Optional bug, improvement, or focus area"
disable-model-invocation: true
---

# Current Work

Understand the work already in progress before investigating further. Start with the current branch's changes from its base, then include staged, unstaged, and untracked work.

This is a read-only context pass. Do not edit files, run formatters, install dependencies, or perform other mutating actions.

## 1. Establish the change boundary

Confirm the current directory is inside a Git repository. Read the repository's applicable agent instructions, but do not begin a general codebase survey.

Determine the comparison base in this order:

1. A base branch or ref explicitly supplied by the user.
2. The base branch of the current pull request, when one can be queried without changing repository state.
3. The remote's symbolic default branch, such as `origin/HEAD`.
4. A clearly established repository default from local evidence.

Do not use the feature branch's upstream tracking ref as the base merely because it is configured; that can hide commits already made on the branch. If the base remains ambiguous, ask the user rather than guessing.

Capture:

- current branch and `HEAD`
- chosen base and merge base
- concise commit list from the merge base to `HEAD`
- staged, unstaged, and untracked files

If the repository is in a merge, rebase, cherry-pick, or detached-HEAD state, report that before continuing and adapt the boundary explicitly.

## 2. Read changes from narrowest to broadest

Inspect in this order:

1. Diff summary for committed branch changes.
2. Commit messages for those changes.
3. Changed hunks in the branch diff.
4. Staged and unstaged hunks relative to `HEAD`.
5. Relevant untracked files.
6. Tests, plans, issues, or documentation directly changed or referenced by the changes.
7. Only the surrounding code required to understand a changed symbol.

Treat existing commits and uncommitted changes as separate layers. Call out when the working tree revises or contradicts committed work.

Do not initially:

- scan unrelated directories
- audit the whole codebase for similar patterns
- read every caller or dependency of a changed symbol
- investigate pre-existing failures unrelated to the change set
- infer intent from filenames alone

Expand beyond changed files only when a concrete question cannot be answered otherwise. Follow the smallest dependency path that can resolve it, and state why the expansion is necessary. If investigation would become broad or open-ended, pause and ask the user first.

## 3. Build the working context

Infer intent from evidence, distinguishing facts from hypotheses. If the user supplied a bug, improvement, or focus area as arguments, organize the catch-up around it without excluding other changes that materially affect it.

Identify:

- the apparent goal of the current work
- completed behavior or structural changes
- unfinished or partially implemented work
- tests or validation evidence already present
- risks, contradictions, and unresolved decisions visible in the changes
- the files and symbols most relevant to the next step

Do not run the test suite during this context pass unless the user explicitly requests it. Report relevant test commands found in changed documentation or project instructions as available validation, not as completed evidence.

## 4. Report and stop

Return a compact catch-up using this structure:

```md
## Current work

**Boundary:** `<merge-base>..HEAD` plus working-tree changes
**Apparent goal:** ...

### What has changed
- ...

### In progress or unresolved
- ...

### Validation visible so far
- ...

### Relevant scope
- `path/to/file` — why it matters

### Suggested next step
- ...
```

Include uncertainty where evidence is incomplete. Mention any scope expansion performed and why. Do not propose unrelated improvements.

Stop after the report. Let the user confirm or redirect the understanding before diagnosing, fixing, or improving the code.
