/** @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  renderReplyPanel,
  setPanelStatus,
  __clearPanelForTests,
  type PanelChat,
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
} {
  return {
    onSave: vi.fn(),
    onSaveVoice: vi.fn(),
    onToggleChat: vi.fn(),
    onToggleVip: vi.fn(),
    onSaveKeywords: vi.fn(),
  };
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
