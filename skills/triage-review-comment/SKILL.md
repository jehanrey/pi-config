---
name: triage-review-comment
description: "Triage a code review comment: research the related code, explain what the comment is about, give a warranted/not-warranted verdict, and propose a fix plan when changes are needed. Use when the user pastes a PR review comment and wants analysis before deciding whether to act."
---

# Triage Review Comment

Analyse a single code review comment, determine if a change is warranted, and — if
so — produce a change plan ready for implementation.

## Workflow

### Step 1 — Intake

Accept the pasted review comment. Extract:
- **file and line/range** if mentioned
- **reviewer concern** in one sentence
- **suggested change** (if any)

If the comment names no file or line, locate it before researching: search the
codebase for any code snippet quoted in the comment. If that yields no unique
match, ask the user which file the comment refers to.

If the user says "pull from PR", fetch both comment kinds (top-level review
comments and inline diff comments live in different places):

```sh
gh pr view --json number,reviews,comments   # PR of the current branch; pass a number for another PR
gh api "repos/{owner}/{repo}/pulls/<number>/comments"   # inline review comments
```

Then ask, via the `ask-user-question` skill, which comment to triage — one
option per comment (label: file/line or reviewer; description: the concern in
a few words).

### Step 2 — Research

Default scope is narrow:
1. Read only the reviewed file and the mentioned function/block. Verify the
   commented code still exists in its current form — it may have changed since
   the review. If it has, say so; the verdict may be `not warranted — already
   addressed`.
2. Read nearby imports only when needed to understand symbols used in that block.
3. Read tests only when the review comment is about behavior, regression risk, or test coverage.
4. Read callers only when the concern is about API usage, side effects, or an external contract.
5. Check broader codebase patterns only when:
   - the reviewer explicitly asks for consistency,
   - the local code has no clear answer,
   - a project convention is directly relevant.

Do not perform a wider audit by default.
Do not report "same issue elsewhere" unless the user asks for it or the reviewer explicitly raises repeated instances.
Do not edit anything. Report only.

### Step 3 — Analysis

Present:
- **What the comment is about** — plain-language explanation (1–3 sentences).
- **Why the reviewer raised it** — likely motivation (correctness, style, performance, maintainability).
- **Verdict**: one of:
  - `warranted` — the concern is valid; a change improves the code.
  - `not warranted` — the code is correct as-is; explain why.
  - `needs more info` — ambiguous; list the open questions.

If a project rule (style guide, lint rule, architecture doc) directly answers the concern, cite it.

End the turn by asking, via the `ask-user-question` skill:
"Accept this verdict?" with options **accept verdict** (recommended) /
**override — treat as warranted** / **override — treat as not warranted**.
A `not warranted` outcome ends the workflow; `warranted` continues to Step 4.

### Step 4 — Fix proposal (if warranted)

Once the user confirms warranted:
1. Describe the proposed change in plain language.
2. Show a before/after snippet if it clarifies intent.
3. List every file that would need to change.
4. Flag any risks or side-effects.
5. Note if the same issue exists elsewhere in the codebase.

If the fix touches a single file, the proposal above already is the change
plan — skip Step 5 and end the turn by asking, via the `ask-user-question`
skill: "Implement this fix now?" with options **implement** /
**adjust the proposal** / **skip — no change**.

Otherwise end the turn by asking, via the `ask-user-question` skill:
"How should we proceed?" with options **proceed with plan** /
**adjust the proposal** / **skip — no change**.

### Step 5 — Change plan (multi-file fixes only)

Once the user approves the fix:
- Ordered list of edits, one item per file/function.
- Description only — no implementation.

End the turn by asking, via the `ask-user-question` skill:
"Implement this change plan now?" with options **implement** /
**revise the plan** / **stop here**.
Only the **implement** answer authorizes touching files.
Accept clear equivalents such as:
- implement
- go ahead
- do it
- proceed
- make the change
- apply the fix
- patch it
- sounds good, fix it

## Rules

- One comment at a time. Finish or explicitly drop the current comment before
  starting the next; triaging another comment afterwards in the same session
  is fine.
- Never edit files during Steps 1–4.
- If the concern may apply elsewhere, mention that a wider audit is possible, but do not perform it unless asked.
