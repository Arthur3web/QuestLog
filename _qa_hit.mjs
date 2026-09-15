export default async function run(page, ui) {
  await page.waitForSelector(".card", { timeout: 15000 });
  await page.waitForTimeout(400);

  await page.click("#new-board-btn");
  await page.waitForTimeout(500);

  return await page.evaluate(() => {
    const btn = document.querySelector("#board-modal .footer-actions .btn-secondary");
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return {
      btnRect: { x: r.x, y: r.y, w: r.width, h: r.height },
      topElement: top ? (top.tagName + "." + top.className + "#" + top.id) : null,
      modalHidden: document.getElementById("board-modal").classList.contains("hidden"),
      overlayHidden: document.getElementById("calendar-overlay").classList.contains("hidden"),
      boardModalClasses: document.getElementById("board-modal").className,
      computed: {
        pe: getComputedStyle(btn).pointerEvents,
        vis: getComputedStyle(btn).visibility,
        disp: getComputedStyle(btn).display,
      },
    };
  });
}