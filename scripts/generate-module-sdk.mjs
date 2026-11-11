#!/usr/bin/env node
/**
 * 生成模块包 SDK（d.131）：
 * - `packages/modules/sdk/index.ts`：模块包 `import ... from "@heming/sdk"` 的具名导出，
 *   运行时从 `globalThis.__hemingHost.files[<web 相对路径>]` 取；
 * - `packages/web/src/lib/modules/host-sdk.generated.ts`：宿主侧把对应共享模块挂进 files 表。
 *
 * 来源：
 * 1. 每个模块的 `module.sdk.json`（迁移脚本按源码 import 生成）：{ exports: { 名字: "store/llm" } }；
 * 2. 兜底扫描 `packages/modules/<id>/src/**` 里仍指向 packages/web/src 的相对 import。
 *
 * 模块私有代码（模块目录内）不会进入 SDK；React 走 `react` shim，不在此处。
 *
 * 用法：node scripts/generate-module-sdk.mjs [--check]
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_SRC = resolve(ROOT, "packages/web/src");
const MODULES = resolve(ROOT, "packages/modules");
const SDK_FILE = resolve(MODULES, "sdk/index.ts");
const HOST_FILE = resolve(WEB_SRC, "lib/modules/host-sdk.generated.ts");

const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
const BARE_SKIP = new Set(["react", "react-dom", "react/jsx-runtime", "@heming/sdk", "@heming/shared"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = resolve(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function extensionOf(webRel) {
  for (const ext of [".ts", ".tsx"]) if (existsSync(resolve(WEB_SRC, webRel + ext))) return ext;
  throw new Error(`找不到宿主模块：packages/web/src/${webRel}.ts|tsx`);
}

function resolveHostDep(file, specifier) {
  if (BARE_SKIP.has(specifier) || !specifier.startsWith(".")) return null;
  const base = resolve(dirname(file), specifier.replace(/\.js$/, ""));
  for (const ext of [".ts", ".tsx", ""]) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const rel = relative(WEB_SRC, candidate);
      if (!rel.startsWith("..") && !rel.startsWith("packages")) {
        return rel.split("\\").join("/").replace(/\.(ts|tsx)$/, "");
      }
      return null;
    }
  }
  return null;
}

const deps = new Map();
const conflicts = [];
const record = (name, from, source) => {
  const prev = deps.get(name);
  if (prev && prev.from !== from) conflicts.push({ name, prev: prev.from, next: from, source });
  else deps.set(name, { from, name });
};

// 1) module.sdk.json
for (const entry of readdirSync(MODULES)) {
  const file = resolve(MODULES, entry, "module.sdk.json");
  if (!existsSync(file)) continue;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  for (const [name, from] of Object.entries(parsed.exports ?? {})) {
    if (typeof from !== "string") continue;
    record(name, from.replace(/\.(ts|tsx)$/, ""), file);
  }
}

// 2) 兜底扫描直接相对 import
for (const file of walk(MODULES)) {
  if (relative(MODULES, file).startsWith("sdk")) continue;
  for (const match of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
    const host = resolveHostDep(file, match[2]);
    if (!host) continue;
    for (const part of match[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) record(name, host, file);
    }
  }
}

if (conflicts.length > 0) {
  console.error("[module-sdk] 有同名导出冲突，需在模块源码里用 `as` 重命名后再生成：");
  for (const c of conflicts) console.error(`  - ${c.name}: ${c.prev} vs ${c.next}（${relative(ROOT, c.source)}）`);
  process.exit(1);
}

const names = [...deps.keys()].sort();
const fromByFile = new Map();
for (const { from } of deps.values()) fromByFile.set(from, extensionOf(from));
const byFile = [...fromByFile.keys()].sort();

const sdkLines = [
  "/** 由 `scripts/generate-module-sdk.mjs` 生成，请勿手改。模块包从宿主同一实例取导出。 */",
  "interface ModuleHostSdk {",
  "  files?: Record<string, Record<string, unknown>>;",
  "}",
  "function hostFiles(): Record<string, Record<string, unknown>> {",
  '  const host = (globalThis as { __hemingHost?: ModuleHostSdk }).__hemingHost;',
  '  if (!host?.files) throw new Error("模块包 SDK 未初始化：宿主应先 installHostSdk()");',
  "  return host.files;",
  "}",
  "",
];
for (const name of names) {
  const { from } = deps.get(name);
  sdkLines.push(
    `export const ${name} = (hostFiles()[${JSON.stringify(from)}] as Record<string, unknown>)[${JSON.stringify(name)}] as never;`,
  );
}
sdkLines.push("");

const fileToIndex = new Map(byFile.map((file, i) => [file, `f${i}`]));
const hostLines = [
  "/* 由 `scripts/generate-module-sdk.mjs` 生成，请勿手改。 */",
  ...byFile.map((file) => {
    const ext = fromByFile.get(file);
    void ext;
    const rel = relative(dirname(HOST_FILE), resolve(WEB_SRC, file)).split("\\").join("/");
    const spec = `${rel.startsWith(".") ? rel : `./${rel}`}.js`;
    return `import * as ${fileToIndex.get(file)} from ${JSON.stringify(spec)};`;
  }),
  "",
  "export const HOST_FILES: Record<string, Record<string, unknown>> = {",
  ...byFile.map((file) => `  ${JSON.stringify(file)}: ${fileToIndex.get(file)} as unknown as Record<string, unknown>,`),
  "};",
  "",
];

const output = { sdk: sdkLines.join("\n"), host: hostLines.join("\n") };
if (process.argv.includes("--check")) {
  const same =
    existsSync(SDK_FILE) &&
    existsSync(HOST_FILE) &&
    readFileSync(SDK_FILE, "utf8").replace(/\r\n/g, "\n") === output.sdk &&
    readFileSync(HOST_FILE, "utf8").replace(/\r\n/g, "\n") === output.host;
  if (!same) {
    console.error("[module-sdk] 生成文件已过期，请运行 node scripts/generate-module-sdk.mjs");
    process.exit(1);
  }
  console.log(`[module-sdk] 最新（${names.length} 个导出 / ${byFile.length} 个宿主模块）`);
  process.exit(0);
}

writeFileSync(SDK_FILE, output.sdk.replace(/\n/g, "\r\n"));
writeFileSync(HOST_FILE, output.host.replace(/\n/g, "\r\n"));
console.log(`[module-sdk] 已生成 ${names.length} 个导出 / ${byFile.length} 个宿主模块`);
