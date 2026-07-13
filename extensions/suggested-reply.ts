import { complete, type AssistantMessage, type UserMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type AutocompleteProvider,
	type EditorComponent,
	type TUI,
} from "@earendil-works/pi-tui";

const SYSTEM_PROMPT = `You generate one concise suggested next user reply for a terminal coding-agent chat.

Rules:
- Output only the suggested user message.
- No quotes.
- No explanation.
- Keep it short: ideally 3-10 words, maximum 14 words.
- Prefer actionable next-step replies.
- If the assistant gave a plan and is waiting for approval, suggest a go-ahead reply like "go implement it".
- If the assistant proposed options, suggest asking to proceed with the most reasonable option only when obvious.
- If the assistant asked a question and the answer is not obvious, suggest an empty string.
- If no useful next reply exists, suggest an empty string.`;

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((part): part is { type: string; text: string } => {
			return Boolean(
				part &&
					typeof part === "object" &&
					"type" in part &&
					part.type === "text" &&
					"text" in part &&
					typeof part.text === "string",
			);
		})
		.map((part) => part.text)
		.join("\n");
}

function findLatestExchange(ctx: ExtensionContext): {
	userText: string;
	assistantText: string;
} | null {
	const branch = ctx.sessionManager.getBranch();
	let assistantText: string | undefined;
	let assistantIndex = -1;

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!("role" in message) || message.role !== "assistant") continue;
		if ((message as AssistantMessage).stopReason && (message as AssistantMessage).stopReason !== "stop") return null;

		const text = textFromContent(message.content).trim();
		if (!text) return null;
		assistantText = text;
		assistantIndex = i;
		break;
	}

	if (!assistantText) return null;

	for (let i = assistantIndex - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!("role" in message) || message.role !== "user") continue;

		const text = textFromContent(message.content).trim();
		if (!text) continue;
		return { userText: text, assistantText };
	}

	return null;
}

function normalizeSuggestion(text: string): string {
	let suggestion = text.trim();

	// Keep only the first non-empty line and strip common model formatting.
	suggestion = suggestion
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0) ?? "";

	suggestion = suggestion.replace(/^```(?:\w+)?\s*/, "").replace(/```$/, "").trim();
	suggestion = suggestion.replace(/^[-*]\s+/, "").trim();
	suggestion = suggestion.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();

	if (!suggestion) return "";
	if (/^(empty string|none|null|n\/a)$/i.test(suggestion)) return "";

	return truncateToWidth(suggestion, 120, "…");
}

export default function suggestedReply(pi: ExtensionAPI) {
	let suggestion = "";
	let generation = 0;
	let activeTui: TUI | undefined;
	let styleGhostText: (text: string) => string = (text) => text;

	const clearSuggestion = () => {
		if (!suggestion) return;
		suggestion = "";
		activeTui?.requestRender();
	};

	class SuggestedReplyEditor implements EditorComponent {
		constructor(
			private readonly base: EditorComponent,
			private readonly tui: TUI,
		) {
			activeTui = tui;
		}

		get onSubmit(): ((text: string) => void) | undefined {
			return this.base.onSubmit;
		}

		set onSubmit(handler: ((text: string) => void) | undefined) {
			this.base.onSubmit = handler;
		}

		get onChange(): ((text: string) => void) | undefined {
			return this.base.onChange;
		}

		set onChange(handler: ((text: string) => void) | undefined) {
			this.base.onChange = handler;
		}

		get focused(): boolean {
			return (this.base as EditorComponent & { focused?: boolean }).focused ?? false;
		}

		set focused(value: boolean) {
			(this.base as EditorComponent & { focused?: boolean }).focused = value;
		}

		get borderColor(): ((str: string) => string) | undefined {
			return this.base.borderColor;
		}

		set borderColor(color: ((str: string) => string) | undefined) {
			this.base.borderColor = color;
		}

		getText(): string {
			return this.base.getText();
		}

		setText(text: string): void {
			this.base.setText(text);
		}

		getExpandedText(): string {
			return this.base.getExpandedText?.() ?? this.base.getText();
		}

		addToHistory(text: string): void {
			this.base.addToHistory?.(text);
		}

		insertTextAtCursor(text: string): void {
			this.base.insertTextAtCursor?.(text);
		}

		setAutocompleteProvider(provider: AutocompleteProvider): void {
			this.base.setAutocompleteProvider?.(provider);
		}

		setPaddingX(padding: number): void {
			this.base.setPaddingX?.(padding);
		}

		setAutocompleteMaxVisible(maxVisible: number): void {
			this.base.setAutocompleteMaxVisible?.(maxVisible);
		}

		handleInput(data: string): void {
			if (matchesKey(data, "tab") && this.base.getText() === "" && suggestion.trim()) {
				this.base.setText(suggestion);
				suggestion = "";
				this.tui.requestRender();
				return;
			}

			this.base.handleInput(data);

			if (this.base.getText() !== "" && suggestion) {
				suggestion = "";
				this.tui.requestRender();
			}
		}

		render(width: number): string[] {
			const lines = this.base.render(width);
			if (this.base.getText() !== "" || !suggestion.trim() || lines.length < 3 || width <= 1) {
				return lines;
			}

			const hintWidth = Math.max(0, width - 1);
			const hint = truncateToWidth(suggestion, hintWidth, "…");
			const visibleHintWidth = visibleWidth(hint);
			const cursor = `${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[0m`;
			const ghost = hint ? styleGhostText(hint) : "";
			const padding = " ".repeat(Math.max(0, width - 1 - visibleHintWidth));

			lines[1] = `${cursor}${ghost}${padding}`;
			return lines;
		}

		invalidate(): void {
			this.base.invalidate();
		}

		dispose(): void {
			(this.base as EditorComponent & { dispose?: () => void }).dispose?.();
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		styleGhostText = (text: string) => ctx.ui.theme.fg("dim", text);
		const previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const base = previousEditor?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			return new SuggestedReplyEditor(base, tui);
		});
	});

	pi.on("session_shutdown", () => {
		generation++;
		suggestion = "";
		activeTui = undefined;
	});

	pi.on("agent_start", () => {
		generation++;
		clearSuggestion();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (!ctx.model) return;
		if (ctx.ui.getEditorText().trim()) return;

		const exchange = findLatestExchange(ctx);
		if (!exchange) return;

		const currentGeneration = ++generation;

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok || !auth.apiKey) return;

			const prompt = `Last user message:\n${exchange.userText}\n\nAssistant response:\n${exchange.assistantText}\n\nSuggested next user reply:`;
			const userMessage: UserMessage = {
				role: "user",
				content: [{ type: "text", text: prompt }],
				timestamp: Date.now(),
			};

			const response = await complete(
				ctx.model,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers },
			);

			if (currentGeneration !== generation) return;
			if (ctx.ui.getEditorText().trim()) return;

			const text = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");

			suggestion = normalizeSuggestion(text);
			activeTui?.requestRender();
		} catch {
			// Suggestion generation is opportunistic; never interrupt the main chat flow.
		}
	});
}
