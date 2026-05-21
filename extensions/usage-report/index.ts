import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
};

type UsageEvent = Usage & {
	app: "Pi" | "Codex CLI";
	provider: string;
	model: string;
	timestamp: number;
	inputIncludesCacheRead: boolean;
};

type Group = Usage & {
	app: string;
	provider: string;
	model: string;
	turns: number;
	price?: number;
	pricingFound: boolean;
	inputIncludesCacheRead: boolean;
};

type ModelCost = {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
};

type ModelsDev = Record<string, { models?: Record<string, { id?: string; name?: string; cost?: ModelCost }> }>;

const WINDOWS = [1, 7, 30, 90] as const;
const MODELS_DEV_URL = "https://models.dev/api.json";

function walkFiles(dir: string, predicate: (path: string) => boolean): string[] {
	if (!existsSync(dir)) return [];

	const out: string[] = [];
	const stack = [dir];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.isFile() && predicate(path)) out.push(path);
		}
	}
	return out;
}

function parseTimestamp(value: unknown): number | undefined {
	if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
	if (typeof value === "string") {
		const time = Date.parse(value);
		return Number.isFinite(time) ? time : undefined;
	}
	return undefined;
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseJsonLines(path: string): unknown[] {
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

function collectPiEvents(): UsageEvent[] {
	const dir = join(homedir(), ".pi/agent/sessions");
	const files = walkFiles(dir, (path) => path.endsWith(".jsonl"));
	const events: UsageEvent[] = [];

	for (const file of files) {
		for (const entry of parseJsonLines(file) as any[]) {
			const message = entry?.message;
			if (entry?.type !== "message" || message?.role !== "assistant" || !message?.usage) continue;

			const usage = message.usage;
			const input = asNumber(usage.input);
			const output = asNumber(usage.output);
			const cacheRead = asNumber(usage.cacheRead ?? usage.cache_read);
			const cacheWrite = asNumber(usage.cacheWrite ?? usage.cache_write);
			const total = asNumber(usage.totalTokens ?? usage.total_tokens) || input + output;
			const timestamp = parseTimestamp(entry.timestamp ?? message.timestamp);
			if (!timestamp) continue;

			events.push({
				app: "Pi",
				provider: String(message.provider ?? "unknown"),
				model: String(message.model ?? "unknown"),
				timestamp,
				input,
				output,
				cacheRead,
				cacheWrite,
				total,
				inputIncludesCacheRead: false,
			});
		}
	}

	return events;
}

function collectCodexEvents(): UsageEvent[] {
	const dir = join(homedir(), ".codex/sessions");
	const files = walkFiles(dir, (path) => path.endsWith(".jsonl"));
	const events: UsageEvent[] = [];

	for (const file of files) {
		let provider = "openai";
		let model = "unknown";
		let previousTotal: number | undefined;

		for (const entry of parseJsonLines(file) as any[]) {
			if (entry?.type === "session_meta") {
				provider = String(entry.payload?.model_provider ?? provider);
			}

			if (entry?.type === "turn_context" && entry.payload?.model) {
				model = String(entry.payload.model);
			}

			const payload = entry?.payload;
			if (entry?.type !== "event_msg" || payload?.type !== "token_count" || !payload.info?.last_token_usage) continue;

			const totalUsage = payload.info.total_token_usage;
			const lastUsage = payload.info.last_token_usage;
			const currentTotal = asNumber(totalUsage?.total_tokens);

			// Codex often repeats the previous token_count at the start of the next turn.
			// Count only records where cumulative total changed.
			if (currentTotal > 0 && currentTotal === previousTotal) continue;
			if (currentTotal > 0) previousTotal = currentTotal;

			const input = asNumber(lastUsage.input_tokens);
			const output = asNumber(lastUsage.output_tokens);
			const cacheRead = asNumber(lastUsage.cached_input_tokens);
			const total = asNumber(lastUsage.total_tokens) || input + output;
			const timestamp = parseTimestamp(entry.timestamp);
			if (!timestamp || total === 0) continue;

			events.push({
				app: "Codex CLI",
				provider,
				model,
				timestamp,
				input,
				output,
				cacheRead,
				cacheWrite: 0,
				total,
				inputIncludesCacheRead: true,
			});
		}
	}

	return events;
}

function fetchJson(url: string): Promise<ModelsDev> {
	return new Promise((resolve, reject) => {
		get(url, { rejectUnauthorized: false }, (res) => {
			if ((res.statusCode ?? 500) >= 400) {
				reject(new Error(`models.dev returned HTTP ${res.statusCode}`));
				res.resume();
				return;
			}
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			res.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				} catch (error) {
					reject(error);
				}
			});
		}).on("error", reject);
	});
}

