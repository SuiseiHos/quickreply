/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  renderReplyPanel,
  setPanelStatus,
  __clearPanelForTests,
  type PanelChat,
  type PanelChatReplies,
  type PanelSender,
  type ReplyPanelCallbacks,
} from "./phone-panel";

const REPLIES = ["On my way", "Noted, will check", "Can't talk now", "Yes", "No"];
const CHATS: PanelChat[] = [
  { chat_id: -1, chat_title: "Ops", allowed: true },
  { chat_id: -2, chat_title: "New group", allowed: false },
];
const SENDERS: PanelSender[] = [
  { sender_id: 555, sender_name: "Ani", vip: true },
  { sender_id: 777, sender_name: "Budi", vip: false },
];

function callbacks(): ReplyPanelCallbacks & {
  onSave: ReturnType<typeof vi.fn>;
  onSaveVoice: ReturnType<typeof vi.fn>;
  onToggleChat: ReturnType<typeof vi.fn>;
  onToggleVip: ReturnType<typeof vi.fn>;
  onSaveKeywords: ReturnType<typeof vi.fn>;
  onSaveQuietHours: ReturnType<typeof vi.fn>;
  onSaveChatReplies: ReturnType<typeof vi.fn>;
  onClearChatReplies: ReturnType<typeof vi.fn>;
} {
  return {
    onSave: vi.fn(),
    onSaveVoice: vi.fn(),
    onToggleChat: vi.fn(),
    onToggleVip: vi.fn(),
    onSaveKeywords: vi.fn(),
    onSaveQuietHours: vi.fn(),
    onSaveChatReplies: vi.fn(),
    onClearChatReplies: vi.fn(),
  };
}

const WORK = ["On it", "In a meeting", "Will check", "Yes", "No"];
const CHAT_REPLIES: PanelChatReplies[] = [{ chat_id: -1, replies: WORK }];

function scopeSelect(): HTMLSelectElement {
  return document.querySelector("#qr-replies-scope") as HTMLSelectElement;
}

function selectScope(value: string): void {
  const select = scopeSelect();
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function saveButton(): HTMLButtonElement {
  return document.querySelectorAll(
    "#qr-replies-card .qr-btn",
  )[0] as HTMLButtonElement;
}

function resetButton(): HTMLButtonElement | null {
  return document.querySelector("#qr-replies-reset") as HTMLButtonElement | null;
}

function inputs(): HTMLInputElement[] {
  return [
    ...document.querySelectorAll("#qr-replies-card .qr-input"),
  ] as HTMLInputElement[];
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  __clearPanelForTests();
});

