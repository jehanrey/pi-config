/**
 * git-commit extension
 *
 * Registers /git-commit [--push] — inspects git changes in the current repo,
 * asks the LLM to propose a commit message, discusses it with the user, handles
 * branch creation when on a protected branch, and commits (and optionally pushes)
 * only after the user gives the go-ahead.
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

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── Tool ───────────────────────────────────────────────────────────────────
  // Called by the LLM only after the user has given the go-ahead.

  pi.registerTool({
    name: "perform_commit",
    label: "Commit",
    description:
      "Performs the git commit (and optional push) after the user has approved " +
      "the commit message. Only call this when the user explicitly gives the go-ahead.",
    parameters: Type.Object({
      message: Type.String({ description: "The agreed commit message" }),
      newBranch: Type.Optional(
        Type.String({
          description: "Branch to create before committing, if on a protected branch",
        })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = pendingRepoCwd ?? ctx.cwd;
      const push = pendingPush;
      const steps: string[] = [];

      try {
        if (params.newBranch) {
          const r = await pi.exec("git", ["-C", cwd, "checkout", "-b", params.newBranch]);
          if (r.code !== 0) throw new Error(r.stderr || "Failed to create branch");
          steps.push(`✓ Created branch: ${params.newBranch}`);
        }

        const add = await pi.exec("git", ["-C", cwd, "add", "-A"]);
        if (add.code !== 0) throw new Error(add.stderr || "git add -A failed");
        steps.push("✓ Staged all changes");

        const commit = await pi.exec("git", ["-C", cwd, "commit", "-m", params.message]);
        if (commit.code !== 0) throw new Error(commit.stderr || "git commit failed");
        steps.push(`✓ Committed: "${params.message}"`);

        if (push) {
          const pushArgs = params.newBranch
            ? ["-C", cwd, "push", "-u", "origin", params.newBranch]
            : ["-C", cwd, "push"];
          const r = await pi.exec("git", pushArgs);
          if (r.code !== 0) throw new Error(r.stderr || "git push failed");
          steps.push(`✓ Pushed to origin`);
        }

        ctx.ui.notify("Done!", "info");
        return {
          content: [{ type: "text", text: steps.join("\n") }],
          details: { steps, message: params.message, branch: params.newBranch },
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
        "Please do the following, **in order, waiting at each step**:",
        "",
        "1. Propose a short, concise commit message focused on what the changes accomplish.",
        ...(isProtected
          ? [
              `2. Since we're on the protected branch \`${branch}\`, suggest a branch name and ask the user to confirm it or provide their own. If the user enters a blank name, choose one yourself.`,
              "3. Wait for the user to say **go** before calling `perform_commit`.",
            ]
          : ["2. Wait for the user to say **go** before calling `perform_commit`."]),
      ].join("\n");

      pi.sendUserMessage(prompt);
    },
  });
}
