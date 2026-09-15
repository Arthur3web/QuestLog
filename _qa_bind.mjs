export default async function run(page, ui) {
  await page.waitForSelector(".card", { timeout: 15000 });
  await page.waitForTimeout(600);

  const diag = await page.evaluate(() => {
    const btn = document.getElementById("new-board-btn");
    // Try dispatching a real click event and see if modal opens
    btn.click();
    return {
      taskBoardKeys: window.TaskBoard ? Object.keys(window.TaskBoard) : null,
      modalHiddenAfterClick: document.getElementById("board-modal").classList.contains("hidden"),
    };
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    modalHidden: document.getElementById("board-modal").classList.contains("hidden"),
  }));
  return { diag, after };
}