function providerAliases(provider: string): string[] {
	const normalized = provider.toLowerCase();
	const aliases = [normalized];
	if (normalized === "openai-codex") aliases.push("openai");
	if (normalized === "codex") aliases.push("openai");
	return aliases;
}

function modelAliases(model: string): string[] {
	const normalized = model.toLowerCase();
	const dashed = normalized.replace(/\./g, "-");
	const noProvider = normalized.includes("/") ? normalized.split("/").at(-1)! : normalized;
	return Array.from(new Set([normalized, dashed, noProvider, noProvider.replace(/\./g, "-")]));
}

function findPricing(data: ModelsDev, provider: string, model: string): ModelCost | undefined {
	const providers = providerAliases(provider);
	const models = modelAliases(model);

	for (const providerId of providers) {
		const providerModels = data[providerId]?.models;
		if (!providerModels) continue;
		for (const modelId of models) {
			const direct = providerModels[modelId]?.cost;
			if (direct) return direct;
		}
		for (const modelInfo of Object.values(providerModels)) {
			const id = String(modelInfo.id ?? "").toLowerCase();
			const name = String(modelInfo.name ?? "").toLowerCase();
			if (models.includes(id) || models.includes(name)) return modelInfo.cost;
		}
	}

	for (const providerInfo of Object.values(data)) {
		for (const modelInfo of Object.values(providerInfo.models ?? {})) {
			const id = String(modelInfo.id ?? "").toLowerCase();
			const name = String(modelInfo.name ?? "").toLowerCase();
			if (models.includes(id) || models.includes(name)) return modelInfo.cost;
		}
	}

	return undefined;
}

function priceUsage(group: Usage, pricing?: ModelCost): number | undefined {
	if (!pricing) return undefined;
	const inputRate = pricing.input ?? 0;
	const outputRate = pricing.output ?? 0;
	const cacheReadRate = pricing.cache_read ?? inputRate;
	const cacheWriteRate = pricing.cache_write ?? inputRate;
	const nonCachedInput = group.inputIncludesCacheRead ? Math.max(0, group.input - group.cacheRead) : group.input;
	return (
		nonCachedInput * inputRate +
		group.output * outputRate +
		group.cacheRead * cacheReadRate +
		group.cacheWrite * cacheWriteRate
	) / 1_000_000;
}

function fmtInt(value: number): string {
	return Math.round(value).toLocaleString("en-US");
}

