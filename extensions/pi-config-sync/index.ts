import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, copyFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTENSION_CONFIG = path.join(homedir(), ".pi", "agent", "pi-config-sync.json");
const DEFAULT_CONFIG_DIR = path.join(homedir(), ".pi", "agent");
const BACKUP_DIR_NAME = "config-sync-backups";
const REPO_MANIFEST = "pi-config-sync.manifest.json";
const DEFAULT_REPO_PATH = "~/pi-config-sync";

const MANAGED_FILES = [
	"settings.json",
	"keybindings.json",
	"AGENTS.md",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"models.json",
];

const MANAGED_DIRS = ["prompts", "skills", "extensions", "themes"];

const EXCLUDED_PATHS = new Set([
	"auth.json",
	"sessions",
	"bin",
	"git",
	"npm",
	"node_modules",
	BACKUP_DIR_NAME,
]);

type SyncConfig = {
	version: 1;
	repoPath: string;
	configDir: string;
};

type FileMap = Map<string, string>;

type PlannedChanges = {
	added: string[];
	modified: string[];
	deleted: string[];
};

type ParsedArgs = {
	command?: string;
	path?: string;
	dryRun: boolean;
	yes: boolean;
};

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

function rel(from: string, to: string): string {
	return path.relative(from, to).split(path.sep).join("/");
}

function parseArgs(args: string): ParsedArgs {
	const parts = args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => {
		if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
			return part.slice(1, -1);
		}
		return part;
	}) ?? [];

	const command = parts[0];
	const flags = new Set(parts.filter((part) => part.startsWith("--")));
	const positional = parts.slice(1).filter((part) => !part.startsWith("--"));
	return {
		command,
		path: positional[0],
		dryRun: flags.has("--dry-run"),
		yes: flags.has("--yes") || flags.has("-y"),
	};
}

async function loadConfig(): Promise<SyncConfig | undefined> {
	if (!existsSync(EXTENSION_CONFIG)) return undefined;
	return JSON.parse(await readFile(EXTENSION_CONFIG, "utf8")) as SyncConfig;
}

async function saveConfig(config: SyncConfig): Promise<void> {
	await mkdir(path.dirname(EXTENSION_CONFIG), { recursive: true });
	await writeFile(EXTENSION_CONFIG, JSON.stringify(config, null, "\t") + "\n");
}

async function ensureConfigured(): Promise<SyncConfig> {
	const config = await loadConfig();
	if (!config) throw new Error("Run /pi-config init <repo-path> first.");
	return config;
}

function shouldExclude(relativePath: string): boolean {
	if (MANAGED_FILES.includes(relativePath)) return false;
	const parts = relativePath.split("/");
	if (parts.some((part) => EXCLUDED_PATHS.has(part))) return true;
	const base = parts[parts.length - 1]?.toLowerCase() ?? "";
	if (base === ".env" || base.startsWith(".env.")) return true;
	if (base.includes("secret") || base.includes("token") || base.includes("key")) return true;
	return false;
}

async function walkFiles(base: string, relativeDir: string, out: string[]): Promise<void> {
	const fullDir = path.join(base, relativeDir);
	if (!existsSync(fullDir)) return;
	for (const entry of await readdir(fullDir, { withFileTypes: true })) {
		const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
		if (shouldExclude(relativePath)) continue;
		if (entry.isDirectory()) {
			await walkFiles(base, relativePath, out);
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			out.push(relativePath);
		}
	}
}

async function listManagedFiles(base: string): Promise<string[]> {
	const files: string[] = [];
	for (const file of MANAGED_FILES) {
		if (!shouldExclude(file) && existsSync(path.join(base, file))) files.push(file);
	}
	for (const dir of MANAGED_DIRS) {
		if (!shouldExclude(dir)) await walkFiles(base, dir, files);
	}
	return Array.from(new Set(files)).sort();
}

