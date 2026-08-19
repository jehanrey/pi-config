---
name: ask-user-question
description: "Present the user with a structured multiple-choice question and wait for their answer. Harness-agnostic emulation of Claude Code's AskUserQuestion tool: renders numbered options in plain text when no native question tool exists. Use when a skill or workflow reaches a decision gate that the user must resolve before work can continue."
---

# Ask User Question

Ask the user a structured question with a fixed set of options, then stop and
wait for their answer. Other skills invoke this at decision gates instead of
hardcoding literal prompt strings.

## Native tool fallback

If the current harness provides a native structured-question tool (e.g.
`AskUserQuestion` in Claude Code), use that tool instead of the plain-text
format below. Map the inputs one-to-one: question, options with descriptions,
multi-select flag.

Otherwise, render the question in plain text using the format below.

## Inputs

Whoever invokes this skill (a user, or another skill at a decision gate)
supplies:

- **question** — one clear, specific question ending in `?`
- **options** — 2–4 mutually exclusive choices, each with:
  - **label** — 1–5 words
  - **description** — one line on what happens if chosen
- **multiSelect** (optional, default false) — whether multiple options may be
  chosen
- **recommended** (optional) — the label of the option the agent recommends

## Plain-text format

```md
**<question>**

1. **<label>** — <description> *(recommended)*
2. **<label>** — <description>
3. **<label>** — <description>
4. **Other** — describe what you'd like instead

> Reply with a number, a label, or your own answer.
```

Rules:

- Always append the **Other** option last; never count it toward the 2–4 limit.
- Put the recommended option first and mark it `*(recommended)*`. At most one
  recommendation.
- For multi-select, change the closing line to:
  `> Reply with one or more numbers (e.g. "1, 3"), labels, or your own answer.`
- Ask at most one question per turn unless the questions are truly independent;
  if more than one, number them `Q1`, `Q2` and keep each to the same format.

## After asking

- **Stop the turn immediately.** Do not perform further work, speculate on the
  answer, or proceed with a default.
- Interpret the reply leniently: a number, an exact or partial label match, or
  a clear paraphrase all count as selecting that option.
- If the reply is ambiguous between two options, re-ask only the ambiguous part
  in one short sentence — do not re-render the whole question.
- If the reply answers a different question or changes scope, treat the
  original question as superseded and follow the user's new direction.
- A free-form reply that matches no option is an **Other** answer; carry it
  forward verbatim as the decision.

## Invoking from other skills

Skills with decision gates should reference this skill rather than embedding
literal prompt strings, e.g.:

> End the turn by asking, via the `ask-user-question` skill:
> "Proceed with this plan?" with options **proceed** / **adjust** / **skip**.

This keeps the gate behavior consistent across harnesses: native tool where
available, the plain-text format everywhere else.
