#!/usr/bin/env node
/**
 * 把发布包上传到云端服务器，并做「本地/远端/HTTP」三重校验。
 *
 * 上传位置（沿用和鸣现有部署约定，不新增一套账号）：
 *   /opt/heming/updates/plugins/heming.workflow-kit/
 *       index.html  plugin.json  latest.json  SHA256SUMS  heming-workflow-kit-<ver>.zip
 *     → nginx 的 /updates/ 直接 alias 到 /opt/heming/updates/，用户可下载
 *   /opt/heming/plugins/heming.workflow-kit/<ver>/plugin.json
 *     → 云端插件目录（服务端 pluginCatalog 的目录布局）；等服务器版本带目录接口后，
 *       和鸣「插件区 → 从插件仓库安装」会自动列出本插件，无需再次上传。
 *
 * 安全：密码不落盘、不打印；优先环境变量 HEMING_SSH_PWD，否则从本机
 * `.superpowers/deploy-*.py` 解析既有凭据（与 scripts/publish-update.mjs 同口径）。
 *
 * 用法：
 *   node scripts/publish-cloud.mjs              # 上传 + 校验
 *   node scripts/publish-cloud.mjs --dry-run    # 只打印计划
 *   node scripts/publish-cloud.mjs --skip-http  # 跳过公网 HTTP 校验
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE = join(ROOT, "release");
const HOST_DEFAULT = "47.92.39.184";
const PORT_DEFAULT = 22;
const USER_DEFAULT = "root";
const REMOTE_ASSETS = "/opt/heming/updates/plugins/heming.workflow-kit";
const REMOTE_CATALOG_ROOT = "/opt/heming/plugins/heming.workflow-kit";
const PUBLIC_BASE = "http://47.92.39.184/updates/plugins/heming.workflow-kit";

const dryRun = process.argv.includes("--dry-run");
const skipHttp = process.argv.includes("--skip-http");

const PYTHON_CANDIDATES = [
  "C:/Users/ADMIN/.workbuddy/binaries/python/envs/default/Scripts/python.exe",
  "python3",
  "python",
];

function log(message = "") {
  console.log(message);
}

function fail(message, hint) {
  console.error(`错误：${message}`);
  if (hint) console.error(`提示：${hint}`);
  process.exit(1);
}

function findPython() {
  for (const candidate of PYTHON_CANDIDATES) {
    const probe = spawnSync(candidate, ["-c", "import paramiko, sys; print(paramiko.__version__)"], {
      stdio: "pipe",
    });
    if (probe.status === 0) return candidate;
  }
  return null;
}

/** 从 `.superpowers/deploy-*.py` 解析既有凭据（密码只进内存）。 */
function credentialsFromDeployScripts() {
  const dir = "D:/Heming/.superpowers";
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((name) => /^deploy-.*\.py$/.test(name));
  for (const name of files) {
    try {
      const text = readFileSync(join(dir, name), "utf8");
      const match = /HOST\s*,\s*PORT\s*,\s*USER\s*,\s*PASS\s*=\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/.exec(
        text,
      );
      if (match) {
        return { host: match[1], port: Number(match[2]), user: match[3], pass: match[4] };
      }
    } catch {
      /* 读不了就继续找下一个 */
    }
  }
  return null;
}

