/**
 * git-commit extension
 *
 * Registers /git-commit [--push] — inspects git changes in the current repo,
 * asks the LLM to summarize the changes and propose a commit message, lets the
 * user revise or accept it naturally, then commits (and optionally pushes).
 * Protected-branch handling is enforced by an interactive selection dialog.
 *
 * Usage:
 *   /git-commit          — commit only
 *   /git-commit --push   — commit and push to origin
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Config ──────────────────────────────────────────────────────────────────
// Edit this list to add or remove protected branches.

const PROTECTED_BRANCHES = ["main", "master", "trunk", "develop"];

// ── State shared between command invocation and tool execution ───────────────

let pendingRepoCwd: string | undefined;
let pendingPush = false;

function suggestedBranchName(message: string): string {
  const slug = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug || "git-commit-update";
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── Tool ───────────────────────────────────────────────────────────────────
  // Called by the LLM after the user has accepted the commit message or asked to commit.

  pi.registerTool({
    name: "perform_commit",
    label: "Commit",
    description:
      "Performs the git commit (and optional push) after the user has accepted " +
      "the commit message or otherwise clearly asked to commit. On protected branches, " +
      "this tool must show an interactive branch selection before committing.",
    parameters: Type.Object({
      message: Type.String({ description: "The agreed commit message" }),
      newBranch: Type.Optional(
        Type.String({
          description: "Branch to create before committing. Normally protected-branch selection is handled interactively.",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = pendingRepoCwd ?? ctx.cwd;
      const push = pendingPush;
      const steps: string[] = [];

      try {
        const currentBranch = (
          await pi.exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])
        ).stdout.trim();
        const suggestedBranch = params.newBranch ?? suggestedBranchName(params.message);
        let branchToCreate = PROTECTED_BRANCHES.includes(currentBranch) ? undefined : params.newBranch;

        if (PROTECTED_BRANCHES.includes(currentBranch)) {
          const customChoice = "Type a different branch name...";
          const suggestedChoice = `Create branch: ${suggestedBranch}`;
          const directChoice = `Commit directly to ${currentBranch}`;
          const choice = await ctx.ui.select("Protected branch commit", [directChoice, suggestedChoice, customChoice]);

          if (!choice) {
            throw new Error("Commit cancelled: no protected-branch option selected");
          }

          if (choice === suggestedChoice) {
            branchToCreate = suggestedBranch;
          } else if (choice === customChoice) {
            const customBranch = await ctx.ui.input("Branch name:", suggestedBranch);
            if (!customBranch?.trim()) {
              throw new Error("Commit cancelled: no branch name provided");
            }
            branchToCreate = customBranch.trim();
          }
        }

        if (branchToCreate) {
          const r = await pi.exec("git", ["-C", cwd, "checkout", "-b", branchToCreate]);
          if (r.code !== 0) throw new Error(r.stderr || "Failed to create branch");
          steps.push(`✓ Created branch: ${branchToCreate}`);
        }

        const add = await pi.exec("git", ["-C", cwd, "add", "-A"]);
        if (add.code !== 0) throw new Error(add.stderr || "git add -A failed");
        steps.push("✓ Staged all changes");

        const commit = await pi.exec("git", ["-C", cwd, "commit", "-m", params.message]);
        if (commit.code !== 0) throw new Error(commit.stderr || "git commit failed");
        steps.push(`✓ Committed: "${params.message}"`);

        if (push) {
          const pushArgs = branchToCreate
            ? ["-C", cwd, "push", "-u", "origin", branchToCreate]
            : ["-C", cwd, "push"];
          const r = await pi.exec("git", pushArgs);
          if (r.code !== 0) throw new Error(r.stderr || "git push failed");
          steps.push(`✓ Pushed to origin`);
        }

        ctx.ui.notify("Done!", "info");
        return {
          content: [{ type: "text", text: steps.join("\n") }],
          details: { steps, message: params.message, branch: branchToCreate ?? currentBranch },
        };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text",
              text: `Error: ${msg}\n\nCompleted steps:\n${steps.join("\n") || "(none)"}`,
            },
          ],
          isError: true,
          details: { error: msg, steps },
        };
      }
    },
  });

  // ── Command ─────────────────────────────────────────────────────────────────

  pi.registerCommand("git-commit", {
    description: "Propose and commit git changes with an AI-generated message. Pass --push to also push.",
    handler: async (args, ctx) => {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy — try again when idle", "warning");
        return;
      }

      pendingPush = (args ?? "").includes("--push");
      const cwd = ctx.cwd;
      pendingRepoCwd = cwd;

      // ── Verify this is a git repo ─────────────────────────────────────────

      const gitCheck = await pi.exec("git", ["-C", cwd, "rev-parse", "--git-dir"]);
      if (gitCheck.code !== 0) {
        ctx.ui.notify(`No git repository found in ${cwd}`, "error");
        return;
      }

      // ── Gather context ────────────────────────────────────────────────────

      const status = (await pi.exec("git", ["-C", cwd, "status", "--short"])).stdout;

      if (!status.trim()) {
        ctx.ui.notify("No changes to commit", "info");
        return;
      }

      let diff = (await pi.exec("git", ["-C", cwd, "diff", "HEAD"])).stdout;
      if (diff.length > 8000) diff = diff.slice(0, 8000) + "\n\n... (diff truncated)";

      const branch = (
        await pi.exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])
      ).stdout.trim();

      const log = (await pi.exec("git", ["-C", cwd, "log", "--oneline", "-5"])).stdout;

      const isProtected = PROTECTED_BRANCHES.includes(branch);

      // ── Prompt the LLM ───────────────────────────────────────────────────

      const prompt = [
        `Please help commit the current git changes in \`${cwd}\`.`,
        "",
        `**Current branch:** \`${branch}\`${isProtected ? " *(protected)*" : ""}`,
        "",
        "**Git status:**",
        "```",
        status,
        "```",
        "",
        "**Git diff:**",
        "```diff",
        diff,
        "```",
        "",
        "**Recent commits (for style context):**",
        "```",
        log,
        "```",
        "",
        "Please follow this workflow, **in order, waiting at each step**:",
        "",
        "1. First, summarize what changed in terms the user can review. Mention the important files and what the diff accomplishes.",
        "2. In the same response, propose one short, concise commit message focused on what the changes accomplish.",
        "3. Ask the user to review the summary and commit message. If they want changes to the message, revise it and ask again.",
        "4. Treat natural approval of the summary/message as acceptance of the commit message; do not require exact keywords like 'go' or 'LGTM'.",
        "5. If the current branch is protected, message acceptance is not permission to silently commit to that branch. The next step is the interactive protected-branch selector inside `perform_commit`.",
        "6. Once the user accepts the commit message or otherwise asks to commit, call `perform_commit` with the accepted message so the tool can run the protected-branch selector if needed.",
        "7. Do not ask the user to type a branch choice in chat and do not ask for a separate 'go' after message approval.",
        "8. Do not handle protected-branch choices in chat. If the current branch is protected, `perform_commit` will show an interactive arrow-key selection before any commit is made.",
      ].join("\n");

      pi.sendUserMessage(prompt);
    },
  });
}
