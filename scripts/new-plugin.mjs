#!/usr/bin/env node
/**
 * 插件脚手架：一条命令生成能直接 lint 通过的新插件目录。
 *
 * 为什么需要：插件作者第一步总是「拷一份示例再改」，拷贝过程中最容易漏 `engines`、
 * 把 `permissions` 写错位置、或忘记 `$schema`。这里把「合法骨架」固化在
 * `plugin-kit/templates/`，只做简单占位符替换（`{{id}}` 这类），不引第三方依赖，
 * 生成后立刻用权威校验器（`scripts/plugin-lint.mjs`）跑一遍——模板坏了当场发现。
 *
 * 用法：
 *   node scripts/new-plugin.mjs <id> [--name <显示名>] [--author <作者>]
 *        [--kind manifest|bundle] [--dir <父目录>] [--force] [--no-lint]
 *
 * 类型：
 *   manifest（缺省）= 纯声明式 v5 清单（技能 / MCP / 命令 / 工具束）；
 *   bundle          = 界面插件 v4 清单（`distribution: "bundle"`，仅首方签名发布），
 *                     额外生成 `files/index.html` 与 `files/app.js`。
 *
 * 退出码：0 = 生成并校验通过；1 = 生成成功但校验失败 / 环境缺失；2 = 用法或 id 不合法。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = join(root, "plugin-kit", "templates");
const distEntry = join(root, "packages", "shared", "dist", "index.js");
const lintScript = join(root, "scripts", "plugin-lint.mjs");
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function usage(code = 2, stream = console.error) {
  stream(
    [
      "用法：node scripts/new-plugin.mjs <id> [--name <显示名>] [--author <作者>]",
      "       [--kind manifest|bundle] [--dir <父目录>] [--force] [--no-lint]",
      "",
      "  <id>       插件 id：^[a-z0-9][a-z0-9._-]{0,63}$（如 acme.hello）",
      "  --name     显示名（缺省取 id 最后一段）",
      "  --author   作者（缺省留空）",
      "  --kind     manifest（缺省，纯声明式 v5）或 bundle（界面插件 v4，仅首方）",
      "  --dir      父目录（缺省 plugins；相对路径按仓库根解析），插件建在 <父目录>/<id 最后一段>",
      "  --force    目标目录已存在且非空时覆盖生成",
      "  --no-lint  生成后不自动跑 scripts/plugin-lint.mjs",
      "",
      "示例：",
      "  node scripts/new-plugin.mjs acme.hello --name 问候工具",
      "  node scripts/new-plugin.mjs heming.demo --kind bundle",
    ].join("\n"),
  );
  process.exit(code);
}

/* ───────────────────────── 参数 ───────────────────────── */

const argv = process.argv.slice(2);
const positionals = [];
let nameArg;
let authorArg;
let kind = "manifest";
let dirArg;
let force = false;
let noLint = false;

