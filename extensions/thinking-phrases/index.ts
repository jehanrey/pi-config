import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PHRASES_FILE = `${EXTENSION_DIR}/phrases.txt`;
const ROTATE_EVERY_MS = 5_000;
const SHIMMER_EVERY_MS = 40;
const SHIMMER_BAND_WIDTH = 4;

const DEFAULT_PHRASES = [
	"Thinking through the shape of this...",
	"Checking the edges...",
	"Looking for the simplest path...",
	"Reading between the lines...",
	"Testing assumptions...",
	"Tracing the thread...",
];

function ensurePhrasesFile() {
	if (!existsSync(PHRASES_FILE)) {
		writeFileSync(PHRASES_FILE, `${DEFAULT_PHRASES.join("\n")}\n`, "utf8");
	}
}

function readPhrases(): string[] {
	ensurePhrasesFile();

	const phrases = readFileSync(PHRASES_FILE, "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));

	return phrases.length > 0 ? phrases : DEFAULT_PHRASES;
}

function shimmerPhrase(ctx: ExtensionContext, phrase: string, step: number): string {
	const chars = [...phrase];
	const cycleLength = chars.length + SHIMMER_BAND_WIDTH * 2;
	const lead = step % cycleLength;
	const highlightStart = lead - SHIMMER_BAND_WIDTH;
	const highlightEnd = highlightStart + SHIMMER_BAND_WIDTH;

	const before = chars.slice(0, Math.max(0, highlightStart)).join("");
	const highlight = chars.slice(Math.max(0, highlightStart), Math.min(chars.length, highlightEnd)).join("");
	const after = chars.slice(Math.min(chars.length, highlightEnd)).join("");

	return [
		before ? ctx.ui.theme.fg("accent", before) : "",
		highlight ? ctx.ui.theme.fg("text", highlight) : "",
		after ? ctx.ui.theme.fg("accent", after) : "",
	].join("");
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
}

function truncateDetail(text: string, maxLength = 56): string {
	const clean = stripAnsi(text).replace(/\s+/g, " ").trim();
	return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;

	if (minutes === 0) {
		return `${seconds}s`;
	}

	return `${minutes}m ${remainingSeconds}s`;
}

function describeTool(toolName: string, args: any): string {
	if (toolName === "bash" && typeof args?.command === "string") {
		return truncateDetail(`running bash: ${args.command.split("\n")[0]}`);
	}

	if (typeof args?.path === "string") {
		return truncateDetail(`${toolName}: ${args.path}`);
	}

	if (typeof args?.pattern === "string") {
		return truncateDetail(`${toolName}: ${args.pattern}`);
	}

	return truncateDetail(`running ${toolName}`);
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let index = 0;
	let shimmerStep = 0;
	let startedAt = 0;
	const activeTools = new Map<string, string>();

	function stop(ctx?: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}

		index = 0;
		shimmerStep = 0;
		startedAt = 0;
		activeTools.clear();
		ctx?.ui.setWorkingMessage();
		ctx?.ui.setWorkingIndicator();
	}

	function renderMessage(ctx: ExtensionContext, phrase: string) {
		const elapsed = startedAt > 0 ? formatElapsed(Date.now() - startedAt) : "0s";
		const toolDetails = [...activeTools.values()].at(-1);
		const details = toolDetails ? `${elapsed} · ${toolDetails}` : elapsed;
		ctx.ui.setWorkingMessage(`${shimmerPhrase(ctx, phrase, shimmerStep)} ${ctx.ui.theme.fg("muted", `(${details})`)}`);
	}

	function start(ctx: ExtensionContext) {
		stop(ctx);

		const phrases = readPhrases();
		startedAt = Date.now();

		ctx.ui.setWorkingIndicator();
		renderMessage(ctx, phrases[0]);

		timer = setInterval(() => {
			index = Math.floor((Date.now() - startedAt) / ROTATE_EVERY_MS) % phrases.length;
			shimmerStep += 1;
			renderMessage(ctx, phrases[index]);
		}, SHIMMER_EVERY_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		ensurePhrasesFile();
		ctx.ui.setWorkingIndicator();
	});

	pi.on("agent_start", async (_event, ctx) => {
		start(ctx);
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		activeTools.set(event.toolCallId, describeTool(event.toolName, event.args));
	});

	pi.on("tool_execution_end", async (event, _ctx) => {
		activeTools.delete(event.toolCallId);
	});

	pi.on("agent_end", async (_event, ctx) => {
		stop(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stop(ctx);
	});

	pi.registerCommand("thinking-phrases", {
		description: "Show where the rotating thinking phrases are stored.",
		handler: async (_args, ctx) => {
			const count = readPhrases().length;
			ctx.ui.notify(`Thinking phrases: ${count} loaded from ${PHRASES_FILE}`, "info");
		},
	});
}
