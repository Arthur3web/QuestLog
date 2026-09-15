export default async function run(page, ui) {
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  await page.waitForSelector(".card", { timeout: 15000 });
  await page.waitForTimeout(400);

  // 1. Board modal BEFORE any context-menu interaction
  await page.click("#new-board-btn");
  await page.waitForTimeout(400);
  const opensBefore = await page.evaluate(() =>
    !document.getElementById("board-modal").classList.contains("hidden"));
  await page.click('#board-modal [data-close]');
  await page.waitForTimeout(300);

  // 2. Right-click a card, then Escape
  const card = page.locator(".card").first();
  await card.click({ button: "right" });
  await page.waitForTimeout(300);
  const menuOpen = await page.evaluate(() =>
    !document.getElementById("task-context-menu").classList.contains("hidden"));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const menuClosed = await page.evaluate(() =>
    document.getElementById("task-context-menu").classList.contains("hidden"));

  // 3. Board modal AFTER the context-menu interaction
  await page.click("#new-board-btn");
  await page.waitForTimeout(400);
  const opensAfter = await page.evaluate(() =>
    !document.getElementById("board-modal").classList.contains("hidden"));

  return { opensBefore, menuOpen, menuClosed, opensAfter, errs };
}