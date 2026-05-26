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

If the user says "pull from PR", run:
`gh pr view <number> --json reviews,comments`
then ask the user which comment to triage.

### Step 2 — Research

Default scope is narrow:
1. Read only the reviewed file and the mentioned function/block.
2. Read nearby imports only when needed to understand symbols used in that block.
3. Read tests only when the review comment is about behavior, regression risk, or test coverage.
4. Read callers only when the concern is about API usage, side effects, or an external contract.
5. Check broader codebase patterns only when:
   - the reviewer explicitly asks for consistency,
   - the local code has no clear answer,
   - a project convention is directly relevant.

Do not perform a wider audit by default.
Do not report “same issue elsewhere” unless the user asks for it or the reviewer explicitly raises repeated instances.
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

End turn: `[warranted / not warranted / needs more info — your call]`

### Step 4 — Fix proposal (if warranted)

Once the user confirms warranted:
1. Describe the proposed change in plain language.
2. Show a before/after snippet if it clarifies intent.
3. List every file that would need to change.
4. Flag any risks or side-effects.
5. Note if the same issue exists elsewhere in the codebase.

End turn: `[proceed with plan / adjust / skip]`

### Step 5 — Change plan

Once the user approves the fix:
- Ordered list of edits, one item per file/function.
- Description only — no implementation.

Wait for an explicit implementation instruction before touching files.
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

- One comment per session.
- Never edit files during Steps 1–4.
- If the concern may apply elsewhere, mention that a wider audit is possible, but do not perform it unless asked.
