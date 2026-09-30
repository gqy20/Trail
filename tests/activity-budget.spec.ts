import { test, expect } from "@playwright/test";
import { getLogEntries, redactLogData } from "../src/logging/logger";
import { DEFAULT_BUDGET_CONFIG, evaluateBudget, getBudgetUsage, recordActivity, releaseActivity, saveBudgetConfig, validateBudgetConfig } from "../src/collector/budget";

test("6 小时为共享加权预算，主页与详情不会各自额外得到 6 小时", () => {
  const now = Date.now();
  const events = [...Array.from({ length: 60 }, () => ({ kind: "profile" as const, at: now - 1 })), ...Array.from({ length: 240 }, () => ({ kind: "detail" as const, at: now - 1 }))];
  const state = evaluateBudget("twitter", events, DEFAULT_BUDGET_CONFIG, now);
  expect(state).toMatchObject({ used: 360, limit: 360, allowed: false, profile: 60, detail: 240 });
  expect(state.nextAvailableAt).toBe(now - 1 + 86_400_000);
  expect(evaluateBudget("twitter", events, DEFAULT_BUDGET_CONFIG, now + 86_400_000)).toMatchObject({ used: 0, allowed: true });
});

test("恢复时间需释放足够额度，不能只取最早一笔", () => {
  const now = Date.now();
  const events = Array.from({ length: 60 }, (_, index) => ({ kind: "detail" as const, at: now - 10_000 + index * 100 }));
  expect(evaluateBudget("xhs", events, { ...DEFAULT_BUDGET_CONFIG, hours: 1 }, now, "profile").nextAvailableAt).toBe(events[1].at + 86_400_000);
  expect(evaluateBudget("xhs", events, { ...DEFAULT_BUDGET_CONFIG, hours: 1 }, now, "detail").nextAvailableAt).toBe(events[0].at + 86_400_000);
});

test("平台分账、持久化、并发硬顶、调整预算与取消预留", async () => {
  const previous = globalThis.chrome;
  const data: Record<string, unknown> = { "trail.activityBudget.v1": { profile: Array(30).fill(Date.now()), detail: [] } };
  globalThis.chrome = { storage: { local: {
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])),
    set: async (values: object) => { Object.assign(data, structuredClone(values)); }
  } } } as unknown as typeof chrome;
  try {
    await saveBudgetConfig("twitter", { hours: 1, profileIntervalSeconds: 1, detailIntervalSeconds: 1 });
    const results = await Promise.all(Array.from({ length: 31 }, () => recordActivity("twitter", "profile")));
    expect(results.filter((result) => result.allowed)).toHaveLength(30);
    expect(results[1].delayMs).toBeGreaterThan(0);
    expect(await getBudgetUsage(["twitter", "xhs"])).toEqual([expect.objectContaining({ used: 60, limit: 60 }), expect.objectContaining({ used: 0, limit: 360 })]);
    await releaseActivity(results[29], "profile");
    expect((await getBudgetUsage(["twitter"]))[0].used).toBe(58);
    await saveBudgetConfig("twitter", { ...DEFAULT_BUDGET_CONFIG, hours: 6 });
    expect((await recordActivity("twitter", "profile")).allowed).toBe(true);
    expect((await recordActivity("xhs", "detail")).used).toBe(1);
    expect((await getBudgetUsage(["twitter"]))[0].used).toBe(60);
    expect(data["trail.activityBudget.v1"]).toBeDefined();
    const logs = await getLogEntries();
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "budget.config.changed", data: expect.objectContaining({ platform: "twitter" }) }),
      expect.objectContaining({ event: "budget.denied", data: expect.objectContaining({ platform: "twitter", kind: "profile", config: expect.objectContaining({ hours: 1 }) }) }),
      expect.objectContaining({ event: "budget.reserved", data: expect.objectContaining({ platform: "xhs", kind: "detail" }) }),
      expect.objectContaining({ event: "budget.released", data: expect.objectContaining({ platform: "twitter" }) })
    ]));
  } finally { globalThis.chrome = previous; }
});

test("配置拒绝无效或无限预算", () => {
  expect(() => validateBudgetConfig({ ...DEFAULT_BUDGET_CONFIG, hours: NaN })).toThrow();
  expect(() => validateBudgetConfig({ ...DEFAULT_BUDGET_CONFIG, hours: 25 })).toThrow();
  expect(() => validateBudgetConfig({ ...DEFAULT_BUDGET_CONFIG, profileIntervalSeconds: 0 })).toThrow();
});

test("次数上限独立于浏览量，恢复需同时满足两项", () => {
  const now = Date.now();
  const events = [{ kind: "profile" as const, at: now - 1000 }, { kind: "detail" as const, at: now - 500 }];
  const config = { ...DEFAULT_BUDGET_CONFIG, profileLimit: 1, detailLimit: 2 };
  expect(evaluateBudget("twitter", events, config, now, "profile")).toMatchObject({ allowed: false, used: 3, nextAvailableAt: now - 1000 + 86_400_000 });
  expect(evaluateBudget("twitter", events, config, now, "detail").allowed).toBe(true);
  expect(evaluateBudget("xhs", [], config, now).allowed).toBe(true);
  expect(() => validateBudgetConfig({ ...config, profileLimit: -1 })).toThrow();
  expect(validateBudgetConfig({ ...config, detailIntervalSeconds: 1800 }).detailIntervalSeconds).toBe(1800);
});
test("导出的嵌套敏感数据也脱敏", () => {
  expect(redactLogData({ context: { token: "secret-value", config: { hours: 6 } } })).toEqual({ context: { token: "[已脱敏]", config: { hours: 6 } } });
});
