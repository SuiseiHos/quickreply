import { test, expect } from "vitest";
import { homeScreen } from "./screens.js";

test("homeScreen shows QuickReply with 0 new messages", () => {
  expect(homeScreen(0)).toBe(
    ["QuickReply", "", "Tap = Messages", "0 new", "Double-tap = Exit"].join(
      "\n",
    ),
  );
});

test("homeScreen shows the unread count", () => {
  expect(homeScreen(3)).toBe(
    ["QuickReply", "", "Tap = Messages", "3 new", "Double-tap = Exit"].join(
      "\n",
    ),
  );
});