for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "--help" || arg === "-h") usage(0, console.log);
  if (arg === "--force") {
    force = true;
    continue;
  }
  if (arg === "--no-lint") {
    noLint = true;
    continue;
  }
  if (arg === "--name" || arg === "--author" || arg === "--kind" || arg === "--dir") {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${arg} 缺少取值。\n\n${usageText()}`, 2);
    index += 1;
    if (arg === "--name") nameArg = value;
    else if (arg === "--author") authorArg = value;
    else if (arg === "--kind") kind = value;
    else dirArg = value;
    continue;
  }
  if (arg.startsWith("--name=") || arg.startsWith("--author=") || arg.startsWith("--kind=") || arg.startsWith("--dir=")) {
    const at = arg.indexOf("=");
    const key = arg.slice(0, at);
    const value = arg.slice(at + 1);
    if (!value) fail(`${key} 缺少取值。\n\n${usageText()}`, 2);
    if (key === "--name") nameArg = value;
    else if (key === "--author") authorArg = value;
    else if (key === "--kind") kind = value;
    else dirArg = value;
    continue;
  }
  if (arg.startsWith("-")) fail(`未知参数：${arg}\n\n${usageText()}`, 2);
  positionals.push(arg);
}

function usageText() {
  return [
    "用法：node scripts/new-plugin.mjs <id> [--name <显示名>] [--author <作者>]",
    "       [--kind manifest|bundle] [--dir <父目录>] [--force] [--no-lint]",
  ].join("\n");
}

if (positionals.length !== 1) usage(2);
const id = positionals[0];
if (!ID_RE.test(id)) {
  fail(
    `插件 id 不合法：${id}\n` +
      "规则：^[a-z0-9][a-z0-9._-]{0,63}$（小写字母或数字开头，只允许字母/数字/点/下划线/连字符，最长 64；见 docs/PLUGINS.md「id 规则」）。",
    2,
  );
}
if (kind !== "manifest" && kind !== "bundle") {
  fail(`--kind 只能是 manifest 或 bundle，收到：${kind}`, 2);
}

/* ───────────────────────── 目标目录 ───────────────────────── */

function lastSegment(value) {
  const afterDot = value.slice(value.lastIndexOf(".") + 1);
  return afterDot || value.replace(/[._-]+$/, "") || "plugin";
}

const segment = lastSegment(id);
const parentDir = dirArg
  ? isAbsolute(dirArg)
    ? resolve(dirArg)
    : resolve(root, dirArg)
  : join(root, "plugins");
const targetDir = join(parentDir, segment);

const insideRoot = !relative(root, targetDir).startsWith("..") && !isAbsolute(relative(root, targetDir));
const dirDisplay = insideRoot ? relative(root, targetDir).split(sep).join("/") : targetDir;
const display = (nameArg ?? segment).trim();
const author = (authorArg ?? "").trim();

if (!display) fail("显示名不能为空（--name）。", 2);
if (display.length > 64) fail(`显示名最多 64 字，当前 ${display.length} 字。`, 2);
if (author.length > 64) fail(`作者最多 64 字，当前 ${author.length} 字。`, 2);
if (kind === "bundle" && display.length > 32) {
  fail(`界面插件的窗口名最多 32 字（desktopWidgets[0].name），请用 --name 取短一些。`, 2);
}

if (!existsSync(templateRoot)) {
  fail(`找不到模板目录：${templateRoot}（仓库不完整？）`, 2);
}
if (existsSync(targetDir) && !statSync(targetDir).isDirectory()) {
  fail(`目标路径已存在且不是目录：${targetDir}`, 1);
}
if (existsSync(targetDir) && readdirSync(targetDir).length > 0 && !force) {
  fail(`目标目录已存在且非空：${dirDisplay}\n如需覆盖生成，加 --force。`, 1);
}
if (!noLint && !existsSync(distEntry)) {
  fail(
    "找不到 packages/shared/dist/index.js，无法自动校验。\n" +
      "先跑 `pnpm --filter @heming/shared build`，或加 --no-lint 只生成不校验。",
    1,
  );
}

/* ───────────────────────── 取值与模板渲染 ───────────────────────── */

/** 和鸣版本前缀（`d.119.3.47.0` → `d.119`）；`engines.heming` 只用最低宿主版本。 */
function currentEngines() {
  for (const relativePath of ["package.json", "packages/shared/package.json"]) {
    const file = join(root, relativePath);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      const match = /^(d\.\d+)/.exec(String(parsed.hemingVersion ?? ""));
      if (match) return match[1];
    } catch {
      /* 读坏了就走下一个来源 */
    }
  }
  return "d.0";
}

const engines = currentEngines();
const schemaAbs = join(root, "plugin-kit", "plugin.schema.json");
let schemaPath = relative(targetDir, schemaAbs).split(sep).join("/");
if (!schemaPath.startsWith("./") && !schemaPath.startsWith("../")) schemaPath = `./${schemaPath}`;
if (schemaPath.startsWith("./../")) schemaPath = schemaPath.slice(2);

const widgetId = (() => {
  const candidate = segment
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32);
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(candidate) ? candidate : "widget";
})();

const description =
  kind === "bundle"
    ? `${display}的界面插件示例：改 files/index.html 与 files/app.js，按需打开 permissions。`
    : `${display}的示例插件：按需修改 plugin.json 里的技能与说明。`;

const kindLabel = kind === "bundle" ? "界面插件（bundle，仅首方）" : "声明式插件";

const editGuide =
  kind === "bundle"
    ? [
        "- `plugin.json`：必须保持 `schemaVersion: 4` + `distribution: \"bundle\"`（安装器口径），不要改成 5；",
        "  `contributions.desktopWidgets[0]` 是窗口入口，`entry` 必须指向包内 `.html`。",
        "- `files/index.html` / `files/app.js`：页面与脚本；脚本必须放外部文件（CSP 的 `script-src` 只放 `'self'`，",
        "  内联脚本在 enforce 模式下会被拦）。宿主能力全部来自 `window.__heming_widget`",
        "  （窗口 / `info()` / `settings()` / `data*` / 事件 / 跳转）。",
        "- `permissions`：默认全关；真正需要联网、渲染能力、`eval`（会放开 `'unsafe-eval'`）或 `chat`（本机网关）时",
        "  再逐项打开，并在 README 里说明理由。",
        "- `files/README.md`：写清窗口做什么、要什么权限、数据放哪、怎么卸载。",
      ].join("\n")
    : [
        "- `plugin.json`：",
        "  - `id` 发布后不要改（改 id 会被当成另一个插件）。",
        "  - `name` / `version` / `description` / `author` 是展示信息；内容变了就升 `version`。",
        "  - `engines.heming` 写**真正需要的最低宿主版本**，不要写当前完整版本号。",
        "  - `contributions.skills[0]` 是示例技能：把 `name` / `description` / `instructions` / `triggers`",
        "    换成你要做的事。`instructions` 写步骤与边界，不要写营销话术或提示词注入。",
        "  - 需要远程 MCP 服务时再加 `permissions.network`（每个服务 host 必须被覆盖）与",
        "    `contributions.mcpServers`，见 `docs/PLUGINS.md` §3。",
        "- `README.md`：写清装了什么、要什么权限、数据放哪、怎么卸载（这份是给用户看的）。",
      ].join("\n");

