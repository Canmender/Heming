#!/usr/bin/env node
/**
 * 发布自动更新包到云服务器的 /opt/heming/updates（Node 版，win32 可直接跑）。
 *
 * 为什么需要这个文件：`publish-update.sh` 依赖 bash，而本机没有 Git Bash ——
 * `release.mjs --publish` 调 `bash …` 会落到 WSL，报 `0x8007054f`
 * （「找不到提供程序」）。发布链因此断了，只能靠手工 Python 补。
 * 本脚本用 Node 编排、用 Python(paramiko) 传输，语义与 shell 版逐条对齐：
 *
 *   1. 找产物（latest.yml + 与当前版本号匹配的安装包 + .blockmap）；
 *   2. 建远端目录；
 *   3. 逐个 SFTP 上传；
 *   4. **校验远端大小与 sha512**（这一条不能省：早先只 head 内容，
 *      「其实传到了本机磁盘」也能通过校验，问题一路溜到客户端检查更新没反应才暴露）；
 *   5. 打印结果，成功时输出含「校验通过」——`release.mjs` 第 9 步按这个串判成功。
 *
 * 用法：
 *   node scripts/publish-update.mjs              # 真发布
 *   node scripts/publish-update.mjs --dry-run    # 只打印要传什么，零副作用
 *   node scripts/publish-update.mjs --self-test  # 自检：1KB 随机文件传到远端临时目录
 *                                                # → 校验大小与 sha512 → 删除 → 确认删净
 *
 * 环境变量（密码永不写进仓库）：
 *   HEMING_SSH_PWD      服务器 root 密码。缺省时从本机 `.superpowers/deploy-*.py`
 *                       里既有的 `HOST, PORT, USER, PASS = …` 行解析（该目录 gitignore，
 *                       凭据只在开发机；这是复用既有做法，不新建一套）。
 *   HEMING_UPDATE_HOST  默认 47.92.39.184
 *   HEMING_UPDATE_DIR   默认 /opt/heming/updates
 *   HEMING_RELEASE_DIR  产物目录；缺省走 scripts/release-dir.mjs 的统一解析
 *   HEMING_PYTHON       python 解释器；缺省按「WorkBuddy 内置 → python3 → python」探测
 *
 * 退出码：0 成功；1 失败（凭据/产物/传输/校验任一环节）。
 */

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReleaseDir } from "./release-dir.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "node scripts/publish-update.mjs";

const DEFAULT_HOST = "47.92.39.184";
const DEFAULT_REMOTE_DIR = "/opt/heming/updates";
const DEFAULT_USER = "root";

/** python 解释器候选：WorkBuddy 内置那份带 paramiko；其次 PATH 上的 python。 */
const PYTHON_CANDIDATES = [
  "C:/Users/ADMIN/.workbuddy/binaries/python/envs/default/Scripts/python.exe",
  "python",
  "python3",
];

function log(msg = "") {
  console.log(msg);
}

function fail(msg, hint) {
  console.error(`错误：${msg}`);
  if (hint) console.error(`提示：${hint}`);
  process.exit(1);
}

