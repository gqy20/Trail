import { test, expect } from "@playwright/test";
import { parseLiteratureCsv } from "../src/literature-queue/csv";
import { mergeLiteratureQueues } from "../src/literature-queue/merge";

test("提取结果合并去重，保留已有下载和人工筛选状态并补全文入口", () => {
  const current = parseLiteratureCsv("title,doi,decision\nFirst,10.1234/a,include\nSecond,10.1234/b,maybe", "manual.csv");
  current.items[0].status = "completed";
  current.items[0].filename = "first.pdf";
  const imported = parseLiteratureCsv("title,doi,pdf_url\nFirst renamed,10.1234/a,https://example.com/a.pdf\nThird,10.1234/c,https://example.com/c.pdf", "提取结果");
  const next = mergeLiteratureQueues(current, imported);
  expect(next.items).toHaveLength(3);
  expect(next.items[0]).toMatchObject({ title: "First", status: "completed", decision: "include", filename: "first.pdf", pdfUrl: "https://example.com/a.pdf" });
  expect(next.sourceName).toBe("manual.csv");
  expect(current.items[0].pdfUrl).toBeUndefined();
  expect(mergeLiteratureQueues(next, imported).items).toHaveLength(3);
});
