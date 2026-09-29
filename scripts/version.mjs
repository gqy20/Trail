import { readFileSync, writeFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const manifest = read("public/manifest.json");
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Trail 发布版本必须为 x.y.z。");
if (process.argv[2] === "sync") {
  manifest.version = pkg.version;
  writeFileSync(new URL("../public/manifest.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已同步扩展版本 ${pkg.version}，请补充 CHANGELOG.md。`);
} else {
  // pnpm-lock.yaml 不记录根包版本，版本一致性只校验 manifest 与更新日志。
  for (const [name, value] of [["manifest", manifest.version]]) {
    if (value !== pkg.version) throw new Error(`${name} 版本 ${value} 与 package.json ${pkg.version} 不一致。运行 pnpm run version:sync。`);
  }
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  if (!changelog.includes(`## [${pkg.version}]`)) throw new Error(`CHANGELOG.md 缺少 ${pkg.version} 版本记录。`);
  console.log(`版本一致性检查通过：Trail ${pkg.version}`);
}
