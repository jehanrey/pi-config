import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, copyFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTENSION_CONFIG = path.join(homedir(), ".pi", "agent", "pi-config-sync.json");
const DEFAULT_CONFIG_DIR = path.join(homedir(), ".pi", "agent");
const BACKUP_DIR_NAME = "config-sync-backups";
const REPO_MANIFEST = "pi-config-sync.manifest.json";
const DEFAULT_REPO_PATH = "~/pi-config-sync";
const MEMORY_DB = path.join(homedir(), ".pi", "memory", "memory.db");
const MEMORY_BACKUP_DIR = path.join(homedir(), ".pi", "memory", BACKUP_DIR_NAME);
const MEMORY_DIR = "memory";
const MEMORY_SEMANTIC_FILE = `${MEMORY_DIR}/semantic.json`;
const MEMORY_LESSONS_FILE = `${MEMORY_DIR}/lessons.json`;
const MEMORY_MANIFEST_FILE = `${MEMORY_DIR}/manifest.json`;

const execFileAsync = promisify(execFile);

const MANAGED_FILES = [
	"settings.json",
	"keybindings.json",
	"AGENTS.md",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"models.json",
];

const MANAGED_DIRS = ["prompts", "extensions", "themes"];

// Only sync skills authored in this config repo. Package-provided or third-party
// skills should remain installed through pi/package mechanisms instead of being
// copied into the config sync checkout.
const MANAGED_SKILL_DIRS = ["triage-review-comment"];

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

type SemanticMemoryItem = {
	key: string;
	value: string;
	confidence?: number;
	source?: string;
};

type LessonMemoryItem = {
	id: string;
	rule: string;
	category: string;
	negative: boolean;
	source?: string;
};

type MemoryExportSummary = {
	semantic: number;
	lessons: number;
	skipped: boolean;
	reason?: string;
};

type MemoryImportSummary = {
	semanticAdded: number;
	semanticUpdated: number;
	semanticSkipped: number;
	lessonsAdded: number;
	lessonsUpdated: number;
	lessonsSkipped: number;
	skipped: boolean;
	reason?: string;
	backupPath?: string;
};

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

function rel(from: string, to: string): string {
	return path.relative(from, to).split(path.sep).join("/");
}

function portablePath(value: string): string {
	const home = homedir();
	if (value === home) return "~";
	if (value.startsWith(`${home}${path.sep}`)) return `~/${value.slice(home.length + 1).split(path.sep).join("/")}`;
	return value;
}

