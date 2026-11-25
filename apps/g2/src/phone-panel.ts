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
  /** User flipped a sender's VIP toggle. */
  onToggleVip?: (senderId: number, vip: boolean) => void;
  /** User saved the urgency keywords (comma-separated). */
  onSaveKeywords?: (keywords: string) => void;
  /** User saved the quiet-hours window (both null turns it off). */
  onSaveQuietHours?: (start: string | null, end: string | null) => void;
  /** User saved a chat's own 5 replies (selected in the scope selector). */
  onSaveChatReplies?: (chatId: number, replies: string[]) => void;
  /** User reset a chat to the all-chats replies. */
  onClearChatReplies?: (chatId: number) => void;
};

/** A chat the bot has seen, with its allowlist flag. */
export type PanelBusinessConnection = {
  id: string;
  user_chat_id: number;
  can_reply: boolean;
  is_enabled: boolean;
};

export type PanelChat = {
  chat_id: number;
  chat_title: string;
  allowed: boolean;
};

/** A chat's own 5 canned replies (chats without one use the global set). */
export type PanelChatReplies = {
  chat_id: number;
  replies: string[];
};

/** A sender the bot has seen, with its VIP flag. */
export type PanelSender = {
  sender_id: number;
  sender_name: string;
  vip: boolean;
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
/** The chat the replies editor is scoped to (null = all chats). */
let selectedReplyChat: number | null = null;
/** Args of the last render, so the scope selector can re-render in place. */
let lastPanelArgs: {
  replies: string[];
  chats: PanelChat[];
  cb: ReplyPanelCallbacks;
  voice?: VoiceReply | null;
  opts?: {
    senders?: PanelSender[];
    keywords?: string[];
    quietHours?: { start: string; end: string } | null;
    businessConnections?: PanelBusinessConnection[];
    chatReplies?: PanelChatReplies[];
  };
} | null = null;

/** Test-only: forget the last render so the next render rebuilds the DOM. */
export function __clearPanelForTests(): void {
  lastRendered = null;
  statusEl = null;
  selectedReplyChat = null;
  lastPanelArgs = null;
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
.qr-input, .qr-textarea, .qr-select { display: block; width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; color: #f8fafc; background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 11px 12px; outline: none; transition: border-color 150ms ease-out, box-shadow 150ms ease-out; }
.qr-input:focus, .qr-textarea:focus, .qr-select:focus { border-color: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,0.25); }
.qr-textarea { min-height: 96px; resize: vertical; }
.qr-btn { display: block; width: 100%; box-sizing: border-box; font: inherit; font-size: 16px; font-weight: 650; color: #0f172a; background: #22c55e; border: none; border-radius: 10px; padding: 13px 16px; margin-top: 16px; cursor: pointer; transition: transform 150ms ease-out, background-color 150ms ease-out; }
.qr-btn:hover { background: #4ade80; }
.qr-btn:active { transform: scale(0.96); }
.qr-btn:focus-visible { outline: 2px solid #f8fafc; outline-offset: 2px; }
.qr-btn--secondary { background: transparent; color: #f8fafc; border: 1px solid #334155; }
.qr-btn--secondary:hover { background: rgba(255,255,255,0.06); }
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

function labeledTimeInput(
  label: string,
  value: string,
  id: string,
): { wrapper: HTMLDivElement; input: HTMLInputElement } {
  const wrapper = el("div", "qr-field");
  const lab = el("label", "qr-label", label) as HTMLLabelElement;
  lab.htmlFor = id;
  const input = el("input", "qr-input") as HTMLInputElement;
  input.id = id;
  input.type = "time";
  input.value = value;
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
  opts?: {
    senders?: PanelSender[];
    keywords?: string[];
    quietHours?: { start: string; end: string } | null;
    businessConnections?: PanelBusinessConnection[];
    chatReplies?: PanelChatReplies[];
  },
): void {
  ensurePanelStyles();
  const appEl = document.querySelector<HTMLDivElement>("#app");
  if (!appEl) return;
  lastPanelArgs = { replies, chats, cb, voice, opts };
  const senders = opts?.senders ?? [];
  const keywords = opts?.keywords ?? [];
  const quietHours = opts?.quietHours ?? null;
  const businessConnections = opts?.businessConnections ?? [];
  const chatReplies = opts?.chatReplies ?? [];
  const signature = JSON.stringify({ replies, chats, voice, senders, keywords, quietHours, businessConnections, chatReplies, selectedReplyChat });
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
  repliesCard.id = "qr-replies-card";
  // Which chat the editor is scoped to (null = all chats). A chat with
  // its own set edits that set; one without starts from the global set,
  // and saving creates a set just for it.
  const selectedChat =
    selectedReplyChat === null
      ? null
      : (chats.find((c) => c.chat_id === selectedReplyChat) ?? null);
  const customSet =
    selectedReplyChat === null
      ? undefined
      : chatReplies.find((c) => c.chat_id === selectedReplyChat)?.replies;
  const scopedReplies = customSet ?? replies;
  const scopeTitle = selectedChat?.chat_title ?? "this chat";
  repliesCard.append(
    el("h2", "qr-card-title", "Canned replies"),
    el(
      "p",
      "qr-card-help",
      selectedReplyChat === null
        ? "Five replies, each at most 64 characters. Tap one on the glasses to send it."
        : customSet
          ? `Editing replies for ${scopeTitle}. Saving replaces this chat's set.`
          : `Editing replies for ${scopeTitle} — starting from the all-chats set. Saving creates a set just for this chat.`,
    ),
  );
  const scopeWrapper = el("div", "qr-field");
  const scopeLabel = el("label", "qr-label", "Replies for") as HTMLLabelElement;
  scopeLabel.htmlFor = "qr-replies-scope";
  const scopeSelect = document.createElement("select");
  scopeSelect.id = "qr-replies-scope";
  scopeSelect.className = "qr-select";
  scopeSelect.setAttribute("aria-label", "Replies for");
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All chats";
  scopeSelect.append(allOption);
  for (const chat of chats) {
    const option = document.createElement("option");
    option.value = String(chat.chat_id);
    option.textContent = chat.chat_title;
    scopeSelect.append(option);
  }
  scopeSelect.value =
    selectedReplyChat === null ? "" : String(selectedReplyChat);
  scopeSelect.addEventListener("change", () => {
    selectedReplyChat =
      scopeSelect.value === "" ? null : Number(scopeSelect.value);
    if (lastPanelArgs) {
      renderReplyPanel(
        lastPanelArgs.replies,
        lastPanelArgs.chats,
        lastPanelArgs.cb,
        lastPanelArgs.voice,
        lastPanelArgs.opts,
      );
    }
  });
  scopeWrapper.append(scopeLabel, scopeSelect);
  repliesCard.append(scopeWrapper);
  const fieldsEl = el("div", "qr-fields");
  const fields = scopedReplies.map((reply, i) =>
    labeledInput(`Reply ${i + 1}`, reply, `qr-reply-${i + 1}`),
  );
  fieldsEl.append(...fields.map((f) => f.wrapper));
  repliesCard.append(fieldsEl);

  statusEl = el("p", "qr-status") as HTMLParagraphElement;

  const saveButton = primaryButton("Save replies", () => {
    const next = fields.map((f) => f.input.value.trim());
    if (next.some((t) => t.length === 0 || t.length > 64)) {
      setPanelStatus("Each reply must be 1-64 characters.", "error");
      return;
    }
    if (selectedReplyChat === null) {
      cb.onSave(next);
    } else {
      cb.onSaveChatReplies?.(selectedReplyChat, next);
    }
  });
  const replyButtons: HTMLButtonElement[] = [saveButton];
  if (selectedReplyChat !== null && customSet) {
    const resetButton = primaryButton("Reset to all-chats replies", () => {
      cb.onClearChatReplies?.(selectedReplyChat as number);
    });
    resetButton.id = "qr-replies-reset";
    resetButton.classList.add("qr-btn--secondary");
    replyButtons.push(resetButton);
  }
  repliesCard.append(...replyButtons, statusEl);
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

  const vipCard = el("section", "qr-card");
  vipCard.id = "qr-vips";
  vipCard.append(
    el("h2", "qr-card-title", "VIP senders"),
    el(
      "p",
      "qr-card-help",
      "VIP senders always come first in the inbox, even when their message is already read — and their messages still reach the glasses during quiet hours.",
    ),
  );
  const vipList = el("div", "qr-chats");
  if (senders.length === 0) {
    vipList.append(el("p", "qr-empty", "No senders yet"));
  }
  for (const sender of senders) {
    const row = el("label", "qr-chat-row qr-vip-row") as HTMLLabelElement;
    const box = el("input", "qr-toggle") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = sender.vip;
    box.setAttribute("aria-label", `VIP ${sender.sender_name}`);
    box.addEventListener("change", () => {
      cb.onToggleVip?.(sender.sender_id, box.checked);
    });
    const track = el("span", "qr-toggle-ui");
    const name = el("span", "qr-chat-name qr-vip-name", sender.sender_name);
    row.append(box, track, name);
    vipList.append(row);
  }
  vipCard.append(vipList);
  root.append(vipCard);

  const keywordsCard = el("section", "qr-card");
  keywordsCard.id = "qr-keywords-card";
  keywordsCard.append(
    el("h2", "qr-card-title", "Urgency keywords"),
    el(
      "p",
      "qr-card-help",
      "Messages containing one of these words jump ahead in the inbox. Comma-separated, at most 20. Leave empty to turn urgency off.",
    ),
  );
  const kw = el("input", "qr-input") as HTMLInputElement;
  kw.id = "qr-keywords";
  kw.value = keywords.join(", ");
  kw.setAttribute("aria-label", "Urgency keywords, comma-separated");
  keywordsCard.append(kw);
  keywordsCard.append(
    primaryButton("Save keywords", () => {
      cb.onSaveKeywords?.(kw.value);
    }),
  );
  root.append(keywordsCard);

  const quietCard = el("section", "qr-card");
  quietCard.id = "qr-quiet-card";
  quietCard.append(
    el("h2", "qr-card-title", "Quiet hours"),
    el(
      "p",
      "qr-card-help",
      "New messages wait on the server during these hours and reach the glasses later. VIP and urgent messages still come through. Both empty turns quiet hours off.",
    ),
  );
  const quietFields = el("div", "qr-fields");
  const startField = labeledTimeInput("From", quietHours?.start ?? "", "qr-quiet-start");
  const endField = labeledTimeInput("Until", quietHours?.end ?? "", "qr-quiet-end");
  quietFields.append(startField.wrapper, endField.wrapper);
  quietCard.append(quietFields);
  quietCard.append(
    primaryButton("Save quiet hours", () => {
      const start = startField.input.value === "" ? null : startField.input.value;
      const end = endField.input.value === "" ? null : endField.input.value;
      cb.onSaveQuietHours?.(start, end);
    }),
  );
  root.append(quietCard);

  const businessCard = el("section", "qr-card");
  businessCard.id = "qr-business-card";
  const live = businessConnections.filter((c) => c.is_enabled);
  businessCard.append(el("h2", "qr-card-title", "Telegram Business"));
  if (live.length === 0) {
    businessCard.append(
      el(
        "p",
        "qr-card-help",
        "Not connected — connect the bot in Telegram Business settings to reply as your business account.",
      ),
    );
  } else {
    const canReply = live.some((c) => c.can_reply);
    businessCard.append(
      el(
        "p",
        "qr-card-help",
        canReply
          ? "Connected — replies in customer chats go out as your business account."
          : "Connected, but replies are paused (no customer message in the last 24 hours).",
      ),
    );
  }
  root.append(businessCard);

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
