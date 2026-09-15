export default async function run(page, ui) {
  const results = {};
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));

  await page.waitForSelector(".card", { timeout: 15000 });
  await page.waitForTimeout(500);
  results.cardsRender = (await page.locator(".card").count()) > 0;

  // --- Контекстное меню по ПКМ ---
  const card = page.locator(".card").first();
  await card.click({ button: "right" });
  await page.waitForTimeout(250);
  results.contextMenuOpens = await page.evaluate(() =>
    !document.getElementById("task-context-menu").classList.contains("hidden"));
  results.priorityOptionsCount = await page.evaluate(() =>
    document.querySelectorAll("#cm-priority option").length);
  results.assigneeOptionsCount = await page.evaluate(() =>
    document.querySelectorAll("#cm-assignee option").length);
  results.columnOptionsCount = await page.evaluate(() =>
    document.querySelectorAll("#cm-column option").length);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  results.escapeClosesMenu = await page.evaluate(() =>
    document.getElementById("task-context-menu").classList.contains("hidden"));

  // --- Кнопка «Создать» доски ---
  await page.click("#new-board-btn");
  await page.waitForSelector("#board-modal:not(.hidden)", { timeout: 5000 });
  await page.waitForTimeout(300);
  results.createBoardDisabledInitially = await page.evaluate(() =>
    document.getElementById("create-board-btn").disabled);
  await page.fill("#new-board-name", "QA");
  await page.waitForTimeout(150);
  results.createBoardEnabledAfterTyping = await page.evaluate(() =>
    document.getElementById("create-board-btn").disabled === false);
  await page.fill("#new-board-name", "   ");
  await page.waitForTimeout(150);
  results.createBoardDisabledOnWhitespace = await page.evaluate(() =>
    document.getElementById("create-board-btn").disabled);
  await page.click('#board-modal [data-close]');
  await page.waitForTimeout(300);

  // --- Модалка задачи + подзадачи ---
  await card.click();
  await page.waitForSelector("#task-modal:not(.hidden)", { timeout: 8000 });
  await page.waitForTimeout(600);
  results.taskModalOpens = true;

  await page.fill("#tm-subtask-input", "QA-сабтаск");
  await page.click("#tm-subtask-add");
  await page.waitForTimeout(900);
  results.subtaskAdded = (await page.locator(".subtask-item").count()) > 0;

  await page.locator(".subtask-item .remove-btn").first().click({ timeout: 8000 });
  await page.waitForTimeout(450);
  results.confirmShownForSubtask = await page.evaluate(() =>
    !document.getElementById("confirm-modal").classList.contains("hidden"));
  results.confirmTitle = await page.textContent("#confirm-title");
  await page.click("#confirm-cancel");
  await page.waitForTimeout(450);
  results.subtaskKeptAfterCancel = (await page.locator(".subtask-item").count()) > 0;

  await page.locator(".subtask-item .remove-btn").first().click({ timeout: 8000 });
  await page.waitForTimeout(450);
  await page.click("#confirm-ok");
  await page.waitForTimeout(900);
  results.subtaskDeletedAfterConfirm = (await page.locator(".subtask-item").count()) === 0;

  await page.click('#task-modal [data-close]');
  await page.waitForTimeout(500);

  // --- Календарь ---
  await page.click("#calendar-toggle-btn");
  await page.waitForTimeout(600);
  results.calendarOpens = await page.evaluate(() =>
    document.getElementById("calendar-panel").classList.contains("open"));
  results.calendarGridCells = await page.evaluate(() =>
    document.querySelectorAll(".calendar-day").length);
  await page.click("#calendar-close-btn");
  await page.waitForTimeout(600);
  results.calendarCloses = await page.evaluate(() =>
    !document.getElementById("calendar-panel").classList.contains("open"));

  // --- tray-хук (главный мир страницы) ---
  await page.addScriptTag({
    content: `window.__tbCheck = typeof window.TaskBoard + "/" + typeof (window.TaskBoard||{}).openQuickAdd;`,
  });
  results.trayHook = await page.evaluate(() => window.__tbCheck);

  results.pageErrors = errs;
  return results;
}