function fmtUsd(value: number | undefined): string {
	return value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

function buildWindowTable(events: UsageEvent[], data: ModelsDev, days: number): string {
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	const groups = new Map<string, Group>();

	for (const event of events) {
		if (event.timestamp < cutoff) continue;
		const key = `${event.app}\u0000${event.provider}\u0000${event.model}`;
		const group = groups.get(key) ?? {
			app: event.app,
			provider: event.provider,
			model: event.model,
			turns: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			pricingFound: false,
			inputIncludesCacheRead: event.inputIncludesCacheRead,
		};
		group.turns += 1;
		group.input += event.input;
		group.output += event.output;
		group.cacheRead += event.cacheRead;
		group.cacheWrite += event.cacheWrite;
		group.total += event.total;
		groups.set(key, group);
	}

	for (const group of groups.values()) {
		const pricing = findPricing(data, group.provider, group.model);
		group.price = priceUsage(group, pricing);
		group.pricingFound = Boolean(pricing);
	}

	const rows = Array.from(groups.values()).sort((a, b) => a.app.localeCompare(b.app) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
	const total: Group = {
		app: "Grand total",
		provider: "—",
		model: "—",
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		price: 0,
		pricingFound: true,
		inputIncludesCacheRead: false,
	};

	for (const row of rows) {
		total.turns += row.turns;
		total.input += row.input;
		total.output += row.output;
		total.cacheRead += row.cacheRead;
		total.cacheWrite += row.cacheWrite;
		total.total += row.total;
		if (row.price === undefined) total.pricingFound = false;
		else total.price = (total.price ?? 0) + row.price;
	}

	const lines = [
		`## Last ${days} day${days === 1 ? "" : "s"}`,
		"",
		"| App | Provider/model | Turns | In | Out | Cached | Total | USD |",
		"|---|---:|---:|---:|---:|---:|---:|---:|",
	];

	for (const row of rows) {
		lines.push(
			`| ${row.app} | ${row.provider}/${row.model} | ${fmtInt(row.turns)} | ${fmtInt(row.input)} | ${fmtInt(row.output)} | ${fmtInt(row.cacheRead)} | ${fmtInt(row.total)} | ${fmtUsd(row.price)} |`,
		);
	}

	lines.push(
		`| **Grand total** | — | **${fmtInt(total.turns)}** | **${fmtInt(total.input)}** | **${fmtInt(total.output)}** | **${fmtInt(total.cacheRead)}** | **${fmtInt(total.total)}** | **${fmtUsd(total.price)}${total.pricingFound ? "" : " + n/a"}** |`,
	);

	if (rows.length === 0) lines.push("\n_No usage found in this window._");
	return lines.join("\n");
}

async function buildReport(): Promise<string> {
	const [pricing, events] = await Promise.all([fetchJson(MODELS_DEV_URL), Promise.resolve([...collectPiEvents(), ...collectCodexEvents()])]);
	const generatedAt = new Date().toISOString();
	const body = WINDOWS.map((days) => buildWindowTable(events, pricing, days)).join("\n\n");
	return `# Pi Usage Report\n\nGenerated: ${generatedAt}\n\nPricing source: ${MODELS_DEV_URL}\n\n${body}\n\nNotes:\n- Pi rows count assistant messages with recorded usage.\n- Codex CLI rows count token usage records whose cumulative total changed; repeated startup token_count records are ignored.\n- Prices are estimated from models.dev per-million-token prices. Cached input/read tokens are priced with \`cache_read\` when available.\n`;
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer("usage-report", (message) => {
		const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
		return new Markdown(content, 0, 0, getMarkdownTheme());
	});

	pi.registerCommand("usage-report", {
		description: "Generate a Markdown token/cost usage report for Pi and Codex CLI sessions over 1, 7, 30, and 90 days. Use 'save' to write pi-usage-report.md.",
		handler: async (args, ctx) => {
			try {
				ctx.ui.notify("Generating usage report from Pi/Codex sessions and models.dev pricing...", "info");
				const report = await buildReport();
				const trimmedArgs = args.trim();
				if (trimmedArgs === "save") {
					const path = join(ctx.cwd, "pi-usage-report.md");
					writeFileSync(path, report, "utf8");
					ctx.ui.notify(`Usage report saved to ${path}`, "info");
					return;
				}
				pi.sendMessage({
					customType: "usage-report",
					content: report,
					display: true,
					details: { generatedAt: Date.now() },
				});
				ctx.ui.notify("Usage report generated. Use /usage-report save to write pi-usage-report.md.", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Usage report failed: ${message}`, "error");
			}
		},
	});
}