describe("renderReplyPanel", () => {
  it("renders five labeled reply inputs with the current values", () => {
    renderReplyPanel(REPLIES, CHATS, callbacks());
    expect(inputs()).toHaveLength(5);
    expect(inputs().map((i) => i.value)).toEqual(REPLIES);
    expect(document.querySelector("label[for='qr-reply-1']")?.textContent).toBe(
      "Reply 1",
    );
    expect(document.querySelector(".qr-btn")?.textContent).toBe("Save replies");
  });

  it("renders a scope selector with All chats plus one option per chat", () => {
    renderReplyPanel(REPLIES, CHATS, callbacks(), null, {
      chatReplies: CHAT_REPLIES,
    });
    const options = [...scopeSelect().options].map((o) => o.textContent);
    expect(options).toEqual(["All chats", "Ops", "New group"]);
    expect(scopeSelect().value).toBe("");
    expect(resetButton()).toBe(null);
  });

  it("selecting a chat shows that chat's replies in the inputs", () => {
    renderReplyPanel(REPLIES, CHATS, callbacks(), null, {
      chatReplies: CHAT_REPLIES,
    });
    selectScope("-1");
    expect(inputs().map((i) => i.value)).toEqual(WORK);
  });

  it("selecting a chat without a custom set starts from the global replies", () => {
    renderReplyPanel(REPLIES, CHATS, callbacks(), null, {
      chatReplies: CHAT_REPLIES,
    });
    selectScope("-2");
    expect(inputs().map((i) => i.value)).toEqual(REPLIES);
  });

  it("saving while a chat is selected calls onSaveChatReplies with the chat id", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb, null, { chatReplies: CHAT_REPLIES });
    selectScope("-1");
    inputs()[0].value = "On it now";
    saveButton().click();
    expect(cb.onSaveChatReplies).toHaveBeenCalledWith(-1, [
      "On it now",
      "In a meeting",
      "Will check",
      "Yes",
      "No",
    ]);
    expect(cb.onSave).not.toHaveBeenCalled();
  });

  it("saving while All chats is selected still calls onSave", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb, null, { chatReplies: CHAT_REPLIES });
    saveButton().click();
    expect(cb.onSave).toHaveBeenCalledWith(REPLIES);
    expect(cb.onSaveChatReplies).not.toHaveBeenCalled();
  });

  it("the reset button appears only for a chat with a custom set and calls onClearChatReplies", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb, null, { chatReplies: CHAT_REPLIES });
    selectScope("-1");
    expect(resetButton()?.textContent).toBe("Reset to all-chats replies");
    resetButton()?.click();
    expect(cb.onClearChatReplies).toHaveBeenCalledWith(-1);
  });

  it("an inbox re-render does not reset the selected scope mid-edit", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb, null, { chatReplies: CHAT_REPLIES });
    selectScope("-1");
    inputs()[0].value = "On it now";
    // Same args again, as an inbox update would do: the scope stays on
    // the chat and the text being typed is not wiped.
    renderReplyPanel(REPLIES, CHATS, cb, null, { chatReplies: CHAT_REPLIES });
    expect(scopeSelect().value).toBe("-1");
    expect(inputs()[0].value).toBe("On it now");
    expect(inputs().slice(1).map((i) => i.value)).toEqual(WORK.slice(1));
  });

  it("renders chat toggles checked for allowed chats and a Pending badge otherwise", () => {
    renderReplyPanel(REPLIES, CHATS, callbacks());
    const toggles = [
      ...document.querySelectorAll(".qr-toggle"),
    ] as HTMLInputElement[];
    expect(toggles).toHaveLength(2);
    expect(toggles[0].checked).toBe(true);
    expect(toggles[1].checked).toBe(false);
    expect(toggles[1].getAttribute("aria-label")).toContain("New group");
    const badges = [...document.querySelectorAll(".qr-badge")].map(
      (b) => b.textContent,
    );
    expect(badges).toEqual(["Pending"]);
    expect(document.querySelector(".qr-chat-name")?.textContent).toBe("Ops");
  });

  it("flipping a toggle calls onToggleChat with the chat id and new state", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb);
    const toggles = [
      ...document.querySelectorAll(".qr-toggle"),
    ] as HTMLInputElement[];
    toggles[1].checked = true;
    toggles[1].dispatchEvent(new Event("change", { bubbles: true }));
    expect(cb.onToggleChat).toHaveBeenCalledWith(-2, true);
  });

  it("renders VIP toggles for known senders, checked for VIPs", () => {
    renderReplyPanel(REPLIES, CHATS, callbacks(), null, { senders: SENDERS });
    const toggles = [
      ...document.querySelectorAll(".qr-vip-row .qr-toggle"),
    ] as HTMLInputElement[];
    expect(toggles).toHaveLength(2);
    expect(toggles[0].checked).toBe(true);
    expect(toggles[0].getAttribute("aria-label")).toContain("Ani");
    expect(toggles[1].checked).toBe(false);
    expect(document.querySelector(".qr-vip-name")?.textContent).toBe("Ani");
  });

  it("flipping a VIP toggle calls onToggleVip with the sender id and new state", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb, null, { senders: SENDERS });
    const toggles = [
      ...document.querySelectorAll(".qr-vip-row .qr-toggle"),
    ] as HTMLInputElement[];
    toggles[1].checked = true;
    toggles[1].dispatchEvent(new Event("change", { bubbles: true }));
    expect(cb.onToggleVip).toHaveBeenCalledWith(777, true);
  });

  it("renders the Business card: not connected, connected, and paused", () => {
    renderReplyPanel(REPLIES, CHATS, callbacks(), null, {
      businessConnections: [],
    });
    const card = document.querySelector("#qr-business-card") as HTMLElement;
    expect(card.textContent).toContain("Not connected");
    renderReplyPanel(REPLIES, CHATS, callbacks(), null, {
      businessConnections: [
        { id: "conn-1", user_chat_id: 777, can_reply: true, is_enabled: true },
      ],
    });
    const connected = document.querySelector("#qr-business-card") as HTMLElement;
    expect(connected.textContent).toContain("Connected");
    renderReplyPanel(REPLIES, CHATS, callbacks(), null, {
      businessConnections: [
        { id: "conn-1", user_chat_id: 777, can_reply: false, is_enabled: true },
      ],
    });
    const paused = document.querySelector("#qr-business-card") as HTMLElement;
    expect(paused.textContent).toContain("paused");
  });

  it("renders the keywords input with the current list and saves edits", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb, null, {
      senders: SENDERS,
      keywords: ["down", "asap"],
    });
    const input = document.querySelector("#qr-keywords") as HTMLInputElement;
    expect(input.value).toBe("down, asap");
    input.value = "down, failed";
    const saveBtn = [...document.querySelectorAll(".qr-btn")].find(
      (b) => b.textContent === "Save keywords",
    ) as HTMLButtonElement;
    saveBtn.click();
    expect(cb.onSaveKeywords).toHaveBeenCalledWith("down, failed");
  });

  it("renders quiet-hours inputs and saves the window, empty means off", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb, null, {
      senders: SENDERS,
      quietHours: { start: "22:00", end: "07:00" },
    });
    const start = document.querySelector("#qr-quiet-start") as HTMLInputElement;
    const end = document.querySelector("#qr-quiet-end") as HTMLInputElement;
    expect(start.value).toBe("22:00");
    expect(end.value).toBe("07:00");
    start.value = "23:00";
    end.value = "06:00";
    const saveBtn = [...document.querySelectorAll(".qr-btn")].find(
      (b) => b.textContent === "Save quiet hours",
    ) as HTMLButtonElement;
    saveBtn.click();
    expect(cb.onSaveQuietHours).toHaveBeenCalledWith("23:00", "06:00");

    start.value = "";
    end.value = "";
    saveBtn.click();
    expect(cb.onSaveQuietHours).toHaveBeenCalledWith(null, null);
  });

  it("saves trimmed replies and rejects an empty slot without calling onSave", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb);
    inputs()[0].value = "  On my way!  ";
    (document.querySelector(".qr-btn") as HTMLButtonElement).click();
    expect(cb.onSave).toHaveBeenCalledWith([
      "On my way!",
      ...REPLIES.slice(1),
    ]);

    inputs()[1].value = "   ";
    (document.querySelector(".qr-btn") as HTMLButtonElement).click();
    expect(cb.onSave).toHaveBeenCalledTimes(1);
    const status = document.querySelector(".qr-status");
    expect(status?.textContent).toBe("Each reply must be 1-64 characters.");
    expect(status?.className).toContain("qr-status--error");
  });

  it("does not wipe typing when re-rendered with unchanged inputs", () => {
    renderReplyPanel(REPLIES, CHATS, callbacks());
    inputs()[0].value = "typing…";
    renderReplyPanel(REPLIES, CHATS, callbacks());
    expect(inputs()[0].value).toBe("typing…");
  });

  it("shows the voice editor only during review and saves through the callback", () => {
    const cb = callbacks();
    renderReplyPanel(REPLIES, CHATS, cb);
    expect(document.querySelector(".qr-textarea")).toBeNull();

    renderReplyPanel(REPLIES, CHATS, cb, {
      messageId: "-1:7",
      text: "On my way, five minutes.",
    });
    const area = document.querySelector(".qr-textarea") as HTMLTextAreaElement;
    expect(area.value).toBe("On my way, five minutes.");
    const buttons = [...document.querySelectorAll(".qr-btn")] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toContain("Save voice reply");
    buttons.find((b) => b.textContent === "Save voice reply")!.click();
    expect(cb.onSaveVoice).toHaveBeenCalledWith(
      "-1:7",
      "On my way, five minutes.",
    );
  });

  it("colors the status line: Saved is ok, errors are error", () => {
    renderReplyPanel(REPLIES, CHATS, callbacks());
    setPanelStatus("Saved", "ok");
    expect(document.querySelector(".qr-status")?.className).toContain(
      "qr-status--ok",
    );
    setPanelStatus("Could not save.", "error");
    expect(document.querySelector(".qr-status")?.className).toContain(
      "qr-status--error",
    );
  });
});