async function hashFile(file: string): Promise<string> {
	return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function fileMap(base: string): Promise<FileMap> {
	const map: FileMap = new Map();
	for (const file of await listManagedFiles(base)) {
		map.set(file, await hashFile(path.join(base, file)));
	}
	return map;
}

function planChanges(source: FileMap, target: FileMap): PlannedChanges {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];

	for (const [file, hash] of source) {
		if (!target.has(file)) added.push(file);
		else if (target.get(file) !== hash) modified.push(file);
	}
	for (const file of target.keys()) {
		if (!source.has(file)) deleted.push(file);
	}

	return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

function hasChanges(changes: PlannedChanges): boolean {
	return changes.added.length > 0 || changes.modified.length > 0 || changes.deleted.length > 0;
}

function formatChanges(title: string, changes: PlannedChanges): string {
	const lines = [title];
	for (const [label, files] of [
		["Added", changes.added],
		["Modified", changes.modified],
		["Deleted", changes.deleted],
	] as const) {
		if (files.length === 0) continue;
		lines.push("", `${label}:`);
		for (const file of files) lines.push(`  ${file}`);
	}
	if (!hasChanges(changes)) lines.push("", "No managed config changes.");
	return lines.join("\n");
}

async function applyChanges(sourceBase: string, targetBase: string, changes: PlannedChanges): Promise<void> {
	for (const file of [...changes.added, ...changes.modified]) {
		const from = path.join(sourceBase, file);
		const to = path.join(targetBase, file);
		await mkdir(path.dirname(to), { recursive: true });
		await copyFile(from, to);
	}
	for (const file of changes.deleted) {
		await rm(path.join(targetBase, file), { force: true });
	}
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeRepoManifest(config: SyncConfig, exportedFiles: string[]): Promise<void> {
	const manifest = {
		version: 1,
		exportedAt: new Date().toISOString(),
		host: hostname(),
		configDir: config.configDir,
		managedFiles: exportedFiles,
		managedRoots: [...MANAGED_FILES, ...MANAGED_DIRS.map((dir) => `${dir}/**`)],
		excludedRoots: Array.from(EXCLUDED_PATHS).sort(),
	};
	await writeFile(path.join(config.repoPath, REPO_MANIFEST), JSON.stringify(manifest, null, "\t") + "\n");
}

async function ensureRepoScaffold(repoPath: string): Promise<void> {
	await mkdir(repoPath, { recursive: true });
	const gitignore = path.join(repoPath, ".gitignore");
	if (!existsSync(gitignore)) {
		await writeFile(gitignore, [".DS_Store", "node_modules/", "*.log", ""].join("\n"));
	}
}

async function makeBackup(configDir: string): Promise<string> {
	const backupRoot = path.join(configDir, BACKUP_DIR_NAME);
	const backupPath = path.join(backupRoot, timestamp());
	await mkdir(backupPath, { recursive: true });
	const current = await fileMap(configDir);
	await applyChanges(configDir, backupPath, { added: Array.from(current.keys()), modified: [], deleted: [] });
	await writeFile(path.join(backupPath, "backup.manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), source: configDir, files: Array.from(current.keys()) }, null, "\t") + "\n");
	return backupPath;
}

async function restoreSourceMap(backupPath: string): Promise<FileMap> {
	const files = await fileMap(backupPath);
	files.delete("backup.manifest.json");
	return files;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pi-config", {
		description: "Sync pi config with a reviewable git checkout: init, status, export, import, restore.",
		handler: async (rawArgs, ctx) => {
			try {
				const args = parseArgs(rawArgs ?? "");

				if (!args.command || args.command === "help") {
					ctx.ui.notify("Usage: /pi-config init [repo-path] | status | export [--dry-run] | import [--dry-run] [--yes] | restore [backup-name] [--dry-run] [--yes]", "info");
					return;
				}

				if (args.command === "init") {
					const selectedPath = args.path ?? DEFAULT_REPO_PATH;
					const repoPath = path.resolve(expandHome(selectedPath));
					const config: SyncConfig = { version: 1, repoPath, configDir: DEFAULT_CONFIG_DIR };
					await ensureRepoScaffold(repoPath);
					await saveConfig(config);
					await writeRepoManifest(config, await listManagedFiles(repoPath));
					ctx.ui.notify(`pi config sync initialized at ${repoPath}`, "info");
					return;
				}

				const config = await ensureConfigured();

				if (args.command === "status") {
					if (!existsSync(config.repoPath)) throw new Error(`Repo path does not exist: ${config.repoPath}`);
					const changes = planChanges(await fileMap(config.configDir), await fileMap(config.repoPath));
					ctx.ui.notify(formatChanges(`Live config -> repo (${config.repoPath})`, changes), hasChanges(changes) ? "warning" : "info");
					return;
				}

				if (args.command === "export") {
					await ensureRepoScaffold(config.repoPath);
					const source = await fileMap(config.configDir);
					const changes = planChanges(source, await fileMap(config.repoPath));
					if (args.dryRun) {
						ctx.ui.notify(formatChanges("Dry run export: live config -> repo", changes), hasChanges(changes) ? "warning" : "info");
						return;
					}
					await applyChanges(config.configDir, config.repoPath, changes);
					await writeRepoManifest(config, Array.from(source.keys()));
					ctx.ui.notify(formatChanges(`Exported live config to ${config.repoPath}`, changes), hasChanges(changes) ? "info" : "info");
					return;
				}

				if (args.command === "import") {
					if (!existsSync(config.repoPath)) throw new Error(`Repo path does not exist: ${config.repoPath}`);
					const source = await fileMap(config.repoPath);
					if (source.size === 0) throw new Error(`No managed config files found in repo; refusing to import from ${config.repoPath}`);
					const changes = planChanges(source, await fileMap(config.configDir));
					if (args.dryRun) {
						ctx.ui.notify(formatChanges("Dry run import: repo -> live config", changes), hasChanges(changes) ? "warning" : "info");
						return;
					}
					if (!hasChanges(changes)) {
						ctx.ui.notify("Import: no managed config changes.", "info");
						return;
					}
					if (!args.yes) {
						const ok = await ctx.ui.confirm("Import pi config?", `${formatChanges("Repo -> live config", changes)}\n\nA backup will be created first. Pi will not reload automatically.`);
						if (!ok) return;
					}
					const backupPath = await makeBackup(config.configDir);
					await applyChanges(config.repoPath, config.configDir, changes);
					ctx.ui.notify(`${formatChanges("Imported repo config into live pi config", changes)}\n\nBackup: ${backupPath}\nRun /reload when ready.`, "info");
					return;
				}

				if (args.command === "restore") {
					const backupRoot = path.join(config.configDir, BACKUP_DIR_NAME);
					if (!existsSync(backupRoot)) throw new Error("No backups found.");
					const backups = (await readdir(backupRoot)).sort().reverse();
					if (backups.length === 0) throw new Error("No backups found.");
					const chosen = args.path ?? (await ctx.ui.select("Restore which pi config backup?", backups));
					if (!chosen) return;
					const backupPath = path.join(backupRoot, chosen);
					if (!existsSync(backupPath) || !(await stat(backupPath)).isDirectory()) throw new Error(`Backup not found: ${chosen}`);
					const changes = planChanges(await restoreSourceMap(backupPath), await fileMap(config.configDir));
					if (args.dryRun) {
						ctx.ui.notify(formatChanges(`Dry run restore: ${chosen} -> live config`, changes), hasChanges(changes) ? "warning" : "info");
						return;
					}
					if (!hasChanges(changes)) {
						ctx.ui.notify(`Restore ${chosen}: no managed config changes.`, "info");
						return;
					}
					if (!args.yes) {
						const ok = await ctx.ui.confirm("Restore pi config backup?", `${formatChanges(`${chosen} -> live config`, changes)}\n\nA pre-restore backup will be created first. Pi will not reload automatically.`);
						if (!ok) return;
					}
					const preRestoreBackup = await makeBackup(config.configDir);
					await applyChanges(backupPath, config.configDir, changes);
					ctx.ui.notify(`${formatChanges(`Restored backup ${chosen}`, changes)}\n\nPre-restore backup: ${preRestoreBackup}\nRun /reload when ready.`, "info");
					return;
				}

				throw new Error(`Unknown subcommand: ${args.command}`);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
