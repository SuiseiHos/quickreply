// Phone WebView panel (Task 3): the canned-reply editor shown on the
// phone. Runs in the G2 page's #app element (the simulator's webview
// screenshot shows this div). The panel never touches the store directly —
// every action goes back through the server over the page's WebSocket via
// callbacks from main.ts.
export type ReplyPanelCallbacks = {
  /** User tapped Save: send the edited reply slots to the server. */
  onSave: (replies: string[]) => void;
};

/** Status line under the panel buttons (e.g. "Saving..." / "Saved"). */
let statusEl: HTMLParagraphElement | null = null;
/** Last rendered inputs, so a re-render does not wipe text being typed. */
let lastRendered: string | null = null;

export function setPanelStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function labeledInput(
  label: string,
  value: string,
): { wrapper: HTMLDivElement; input: HTMLInputElement } {
  const wrapper = document.createElement("div");
  wrapper.style.marginBottom = "12px";
  const lab = document.createElement("label");
  lab.textContent = label;
  lab.style.display = "block";
  lab.style.fontWeight = "bold";
  lab.style.marginBottom = "4px";
  const input = document.createElement("input");
  input.value = value;
  input.maxLength = 64;
  input.style.display = "block";
  input.style.width = "100%";
  input.style.boxSizing = "border-box";
  input.style.fontSize = "16px";
  input.style.padding = "8px";
  wrapper.append(lab, input);
  return { wrapper, input };
}

function button(
  label: string,
  onClick: () => void,
  primary: boolean,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.display = "block";
  b.style.width = "100%";
  b.style.fontSize = "16px";
  b.style.padding = "10px";
  b.style.marginTop = "8px";
  b.style.cursor = "pointer";
  if (primary) b.style.fontWeight = "bold";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Render the reply editor into #app: 5 text inputs (one per slot, max 64
 * chars), a Save button, a status line, and a read-only list of chats the
 * bot has seen. Re-rendering with unchanged inputs is a no-op, so typing
 * is never wiped by an inbox update.
 */
export function renderReplyPanel(
  replies: string[],
  chats: string[],
  cb: ReplyPanelCallbacks,
): void {
  const appEl = document.querySelector<HTMLDivElement>("#app");
  if (!appEl) return;
  const signature = JSON.stringify({ replies, chats });
  if (signature === lastRendered) return;
  lastRendered = signature;
  appEl.textContent = "";

  const title = document.createElement("h2");
  title.textContent = "QuickReply — canned replies";
  title.style.margin = "0 0 12px";
  appEl.append(title);

  const fields = replies.map((reply, i) =>
    labeledInput(`Reply ${i + 1}`, reply),
  );
  appEl.append(...fields.map((f) => f.wrapper));

  statusEl = document.createElement("p");
  statusEl.style.margin = "12px 0 0";
  statusEl.style.color = "inherit";

  const chatList = document.createElement("p");
  chatList.style.margin = "12px 0 0";
  chatList.textContent =
    chats.length > 0 ? `Chats: ${chats.join(", ")}` : "No chats yet";

  appEl.append(
    button("Save replies", () => {
      const next = fields.map((f) => f.input.value.trim());
      if (next.some((t) => t.length === 0 || t.length > 64)) {
        setPanelStatus("Each reply must be 1-64 characters.");
        return;
      }
      cb.onSave(next);
    }, true),
    statusEl,
    chatList,
  );
}
