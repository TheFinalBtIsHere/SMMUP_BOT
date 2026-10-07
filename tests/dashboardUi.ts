import assert from "node:assert/strict";
import { addNavigation, button, homeKeyboard, pageNavigation, wizardKeyboard } from "../src/ui/adminDashboard.js";

const home = homeKeyboard();
const callbacks = home.inline_keyboard.flat().map((entry) => entry.callback_data);
assert.ok(callbacks.includes("d:overview"));
assert.ok(callbacks.includes("d:users:0"));
assert.ok(callbacks.includes("d:payments"));
assert.ok(callbacks.includes("d:security"));
assert.ok(callbacks.every((value) => Buffer.byteLength(value, "utf8") <= 64));

const idA = "a".repeat(24);
const idB = "b".repeat(24);
const workflowCallbacks = [
  `d:order:${idA}:u:${idB}:9999`,
  `d:txn:${idA}:u:${idB}:9999`,
  `d:key:${idA}:${idB}:9999`,
  `d:records:orders:${idA}:9999`,
  `d:control:${idA}:payment_release`,
  `d:key-action:${idA}:api_reissue_required`,
  `d:review-toggle:${idA}:approved:9999`,
  `d:user:${idA}:se:9999`,
  `d:user:${idA}:of:${idB}:9999`,
  `d:user:${idA}:or:${idB}:9999`,
  `d:user:${idA}:ou:9999:${idB}`,
  `d:user:${idA}:tu:9999:${idB}`,
  `d:user:${idA}:tp:${idB}:9999`,
  `d:user:${idA}:th:${idB}:9999`,
  `d:user:${idA}:tm:SUPABCDE`,
];
for (const callback of workflowCallbacks) {
  assert.doesNotThrow(() => button("Button", callback), `callback exceeds Telegram's 64-byte limit: ${callback}`);
}

const oversizedLabel = button("📦".repeat(100), "d:home");
assert.ok(Array.from(oversizedLabel.text).length <= 64);
assert.throws(() => button("Invalid callback", "x".repeat(65)));

const withBack = addNavigation([[button("Open", "d:overview")]], "d:home", "d:overview");
assert.equal(withBack.inline_keyboard.at(-1)?.[0]?.callback_data, "d:home");
assert.equal(withBack.inline_keyboard.at(-2)?.[0]?.callback_data, "d:overview");
const paged = pageNavigation([], 0, 2, (page) => `d:users:${page}`, "d:home", "d:users:0");
assert.ok(paged.inline_keyboard.flat().some((entry) => entry.callback_data === "d:users:1"));
assert.equal(paged.inline_keyboard.at(-2)?.[0]?.callback_data, "d:users:0");
assert.equal(wizardKeyboard().inline_keyboard[0][0].callback_data, "d:wizard:cancel");

console.log("Admin dashboard keyboard checks passed.");
