/**
 * double-escape-clear
 *
 * Press Escape twice quickly (within 400ms) to clear all text in the editor —
 * the same UX as Claude Code.
 *
 * A single Escape still works normally (cancel / abort).
 */
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const DOUBLE_PRESS_WINDOW_MS = 400;

class DoubleEscapeClearEditor extends CustomEditor {
  private lastEscapeTime: number | null = null;
  private readonly onClear: () => void;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    onClear: () => void,
  ) {
    super(tui, theme, keybindings);
    this.onClear = onClear;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      const now = Date.now();

      if (this.lastEscapeTime !== null && now - this.lastEscapeTime <= DOUBLE_PRESS_WINDOW_MS) {
        // Second press within window — clear the editor
        this.onClear();
        this.lastEscapeTime = null;
      } else {
        // First press — start the window, let normal escape (abort/interrupt) still work
        this.lastEscapeTime = now;
        super.handleInput(data);
      }
      return;
    }

    // Reset timer on any other key
    this.lastEscapeTime = null;
    super.handleInput(data);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, kb) =>
      new DoubleEscapeClearEditor(tui, theme, kb, () => ctx.ui.setEditorText("")),
    );
  });
}