function resolveCredentials() {
  const password = process.env.HEMING_SSH_PWD || "";
  const found = credentialsFromDeployScripts();
  if (password) {
    return {
      host: process.env.HEMING_SSH_HOST || HOST_DEFAULT,
      port: Number(process.env.HEMING_SSH_PORT || PORT_DEFAULT),
      user: process.env.HEMING_SSH_USER || USER_DEFAULT,
      pass: password,
    };
  }
  if (found) return found;
  fail(
    "找不到服务器凭据",
    "设置环境变量 HEMING_SSH_PWD，或确认 D:/Heming/.superpowers/deploy-*.py 里的 HOST/PORT/USER/PASS 行存在",
  );
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const PY_UPLOAD = String.raw`
import hashlib, json, os, shlex, sys
import paramiko

spec = json.load(open(sys.argv[1], encoding="utf-8"))
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(spec["host"], spec["port"], spec["user"], spec["pass"],
               timeout=30, banner_timeout=120, auth_timeout=120,
               allow_agent=False, look_for_keys=False)
sftp = client.open_sftp()

def mkdirs(remote_dir):
    current = ""
    for part in remote_dir.strip("/").split("/"):
        current += "/" + part
        try:
            sftp.stat(current)
        except IOError:
            sftp.mkdir(current)

def remote_sha256(remote):
    stdin, stdout, stderr = client.exec_command("sha256sum " + shlex.quote(remote))
    out = stdout.read().decode("utf-8", "replace").strip()
    code = stdout.channel.recv_exit_status()
    if code != 0:
        return None
    return out.split()[0] if out else None

results = []
for directory in spec["dirs"]:
    mkdirs(directory)
for item in spec["files"]:
    remote = item["remote"]
    parent = os.path.dirname(remote)
    mkdirs(parent)
    sftp.put(item["local"], remote)
    local_hash = hashlib.sha256(open(item["local"], "rb").read()).hexdigest()
    remote_hash = remote_sha256(remote)
    results.append({
        "remote": remote,
        "size": os.path.getsize(item["local"]),
        "localSha256": local_hash,
        "remoteSha256": remote_hash,
        "ok": bool(remote_hash) and remote_hash == local_hash,
    })
sftp.close()
client.close()
print(json.dumps({"ok": all(r["ok"] for r in results), "files": results}, ensure_ascii=False))
`;

async function main() {
  if (!existsSync(join(RELEASE, "latest.json"))) {
    fail("找不到 release/ 产物", "先运行 node scripts/build-release.mjs");
  }
  const latest = JSON.parse(readFileSync(join(RELEASE, "latest.json"), "utf8"));
  const version = latest.version;
  const zipName = latest.files.service.name;
  const assets = ["index.html", "plugin.json", "latest.json", "SHA256SUMS", zipName];

  log(`发布 ${latest.name} v${version}`);
  log(`  本地产物 ${RELEASE}`);
  log(`  静态资源 ${REMOTE_ASSETS}/`);
  log(`  目录清单 ${REMOTE_CATALOG_ROOT}/${version}/plugin.json`);
  log("");

  const plan = {
    assets,
    remoteAssets: REMOTE_ASSETS,
    remoteCatalog: `${REMOTE_CATALOG_ROOT}/${version}`,
  };
  if (dryRun) {
    log("[dry-run] 将要上传：");
    for (const file of assets) log(`  ${file}  ${fmtSize(statSync(join(RELEASE, file)).size)}`);
    log(`  → ${REMOTE_ASSETS}/`);
    log(`  plugin.json → ${REMOTE_CATALOG_ROOT}/${version}/plugin.json`);
    return;
  }

  const python = findPython();
  if (!python) fail("找不到带 paramiko 的 Python", "安装 paramiko（pip install paramiko）后重试");
  const credentials = resolveCredentials();

  // 产物完整性：清单里的 sha256 必须与本地文件一致
  const zipSha = sha256File(join(RELEASE, zipName));
  const pluginSha = sha256File(join(RELEASE, "plugin.json"));
  if (zipSha !== latest.files.service.sha256) fail("服务包 sha256 与 latest.json 不一致", "重新运行 build-release.mjs");
  if (pluginSha !== latest.files.manifest.sha256) fail("plugin.json sha256 与 latest.json 不一致", "重新运行 build-release.mjs");

  const files = assets.map((name) => ({ local: join(RELEASE, name), remote: `${REMOTE_ASSETS}/${name}` }));
  files.push({ local: join(RELEASE, "plugin.json"), remote: `${REMOTE_CATALOG_ROOT}/${version}/plugin.json` });

  const tmpDir = mkdtempSync(join(tmpdir(), "wf-publish-"));
  const specPath = join(tmpDir, "spec.json");
  const pyPath = join(tmpDir, "upload.py");
  writeFileSync(
    specPath,
    JSON.stringify(
      {
        host: credentials.host,
        port: credentials.port,
        user: credentials.user,
        pass: credentials.pass,
        dirs: [REMOTE_ASSETS, `${REMOTE_CATALOG_ROOT}/${version}`],
        files,
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(pyPath, PY_UPLOAD, "utf8");

  log("[1/3] 上传（SFTP）…");
  const upload = spawnSync(python, [pyPath, specPath], { stdio: "pipe" });
  rmSync(tmpDir, { recursive: true, force: true });
  if (upload.status !== 0) {
    fail(`上传失败（python exit ${upload.status}）`, upload.stderr?.toString().slice(0, 800));
  }
  let report;
  try {
    report = JSON.parse(upload.stdout.toString().trim());
  } catch {
    fail("上传脚本没有返回可解析的结果", upload.stdout?.toString().slice(0, 500));
  }
  for (const item of report.files) {
    log(`  ${item.ok ? "OK " : "BAD"}  ${item.remote}  ${fmtSize(item.size)}`);
  }
  if (!report.ok) fail("远端 sha256 与本地不一致（有文件没传对）");

  if (skipHttp) {
    log("");
    log("上传完成（已跳过公网校验）。");
    return;
  }

  log("");
  log("[2/3] 公网 HTTP 校验…");
  return verifyHttp(latest, zipName);
}

async function verifyHttp(latest, zipName) {
  const checks = [];
  async function check(name, fn) {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
      log(`  OK   ${name}${detail ? ` — ${detail}` : ""}`);
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error?.message ?? error) });
      log(`  BAD  ${name} — ${error?.message ?? error}`);
    }
  }

  async function fetchText(path) {
    const response = await fetch(`${PUBLIC_BASE}/${path}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { text: await response.text(), headers: response.headers };
  }

  await check("落地页 index.html", async () => {
    const { text } = await fetchText("index.html");
    if (!text.includes(`v${latest.version}`)) throw new Error("内容里没有版本号");
    return "可访问";
  });
  await check("plugin.json", async () => {
    const { text } = await fetchText("plugin.json");
    const manifest = JSON.parse(text);
    if (manifest.version !== latest.version) throw new Error(`版本 ${manifest.version} ≠ ${latest.version}`);
    const bytes = new TextEncoder().encode(text);
    const digest = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    if (digest !== latest.files.manifest.sha256) throw new Error("下载内容 sha256 不一致");
    return `${manifest.id}@${manifest.version}`;
  });
  await check("latest.json", async () => {
    const { text } = await fetchText("latest.json");
    const parsed = JSON.parse(text);
    if (parsed.version !== latest.version) throw new Error("版本不一致");
    return parsed.version;
  });
  await check("服务包 zip", async () => {
    const response = await fetch(`${PUBLIC_BASE}/${zipName}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(buffer).digest("hex");
    if (digest !== latest.files.service.sha256) throw new Error("下载内容 sha256 不一致");
    return `${fmtSize(buffer.length)} · sha256 一致`;
  });

  log("");
  log("[3/3] 云端插件目录接口（当前服务器版本可能尚未包含，404 不影响下载安装）…");
  try {
    const response = await fetch("http://47.92.39.184/api/plugins", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      const found = (data.plugins ?? []).find((item) => item.id === latest.id);
      log(found ? `  OK   目录已收录 ${latest.id}@${found.version}` : `  WARN 目录接口可用，但还没有本插件（等目录刷新）`);
    } else {
      log(`  WARN 目录接口 HTTP ${response.status}（服务器版本未带云端插件目录；已按目录布局预先上传）`);
    }
  } catch (error) {
    log(`  WARN 目录接口不可达：${error?.message ?? error}`);
  }

  const failed = checks.filter((item) => !item.ok);
  log("");
  if (failed.length > 0) {
    fail(`${failed.length} 项公网校验失败`);
  }
  log("发布完成：下载地址可用，sha256 校验通过。");
  log(`  落地页   ${PUBLIC_BASE}/index.html`);
  log(`  服务包   ${PUBLIC_BASE}/${zipName}`);
  log(`  插件清单 ${PUBLIC_BASE}/plugin.json`);
}

main().catch((error) => fail(String(error?.stack ?? error)));
