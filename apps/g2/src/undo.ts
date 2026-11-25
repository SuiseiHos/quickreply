// Undo window for a canned reply: after the user taps a reply, the send
// waits `windowMs` before firing, and a second tap inside the window
// cancels it. Taps inside the first `armMs` are ignored — one physical
// tap can arrive twice (sysEvent + textEvent) and the duplicate must not
// cancel a send the user never meant to cancel.

export type UndoTap = "cancelled" | "ignored" | "none";

export type UndoWindow = {
  readonly pending: string | null;
  start(key: string, nowMs: number): void;
  tap(nowMs: number): UndoTap;
  expire(nowMs: number): string | null;
  /** Drop the pending key without firing or cancelling via a tap. */
  clear(): void;
};

export function createUndoWindow(
  windowMs: number,
  armMs = 300,
): UndoWindow {
  let pending: { key: string; startedAt: number } | null = null;
  return {
    get pending(): string | null {
      return pending ? pending.key : null;
    },
    start(key: string, nowMs: number): void {
      pending = { key, startedAt: nowMs };
    },
    tap(nowMs: number): UndoTap {
      if (!pending) return "none";
      if (nowMs - pending.startedAt < armMs) return "ignored";
      // At or past the window end the send has fired (or is firing) —
      // a late tap must not cancel a message that already went out.
      if (nowMs - pending.startedAt >= windowMs) return "none";
      pending = null;
      return "cancelled";
    },
    expire(nowMs: number): string | null {
      if (!pending) return null;
      if (nowMs - pending.startedAt < windowMs) return null;
      const key = pending.key;
      pending = null;
      return key;
    },
    clear(): void {
      pending = null;
    },
  };
}
