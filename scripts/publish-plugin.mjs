#!/usr/bin/env node
/**
 * 发布插件包到「云端插件目录」的本地发布目录（d.86）。
 *
 * 为什么需要：信息采集 / magpie 网关这类插件**不随安装包分发**——它们是独立产物，
 * 由服务端 `/api/plugins` 列出来、用户自行下载安装。本脚本只负责把仓库里的
 * `plugins/<名字>/plugin.json` 校验后摆成服务端要的目录布局：
 *
 *   <dest>/<插件 id>/<版本>/plugin.json      （原样字节）
 *
 * 目录布局与读取逻辑见 `packages/server/src/pluginCatalog.ts`。
 *
 * 用法：
 *   node scripts/publish-plugin.mjs plugins/magpie-gateway/plugin.json
 *   node scripts/publish-plugin.mjs plugins/                     # 目录下每个并包
 *   node scripts/publish-plugin.mjs plugins/magpie-gateway/plugin.json --dry-run
 *   node scripts/publish-plugin.mjs plugins/ --dest D:/tmp/plugins-catalog
 *   node scripts/publish-plugin.mjs plugins/ --push https://heming.example.com
 *
 * 两种目标：
 * - 缺省写本地目录（沿用「同步目录到服务器」的部署链）；
 * - `--push <apiBase>` 直接走仓库发布接口：`PUT /api/plugins/<id>/<version>`
 *   （`x-publish-key: $HEMING_PLUGIN_PUBLISH_KEY`），适合 CI 直接发到云端。
 *
 * 环境变量：
 *   HEMING_PLUGIN_DIR         目标目录；缺省 `<cwd>/plugins-catalog`
 *   HEMING_PLUGIN_PUBLISH_KEY 发布密钥（`--push` 必填；服务端未配置则接口关闭）
 *
 * 不做的事（边界）：
 * - **不做 SFTP/SSH**：上传服务器沿用现有部署链（把本目录同步到服务器的
 *   `HEMING_PLUGIN_DIR`，例如 `/opt/heming/plugins`），发布账号与凭据不在这里新增一套；
 * - 不信任清单内容：只做「是不是一个能解析、id/版本合规的插件包」的基础校验；
 *   权限、签名、安装校验都由客户端在下载后做。
 *
 * 退出码：0 全部成功；1 有坏包或写盘失败（不静默跳过）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

function usage() {
  console.error(
    [
      "用法：node scripts/publish-plugin.mjs <plugin.json | 目录> [...] [--dest <dir>] [--push <apiBase>] [--dry-run]",
      "  --dest      目标目录（缺省 HEMING_PLUGIN_DIR 或 <cwd>/plugins-catalog）",
      "  --push      直接发布到远端仓库（PUT /api/plugins/<id>/<version>），需 HEMING_PLUGIN_PUBLISH_KEY",
      "  --dry-run   只校验并打印，不写盘/不请求",
    ].join("\n"),
  );
}

/** 参数里的目录 → 其下的 plugin.json；文件则原样。 */
function resolveInputs(rawArgs) {
  const files = [];
  const missing = [];
  for (const arg of rawArgs) {
    const abs = resolve(arg);
    if (!existsSync(abs)) {
      missing.push(arg);
      continue;
    }
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      const nested = join(abs, "plugin.json");
      if (existsSync(nested)) files.push(nested);
      else {
        for (const entry of readdirSync(abs, { withFileTypes: true })) {
          if (entry.isDirectory() && existsSync(join(abs, entry.name, "plugin.json"))) {
            files.push(join(abs, entry.name, "plugin.json"));
          }
        }
      }
    } else {
      files.push(abs);
    }
  }
  return { files, missing };
}

