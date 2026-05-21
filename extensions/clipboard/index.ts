import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ContentBlock = {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
};

function contentToText(content: unknown, options: { includeThinking?: boolean; includeToolCalls?: boolean } = {}): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((block: ContentBlock) => {
			if (block.type === "text" || block.type === "input_text" || block.type === "output_text") return block.text ?? "";
			if (block.type === "thinking" && options.includeThinking) return block.thinking ?? "";
			if (block.type === "toolCall" && options.includeToolCalls) {
				return `[tool call: ${block.name ?? "unknown"} ${JSON.stringify(block.arguments ?? {})}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function copyToClipboard(text: string): { ok: true } | { ok: false; error: string } {
	if (process.platform === "darwin") {
		const result = spawnSync("pbcopy", [], { input: text });
		return result.status === 0 ? { ok: true } : { ok: false, error: result.stderr?.toString() || "pbcopy failed" };
	}

	if (process.platform === "win32") {
		const result = spawnSync("clip", [], { input: text, shell: true });
		return result.status === 0 ? { ok: true } : { ok: false, error: result.stderr?.toString() || "clip failed" };
	}

	for (const command of ["wl-copy", "xclip", "xsel"]) {
		const args = command === "xclip" ? ["-selection", "clipboard"] : command === "xsel" ? ["--clipboard", "--input"] : [];
		const result = spawnSync(command, args, { input: text });
		if (result.status === 0) return { ok: true };
	}

	return { ok: false, error: "No clipboard command found. Install wl-copy, xclip, or xsel." };
}

function formatEntryAfterLatestUser(entry: any): string | undefined {
	if (entry?.type === "message") {
		const message = entry.message;

		if (message?.role === "assistant") {
			const text = contentToText(message.content, { includeToolCalls: true });
			return text.trim() ? text.trim() : undefined;
		}

		if (message?.role === "toolResult") {
			const text = contentToText(message.content);
			if (!text.trim()) return undefined;
			return `Tool result (${message.toolName ?? "tool"}):\n\n${text.trim()}`;
		}

		if (message?.role === "custom" && message.display !== false) {
			const text = contentToText(message.content);
			if (!text.trim()) return undefined;
			return text.trim();
		}
	}

	if (entry?.type === "custom_message" && entry.display !== false) {
		const text = contentToText(entry.content);
		if (!text.trim()) return undefined;
		return text.trim();
	}

	return undefined;
}

function getLatestResponseText(ctx: { sessionManager: { getBranch(): unknown[] } }): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	let latestUserIndex = -1;

	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index] as any;
		if (entry?.type === "message" && entry.message?.role === "user") {
			latestUserIndex = index;
			break;
		}
	}

	const entries = latestUserIndex >= 0 ? branch.slice(latestUserIndex + 1) : branch;
	const parts = entries.flatMap((entry) => {
		const text = formatEntryAfterLatestUser(entry);
		return text ? [text] : [];
	});

	return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
}

function formatThread(ctx: { sessionManager: { getBranch(): unknown[] } }): string {
	const lines: string[] = [];

	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry?.type === "message") {
			const message = entry.message;
			if (message?.role === "user") {
				const text = contentToText(message.content);
				if (text.trim()) lines.push(`## User\n\n${text.trim()}`);
			} else if (message?.role === "assistant") {
				const label = message.provider && message.model ? `Assistant (${message.provider}/${message.model})` : "Assistant";
				const text = contentToText(message.content, { includeToolCalls: true });
				if (text.trim()) lines.push(`## ${label}\n\n${text.trim()}`);
			} else if (message?.role === "toolResult") {
				const text = contentToText(message.content);
				if (text.trim()) lines.push(`## Tool result (${message.toolName ?? "tool"})\n\n${text.trim()}`);
			} else if (message?.role === "custom" && message.display !== false) {
				const text = contentToText(message.content);
				if (text.trim()) lines.push(`## ${message.customType ?? "Custom"}\n\n${text.trim()}`);
			}
		} else if (entry?.type === "custom_message" && entry.display !== false) {
			const text = contentToText(entry.content);
			if (text.trim()) lines.push(`## ${entry.customType ?? "Custom"}\n\n${text.trim()}`);
		}
	}

	return lines.join("\n\n---\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("copy", {
		description: "Copy everything produced after the latest user prompt to the clipboard.",
		handler: async (_args, ctx) => {
			const text = getLatestResponseText(ctx);
			if (!text) {
				ctx.ui.notify("No response found to copy.", "warning");
				return;
			}

			const result = copyToClipboard(text);
			if (!result.ok) {
				ctx.ui.notify(`Copy failed: ${result.error}`, "error");
				return;
			}

			ctx.ui.notify(`Copied latest response turn (${text.length.toLocaleString()} chars).`, "info");
		},
	});

	pi.registerCommand("copy-all", {
		description: "Copy the current thread to the clipboard as Markdown.",
		handler: async (_args, ctx) => {
			const text = formatThread(ctx).trim();
			if (!text) {
				ctx.ui.notify("No thread content found to copy.", "warning");
				return;
			}

			const result = copyToClipboard(text);
			if (!result.ok) {
				ctx.ui.notify(`Copy all failed: ${result.error}`, "error");
				return;
			}

			ctx.ui.notify(`Copied thread (${text.length.toLocaleString()} chars).`, "info");
		},
	});
}
