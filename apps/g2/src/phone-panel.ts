// Phone WebView panel: the canned-reply editor shown on the
// phone. Runs in the G2 page's #app element (the simulator's webview
// screenshot shows this div). The panel never touches the store directly —
// every action goes back through the server over the page's WebSocket via
// callbacks from main.ts.
//
// Design: one dark system, drawn from the glasses themselves — near-black
// ground, green accent, one card style, one button style. No external
// fonts: the system stack keeps the panel self-contained.
export type ReplyPanelCallbacks = {
  /** User tapped Save: send the edited reply slots to the server. */
  onSave: (replies: string[]) => void;
  /** User saved the voice reply under review. */
  onSaveVoice?: (messageId: string, text: string) => void;
  /** User flipped a chat's allowlist toggle. */
  onToggleChat?: (chatId: number, allowed: boolean) => void;
};

/** A chat the bot has seen, with its allowlist flag. */
export type PanelChat = {
  chat_id: number;
  chat_title: string;
  allowed: boolean;
};

/** A voice reply under review on the glasses. */
export type VoiceReply = {
  messageId: string;
  text: string;
};

/** Status line under the panel buttons (e.g. "Saving..." / "Saved"). */
let statusEl: HTMLParagraphElement | null = null;
/** Last rendered inputs, so a re-render does not wipe text being typed. */
let lastRendered: string | null = null;

/** Test-only: forget the last render so the next render rebuilds the DOM. */
export function __clearPanelForTests(): void {
  lastRendered = null;
  statusEl = null;
}

const PANEL_STYLE_ID = "qr-panel-style";
const PANEL_CSS = `
body { margin: 0; background: #0f172a; }
#app { -webkit-font-smoothing: antialiased; }
.qr-root { max-width: 560px; margin: 0 auto; padding: 28px 20px 48px; color: #f8fafc; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.qr-header { margin-bottom: 20px; }
.qr-title { margin: 0; font-size: 24px; line-height: 1.25; font-weight: 700; letter-spacing: -0.02em; text-wrap: balance; }
.qr-subtitle { margin: 6px 0 0; color: #94a3b8; font-size: 14px; }
.qr-card { background: #1b2336; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 20px; margin-bottom: 16px; }
.qr-card-title { margin: 0 0 4px; font-size: 17px; font-weight: 650; text-wrap: balance; }
.qr-card-help { margin: 0 0 16px; color: #94a3b8; font-size: 13px; }
.qr-fields { display: grid; gap: 12px; }
.qr-label { display: block; font-size: 13px; font-weight: 600; color: #cbd5e1; margin-bottom: 6px; }
.qr-input, .qr-textarea { display: block; width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; color: #f8fafc; background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 11px 12px; outline: none; transition: border-color 150ms ease-out, box-shadow 150ms ease-out; }
.qr-input:focus, .qr-textarea:focus { border-color: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.25); }
.qr-textarea { min-height: 96px; resize: vertical; }
.qr-btn { display: block; width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; font-weight: 650; color: #0f172a; background: #22c55e; border: none; border-radius: 10px; padding: 13px 16px; margin-top: 16px; cursor: pointer; transition: transform 150ms ease-out, background-color 150ms ease-out; }
.qr-btn:hover { background: #4ade80; }
.qr-btn:active { transform: scale(0.96); }
.qr-btn:focus-visible { outline: 2px solid #f8fafc; outline-offset: 2px; }
.qr-status { margin: 12px 0 0; min-height: 24px; font-size: 14px; color: #94a3b8; }
.qr-status--ok { color: #22c55e; }
.qr-status--error { color: #ef4444; }
.qr-chats { display: grid; }
.qr-chat-row { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 4px 0; cursor: pointer; }
.qr-chat-row + .qr-chat-row { border-top: 1px solid rgba(255,255,255,0.06); }
.qr-chat-name { flex: 1; min-width: 0; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qr-badge { flex: none; font-size: 12px; font-weight: 600; color: #fbbf24; background: rgba(251,191,36,0.12); border: 1px solid rgba(251,191,36,0.35); border-radius: 999px; padding: 2px 8px; }
.qr-toggle { position: absolute; opacity: 0; width: 1px; height: 1px; }
.qr-toggle-ui { flex: none; width: 44px; height: 26px; border-radius: 999px; background: #334155; position: relative; transition: background-color 150ms ease-out; }
.qr-toggle-ui::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #f8fafc; transition: transform 150ms ease-out; }
.qr-toggle:checked + .qr-toggle-ui { background: #22c55e; }
.qr-toggle:checked + .qr-toggle-ui::after { transform: translateX(18px); }
.qr-toggle:focus-visible + .qr-toggle-ui { outline: 2px solid #f8fafc; outline-offset: 2px; }
.qr-empty { margin: 0; color: #94a3b8; font-size: 14px; }
@media (prefers-reduced-motion: reduce) {
  .qr-btn, .qr-toggle-ui, .qr-toggle-ui::after, .qr-input, .qr-textarea { transition: none; }
}
`;

