export default async function run(page, ui) {
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  page.on("response", r => {
    if (r.url().includes("/subtasks")) errs.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });

  await page.waitForSelector(".card", { timeout: 15000 });
  const card = page.locator(".card").first();
  await card.click();
  await page.waitForSelector("#task-modal:not(.hidden)", { timeout: 8000 });
  await page.waitForTimeout(500);

  const inputVisible = await page.isVisible("#tm-subtask-input");
  const addVisible = await page.isVisible("#tm-subtask-add");
  await page.fill("#tm-subtask-input", "QA-сабтаск");
  const val = await page.inputValue("#tm-subtask-input");
  await page.click("#tm-subtask-add");
  await page.waitForTimeout(1000);

  return {
    inputVisible,
    addVisible,
    val,
    subtaskHtml: await page.evaluate(() => document.getElementById("tm-subtasks").innerHTML.slice(0, 200)),
    subtaskCount: await page.locator(".subtask-item").count(),
    errs,
  };
}