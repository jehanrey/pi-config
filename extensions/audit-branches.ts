import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type PullRequest = {
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED" | string;
	mergedAt?: string | null;
	closedAt?: string | null;
	title: string;
	url: string;
	updatedAt: string;
};

type BranchInfo = {
	name: string;
	upstream?: string;
	remoteStatus: string;
	remoteAvailable: boolean;
	lastCommitDate: string;
	lastCommitSubject: string;
	pullRequests: PullRequest[];
	primaryPullRequest?: PullRequest;
	recommendation: string;
	deleteCandidateReason?: string;
};

const REPORT_TYPE = "audit-branches-report";
const DEFAULT_REPO = "trivago/hs-web-app";

function execFailed(result: ExecResult): boolean {
	return result.code !== 0;
}

function trim(value: string): string {
	return value.trim();
}

function formatDate(value: string | undefined | null): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toISOString().slice(0, 10);
}

function escapeMarkdownCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function parseArgs(args: string): { save: boolean; noDelete: boolean; repo: string } {
	const parts = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
		if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
			return part.slice(1, -1);
		}
		return part;
	}) ?? [];

	let repo = DEFAULT_REPO;
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--repo" && parts[i + 1]) repo = parts[i + 1];
	}

	return {
		save: parts.includes("save") || parts.includes("--save"),
		noDelete: parts.includes("--no-delete") || parts.includes("--report-only"),
		repo,
	};
}

async function requireGitRepo(pi: ExtensionAPI, cwd: string): Promise<void> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
	if (execFailed(result)) throw new Error("Current directory is not inside a git repository.");
}

async function fetchAndPrune(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["fetch", "--prune", "origin"], { cwd, timeout: 120_000 });
	if (execFailed(result)) return trim(result.stderr || result.stdout || "git fetch --prune origin failed");
	return undefined;
}

async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 10_000 });
	if (execFailed(result)) return undefined;
	return trim(result.stdout) || undefined;
}

async function getRemoteRefs(pi: ExtensionAPI, cwd: string): Promise<Set<string>> {
	const result = await pi.exec("git", ["for-each-ref", "refs/remotes", "--format=%(refname:short)"], {
		cwd,
		timeout: 10_000,
	});
	if (execFailed(result)) return new Set();
	return new Set(result.stdout.split(/\r?\n/).map(trim).filter(Boolean));
}

async function getLocalBranches(pi: ExtensionAPI, cwd: string): Promise<Array<Omit<BranchInfo, "remoteStatus" | "remoteAvailable" | "pullRequests" | "recommendation">>> {
	const format = "%(refname:short)%09%(upstream:short)%09%(committerdate:iso8601)%09%(subject)";
	const result = await pi.exec("git", ["for-each-ref", "refs/heads", `--format=${format}`], { cwd, timeout: 10_000 });
	if (execFailed(result)) throw new Error(trim(result.stderr || result.stdout || "Failed to list local branches."));

	return result.stdout
		.split(/\r?\n/)
		.map(trim)
		.filter(Boolean)
		.map((line) => {
			const [name = "", upstream = "", lastCommitDate = "", ...subjectParts] = line.split("\t");
			return {
				name,
				upstream: upstream || undefined,
				lastCommitDate,
				lastCommitSubject: subjectParts.join("\t"),
			};
		});
}

function resolveRemoteStatus(branch: { name: string; upstream?: string }, remoteRefs: Set<string>): Pick<BranchInfo, "remoteStatus" | "remoteAvailable"> {
	const matchingOrigin = `origin/${branch.name}`;
	if (remoteRefs.has(matchingOrigin)) {
		return { remoteStatus: `exists (${matchingOrigin})`, remoteAvailable: true };
	}
	if (branch.upstream && remoteRefs.has(branch.upstream)) {
		return { remoteStatus: `exists (${branch.upstream})`, remoteAvailable: true };
	}
	if (branch.upstream) {
		return { remoteStatus: `gone (${branch.upstream})`, remoteAvailable: false };
	}
	return { remoteStatus: "no matching remote", remoteAvailable: false };
}

