// Phone WebView panel (Task 3): the canned-reply editor shown on the
// phone. Runs in the G2 page's #app element (the simulator's webview
// screenshot shows this div). The panel never touches the store directly —
// every action goes back through the server over the page's WebSocket via
// callbacks from main.ts.
export type ReplyPanelCallbacks = {
  /** User tapped Save: send the edited reply slots to the server. */
  onSave: (replies: string[]) => void;
  /** User saved the voice reply under review (Task 5). */
  onSaveVoice?: (messageId: string, text: string) => void;
  /** User flipped a chat's allowlist toggle (Task 8). */
  onToggleChat?: (chatId: number, allowed: boolean) => void;
};

/** A chat the bot has seen, with its allowlist flag (Task 8). */
export type PanelChat = {
  chat_id: number;
  chat_title: string;
  allowed: boolean;
};

/** A voice reply under review on the glasses (Task 5). */
export type VoiceReply = {
  messageId: string;
  text: string;
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
 * chars), a Save button, a status line, and the chat allowlist (Task 8):
 * one toggle per chat the bot has seen — only allowlisted chats reach the
 * glasses. When a voice reply is under review on the glasses, a second
 * section edits that transcript (max 4096 chars) — the Edit path for the
 * review screen and the too-long offer. Re-rendering with unchanged inputs
 * is a no-op, so typing is never wiped by an inbox update.
 */
export function renderReplyPanel(
  replies: string[],
  chats: PanelChat[],
  cb: ReplyPanelCallbacks,
  voice?: VoiceReply | null,
): void {
  const appEl = document.querySelector<HTMLDivElement>("#app");
  if (!appEl) return;
  const signature = JSON.stringify({ replies, chats, voice });
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

  const chatTitle = document.createElement("h2");
  chatTitle.textContent = "Chats — only checked chats reach the glasses";
  chatTitle.style.margin = "20px 0 8px";
  chatTitle.style.fontSize = "16px";

  const chatList = document.createElement("div");
  if (chats.length === 0) {
    const empty = document.createElement("p");
    empty.style.margin = "0";
    empty.textContent = "No chats yet";
    chatList.append(empty);
  }
  for (const chat of chats) {
    const row = document.createElement("label");
    row.style.display = "block";
    row.style.fontSize = "16px";
    row.style.padding = "6px 0";
    row.style.cursor = "pointer";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = chat.allowed;
    box.style.marginRight = "8px";
    box.addEventListener("change", () => {
      cb.onToggleChat?.(chat.chat_id, box.checked);
    });
    row.append(box, document.createTextNode(
      chat.allowed ? chat.chat_title : `${chat.chat_title} (pending)`,
    ));
    chatList.append(row);
  }

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
    chatTitle,
    chatList,
  );

  if (voice && cb.onSaveVoice) {
    const voiceTitle = document.createElement("h2");
    voiceTitle.textContent = "Voice reply";
    voiceTitle.style.margin = "20px 0 12px";
    appEl.append(voiceTitle);

    const area = document.createElement("textarea");
    area.value = voice.text;
    area.maxLength = 4096;
    area.rows = 4;
    area.style.display = "block";
    area.style.width = "100%";
    area.style.boxSizing = "border-box";
    area.style.fontSize = "16px";
    area.style.padding = "8px";
    appEl.append(area);

    appEl.append(
      button("Save voice reply", () => {
        if (area.value.trim().length === 0) {
          setPanelStatus("Empty — say something first.");
          return;
        }
        if (area.value.length > 4096) {
          setPanelStatus("Too long — shorten it.");
          return;
        }
        cb.onSaveVoice!(voice.messageId, area.value);
      }, true),
    );
  }
}