const schemaNote =
  kind === "bundle"
    ? "界面插件清单是 v4 格式，`plugin-kit/plugin.schema.json`（v5 编辑器补全）不适用；字段口径以安装器 `packages/desktop/plugin-package.js` 为准。"
    : "`$schema` 指向仓库内 `plugin-kit/plugin.schema.json`，只用于编辑器补全，**不等于**能装；对外发布时可以换成绝对 URL。权威校验永远是 `parsePluginManifestV5` / `plugin-lint`。";

const installGuide =
  kind === "bundle"
    ? "界面插件由宿主在独立窗口执行，**只允许首方签名包安装**；开发期用本地宿主验证（设 `HEMING_ALLOW_DEV_PLUGIN_KEYS=1` 可装 dev 公钥签出的测试包），正式发布后用户从插件区安装已签名包。先按下面「怎么发布」签名、打包，再在应用里确认。"
    : "和鸣桌面端 → 插件区 → 安装 → 选文件或粘贴 `plugin.json` → 先看预览（权限、贡献、兼容性）→ 点安装。\n装完不生效时看插件详情页的「诊断」，它会给原因（停用 / 兼容性 / 权限上限 / 签名 / 孤儿记录），不要靠猜。";

const publishGuide =
  kind === "bundle"
    ? [
        "界面插件**只允许首方签名、走 `docs/PLUGINS.md` §10 流程**，第三方的声明式插件不能带可执行内容。",
        "",
        "包根只能有 `plugin.json` + `files/**`（本 README 已放在 `files/` 内）；`pack-plugin` 的安装口径回读会拒绝其它根文件。",
        "",
        "```bash",
        "# 1) 发版前检查首方公钥（只剩 dev-* 会非 0 阻断；本地开发可加 --allow-dev）",
        "node scripts/check-release-keys.mjs",
        "",
        "# 2) 签名：自动按 files/** 计算并写回 packageSha256，再签名",
        `node scripts/sign-plugin.mjs sign ${dirDisplay}/plugin.json <正式私钥> --id <发布者 id> --write`,
        "",
        "# 3) 打包 + 安装口径回读（pack-plugin 也会在产物清单里重算 packageSha256）",
        `node scripts/pack-plugin.mjs ${dirDisplay}`,
        "",
        "# 4) 发布（第 3 步输出「校验 readPackage ✓」才算可发布）",
        `node scripts/publish-plugin.mjs ${dirDisplay}`,
        "```",
        "",
        "签名脚本会把 `packageSha256` 写回源清单，打包脚本在产物清单里重算并回读校验，所以顺序是**先签名、再打包自检**（先打包会因为缺签名被 `readPackage` 拒绝，这是预期）。",
        "签名私钥不在仓库里，丢失私钥等于已安装用户永久收不到更新；`dev-*` 公钥签的包在正式版一律被拒。",
      ].join("\n")
    : [
        "```bash",
        `node scripts/publish-plugin.mjs ${dirDisplay}/plugin.json --dest <插件目录>   # 写本地发布目录`,
        `pnpm plugin:publish -- ${dirDisplay}/plugin.json --dest <插件目录>            # 同上（pnpm 透传）`,
        `node scripts/publish-plugin.mjs ${dirDisplay}/plugin.json --push https://heming.example.com  # 推云端仓库（需发布密钥）`,
        "```",
      ].join("\n");

const textValues = {
  id,
  name: display,
  author,
  description,
  engines,
  kind,
  kindLabel,
  dir: dirDisplay,
  schemaPath,
  widgetId,
  widgetName: display,
  editGuide,
  schemaNote,
  installGuide,
  publishGuide,
};