async function getPullRequests(pi: ExtensionAPI, cwd: string, repo: string, branch: string): Promise<PullRequest[]> {
	const result = await pi.exec(
		"gh",
		[
			"pr",
			"list",
			"--repo",
			repo,
			"--state",
			"all",
			"--head",
			branch,
			"--json",
			"number,state,mergedAt,closedAt,title,url,updatedAt",
			"--limit",
			"20",
		],
		{ cwd, timeout: 30_000 },
	);

	if (execFailed(result)) throw new Error(trim(result.stderr || result.stdout || `Failed to query PRs for ${branch}.`));
	const parsed = JSON.parse(result.stdout || "[]") as PullRequest[];
	return parsed.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function selectPrimaryPullRequest(pullRequests: PullRequest[]): PullRequest | undefined {
	return pullRequests[0];
}

function classify(branch: Omit<BranchInfo, "recommendation" | "deleteCandidateReason">): Pick<BranchInfo, "recommendation" | "deleteCandidateReason"> {
	const pr = branch.primaryPullRequest;
	if (branch.name === "main") return { recommendation: "keep main" };

	if (pr?.state === "OPEN") return { recommendation: "keep: PR open" };
	if (pr?.state === "MERGED") {
		if (!branch.remoteAvailable) {
			return { recommendation: "delete candidate: merged PR, remote gone", deleteCandidateReason: "merged PR; remote gone" };
		}
		return { recommendation: "review: PR merged, remote still exists", deleteCandidateReason: "merged PR; remote still exists" };
	}
	if (pr?.state === "CLOSED") {
		return { recommendation: "delete candidate: PR closed unmerged", deleteCandidateReason: "PR closed unmerged" };
	}
	if (!branch.remoteAvailable && branch.pullRequests.length === 0) {
		return { recommendation: "delete candidate: local only, no PR", deleteCandidateReason: "local only; no PR found" };
	}
	if (branch.pullRequests.length === 0) return { recommendation: "review: no PR found" };
	return { recommendation: "review" };
}

async function auditBranches(pi: ExtensionAPI, cwd: string, repo: string): Promise<{ branches: BranchInfo[]; fetchWarning?: string }> {
	await requireGitRepo(pi, cwd);
	const fetchWarning = await fetchAndPrune(pi, cwd);
	const [remoteRefs, localBranches] = await Promise.all([getRemoteRefs(pi, cwd), getLocalBranches(pi, cwd)]);

	const branches: BranchInfo[] = [];
	for (const localBranch of localBranches) {
		const remote = resolveRemoteStatus(localBranch, remoteRefs);
		const pullRequests = localBranch.name === "main" ? [] : await getPullRequests(pi, cwd, repo, localBranch.name);
		const primaryPullRequest = selectPrimaryPullRequest(pullRequests);
		const base = { ...localBranch, ...remote, pullRequests, primaryPullRequest };
		branches.push({ ...base, ...classify(base) });
	}

	return { branches, fetchWarning };
}

function formatPullRequest(pr: PullRequest | undefined): string {
	if (!pr) return "—";
	const state = pr.state === "MERGED" ? `MERGED ${formatDate(pr.mergedAt)}` : pr.state === "CLOSED" ? `CLOSED ${formatDate(pr.closedAt)}` : pr.state;
	return `[#${pr.number}](${pr.url}) ${state}`;
}

function buildReport(branches: BranchInfo[], repo: string, fetchWarning?: string): string {
	const open = branches.filter((branch) => branch.primaryPullRequest?.state === "OPEN").length;
	const closed = branches.filter((branch) => branch.primaryPullRequest?.state === "CLOSED").length;
	const merged = branches.filter((branch) => branch.primaryPullRequest?.state === "MERGED").length;
	const localOnly = branches.filter((branch) => !branch.remoteAvailable && branch.name !== "main").length;
	const noPr = branches.filter((branch) => branch.name !== "main" && branch.pullRequests.length === 0).length;
	const candidates = branches.filter((branch) => branch.deleteCandidateReason).length;

	const lines = [
		"# Branch Audit",
		"",
		`Generated: ${new Date().toISOString()}`,
		`Repository: ${repo}`,
		"",
		`Summary: ${branches.length} local branches; ${open} open PRs; ${closed} closed PRs; ${merged} merged PRs; ${localOnly} not available remotely; ${noPr} with no PR found; ${candidates} deletion candidates.`,
	];

	if (fetchWarning) {
		lines.push("", `> Warning: \`git fetch --prune origin\` failed or was incomplete: ${escapeMarkdownCell(fetchWarning)}`);
	}

	lines.push(
		"",
		"| Branch | Remote | PR | Last commit | Recommendation |",
		"|---|---|---|---|---|",
	);

	for (const branch of branches) {
		lines.push(
			`| \`${escapeMarkdownCell(branch.name)}\` | ${escapeMarkdownCell(branch.remoteStatus)} | ${formatPullRequest(branch.primaryPullRequest)} | ${escapeMarkdownCell(formatDate(branch.lastCommitDate))}: ${escapeMarkdownCell(branch.lastCommitSubject)} | ${escapeMarkdownCell(branch.recommendation)} |`,
		);
	}

	const deletionCandidates = branches.filter((branch) => branch.deleteCandidateReason);
	lines.push("", "## Deletion candidates", "");
	if (deletionCandidates.length === 0) {
		lines.push("No obvious local branch deletion candidates found.");
	} else {
		for (const branch of deletionCandidates) {
			lines.push(`- [ ] \`${branch.name}\` — ${branch.deleteCandidateReason}`);
		}
	}

	lines.push(
		"",
		"Notes:",
		"- The checkbox list above is a recommendation list only; the interactive picker decides what to delete.",
		"- Deletion only removes local branches with `git branch -D`; remote branches are never deleted by this command.",
		"- Use `/audit-branches --report-only` to skip the deletion picker.",
		"- Use `/audit-branches save` to write `branch-audit.md` in the current working directory.",
	);

	return lines.join("\n");
}

async function chooseBranchesToDelete(ctx: ExtensionCommandContext, candidates: BranchInfo[], currentBranch?: string): Promise<string[] | undefined> {
	if (ctx.mode !== "tui") return undefined;
	if (candidates.length === 0) return [];

	return ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
		let selectedIndex = 0;
		const selectedBranches = new Set<string>();
		let cachedLines: string[] | undefined;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function toggleCurrent() {
			const branch = candidates[selectedIndex];
			if (!branch || branch.name === currentBranch) return;
			if (selectedBranches.has(branch.name)) selectedBranches.delete(branch.name);
			else selectedBranches.add(branch.name);
			refresh();
		}

		function toggleAll() {
			const selectable = candidates.filter((branch) => branch.name !== currentBranch);
			const allSelected = selectable.every((branch) => selectedBranches.has(branch.name));
			if (allSelected) selectedBranches.clear();
			else for (const branch of selectable) selectedBranches.add(branch.name);
			refresh();
		}

		function addWrapped(lines: string[], width: number, prefix: string, text: string) {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= width) {
				lines.push(...wrapTextWithAnsi(prefix + text, width));
				return;
			}
			const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
			const continuationPrefix = " ".repeat(prefixWidth);
			for (let i = 0; i < wrapped.length; i++) {
				lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
			}
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.up)) {
				selectedIndex = Math.max(0, selectedIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				selectedIndex = Math.min(candidates.length - 1, selectedIndex + 1);
				refresh();
				return;
			}
			if (data === " ") {
				toggleCurrent();
				return;
			}
			if (data === "a" || data === "A") {
				toggleAll();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				done(Array.from(selectedBranches));
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done(undefined);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const renderWidth = Math.max(1, width);
			const lines: string[] = [];

			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			addWrapped(lines, renderWidth, " ", theme.fg("text", "Select local branches to delete"));
			addWrapped(lines, renderWidth, " ", theme.fg("muted", "Space toggles • a toggles all • Enter confirms • Esc cancels"));
			lines.push("");

			for (let i = 0; i < candidates.length; i++) {
				const branch = candidates[i];
				const isCurrent = branch.name === currentBranch;
				const isSelected = selectedBranches.has(branch.name);
				const isCursor = i === selectedIndex;
				const cursor = isCursor ? theme.fg("accent", "> ") : "  ";
				const checkbox = isCurrent ? "[-]" : isSelected ? "[x]" : "[ ]";
				const reason = branch.deleteCandidateReason ?? "review";
				const label = `${checkbox} ${branch.name} — ${reason}${isCurrent ? " (current branch; cannot delete)" : ""}`;
				addWrapped(lines, renderWidth, cursor, theme.fg(isCursor ? "accent" : isCurrent ? "dim" : "text", label));
			}

			lines.push("");
			addWrapped(lines, renderWidth, " ", theme.fg("warning", `${selectedBranches.size} branch${selectedBranches.size === 1 ? "" : "es"} selected for local deletion.`));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));

			cachedLines = lines;
			return lines;
		}

		return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
	});
}