function fmtSize(n) {
  if (n >= 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function sha512(buf) {
  return createHash("sha512").update(buf).digest();
}

/**
 * 从本机 `.superpowers/deploy-*.py` 里解析既有凭据。
 *
 * 为什么不把密码写进这个文件：本脚本进仓库，而 `.superpowers/` 在 gitignore 里。
 * 这里只做「往上找主检出 → 正则读那一行」的复用，密码始终只在开发机上。
 */
function locateLocalCredentials() {
  let dir = ROOT;
  for (let depth = 0; depth < 6; depth += 1) {
    const sp = join(dir, ".superpowers");
    if (existsSync(sp)) {
      const candidates = readdirSync(sp)
        .filter((n) => /^deploy.*\.py$/.test(n))
        // 优先用打包/发布链一直在用的那份，其余按名字兜底：同一台开发机上
        // 这些脚本的 HOST/USER/PASS 是一致的，但优先取约定那份更容易排查。
        .sort((a, b) => {
          const rank = (n) => (n === "deploy-d21.py" ? 0 : n === "deploy-build.py" ? 1 : 2);
          return rank(a) - rank(b) || a.localeCompare(b);
        })
        .map((n) => join(sp, n));
      for (const file of candidates) {
        let text = "";
        try {
          text = readFileSync(file, "utf8");
        } catch {
          continue;
        }
        const m = /^HOST,\s*PORT,\s*USER,\s*PASS\s*=\s*(.+)$/m.exec(text);
        if (!m) continue;
        // 形如："47.92.39.184", 22, "root", "……"
        const parts = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
        if (parts.length < 4) continue;
        return { host: parts[0], port: Number(parts[1]) || 22, user: parts[2], password: parts[3], from: file };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveCredentials() {
  const envPwd = process.env.HEMING_SSH_PWD;
  const host = process.env.HEMING_UPDATE_HOST || null;
  const user = DEFAULT_USER;
  if (envPwd) {
    return { host: host || DEFAULT_HOST, port: 22, user, password: envPwd, source: "HEMING_SSH_PWD" };
  }
  const local = locateLocalCredentials();
  if (!local) {
    fail(
      "未设置 HEMING_SSH_PWD，也没能在本机 .superpowers/ 里找到既有凭据",
      "PowerShell：`$env:HEMING_SSH_PWD='***'`；或确认 `.superpowers/deploy-*.py` 还在（该目录 gitignore，只在开发机）。",
    );
  }
  return {
    host: host || local.host,
    port: local.port,
    user: local.user,
    password: local.password,
    source: `.superpowers/${local.from.split(/[\\/]/).pop()}`,
  };
}

/** 探测可用的 python（必须能 import paramiko）。 */
function detectPython() {
  const explicit = process.env.HEMING_PYTHON;
  const candidates = explicit ? [explicit] : PYTHON_CANDIDATES;
  for (const p of candidates) {
    if (p.includes("/") && !existsSync(p)) continue;
    const r = spawnSync(p, ["-c", "import sys, paramiko; print(sys.version.split()[0])"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (r.status === 0) return { python: p, version: (r.stdout || "").trim() };
  }
  fail(
    "找不到带 paramiko 的 python",
    "设置 HEMING_PYTHON 指向带 paramiko 的解释器；本机常用：C:/Users/ADMIN/.workbuddy/binaries/python/envs/default/Scripts/python.exe",
  );
}

/** 读桌面包的 hemingVersion（与 scripts/version.mjs 同源，避免再起一个 node 进程）。 */
function readVersion() {
  const pkgPath = join(ROOT, "packages", "desktop", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const version = pkg.hemingVersion || pkg.version;
  if (!version) fail(`读不到版本号：${pkgPath}`);
  return version;
}

/** 在目录里找最新改动的那一个匹配文件（与 shell 版 `ls -t … | head -1` 等价）。 */
function newest(dir, filter) {
  const hits = readdirSync(dir)
    .filter(filter)
    .map((name) => ({ name, full: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return hits.length ? hits[0].full : null;
}

/**
 * 解析 latest.yml 里与安装包对应的 path / sha512 / size。
 *
 * 只认 electron-updater 生成的那种简单结构（`files:` 下一段 `- url:` / `sha512:` / `size:`），
 * 不引 yaml 依赖 —— 这里只需要三行字段，正则足够，且不会因为 yml 里多出字段就崩。
 */
function parseLatestYml(text) {
  const grab = (key) => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
  };
  return { path: grab("path") || grab("url"), sha512: grab("sha512"), size: Number(grab("size")) || null };
}

function collectArtifacts(releaseDir, version) {
  const yml = newest(releaseDir, (n) => /^latest.*\.ya?ml$/.test(n));
  if (!yml) {
    fail(
      `未在 ${releaseDir} 找到 latest*.yml`,
      "打包时 build.publish 必须生成更新清单；没有它客户端永远提示「已是最新」。重新跑 --desktop。",
    );
  }
  const setup = newest(releaseDir, (n) => n.endsWith(`.exe`) && n.includes(version));
  if (!setup) {
    fail(
      `${releaseDir} 里找不到含 ${version} 的安装包`,
      "打包与发布必须指同一目录（build-desktop.mjs 与发布脚本都读 HEMING_RELEASE_DIR）。",
    );
  }
  const blockmap = existsSync(`${setup}.blockmap`) ? `${setup}.blockmap` : null;
  return { yml, setup, blockmap };
}

/**
 * 组装给 Python 的作业描述。
 *
 * 密码**不进 argv**（进程列表可见），走子进程环境变量；其余结构走 argv JSON。
 * Windows 上 Node → python 的 argv 按 UTF-16 传递，中文文件名不会乱码。
 */
function buildJob(mode, cfg, artifacts) {
  const files = [];
  const push = (localPath, remoteName) => {
    const buf = readFileSync(localPath);
    files.push({
      local: localPath,
      remote: remoteName,
      size: buf.length,
      sha512b64: sha512(buf).toString("base64"),
      sha512hex: sha512(buf).toString("hex"),
    });
  };

  if (mode === "publish") {
    push(artifacts.yml, artifacts.yml.split(/[\\/]/).pop());
    push(artifacts.setup, artifacts.setup.split(/[\\/]/).pop());
    if (artifacts.blockmap) push(artifacts.blockmap, artifacts.blockmap.split(/[\\/]/).pop());
  } else {
    // self-test：1KB 随机内容，名字带时间戳，落在远端临时子目录里
    const dir = mkdtempSync(join(tmpdir(), "heming-publish-selftest-"));
    const file = join(dir, `selftest-${Date.now()}.bin`);
    writeFileSync(file, randomBytes(1024));
    const name = file.split(/[\\/]/).pop();
    push(file, name);
    artifacts = { ...artifacts, tempDir: dir, tempName: name };
  }

  return {
    mode,
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    remoteDir: mode === "publish" ? cfg.remoteDir : `${cfg.remoteDir}/_selftest`,
    files,
    expected: artifacts,
  };
}

/** 内联 Python：只做「连、传、校验、清」，不带任何业务判断。 */
const PY_PROGRAM = String.raw`
import base64, hashlib, json, os, shlex, sys

job = json.loads(sys.argv[1])
password = os.environ["HEMING_SSH_PWD"]
host, port, user = job["host"], job["port"], job["user"]

try:
    import paramiko
except ImportError:
    print("错误：当前 python 没有 paramiko"); sys.exit(1)

def sha512_hex(data): return hashlib.sha512(data).hexdigest()

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    c.connect(host, port, user, password, timeout=20, allow_agent=False, look_for_keys=False)
except Exception as e:
    print("错误：SSH 连接失败：%s" % e); sys.exit(1)

def sh(cmd, timeout=120):
    _, o, e = c.exec_command(cmd, timeout=timeout)
    out = o.read().decode("utf-8", "replace")
    err = e.read().decode("utf-8", "replace")
    code = o.channel.recv_exit_status()
    return code, out, err

remote_dir = job["remoteDir"]
if not remote_dir.startswith("/"):
    print("错误：远端目录必须是绝对 POSIX 路径：%r" % remote_dir); sys.exit(1)

code, out, err = sh("mkdir -p %s" % shlex.quote(remote_dir))
if code != 0:
    print("错误：建目录失败：%s" % err.strip()); sys.exit(1)
print("目录已就绪：%s" % remote_dir)

sftp = c.open_sftp()
uploaded = []
for f in job["files"]:
    target = remote_dir + "/" + f["remote"]
    print("上传 %s (%s) ..." % (f["remote"], "%.1f MB" % (f["size"] / 1048576) if f["size"] >= 1048576 else "%d B" % f["size"]))
    sftp.put(f["local"], target)
    uploaded.append((f, target))
sftp.close()

print("")
print("--- 校验：大小 + sha512 ---")
ok = True
for f, target in uploaded:
    # 大小
    code, out, err = sh("stat -c %%s %s" % shlex.quote(target))
    remote_size = int(out.strip()) if code == 0 and out.strip().isdigit() else -1
    # sha512（远端算，不在本地信任何缓存）
    code2, out2, err2 = sh("sha512sum %s 2>/dev/null || openssl dgst -sha512 %s" % (shlex.quote(target), shlex.quote(target)))
    remote_hex = None
    if code2 == 0:
        for line in out2.splitlines():
            line = line.strip()
            if not line:
                continue
            token = line.split()[0].lower()
            if len(token) == 128 and all(ch in "0123456789abcdef" for ch in token):
                remote_hex = token
                break
    size_ok = remote_size == f["size"]
    sha_ok = remote_hex == f["sha512hex"].lower()
    if size_ok and sha_ok:
        print("  ok   %s  %d 字节  sha512 一致" % (f["remote"], remote_size))
    else:
        ok = False
        print("  失败 %s  远端大小=%d 期望=%d；远端 sha512=%s 期望=%s" % (
            f["remote"], remote_size, f["size"], (remote_hex or "<取不到>")[:16] + "...", f["sha512hex"][:16] + "..."))

if not ok:
    print("校验未通过"); sys.exit(1)

print("")
print("--- 远端目录现状 ---")
code, out, err = sh("cd %s && ls -la && echo '--- latest.yml 前 6 行 ---' && head -6 latest.yml" % shlex.quote(remote_dir))
print(out.strip())

if job["mode"] == "selftest":
    code, out, err = sh("rm -rf %s && echo removed" % shlex.quote(remote_dir))
    if code != 0 or "removed" not in out:
        print("错误：自检临时目录删除失败：%s" % err.strip()); sys.exit(1)
    code, out, err = sh("test -d %s && echo still-there || echo gone" % shlex.quote(remote_dir))
    if "gone" not in out:
        print("错误：自检临时目录仍然存在：%s" % remote_dir); sys.exit(1)
    print("自检临时目录已删除：%s" % remote_dir)

c.close()
print("校验通过：%d 个文件，大小与 sha512 均一致" % len(uploaded))
if job["mode"] == "publish":
    print("发布完成")
`;

function runJob(job, cfg) {
  const { python, version } = detectPython();
  const r = spawnSync(python, ["-c", PY_PROGRAM, JSON.stringify(job)], {
    encoding: "utf8",
    timeout: 30 * 60 * 1000,
    env: {
      ...process.env,
      HEMING_SSH_PWD: cfg.password,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });
  if (r.error) fail(`调用 python 失败：${r.error.message}`);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { code: r.status ?? 1, output: `${r.stdout || ""}${r.stderr || ""}`, python: `${python} (py${version})` };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    log(`用法：
  ${SELF}                真发布：上传 latest.yml + 安装包 + blockmap 并校验
  ${SELF} --dry-run      只打印要做什么，零副作用
  ${SELF} --self-test    自检：1KB 测试文件传到远端临时目录 → 校验 → 删除

环境变量见 scripts/publish-update.mjs 文件头注释。`);
    return;
  }
  const dryRun = argv.includes("--dry-run");
  const selfTest = argv.includes("--self-test");
  const mode = selfTest ? "selftest" : "publish";

  const cfg = {
    ...resolveCredentials(),
    remoteDir: process.env.HEMING_UPDATE_DIR || DEFAULT_REMOTE_DIR,
  };
  const releaseDir = process.env.HEMING_RELEASE_DIR
    ? resolve(ROOT, process.env.HEMING_RELEASE_DIR)
    : resolveReleaseDir({ create: false });
  const version = readVersion();
  // 自检只验「连得上、传得进、校验和与删除都对」，不依赖本机有没有出过包。
  const artifacts = selfTest ? null : collectArtifacts(releaseDir, version);

  log(`模式    : ${mode === "selftest" ? "自检（上传 1KB 测试文件后删除）" : "正式发布"}`);
  log(`版本    : ${version}`);
  log(`产物目录: ${releaseDir}`);
  if (artifacts) {
    log(`清单    : ${artifacts.yml.split(/[\\/]/).pop()}`);
    log(`安装包  : ${artifacts.setup.split(/[\\/]/).pop()}`);
    log(`差分索引: ${artifacts.blockmap ? artifacts.blockmap.split(/[\\/]/).pop() : "<无>"}`);
  } else {
    log("清单    : （自检模式不读产物）");
  }
  log(`目标    : ${cfg.user}@${cfg.host}:${mode === "selftest" ? cfg.remoteDir + "/_selftest（临时）" : cfg.remoteDir}`);
  log(`凭据来源: ${cfg.source}`);

  if (artifacts) {
    // 清单自检：yml 里的 sha512/size 必须与本地安装包一致，否则传上去也是坏包。
    const ymlText = readFileSync(artifacts.yml, "utf8");
    const meta = parseLatestYml(ymlText);
    const setupBuf = readFileSync(artifacts.setup);
    const localSha = sha512(setupBuf).toString("base64");
    const localSize = setupBuf.length;
    if (meta.sha512 && meta.sha512 !== localSha) {
      fail(
        `latest.yml 的 sha512 与本地安装包不一致`,
        `清单可能来自上一版或被打包工具改过：清单 ${meta.sha512.slice(0, 16)}… / 本地 ${localSha.slice(0, 16)}…`,
      );
    }
    if (meta.size && meta.size !== localSize) {
      fail(`latest.yml 的 size（${meta.size}）与本地安装包（${localSize}）不一致`);
    }
    log(`清单自检: sha512 与 size 均与本地安装包一致${meta.sha512 ? "" : "（清单没有 sha512 字段，跳过该子校验）"}`);
  }

  if (dryRun) {
    log("[dry-run] 未上传任何文件（零副作用）");
    return;
  }

  const job = buildJob(mode, cfg, artifacts);
  const result = runJob(job, cfg);
  if (result.code !== 0) {
    fail(
      `${mode === "selftest" ? "自检" : "上传"}失败（退出码 ${result.code}）`,
      "别当成功：远端可能没有文件。手工 `ls -la " + cfg.remoteDir + "` 核对。",
    );
  }
  if (!/校验通过/.test(result.output)) {
    fail("命令返回 0，但输出里没有「校验通过」", "不要当成功：校验环节可能被跳过。");
  }
  log(`\n${mode === "selftest" ? "自检完成" : "发布完成"}（python: ${result.python}）`);
}

main();
