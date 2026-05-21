import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PHRASES_FILE = `${EXTENSION_DIR}/phrases.txt`;
const ROTATE_EVERY_MS = 2_000;

const DEFAULT_PHRASES = [
	"Thinking through the shape of this...",
	"Checking the edges...",
	"Looking for the simplest path...",
	"Reading between the lines...",
	"Testing assumptions...",
	"Tracing the thread...",
];

const SPINNER: WorkingIndicatorOptions = {
	frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	intervalMs: 80,
};

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

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let index = 0;

	function stop(ctx?: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}

		index = 0;
		ctx?.ui.setWorkingMessage();
	}

	function start(ctx: ExtensionContext) {
		stop(ctx);

		const phrases = readPhrases();
		ctx.ui.setWorkingIndicator(SPINNER);
		ctx.ui.setWorkingMessage(phrases[0]);

		timer = setInterval(() => {
			index = (index + 1) % phrases.length;
			ctx.ui.setWorkingMessage(phrases[index]);
		}, ROTATE_EVERY_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		ensurePhrasesFile();
		ctx.ui.setWorkingIndicator(SPINNER);
	});

	pi.on("agent_start", async (_event, ctx) => {
		start(ctx);
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
