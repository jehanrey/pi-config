import { randomInt } from "node:crypto";
import { complete, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type AvailableModel = NonNullable<ExtensionCommandContext["model"]>;

const PREFERRED_MODELS = [
	["github-copilot", "gemini-3.5-flash"],
	["github-copilot", "claude-haiku-4.5"],
	["github-copilot", "gpt-5-mini"],
	["google", "gemini-2.5-flash"],
	["anthropic", "claude-haiku-4-5"],
	["openai", "gpt-5-mini"],
] as const;

const NAME_PROMPT = `Invent one whimsical Git branch name.

Return exactly two lowercase English words separated by one hyphen: adjective-noun.
Choose an unusual, vivid adjective and a concrete noun. The result should feel unique, weird, indie, hip, quirky, or cute—something that causes a small internal chuckle.

Return only the branch name. No quotes, explanation, punctuation, or Markdown.`;

const ADJECTIVES = [
	"bashful",
	"bumbling",
	"cosmic",
	"dinky",
	"drowsy",
	"fizzy",
	"fluffy",
	"giddy",
	"haunted",
	"inky",
	"jolly",
	"lopsided",
	"merry",
	"moonlit",
	"mossy",
	"nifty",
	"noisy",
	"peculiar",
	"pocket",
	"polite",
	"sleepy",
	"soggy",
	"sparkly",
	"tiny",
	"velvety",
	"wobbly",
	"wonky",
	"zesty",
] as const;

const NOUNS = [
	"axolotl",
	"badger",
	"banjo",
	"biscuit",
	"cardigan",
	"dumpling",
	"ferret",
	"goose",
	"kazoo",
	"marmalade",
	"moth",
	"mushroom",
	"otter",
	"pebble",
	"pickle",
	"possum",
	"puddle",
	"raccoon",
	"sardine",
	"teacup",
	"turnip",
	"walrus",
	"waffle",
	"weevil",
] as const;

function randomItem<T>(items: readonly T[]): T {
	return items[randomInt(items.length)];
}

function makeBranchName(): string {
	return `${randomItem(ADJECTIVES)}-${randomItem(NOUNS)}`;
}

function branchNameExists(name: string, refs: string[]): boolean {
	return refs.some((ref) => ref === name || ref.endsWith(`/${name}`));
}

function parseModelName(text: string): string | undefined {
	const match = text.trim().match(/^([a-z]{2,20}-[a-z]{2,20})$/i);
	return match?.[1].toLowerCase();
}

async function findAvailableModel(ctx: ExtensionCommandContext): Promise<{
	model: AvailableModel;
	auth: { apiKey: string; headers?: Record<string, string>; env?: Record<string, string> };
} | undefined> {
	const preferred = PREFERRED_MODELS.map(([provider, id]) => ctx.modelRegistry.find(provider, id)).filter(
		(model): model is AvailableModel => model !== undefined,
	);
	const candidates = [...preferred, ...(ctx.model ? [ctx.model] : [])].filter(
		(model, index, models) =>
			models.findIndex((other) => other.provider === model.provider && other.id === model.id) === index,
	);

	for (const model of candidates) {
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (auth.ok && auth.apiKey) return { model, auth };
		} catch {
			// Try the next model; local name generation remains the final fallback.
		}
	}

	return undefined;
}

async function generateModelName(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const available = await findAvailableModel(ctx);
	if (!available) return undefined;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8_000);
	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: `${NAME_PROMPT}\n\nCreative seed: ${randomInt(1_000_000)}` }],
		timestamp: Date.now(),
	};

	try {
		const response = await complete(
			available.model,
			{ messages: [message] },
			{
				apiKey: available.auth.apiKey,
				headers: available.auth.headers,
				env: available.auth.env,
				signal: controller.signal,
			},
		);
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
		return parseModelName(text);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function generateLocalName(refs: string[]): string | undefined {
	for (let attempt = 0; attempt < 100; attempt++) {
		const candidate = makeBranchName();
		if (!branchNameExists(candidate, refs)) return candidate;
	}
	return undefined;
}

export default function sproutExtension(pi: ExtensionAPI) {
	pi.registerCommand("sprout", {
		description: "Create and switch to a whimsically named Git branch.",
		handler: async (_args, ctx) => {
			const repoCheck = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
				cwd: ctx.cwd,
				timeout: 10_000,
			});

			if (repoCheck.code !== 0) {
				ctx.ui.notify("Cannot sprout here: the current directory is not inside a Git repository.", "warning");
				return;
			}

			const refsResult = await pi.exec(
				"git",
				["for-each-ref", "refs/heads", "refs/remotes", "--format=%(refname:strip=2)"],
				{ cwd: ctx.cwd, timeout: 10_000 },
			);

			if (refsResult.code !== 0) {
				const reason = (refsResult.stderr || refsResult.stdout).trim() || "could not inspect existing branches";
				ctx.ui.notify(`Could not sprout a branch: ${reason}`, "error");
				return;
			}

			const refs = refsResult.stdout.split(/\r?\n/).filter(Boolean);
			const modelName = await generateModelName(ctx);
			const branchName = modelName && !branchNameExists(modelName, refs) ? modelName : generateLocalName(refs);

			if (!branchName) {
				ctx.ui.notify("Could not find an unused whimsical branch name. The garden may be full.", "error");
				return;
			}

			const result = await pi.exec("git", ["switch", "-c", branchName], {
				cwd: ctx.cwd,
				timeout: 30_000,
			});

			if (result.code !== 0) {
				const reason = (result.stderr || result.stdout).trim() || "git switch failed";
				ctx.ui.notify(`Failed to sprout ${branchName}: ${reason}`, "error");
				return;
			}

			ctx.ui.notify(`🌱 Sprouted ${branchName}`, "info");
		},
	});
}
