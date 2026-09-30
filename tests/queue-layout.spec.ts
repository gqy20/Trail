import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";
import { parseLiteratureCsv } from "../src/literature-queue/csv";

test("长文献列表：两行题名与 DOI 不溢出、不重叠，处理数量排除已完成项", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const extension = resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium", executablePath: process.env.TRAIL_TEST_CHROMIUM, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 590, height: 944 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/entries/tools.html`);
    const titles = [
      "A comparative study of two cytotypes of Chenopodium album in West Bengal, India",
      "Synthetic polyploid production of Miscanthus sacchariflorus, Miscanthus sinensis, and Miscanthus xgiganteus",
      "Polyploidy, flowering phenology and climatic adaptation in Heteropogon contortus (Gramineae)",
      "Genetic variation, polyploidy and hybridization in Scandinavian Anthericum ramosum and A. liliago (Anthericaceae)",
      "Understanding the genetic landscape of flowering time variation in Brassica juncea and its diploid progenitors: unravelling the mechanisms of adaptation"
    ];
    const rows = Array.from({ length: 188 }, (_, i) => `${titles[i % titles.length].replaceAll(",", " ")},${i < 140 ? `10.1111/j.1442-9993.1976.tb01110.${i}` : ""},${i < 90 ? "include" : "maybe"}`);
    const queue = parseLiteratureCsv(`title,doi,decision\n${rows.join("\n")}`, "05_manual.csv");
    // 没有 DOI 的重复题名会被去重；用各自题名保持 188 篇真实列表规模。
    queue.items = Array.from({ length: 188 }, (_, i) => ({
      id: `layout-${i}`, title: titles[i % titles.length], doi: i < 140 ? `10.1111/j.1442-9993.1976.tb01110.${i}` : undefined,
      decision: i < 90 ? "include" : "maybe", sourceRows: 2,
      status: i < 42 ? "completed" : i < 140 ? "pending" : "needs_search",
      error: i === 51 ? "登录或机构权限需要人工确认，打开来源页面后重试。" : undefined
    }));
    queue.sourceRows = 236;
    await page.evaluate((queue) => chrome.storage.local.set({ "trail.literatureQueue": queue }), queue);
    await page.getByRole("button", { name: "日志", exact: true }).click();
    await expect(page.locator(".tools-nav").getByRole("button", { name: "文献队列", exact: true })).toHaveCount(0);
    await expect(page.locator(".tools-header .brand")).toHaveCount(0);
    await page.getByRole("button", { name: "文献队列", exact: true }).click();
    await expect(page.locator(".queue-row")).toHaveCount(60);
    for (const width of [360, 420, 590, 760]) {
      await page.setViewportSize({ width, height: 944 });
      await page.evaluate(() => document.fonts.ready);
      const defects = await page.locator(".queue-list").evaluate((list) => {
        const rows = [...list.querySelectorAll(".queue-row")];
        return rows.flatMap((row, index) => {
          const rect = row.getBoundingClientRect();
          const next = rows[index + 1]?.getBoundingClientRect();
          const children = [...row.querySelectorAll(".queue-row-main > *, .icon-button")];
          const overflow = children.some((child) => {
            const box = child.getBoundingClientRect();
            return box.top < rect.top || box.bottom > rect.bottom + 1;
          });
          return overflow || (next && rect.bottom > next.top) ? [index] : [];
        });
      });
      expect(defects, `rows at ${width}px`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`queue-${width}.png`), fullPage: true });
    }
    await expect(page.locator(".queue-start")).toContainText("98 篇");
    await expect(page.locator(".queue-summary")).toContainText("可处理 98");
    await page.getByRole("tab", { name: "纳入 90", exact: true }).click();
    await expect(page.locator(".queue-start")).toContainText("48 篇");
  } finally { await context.close(); }
});
