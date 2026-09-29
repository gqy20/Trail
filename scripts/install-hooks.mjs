import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooksDir = resolve(root, ".git", "hooks");

if (!existsSync(resolve(root, ".git"))) {
  console.error("未找到 .git 目录，请在仓库根目录运行 pnpm run install-hooks。");
  process.exit(1);
}

mkdirSync(hooksDir, { recursive: true });

for (const hook of ["pre-commit", "commit-msg"]) {
  const source = resolve(root, "scripts", hook);
  const target = resolve(hooksDir, hook);
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  console.log(`${hook} hook installed -> ${target}`);
}