function jsonEscape(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

function render(template, values, { json = false } = {}) {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, key) => {
    if (!(key in values)) return placeholder;
    const value = String(values[key]);
    return json ? jsonEscape(value) : value;
  });
}

function readTemplate(relativePath) {
  const file = join(templateRoot, relativePath);
  if (!existsSync(file)) fail(`模板缺文件：${relative(join(root), file)}（仓库不完整？）`, 2);
  return readFileSync(file, "utf8").replace(/^\uFEFF/, "");
}

/** 递归列出目录下文件（相对路径用 `/` 分隔），按字典序保证生成结果稳定。 */
function walkFiles(dir, base = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    const info = statSync(full);
    if (info.isDirectory()) out.push(...walkFiles(full, rel));
    else if (info.isFile()) out.push(rel);
  }
  return out;
}

const outputs = [];
if (kind === "bundle") {
  outputs.push({ path: "plugin.json", content: render(readTemplate("bundle/plugin.json"), textValues, { json: true }) });
  const filesRoot = join(templateRoot, "bundle", "files");
  if (!existsSync(filesRoot)) fail("模板缺目录：plugin-kit/templates/bundle/files（仓库不完整？）", 2);
  for (const rel of walkFiles(filesRoot)) {
    outputs.push({
      path: `files/${rel}`,
      content: render(readFileSync(join(filesRoot, rel), "utf8").replace(/^\uFEFF/, ""), textValues, {
        json: rel.endsWith(".json"),
      }),
    });
  }
  // 界面插件的包根只能有 plugin.json + files/**，README 放进 files/ 才不会让 pack 回读失败。
  outputs.push({ path: "files/README.md", content: render(readTemplate("manifest/README.md"), textValues) });
} else {
  outputs.push({
    path: "plugin.json",
    content: render(readTemplate("manifest/plugin.json"), textValues, { json: true }),
  });
  outputs.push({ path: "README.md", content: render(readTemplate("manifest/README.md"), textValues) });
}

/* ───────────────────────── 写盘 ───────────────────────── */

mkdirSync(targetDir, { recursive: true });
for (const output of outputs) {
  const file = join(targetDir, output.path.split("/").join(sep));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, output.content, "utf8");
}

console.log(`已生成插件：${dirDisplay}（${id}，${kindLabel}）`);
for (const output of outputs) console.log(`  ${dirDisplay}/${output.path}`);

/* ───────────────────────── 生成后校验 ───────────────────────── */

if (noLint) {
  console.log("\n已按 --no-lint 跳过校验。");
} else {
  console.log(`\n开始校验：node scripts/plugin-lint.mjs ${dirDisplay}`);
  const lint = spawnSync(process.execPath, [lintScript, targetDir], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (lint.error) fail(`调用校验器失败：${lint.error.message}`, 1);
  if (lint.status !== 0) {
    fail(
      `\n脚手架已生成，但校验未通过（退出码 ${String(lint.status)}）。\n` +
        `按上面的中文错误改 ${dirDisplay}/plugin.json，然后重跑 node scripts/plugin-lint.mjs ${dirDisplay}。`,
      1,
    );
  }
}

/* ───────────────────────── 下一步 ───────────────────────── */

if (kind === "bundle") {
  console.log(
    [
      "",
      "下一步（界面插件只允许首方签名，见 docs/PLUGINS.md §10）：",
      `  node scripts/plugin-lint.mjs ${dirDisplay}                 # 打包前模式：缺 packageSha256 不算错`,
      "  node scripts/check-release-keys.mjs                       # 发版前必跑",
      `  node scripts/sign-plugin.mjs sign ${dirDisplay}/plugin.json <正式私钥> --id <发布者 id> --write`,
      `  node scripts/pack-plugin.mjs ${dirDisplay}               # 输出「校验 readPackage ✓」才算可发布`,
      `  node scripts/publish-plugin.mjs ${dirDisplay}`,
      "  先在本地宿主验证页面（HEMING_ALLOW_DEV_PLUGIN_KEYS=1），再签名发布。",
    ].join("\n"),
  );
} else {
  console.log(
    [
      "",
      "下一步：",
      `  node scripts/plugin-lint.mjs ${dirDisplay}                # 再校验一次（--strict 让 warning 也算失败）`,
      `  # 安装：和鸣桌面端 → 插件区 → 安装 → 选文件或粘贴 ${dirDisplay}/plugin.json`,
      `  node scripts/publish-plugin.mjs ${dirDisplay}/plugin.json --dest <插件目录>`,
      `  pnpm plugin:publish -- ${dirDisplay}/plugin.json --dest <插件目录>`,
      "",
      "先改 plugin.json 里的示例技能（instructions / triggers），内容变了记得升 version。",
    ].join("\n"),
  );
}