function makeMemoryPortable(value: string): string {
	return value.split(homedir()).join("~");
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
		const fullPath = path.join(base, relativePath);
		if (entry.isDirectory()) {
			await walkFiles(base, relativePath, out);
		} else if (entry.isSymbolicLink()) {
			const target = await stat(fullPath);
			if (target.isDirectory()) {
				await walkFiles(base, relativePath, out);
			} else if (target.isFile()) {
				out.push(relativePath);
			}
		} else if (entry.isFile()) {
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
	for (const skill of MANAGED_SKILL_DIRS) {
		const dir = `skills/${skill}`;
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
	const repoMemoryFiles = [MEMORY_SEMANTIC_FILE, MEMORY_LESSONS_FILE, MEMORY_MANIFEST_FILE].filter((file) => existsSync(path.join(config.repoPath, file)));
	const manifest = {
		version: 1,
		exportedAt: new Date().toISOString(),
		host: hostname(),
		configDir: portablePath(config.configDir),
		managedFiles: Array.from(new Set([...exportedFiles, ...repoMemoryFiles])).sort(),
		managedRoots: [
			...MANAGED_FILES,
			...MANAGED_DIRS.map((dir) => `${dir}/**`),
			...MANAGED_SKILL_DIRS.map((skill) => `skills/${skill}/**`),
			`${MEMORY_DIR}/**`,
		],
		excludedRoots: Array.from(EXCLUDED_PATHS).sort(),
	};
	await writeFile(path.join(config.repoPath, REPO_MANIFEST), JSON.stringify(manifest, null, "\t") + "\n");
}

async function runSqliteJson(sql: string): Promise<unknown[]> {
	const { stdout } = await execFileAsync("sqlite3", ["-json", MEMORY_DB, sql]);
	const trimmed = stdout.trim();
	return trimmed ? JSON.parse(trimmed) as unknown[] : [];
}

async function runSqlite(sql: string): Promise<void> {
	await execFileAsync("sqlite3", [MEMORY_DB, sql]);
}

function sqlString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function memoryFilesExist(repoPath: string): boolean {
	return existsSync(path.join(repoPath, MEMORY_SEMANTIC_FILE)) || existsSync(path.join(repoPath, MEMORY_LESSONS_FILE));
}

async function exportMemoryToRepo(config: SyncConfig): Promise<MemoryExportSummary> {
	if (!existsSync(MEMORY_DB)) return { semantic: 0, lessons: 0, skipped: true, reason: `Memory DB not found: ${MEMORY_DB}` };
	try {
		const semantic = (await runSqliteJson("SELECT key, value, confidence, source FROM semantic ORDER BY key;") as SemanticMemoryItem[]).map((item) => ({
			...item,
			value: makeMemoryPortable(item.value),
		}));
		const lessons = (await runSqliteJson("SELECT id, rule, category, negative, source FROM lessons WHERE is_deleted = 0 ORDER BY category, id;") as Array<Omit<LessonMemoryItem, "negative"> & { negative: number }>).map((lesson) => ({
			...lesson,
			rule: makeMemoryPortable(lesson.rule),
			negative: Boolean(lesson.negative),
		}));
		const memoryDir = path.join(config.repoPath, MEMORY_DIR);
		await mkdir(memoryDir, { recursive: true });
		await writeFile(path.join(config.repoPath, MEMORY_SEMANTIC_FILE), JSON.stringify({ version: 1, items: semantic }, null, "\t") + "\n");
		await writeFile(path.join(config.repoPath, MEMORY_LESSONS_FILE), JSON.stringify({ version: 1, items: lessons }, null, "\t") + "\n");
		await writeFile(path.join(config.repoPath, MEMORY_MANIFEST_FILE), JSON.stringify({
			version: 1,
			exportedAt: new Date().toISOString(),
			host: hostname(),
			sourceDb: portablePath(MEMORY_DB),
			semanticCount: semantic.length,
			lessonCount: lessons.length,
		}, null, "\t") + "\n");
		return { semantic: semantic.length, lessons: lessons.length, skipped: false };
	} catch (error) {
		return { semantic: 0, lessons: 0, skipped: true, reason: error instanceof Error ? error.message : String(error) };
	}
}

async function makeMemoryBackup(): Promise<string | undefined> {
	if (!existsSync(MEMORY_DB)) return undefined;
	await mkdir(MEMORY_BACKUP_DIR, { recursive: true });
	const backupPath = path.join(MEMORY_BACKUP_DIR, `${timestamp()}.db`);
	await copyFile(MEMORY_DB, backupPath);
	return backupPath;
}

async function readMemoryItems<T>(repoPath: string, relativeFile: string): Promise<T[]> {
	const fullPath = path.join(repoPath, relativeFile);
	if (!existsSync(fullPath)) return [];
	const parsed = JSON.parse(await readFile(fullPath, "utf8")) as { items?: T[] };
	return Array.isArray(parsed.items) ? parsed.items : [];
}

async function importMemoryFromRepo(config: SyncConfig): Promise<MemoryImportSummary> {
	const empty: MemoryImportSummary = { semanticAdded: 0, semanticUpdated: 0, semanticSkipped: 0, lessonsAdded: 0, lessonsUpdated: 0, lessonsSkipped: 0, skipped: false };
	if (!memoryFilesExist(config.repoPath)) return { ...empty, skipped: true, reason: "No synced memory files found." };
	if (!existsSync(MEMORY_DB)) return { ...empty, skipped: true, reason: `Memory DB not found: ${MEMORY_DB}` };

	const semantic = await readMemoryItems<SemanticMemoryItem>(config.repoPath, MEMORY_SEMANTIC_FILE);
	const lessons = await readMemoryItems<LessonMemoryItem>(config.repoPath, MEMORY_LESSONS_FILE);
	const backupPath = await makeMemoryBackup();

	for (const item of semantic) {
		const existing = await runSqliteJson(`SELECT value FROM semantic WHERE key = ${sqlString(item.key)} LIMIT 1;`) as Array<{ value: string }>;
		if (existing.length === 0) {
			await runSqlite(`INSERT INTO semantic (key, value, confidence, source) VALUES (${sqlString(item.key)}, ${sqlString(item.value)}, ${item.confidence ?? 0.8}, ${sqlString(item.source ?? "memory-sync")});`);
			empty.semanticAdded++;
		} else if (existing[0]?.value !== item.value) {
			await runSqlite(`UPDATE semantic SET value = ${sqlString(item.value)}, confidence = ${item.confidence ?? 0.8}, source = ${sqlString(item.source ?? "memory-sync")}, updated_at = datetime('now') WHERE key = ${sqlString(item.key)};`);
			empty.semanticUpdated++;
		} else {
			empty.semanticSkipped++;
		}
	}

	for (const item of lessons) {
		const negative = item.negative ? 1 : 0;
		const existing = await runSqliteJson(`SELECT rule, category, negative, is_deleted FROM lessons WHERE id = ${sqlString(item.id)} LIMIT 1;`) as Array<{ rule: string; category: string; negative: number; is_deleted: number }>;
		if (existing.length === 0) {
			await runSqlite(`INSERT INTO lessons (id, rule, category, source, negative, is_deleted) VALUES (${sqlString(item.id)}, ${sqlString(item.rule)}, ${sqlString(item.category)}, ${sqlString(item.source ?? "memory-sync")}, ${negative}, 0);`);
			empty.lessonsAdded++;
		} else if (existing[0]?.rule !== item.rule || existing[0]?.category !== item.category || existing[0]?.negative !== negative || existing[0]?.is_deleted !== 0) {
			await runSqlite(`UPDATE lessons SET rule = ${sqlString(item.rule)}, category = ${sqlString(item.category)}, source = ${sqlString(item.source ?? "memory-sync")}, negative = ${negative}, is_deleted = 0 WHERE id = ${sqlString(item.id)};`);
			empty.lessonsUpdated++;
		} else {
			empty.lessonsSkipped++;
		}
	}

	return { ...empty, backupPath };
}

function formatMemoryExportSummary(summary: MemoryExportSummary): string {
	if (summary.skipped) return `Memory export skipped: ${summary.reason}`;
	return `Memory export: ${summary.semantic} semantic facts, ${summary.lessons} lessons.`;
}

function formatMemoryImportSummary(summary: MemoryImportSummary): string {
	if (summary.skipped) return `Memory import skipped: ${summary.reason}`;
	return `Memory import: semantic +${summary.semanticAdded}/~${summary.semanticUpdated}/${summary.semanticSkipped} skipped; lessons +${summary.lessonsAdded}/~${summary.lessonsUpdated}/${summary.lessonsSkipped} skipped${summary.backupPath ? `; backup: ${summary.backupPath}` : ""}.`;
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

async function pullRepoMain(repoPath: string): Promise<string> {
	if (!existsSync(path.join(repoPath, ".git"))) throw new Error(`Repo path is not a git checkout: ${repoPath}`);
	const { stdout, stderr } = await execFileAsync("git", ["-C", repoPath, "pull", "--ff-only", "origin", "main"]);
	return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || "Already up to date.";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pi-config", {
		description: "Sync pi config with a reviewable git checkout: init, status, pull, export, import, restore.",
		handler: async (rawArgs, ctx) => {
			try {
				const args = parseArgs(rawArgs ?? "");

				if (!args.command || args.command === "help") {
					ctx.ui.notify("Usage: /pi-config init [repo-path] | status | pull | export [--dry-run] | import [--dry-run] [--yes] | restore [backup-name] [--dry-run] [--yes]", "info");
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

				if (args.command === "pull") {
					if (!existsSync(config.repoPath)) throw new Error(`Repo path does not exist: ${config.repoPath}`);
					const output = await pullRepoMain(config.repoPath);
					ctx.ui.notify(`Pulled main in ${config.repoPath}\n\n${output}`, "info");
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
					const memorySummary = await exportMemoryToRepo(config);
					await applyChanges(config.configDir, config.repoPath, changes);
					await writeRepoManifest(config, Array.from(source.keys()));
					ctx.ui.notify(`${formatChanges(`Exported live config to ${config.repoPath}`, changes)}\n\n${formatMemoryExportSummary(memorySummary)}`, hasChanges(changes) ? "info" : "info");
					return;
				}

				if (args.command === "import") {
					if (!existsSync(config.repoPath)) throw new Error(`Repo path does not exist: ${config.repoPath}`);
					const source = await fileMap(config.repoPath);
					if (source.size === 0 && !memoryFilesExist(config.repoPath)) throw new Error(`No managed config files found in repo; refusing to import from ${config.repoPath}`);
					const changes = planChanges(source, await fileMap(config.configDir));
					if (args.dryRun) {
						ctx.ui.notify(formatChanges("Dry run import: repo -> live config", changes), hasChanges(changes) ? "warning" : "info");
						return;
					}
					if (hasChanges(changes) && !args.yes) {
						const ok = await ctx.ui.confirm("Import pi config?", `${formatChanges("Repo -> live config", changes)}\n\nA backup will be created first. Pi will not reload automatically.`);
						if (!ok) return;
					}
					const backupPath = hasChanges(changes) ? await makeBackup(config.configDir) : undefined;
					if (hasChanges(changes)) await applyChanges(config.repoPath, config.configDir, changes);
					const memorySummary = await importMemoryFromRepo(config);
					ctx.ui.notify(`${hasChanges(changes) ? formatChanges("Imported repo config into live pi config", changes) : "Import: no managed config changes."}\n\n${backupPath ? `Backup: ${backupPath}\n` : ""}${formatMemoryImportSummary(memorySummary)}\nRun /reload when ready.`, "info");
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
