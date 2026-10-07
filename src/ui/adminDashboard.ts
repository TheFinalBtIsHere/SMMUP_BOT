export type DashboardButton = { text: string; callback_data: string };
export type DashboardKeyboard = { inline_keyboard: DashboardButton[][] };

export function button(text: string, callback_data: string): DashboardButton {
  if (!callback_data || Buffer.byteLength(callback_data, "utf8") > 64) {
    throw new Error("Telegram callback_data must be between 1 and 64 bytes.");
  }
  const safeText = Array.from(String(text)).slice(0, 64).join("");
  return { text: safeText, callback_data };
}

export function homeKeyboard(): DashboardKeyboard {
  return {
    inline_keyboard: [
      [button("📊 Overview", "d:overview"), button("👥 Users", "d:users:0")],
      [button("📦 Orders", "d:orders:recent:0"), button("🚨 Failed review", "d:orders:failed:0")],
      [button("💳 Payments", "d:payments"), button("🔐 Security", "d:security")],
      [button("⭐ Reviews", "d:reviews:0"), button("⚙️ Worker", "d:workers")],
      [button("🔎 Find user", "d:usersearch"), button("📘 Commands", "d:commands")],
    ],
  };
}

export function addNavigation(
  rows: DashboardButton[][],
  backCallback: string,
  refreshCallback?: string,
): DashboardKeyboard {
  return {
    inline_keyboard: [
      ...rows,
      ...(refreshCallback ? [[button("🔄 Refresh", refreshCallback)]] : []),
      [button("⬅ Back", backCallback), button("🏠 Dashboard", "d:home")],
    ],
  };
}

export function pageNavigation(
  rows: DashboardButton[][],
  page: number,
  pageCount: number,
  callbackForPage: (page: number) => string,
  backCallback: string,
  refreshCallback?: string,
): DashboardKeyboard {
  if (pageCount > 1) {
    const controls: DashboardButton[] = [];
    if (page > 0) controls.push(button("◀ Previous", callbackForPage(page - 1)));
    controls.push(button(`${page + 1}/${pageCount}`, "d:noop"));
    if (page + 1 < pageCount) controls.push(button("Next ▶", callbackForPage(page + 1)));
    rows.push(controls);
  }
  return addNavigation(rows, backCallback, refreshCallback);
}

export function wizardKeyboard(): DashboardKeyboard {
  return {
    inline_keyboard: [
      [button("✖ Cancel", "d:wizard:cancel"), button("🏠 Dashboard", "d:home")],
    ],
  };
}
