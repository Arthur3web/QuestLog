export default async function run(page, ui) {
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message + " @ " + (e.stack || "").split("\n")[1]));
  page.on("console", m => { if (m.type() === "error") errs.push("console.error: " + m.text()); });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  return {
    errs,
    cards: await page.evaluate(() => document.querySelectorAll(".card").length),
    bodyChars: await page.evaluate(() => document.body.innerText.length),
    boardSelectOptions: await page.evaluate(() => document.getElementById("board-select").options.length),
  };
}