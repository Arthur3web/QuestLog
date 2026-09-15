export default async function run(page, ui) {
  await page.waitForSelector(".card", { timeout: 15000 });
  await page.waitForTimeout(400);
  const card = page.locator(".card").first();
  const out = {};

  // Baseline
  await page.click("#new-board-btn");
  await page.waitForTimeout(400);
  out.baselineOpen = await page.evaluate(() =>
    !document.getElementById("board-modal").classList.contains("hidden"));
  await page.click("#board-modal .footer-actions .btn-secondary");
  await page.waitForTimeout(350);

  // After right-click only (no Escape)
  await card.click({ button: "right" });
  await page.waitForTimeout(250);
  out.menuAfterRightClick = await page.evaluate(() =>
    !document.getElementById("task-context-menu").classList.contains("hidden"));
  await page.mouse.click(8, 8);
  await page.waitForTimeout(250);
  out.menuAfterOutsideClick = await page.evaluate(() =>
    document.getElementById("task-context-menu").classList.contains("hidden"));
  await page.click("#new-board-btn");
  await page.waitForTimeout(400);
  out.openAfterOutsideClick = await page.evaluate(() =>
    !document.getElementById("board-modal").classList.contains("hidden"));

  return out;
}