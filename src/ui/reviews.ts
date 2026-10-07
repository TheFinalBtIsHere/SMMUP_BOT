import { ObjectId } from "mongodb";
import { escapeHtml } from "../security/telegramHtml.js";

export function reviewModerationText(review: any, status: "approved" | "hidden"): string {
  const stars = "★".repeat(Math.max(1, Math.min(5, Number(review.rating) || 1)));
  const body = String(review.text || "").slice(0, 900);
  return (
    `${status === "hidden" ? "🙈" : "✅"} <b>${escapeHtml(review.username)}</b> · ${stars}\n` +
    `<code>${review._id.toString()}</code>\n` +
    `${review.city ? `📍 ${escapeHtml(review.city)}\n` : ""}` +
    `\n${escapeHtml(body)}\n\n` +
    `<i>Status: ${status.toUpperCase()}</i>`
  );
}

export function reviewModerationKeyboard(id: ObjectId, status: "approved" | "hidden") {
  return {
    inline_keyboard: [
      [{
        text: status === "hidden" ? "👁 Show review" : "🙈 Hide review",
        callback_data: `review-toggle:${id.toString()}`,
      }],
      [{ text: "🏠 Dashboard", callback_data: "d:home" }],
    ],
  };
}