export default function auditBranchesExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer(REPORT_TYPE, (message) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
		return new Markdown(content, 0, 0, getMarkdownTheme());
	});

	pi.registerCommand("audit-branches", {
		description: "Audit local git branches against remote refs and GitHub PR state, then optionally delete selected local stale branches.",
		handler: async (args, ctx) => {
			const options = parseArgs(args);
			try {
				ctx.ui.notify("Auditing local branches, remotes, and GitHub PRs...", "info");
				const { branches, fetchWarning } = await auditBranches(pi, ctx.cwd, options.repo);
				const report = buildReport(branches, options.repo, fetchWarning);

				if (options.save) {
					const path = join(ctx.cwd, "branch-audit.md");
					writeFileSync(path, report, "utf8");
					ctx.ui.notify(`Branch audit saved to ${path}`, "info");
				}

				pi.sendMessage({
					customType: REPORT_TYPE,
					content: report,
					display: true,
					details: { generatedAt: Date.now(), branchCount: branches.length },
				});

				if (options.noDelete) {
					ctx.ui.notify("Branch audit complete; deletion picker skipped.", "info");
					return;
				}

				const candidates = branches.filter((branch) => branch.deleteCandidateReason);
				const currentBranch = await getCurrentBranch(pi, ctx.cwd);
				const selected = await chooseBranchesToDelete(ctx, candidates, currentBranch);
				if (!selected) {
					ctx.ui.notify("Branch deletion cancelled.", "info");
					return;
				}
				if (selected.length === 0) {
					ctx.ui.notify("No branches selected for deletion.", "info");
					return;
				}

				const confirmed = await ctx.ui.confirm(
					"Delete selected local branches?",
					`This will run git branch -D for:\n${selected.map((branch) => `- ${branch}`).join("\n")}\n\nRemote branches will not be deleted.`,
				);
				if (!confirmed) {
					ctx.ui.notify("Branch deletion cancelled.", "info");
					return;
				}

				const deleted: string[] = [];
				const failed: string[] = [];
				for (const branch of selected) {
					const result = await pi.exec("git", ["branch", "-D", branch], { cwd: ctx.cwd, timeout: 30_000 });
					if (execFailed(result)) failed.push(`${branch}: ${trim(result.stderr || result.stdout || "failed")}`);
					else deleted.push(branch);
				}

				const deletionReport = [
					"# Branch deletion result",
					"",
					deleted.length > 0 ? `Deleted local branches:\n${deleted.map((branch) => `- \`${branch}\``).join("\n")}` : "No branches deleted.",
					failed.length > 0 ? `\nFailures:\n${failed.map((failure) => `- ${escapeMarkdownCell(failure)}`).join("\n")}` : "",
				]
					.filter(Boolean)
					.join("\n");

				pi.sendMessage({
					customType: REPORT_TYPE,
					content: deletionReport,
					display: true,
					details: { deleted, failed },
				});
				ctx.ui.notify(`Deleted ${deleted.length} local branch${deleted.length === 1 ? "" : "es"}.`, failed.length > 0 ? "warning" : "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Branch audit failed: ${message}`, "error");
				pi.sendMessage({
					customType: REPORT_TYPE,
					content: `# Branch Audit Failed\n\n${message}`,
					display: true,
					details: { error: message },
				});
			}
		},
	});
}
