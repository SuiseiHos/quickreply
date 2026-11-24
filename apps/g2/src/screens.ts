// Screen text builders for the G2 glasses UI (576x288, monochrome).
// Layouts follow DEEP-DIVE.md section 6 exactly; English only (demo language).

/** Home screen (Screen 1); the count is live from the backend store. */
export function homeScreen(unreadCount: number): string {
  return [
    "QuickReply",
    "",
    "Tap = Messages",
    `${unreadCount} new`,
    "Double-tap = Exit",
  ].join("\n");
}
