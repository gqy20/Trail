import { test, expect } from "@playwright/test";
import { exportFollowsCsv, parseFollowsText, removeFollows } from "../src/collector/follows";

test("账号 CSV 保留名称中的逗号、引号、换行以及优先级", () => {
  const entries = [{ platform: "twitter", handle: "research", priority: 5, displayName: '研究, "实验"\n室' }];
  expect(parseFollowsText("twitter", "\uFEFF" + exportFollowsCsv(entries))).toEqual(entries);
  expect(parseFollowsText("twitter", "handle,name\nsama,Sam Altman")).toEqual([{ platform: "twitter", handle: "sama", displayName: "Sam Altman", priority: undefined }]);
});

test("批量删除仅移除指定平台的已选账号", async () => {
  let entries = [
    { platform: "twitter", handle: "same" },
    { platform: "twitter", handle: "keep" },
    { platform: "xhs", handle: "same" }
  ];
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { local: {
    get: async () => ({ "trail.follows.v1": entries }),
    set: async (values: Record<string, typeof entries>) => { entries = values["trail.follows.v1"]; }
  } } } as unknown as typeof chrome;
  try {
    await removeFollows("twitter", ["same"]);
    expect(entries).toEqual([{ platform: "twitter", handle: "keep" }, { platform: "xhs", handle: "same" }]);
  } finally { globalThis.chrome = previous; }
});
