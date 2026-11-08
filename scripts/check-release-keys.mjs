#!/usr/bin/env node
/**
 * 发布阻断检查（P1-1，d.111 审计）：应用内置的首方公钥不能还是开发/测试钥。
 *
 * 背景：`packages/desktop/resources/official-keys.json` 里当前是 `dev-test-*` 公钥，
 * 对应私钥就写在测试夹具里（`plugin-signature.test.js` / `plugin-store.test.js`）。
 * 如果带着它发版，任何拿到仓库的人都能签出「官方」界面插件包——这是把「只允许
 * 官方面板插件」变成一句空话的最短路径。
 *
 * 用法：
 *   node scripts/check-release-keys.mjs            # 发布前跑：只有 dev-* 键 → exit 2
 *   node scripts/check-release-keys.mjs --allow-dev # 本地/CI 开发（明确放行 dev 键）
 *
 * 退出码：
 *   0  公钥表含至少一把正式钥（或 --allow-dev）
 *   2  只有 dev-* 键：正式发版前必须换正式首方公钥（见文件 _rotate）
 *   1  公钥表缺失/不可解析（配置错误，同样阻断发布）
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS_FILE = resolve(ROOT, "packages/desktop/resources/official-keys.json");
const ALLOW_DEV = process.argv.includes("--allow-dev");

function fail(message, code) {
  console.error(`[check-release-keys] ${message}`);
  process.exit(code);
}

if (!existsSync(KEYS_FILE)) {
  fail(`首方公钥表不存在：${KEYS_FILE}`, 1);
}

let table;
try {
  table = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
} catch (err) {
  fail(`首方公钥表不是合法 JSON：${KEYS_FILE}（${(err && err.message) || err}）`, 1);
}
if (!table || typeof table !== "object" || Array.isArray(table)) {
  fail(`首方公钥表必须是 { keyId: base64url } 对象：${KEYS_FILE}`, 1);
}

const keyIds = Object.keys(table).filter((keyId) => !keyId.startsWith("_"));
if (keyIds.length === 0) {
  fail(`首方公钥表为空：${KEYS_FILE}`, 1);
}
const official = keyIds.filter((keyId) => !/^dev[-_.]/i.test(keyId));

if (official.length === 0) {
  const detail = `只有开发/测试公钥：${keyIds.join(", ")}`;
  if (ALLOW_DEV) {
    console.warn(`[check-release-keys] 警告：${detail}；--allow-dev 仅供本地/CI 开发使用`);
    process.exit(0);
  }
  fail(
    `正式发版前必须换正式首方公钥（见文件 _rotate）——当前 ${detail}。\n` +
      `  换钥流程见 packages/desktop/resources/official-keys.json 的 _rotate 注释；\n` +
      `  本地/CI 开发可加 --allow-dev 跳过本检查。`,
    2,
  );
}

console.log(`[check-release-keys] OK：首方公钥表含正式密钥（${official.join(", ")}）`);
