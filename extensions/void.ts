import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = path.join(homedir(), ".pi", "agent", "void.json");
const DEFAULT_VOID_DIR = "~/void";

type VoidConfig = {
	version: 1;
	voidDir: string;
};

type ParsedArgs = {
	command?: string;
	path?: string;
};

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

function portablePath(value: string): string {
	const home = homedir();
	if (value === home) return "~";
	if (value.startsWith(`${home}${path.sep}`)) return `~/${value.slice(home.length + 1).split(path.sep).join("/")}`;
	return value;
}

function resolveVoidDir(value: string): string {
	return path.resolve(expandHome(value));
}

function parseArgs(args: string): ParsedArgs {
	const parts = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
		if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
			return part.slice(1, -1);
		}
		return part;
	}) ?? [];

	return {
		command: parts[0],
		path: parts.slice(1).join(" ") || undefined,
	};
}

async function loadConfig(): Promise<VoidConfig | undefined> {
	if (!existsSync(CONFIG_PATH)) return undefined;
	const parsed = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Partial<VoidConfig>;
	if (parsed.version !== 1 || typeof parsed.voidDir !== "string" || parsed.voidDir.trim() === "") {
		throw new Error(`Invalid void config: ${CONFIG_PATH}`);
	}
	return { version: 1, voidDir: parsed.voidDir };
}

async function saveConfig(voidDir: string): Promise<VoidConfig> {
	const config: VoidConfig = { version: 1, voidDir: resolveVoidDir(voidDir) };
	await mkdir(path.dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n");
	return config;
}

async function promptForVoidDir(ctx: ExtensionCommandContext): Promise<string | undefined> {
	const current = ctx.cwd;
	const defaultDir = resolveVoidDir(DEFAULT_VOID_DIR);
	const currentChoice = `Use current directory: ${portablePath(current)}`;
	const defaultChoice = `Create/use default: ${DEFAULT_VOID_DIR}`;
	const customChoice = "Enter custom path...";
	const cancelChoice = "Cancel";

	const choice = await ctx.ui.select("No void directory configured. Where should /void go?", [
		currentChoice,
		defaultChoice,
		customChoice,
		cancelChoice,
	]);

	if (!choice || choice === cancelChoice) return undefined;
	if (choice === currentChoice) return current;
	if (choice === defaultChoice) return defaultDir;

	const custom = await ctx.ui.input("Void directory", "~/void");
	if (!custom || custom.trim() === "") return undefined;
	return resolveVoidDir(custom.trim());
}

async function configureVoidDir(ctx: ExtensionCommandContext, requestedPath?: string): Promise<VoidConfig | undefined> {
	const selected = requestedPath && requestedPath.trim() ? resolveVoidDir(requestedPath.trim()) : await promptForVoidDir(ctx);
	if (!selected) return undefined;
	const config = await saveConfig(selected);
	await mkdir(config.voidDir, { recursive: true });
	return config;
}

async function navigateToVoid(ctx: ExtensionCommandContext, voidDir: string): Promise<void> {
	const target = resolveVoidDir(voidDir);
	await mkdir(target, { recursive: true });

	if (path.resolve(ctx.cwd) === target) {
		ctx.ui.notify(`Already in void: ${portablePath(target)}`, "info");
		return;
	}

	const sessionManager = SessionManager.create(target);
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error(`Could not create a void session for ${target}`);

	await ctx.switchSession(sessionFile, {
		withSession: async (ctx) => {
			ctx.ui.notify(`Entered void: ${portablePath(target)}`, "info");
		},
	});
}

export default function voidExtension(pi: ExtensionAPI) {
	pi.registerCommand("void", {
		description: "Navigate to your configured per-device void directory.",
		handler: async (rawArgs, ctx) => {
			try {
				const args = parseArgs(rawArgs ?? "");

				if (args.command === "help") {
					ctx.ui.notify("Usage: /void | /void set [path] | /void show | /void reset", "info");
					return;
				}

				if (args.command === "show") {
					const config = await loadConfig();
					ctx.ui.notify(config ? `Void directory: ${portablePath(config.voidDir)}\nConfig: ${CONFIG_PATH}` : `No void directory configured. Run /void or /void set [path].\nConfig: ${CONFIG_PATH}`, "info");
					return;
				}

				if (args.command === "reset") {
					await rm(CONFIG_PATH, { force: true });
					ctx.ui.notify("Void directory config reset. Run /void to configure it again.", "info");
					return;
				}

				if (args.command === "set") {
					const config = await configureVoidDir(ctx, args.path);
					if (config) ctx.ui.notify(`Void directory set to ${portablePath(config.voidDir)}\nConfig: ${CONFIG_PATH}`, "info");
					return;
				}

				if (args.command) {
					// Treat `/void ~/path` as a convenient alias for `/void set ~/path`.
					const requestedPath = [args.command, args.path].filter(Boolean).join(" ");
					const config = await configureVoidDir(ctx, requestedPath);
					if (config) await navigateToVoid(ctx, config.voidDir);
					return;
				}

				const config = await loadConfig() ?? await configureVoidDir(ctx);
				if (!config) return;
				await navigateToVoid(ctx, config.voidDir);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