function ensurePanelStyles(): void {
  if (document.getElementById(PANEL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PANEL_STYLE_ID;
  style.textContent = PANEL_CSS;
  document.head.append(style);
}

export function setPanelStatus(
  text: string,
  kind: "ok" | "error" | "" = "",
): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.className = `qr-status${kind ? ` qr-status--${kind}` : ""}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labeledInput(
  label: string,
  value: string,
  id: string,
): { wrapper: HTMLDivElement; input: HTMLInputElement } {
  const wrapper = el("div", "qr-field");
  const lab = el("label", "qr-label", label) as HTMLLabelElement;
  lab.htmlFor = id;
  const input = el("input", "qr-input") as HTMLInputElement;
  input.id = id;
  input.value = value;
  input.maxLength = 64;
  wrapper.append(lab, input);
  return { wrapper, input };
}

function primaryButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", "qr-btn", label) as HTMLButtonElement;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Render the reply editor into #app: 5 text inputs (one per slot, max 64
 * chars), a Save button, a status line, and the chat allowlist:
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
  ensurePanelStyles();
  const appEl = document.querySelector<HTMLDivElement>("#app");
  if (!appEl) return;
  const signature = JSON.stringify({ replies, chats, voice });
  if (signature === lastRendered) return;
  lastRendered = signature;
  appEl.textContent = "";

  const root = el("div", "qr-root");

  const header = el("header", "qr-header");
  header.append(
    el("h1", "qr-title", "QuickReply"),
    el("p", "qr-subtitle", "Canned replies and chats for your Even G2 glasses."),
  );
  root.append(header);

  const repliesCard = el("section", "qr-card");
  repliesCard.append(
    el("h2", "qr-card-title", "Canned replies"),
    el(
      "p",
      "qr-card-help",
      "Five replies, each at most 64 characters. Tap one on the glasses to send it.",
    ),
  );
  const fieldsEl = el("div", "qr-fields");
  const fields = replies.map((reply, i) =>
    labeledInput(`Reply ${i + 1}`, reply, `qr-reply-${i + 1}`),
  );
  fieldsEl.append(...fields.map((f) => f.wrapper));
  repliesCard.append(fieldsEl);

  statusEl = el("p", "qr-status") as HTMLParagraphElement;

  repliesCard.append(
    primaryButton("Save replies", () => {
      const next = fields.map((f) => f.input.value.trim());
      if (next.some((t) => t.length === 0 || t.length > 64)) {
        setPanelStatus("Each reply must be 1-64 characters.", "error");
        return;
      }
      cb.onSave(next);
    }),
    statusEl,
  );
  root.append(repliesCard);

  const chatsCard = el("section", "qr-card");
  chatsCard.id = "qr-chats";
  chatsCard.append(
    el("h2", "qr-card-title", "Chats"),
    el(
      "p",
      "qr-card-help",
      "Only checked chats reach the glasses. New chats wait here until you allow them.",
    ),
  );
  const chatList = el("div", "qr-chats");
  if (chats.length === 0) {
    chatList.append(el("p", "qr-empty", "No chats yet"));
  }
  for (const chat of chats) {
    const row = el("label", "qr-chat-row") as HTMLLabelElement;
    const box = el("input", "qr-toggle") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = chat.allowed;
    box.setAttribute("aria-label", `Allow ${chat.chat_title} to reach the glasses`);
    box.addEventListener("change", () => {
      cb.onToggleChat?.(chat.chat_id, box.checked);
    });
    const track = el("span", "qr-toggle-ui");
    const name = el("span", "qr-chat-name", chat.chat_title);
    row.append(box, track, name);
    if (!chat.allowed) row.append(el("span", "qr-badge", "Pending"));
    chatList.append(row);
  }
  chatsCard.append(chatList);
  root.append(chatsCard);

  if (voice && cb.onSaveVoice) {
    const voiceCard = el("section", "qr-card");
    voiceCard.append(
      el("h2", "qr-card-title", "Voice reply"),
      el(
        "p",
        "qr-card-help",
        "Edit the transcript before it is sent from the glasses.",
      ),
    );
    const area = el("textarea", "qr-textarea") as HTMLTextAreaElement;
    area.id = "qr-voice-text";
    area.value = voice.text;
    area.maxLength = 4096;
    area.setAttribute("aria-label", "Voice reply text");
    voiceCard.append(area);
    voiceCard.append(
      primaryButton("Save voice reply", () => {
        if (area.value.trim().length === 0) {
          setPanelStatus("Empty — say something first.", "error");
          return;
        }
        if (area.value.length > 4096) {
          setPanelStatus("Too long — shorten it.", "error");
          return;
        }
        cb.onSaveVoice!(voice.messageId, area.value);
      }),
    );
    root.append(voiceCard);
  }

  appEl.append(root);
}
