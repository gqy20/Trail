import { test, expect } from "@playwright/test";
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

test("版本检查拒绝不一致，同步以 package.json 为准", ({}, testInfo) => {
  const root = testInfo.outputPath("release");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "public"), { recursive: true });
  copyFileSync("scripts/version.mjs", join(root, "scripts/version.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.2.0" }));
  writeFileSync(join(root, "public/manifest.json"), JSON.stringify({ version: "0.1.0", name: "Trail" }));
  writeFileSync(join(root, "CHANGELOG.md"), "## [0.2.0]\n");
  const run = (mode: string) => execFileSync(process.execPath, [join(root, "scripts/version.mjs"), mode], { stdio: "pipe" });
  expect(() => run("check")).toThrow();
  run("sync");
  expect(() => run("check")).not.toThrow();
  expect(JSON.parse(readFileSync(join(root, "public/manifest.json"), "utf8"))).toEqual({ version: "0.2.0", name: "Trail" });
  writeFileSync(join(root, "CHANGELOG.md"), "## [0.1.0]\n");
  expect(() => run("check")).toThrow();
});
