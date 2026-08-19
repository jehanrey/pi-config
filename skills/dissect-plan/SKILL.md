---
name: dissect-plan
description: Guides a collaborative, item-by-item review of a plan, using the current conversation plan or a plan pasted by the user. Use when the user asks to dissect, refine, challenge, walk through, or discuss a plan step by step before implementing it.
---

# Dissect Plan

## Goal

Refine a plan one item at a time until the user and agent share the same understanding of each step, its trade-offs, and the agreed direction.

## Inputs

Use the first available source:

1. A plan pasted or attached in the user's current message.
2. The most recent plan the assistant provided earlier in the conversation.
3. If neither exists, ask the user for the plan and stop.

Do not ask the user to paste a plan when a recent assistant-authored plan is available in the conversation.

## Core rules

- Work on exactly one plan item at a time.
- Do not skip ahead.
- Do not rewrite the full plan in one pass unless the user explicitly asks.
- Do not implement the plan during this skill.
- Do not implement immediately after the final item is settled; output the revised plan and wait for separate implementation approval.
- Treat each item as a discussion gate: present analysis, ask for input, then wait.
- Move to the next item only after the user agrees with the current item's direction.
- If the user's reply changes the direction, keep discussing the same item until it is settled.
- If settling a later item contradicts an earlier settled item, flag it immediately and reopen the earlier item; never carry a known contradiction into the final plan.
- Preserve unresolved decisions as explicit open questions; do not silently choose defaults.
- Reading code is allowed and encouraged: ground each item's analysis in the actual codebase (verify referenced files, functions, and assumptions exist). Never edit files.

## Workflow

1. Identify the plan source from [Inputs](#inputs).
2. Split the plan into ordered items. If the plan is not already numbered, infer stable item boundaries.
3. Show the resulting item list (numbers and short titles only) and confirm it via the `ask-user-question` skill: "Does this split look right?" with options **looks right — start with item 1** / **adjust the boundaries** / **skip some items**. The user may batch-accept items here ("3 and 4 are fine"); record those as settled as-written.
4. Start with the first unsettled item unless the user asks to start elsewhere.
5. For the current item:
   - State the item briefly.
   - Explain what the item is trying to achieve.
   - Call out assumptions, risks, coupling, and hidden implementation consequences.
   - Offer concrete alternatives when there are meaningful trade-offs.
   - Recommend a direction when enough information exists.
   - Ask targeted questions only where user input would change the outcome.
6. Stop and wait for the user's response.
7. When the item is settled, write the refined version of that item.
8. Ask whether to continue to the next item.
9. Repeat until every item is settled.
10. Output the full revised plan as the skill's final artifact.
11. Stop and ask whether the user wants to implement, revise further, or save the plan.

### Fast path for uncontroversial items

When an item is trivial and carries no assumptions, risks, or trade-offs worth
discussing, skip the full per-item template. Say so in one or two sentences
("Item N looks straightforward — no risks I'd flag") and ask, via the
`ask-user-question` skill: "Settle item N as-is?" with options
**settle as-is** / **discuss it anyway**. Use the fast path only when genuinely
confident; when in doubt, run the full template.

## Per-item output format

```md
### Item N: <short title>

Current step:
> <the plan item being discussed>

Read:
<plain-language interpretation of the step>

Things to settle:
- <assumption, risk, ambiguity, or trade-off>

Suggested direction:
<recommended refinement or options>

Question:
<targeted prompt for the user>
```

End each turn by asking, via the `ask-user-question` skill, exactly one of:

- "Agree with this direction for the item?" with options **agree** /
  **revise** / **explore alternatives** — when presenting an item's analysis.
- "Is this item settled?" with options **settled** / **keep discussing** —
  when the discussion has converged but agreement is not yet explicit.
- "Continue to the next item?" with options **continue** / **revisit this
  item** / **stop here** — after writing an item's refined version.

When the template's `Question:` field already covers the decision (e.g. it
asks the user to choose between alternatives), fold it into the
`ask-user-question` options instead of asking two questions in one turn.

## Refinement style

A refined item should be actionable by another agent or developer without extra context. Include:

- The concrete action.
- The files, modules, or concepts involved when known.
- The expected behavior or outcome.
- Guardrails and non-goals.
- Validation or follow-up checks when relevant.

Keep refinements scoped to the current item. Do not sneak in decisions from later items.

## Final output

After all items are settled, produce a single revised plan that incorporates the agreed refinements. If any decisions were deliberately left unresolved, end the plan with an **Open questions** section listing each one and which item it belongs to. Do not start implementation in the same turn. End the turn by asking, via the `ask-user-question` skill:

"Revised plan ready — what next?" with options **implement** /
**revise further** / **save the plan and stop**.
