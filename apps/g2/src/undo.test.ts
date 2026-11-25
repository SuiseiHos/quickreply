import { test, expect } from "vitest";
import { createUndoWindow } from "./undo.js";

test("start sets the pending key", () => {
  const w = createUndoWindow(2000);
  w.start("key-1", 1000);
  expect(w.pending).toBe("key-1");
});

test("tap after the arm delay cancels the pending send", () => {
  const w = createUndoWindow(2000);
  w.start("key-1", 1000);
  expect(w.tap(1400)).toBe("cancelled");
  expect(w.pending).toBeNull();
});

test("tap inside the arm delay is ignored (duplicate delivery of the same tap)", () => {
  const w = createUndoWindow(2000);
  w.start("key-1", 1000);
  expect(w.tap(1100)).toBe("ignored");
  expect(w.pending).toBe("key-1");
});

test("tap with nothing pending returns none", () => {
  const w = createUndoWindow(2000);
  expect(w.tap(1000)).toBe("none");
});

test("expire returns the key once the window has elapsed", () => {
  const w = createUndoWindow(2000);
  w.start("key-1", 1000);
  expect(w.expire(2500)).toBeNull();
  expect(w.expire(3000)).toBe("key-1");
  expect(w.pending).toBeNull();
});

test("tap after expiry returns none", () => {
  const w = createUndoWindow(2000);
  w.start("key-1", 1000);
  w.expire(3000);
  expect(w.tap(3100)).toBe("none");
});

test("tap at or after the window end does not cancel (the send has fired or is firing)", () => {
  const w = createUndoWindow(2000);
  w.start("key-1", 1000);
  // Exactly at the window end: the timer owns the send now, not the tap.
  expect(w.tap(3000)).toBe("none");
  expect(w.pending).toBe("key-1");
  expect(w.tap(3100)).toBe("none");
  expect(w.pending).toBe("key-1");
});

test("clear drops the pending key", () => {
  const w = createUndoWindow(2000);
  w.start("key-1", 1000);
  w.clear();
  expect(w.pending).toBeNull();
  expect(w.tap(1400)).toBe("none");
});

test("expire with nothing pending returns null", () => {
  const w = createUndoWindow(2000);
  expect(w.expire(1000)).toBeNull();
});

test("starting a new send replaces the pending key", () => {
  const w = createUndoWindow(2000);
  w.start("key-1", 1000);
  w.start("key-2", 1500);
  expect(w.pending).toBe("key-2");
});