function validate(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { error: `不是合法 JSON：${err.message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "清单必须是 JSON 对象" };
  if (!ID_RE.test(String(raw.id ?? ""))) return { error: `插件 id 不合规：${String(raw.id)}` };
  if (!VERSION_RE.test(String(raw.version ?? ""))) return { error: `版本号不合规：${String(raw.version)}` };
  if (!Number.isInteger(raw.schemaVersion)) return { error: "缺少整数 schemaVersion" };
  if (typeof raw.name !== "string" || !raw.name.trim()) return { error: "缺少插件名" };
  const bytes = readFileSync(file);
  return {
    id: raw.id,
    version: raw.version,
    schemaVersion: raw.schemaVersion,
    name: raw.name,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function pushToRepo(apiBase, result) {
  const key = (process.env.HEMING_PLUGIN_PUBLISH_KEY ?? "").trim();
  if (!key) return { error: "未设置 HEMING_PLUGIN_PUBLISH_KEY（发布接口需要发布密钥）" };
  const base = apiBase.replace(/\/+$/, "");
  const url = `${base}/api/plugins/${encodeURIComponent(result.id)}/${encodeURIComponent(result.version)}`;
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-publish-key": key },
      body: result.bytes,
    });
    if (!response.ok) {
      let reason = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body && typeof body.error === "string") reason = `${reason} ${body.error}`;
      } catch {
        /* 非 JSON 错误体：保留状态码 */
      }
      return { error: `发布失败：${reason}` };
    }
    const body = await response.json();
    return { target: url, created: Boolean(body?.created) };
  } catch (err) {
    return { error: `请求失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

async function main(argv) {
  let destArg = "";
  let pushArg = "";
  let dryRun = false;
  const inputs = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--push") {
      pushArg = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--dest") {
      destArg = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "-h" || arg === "--help") {
      usage();
      return 0;
    } else inputs.push(arg);
  }
  if (inputs.length === 0) {
    usage();
    return 1;
  }
  const dest = resolve(destArg || process.env.HEMING_PLUGIN_DIR || join(process.cwd(), "plugins-catalog"));
  const { files, missing } = resolveInputs(inputs);
  const failures = [];
  for (const item of missing) failures.push(`${item}：路径不存在`);
  if (files.length === 0 && failures.length === 0) failures.push("没有找到任何 plugin.json");

  const ok = [];
  for (const file of files) {
    const result = validate(file);
    if (result.error) {
      failures.push(`${file}：${result.error}`);
      continue;
    }
    if (!dryRun && pushArg) {
      const pushed = await pushToRepo(pushArg, result);
      if (pushed.error) {
        failures.push(`${file}：${pushed.error}`);
        continue;
      }
      ok.push({ ...result, source: file, target: pushed.target, created: pushed.created });
      continue;
    }
    const targetDir = join(dest, result.id, result.version);
    if (!dryRun) {
      try {
        mkdirSync(targetDir, { recursive: true });
        copyFileSync(file, join(targetDir, "plugin.json"));
      } catch (err) {
        failures.push(`${file}：写盘失败 ${err.message}`);
        continue;
      }
    }
    ok.push({ ...result, source: file, target: join(targetDir, "plugin.json") });
  }

  for (const item of ok) {
    console.log(
      `${dryRun ? "[dry-run] " : ""}发布 ${item.id}@${item.version}（schemaVersion ${item.schemaVersion}）` +
        ` sha256=${item.sha256.slice(0, 16)}… → ${item.target}` +
        (item.created === false ? "（覆盖已有版本）" : ""),
    );
  }
  for (const failure of failures) console.error(`[失败] ${failure}`);
  if (ok.length > 0) {
    if (pushArg) {
      console.log(`
已发布到 ${pushArg}；客户端「插件区 → 仓库」即可看到（服务端 GET /api/plugins）。`);
    } else {
      console.log(`
目录：${dest}`);
      console.log(
        "下一步：把该目录同步到服务器的 HEMING_PLUGIN_DIR（例如 /opt/heming/plugins），" +
          "客户端「插件区 → 仓库」即可看到（服务端 GET /api/plugins）。",
      );
    }
  }
  return failures.length > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
