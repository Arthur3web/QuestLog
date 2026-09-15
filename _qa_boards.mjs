export default async function run(page, ui) {
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  await page.waitForSelector(".card", { timeout: 15000 });
  await page.waitForTimeout(400);

  const btnExists = await page.locator("#new-board-btn").count();
  await page.click("#new-board-btn");
  await page.waitForTimeout(500);
  const modalHidden = await page.evaluate(() =>
    document.getElementById("board-modal").classList.contains("hidden"));
  const btnDisabled = await page.evaluate(() =>
    document.getElementById("create-board-btn").disabled);

  // Try people modal and calendar too
  await page.click("#manage-people-btn");
  await page.waitForTimeout(400);
  const peopleHidden = await page.evaluate(() =>
    document.getElementById("people-modal").classList.contains("hidden"));

  return { btnExists, modalHidden, btnDisabled, peopleHidden, errs };
}