"use strict";
/**
 * 文件编辑桥（桌面端主进程）：`file_patch` / `file_read` 的读盘与落盘层。
 *
 * 为什么需要它：渲染层没有 fs，而「改用户文件」是本产品里权限最大的一件事，
 * 必须在主进程留最后一道闸——即使 web 侧的路径收敛出了 bug，这里也要夹一次。
 *
 * 安全约束（渲染层是网页内容，等同不可信输入）：
 * - 每一条目标路径都必须在**用户显式添加的根**内（根清单随请求传来，来自设置区配置）；
 * - 只用 `mode=write` 的根写、任一已配置的根读；
 * - 软链一律拒绝（目标本身与所有祖先目录都查）：否则圈定的根会被一个链接绕出去；
 * - 硬链接拒绝（`nlink > 1`）：写它等于同时改了根外的另一份；
 * - NUL、超长、Windows 保留名、非普通文件一律拒绝；
 * - 单文件 / 单次总量 / 文件数上限在 web 侧判过，这里**再判一次**（不信任渲染层）。
 *
 * 写盘语义：
 * - 先写 `.<name>.heming-tmp-<rand>` 并 `fsync`，全部成功后再统一 `rename` 覆盖；
 *   中途失败只清理 tmp，**原文件不动**；
 * - 删除放在所有写入之后执行（改名 = 写新文件 + 删旧文件，绝不能先删）；
 * - **不创建目录**：父目录不存在就拒绝（文案提示先建目录）——「顺便帮你建目录」
 *   会让一次拼错路径的补丁在磁盘上留下意料之外的目录树；
 * - 内容按传入字符串原样写 UTF-8，不做行尾转换——CRLF/LF 由 web 侧按原文件保留；
 * - 写入串行排队：同一文件被两个并发请求改时，后一个在前一个完成之后才开始，
 *   最终内容必然是「某一整份」，不会出现两份内容交错。
 *
 * IPC 边界：所有通道都先校验调用来源（只接受主窗口），再校验参数形状与长度上限；
 * 路径解析只认「根 + 目标绝对路径」，渲染层不能传一个根外路径直接写盘。
 *
 * 红线：本模块只碰文件系统，**不引入任何网络能力**（与 crash-log / export-fs 同一条红线）。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  checkAbsoluteInside,
  isInsideRoot,
  isReservedName,
  assertNoSymlinkAncestor,
} = require("./path-guard");

/** 单文件上限（与 web 侧 `limits.ts` 同值；两侧都判，改一处必须改两处）。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 单次写入总量上限。 */
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
/** 单次最多改多少个文件。 */
const MAX_FILES = 20;
/** 二进制嗅探前缀长度（与 web 侧一致）。 */
const SNIFF_BYTES = 8 * 1024;
/** 根名长度上限（设置区输入框同样限制）。 */
const MAX_ROOT_NAME = 64;

/** UTF-8 严格解码器：非法序列直接抛，用于判「这不是文本文件」。 */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * 规整渲染层传来的根清单：坏条目**逐条丢弃**，不因为一条脏数据整体失败。
 *
 * 注意这里不接受「盘符根」（`D:\`）：那等价于整盘可写，
 * 与规格 §5.1「没有 full-disk 档」的口径冲突。想写整个盘就逐个目录加。
 */
function normalizeRoots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, MAX_ROOT_NAME) : "";
    const rawPath = typeof item.path === "string" ? item.path.trim() : "";
    const mode = item.mode === "read" ? "read" : item.mode === "write" ? "write" : null;
    if (!name || !rawPath || !mode) continue;
    if (rawPath.includes("\0") || rawPath.length > 300) continue;
    if (!path.isAbsolute(rawPath)) continue;
    const abs = path.resolve(rawPath);
    if (path.parse(abs).root === abs) continue; // 盘符根/文件系统根
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, path: abs, mode });
  }
  return out;
}

/**
 * 找到包含该绝对路径的根。
 *
 * **最长前缀优先**：同时配了 `D:/库` 和 `D:/库/私人` 时，后者更具体，
 * 用它的 mode 判定——否则「私人目录设为只读」会被外层可写根吞掉。
 */
function findRoot(roots, absPath) {
  let best = null;
  for (const root of roots) {
    if (!isInsideRoot(root.path, absPath)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best;
}

/** 前缀里是否有 NUL（二进制文件的可靠特征）。 */
function looksBinary(buf) {
  const head = buf.subarray(0, SNIFF_BYTES);
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0) return true;
  }
  return false;
}

/**
 * 读一个文件（供 `file_read` 与干跑使用）。
 *
 * @param {Array} roots 已规整的根清单
 * @param {string} absPath 绝对路径
 * @returns {Promise<object>} `{ok:true,content,bytes}` 或 `{ok:false,code,error}`
 */
async function readFile(roots, absPath) {
  if (typeof absPath !== "string" || !absPath) {
    return { ok: false, code: "invalid-path", error: "路径不能为空" };
  }
  if (absPath.includes("\0")) return { ok: false, code: "invalid-path", error: "路径里含非法字符（NUL）" };
  if (!path.isAbsolute(absPath)) return { ok: false, code: "invalid-path", error: "路径必须是绝对路径" };
  const abs = path.resolve(absPath);
  const root = findRoot(roots, abs);
  if (!root) {
    return { ok: false, code: "outside-roots", error: "目标不在任何已配置的根内（请在设置区添加根）" };
  }
  const linkCheck = assertNoSymlinkAncestor(root.path, abs);
  if (!linkCheck.ok) return { ok: false, code: "symlink", error: linkCheck.error };

  let stat;
  try {
    stat = await fsp.lstat(abs);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: false, code: "not-found", error: "文件不存在" };
    return { ok: false, code: "io", error: `读取失败：${e && e.message ? e.message : String(e)}` };
  }
  if (stat.isSymbolicLink()) return { ok: false, code: "symlink", error: "目标是符号链接，已拒绝" };
  if (!stat.isFile()) return { ok: false, code: "not-file", error: "目标不是普通文件" };
  if (stat.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: "too-large",
      error: `文件 ${Math.round(stat.size / 1024)} KB 超过单文件上限 ${Math.round(MAX_FILE_BYTES / 1024)} KB`,
    };
  }

  let buf;
  try {
    buf = await fsp.readFile(abs);
  } catch (e) {
    return { ok: false, code: "io", error: `读取失败：${e && e.message ? e.message : String(e)}` };
  }
  if (looksBinary(buf)) return { ok: false, code: "binary", error: "这不是文本文件（检测到二进制内容）" };
  let content;
  try {
    content = UTF8_DECODER.decode(buf);
  } catch {
    return { ok: false, code: "binary", error: "这不是 UTF-8 文本文件（含非法字节序列）" };
  }
  return { ok: true, content, bytes: buf.length };
}

/** 目标已存在时的额外检查：软链 / 非普通文件 / 硬链接。返回错误文案或 null。 */
async function inspectExistingTarget(abs) {
  let stat;
  try {
    stat = await fsp.lstat(abs);
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    return `检查目标失败：${e && e.message ? e.message : String(e)}`;
  }
  if (stat.isSymbolicLink()) return "目标是符号链接，已拒绝（避免写入根外的文件）";
  if (!stat.isFile()) return "目标不是普通文件，已拒绝";
  if (stat.nlink > 1) return "目标是硬链接（nlink>1），可能同时改到根外的另一份，已拒绝";
  return null;
}

/**
 * 批量写入/删除（两阶段：先全部 stage，再统一 rename）。
 *
 * @param {Array} roots 已规整的根清单
 * @param {Array} ops `[{kind:"write"|"delete", path, content?}]`
 */
async function writeBatch(roots, ops) {
  const writeRoots = roots.filter((r) => r.mode === "write");
  if (writeRoots.length === 0) {
    return { ok: false, error: "尚未配置可写根（mode=write），无法写入" };
  }
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: "没有要写入的变更" };
  if (ops.length > MAX_FILES) return { ok: false, error: `单次最多修改 ${MAX_FILES} 个文件` };

  const plan = [];
  let totalBytes = 0;
  for (const op of ops) {
    if (!op || typeof op !== "object") return { ok: false, error: "变更项格式不合法" };
    const kind = op.kind === "write" ? "write" : op.kind === "delete" ? "delete" : null;
    if (!kind) return { ok: false, error: "变更项类型只能是 write 或 delete" };
    if (typeof op.path !== "string" || !op.path) return { ok: false, error: "变更项缺少目标路径" };
    const root = findRoot(roots, op.path);
    if (!root) return { ok: false, error: `目标不在任何已配置的根内：${op.path}` };
    if (root.mode !== "write") {
      return { ok: false, error: `目标位于只读根「${root.name}」，写入被拒绝：${op.path}` };
    }
    const checked = checkAbsoluteInside(op.path, root.path);
    if (!checked.ok) return { ok: false, error: `${checked.error}：${op.path}` };
    const linkCheck = assertNoSymlinkAncestor(root.path, checked.abs);
    if (!linkCheck.ok) return { ok: false, error: `${linkCheck.error}：${op.path}` };
    if (isReservedName(path.basename(checked.abs))) {
      return { ok: false, error: `文件名是 Windows 保留名，无法写入：${path.basename(checked.abs)}` };
    }

    if (kind === "write") {
      if (typeof op.content !== "string") return { ok: false, error: "写入内容必须是字符串" };
      if (op.content.includes("\0")) return { ok: false, error: "写入内容含 NUL，拒绝写入二进制内容" };
      const bytes = Buffer.byteLength(op.content, "utf8");
      if (bytes > MAX_FILE_BYTES) {
        return { ok: false, error: `${op.path} 内容约 ${Math.round(bytes / 1024)} KB，超过单文件上限` };
      }
      totalBytes += bytes;
      if (totalBytes > MAX_PATCH_BYTES) return { ok: false, error: "单次补丁总量超过上限" };
      // 父目录必须已存在：本工具不创建目录（见文件头）。写新文件也一样要求父目录在。
      let parentStat = null;
      try {
        parentStat = await fsp.lstat(path.dirname(checked.abs));
      } catch {
        parentStat = null;
      }
      if (!parentStat || !parentStat.isDirectory()) {
        return {
          ok: false,
          error: `父目录不存在或不是目录：${path.dirname(checked.abs)}。请先在文件系统里创建目录，本工具不创建目录。`,
        };
      }
      plan.push({ kind, abs: checked.abs, root, content: op.content });
    } else {
      plan.push({ kind, abs: checked.abs, root });
    }
  }

  // 已存在目标的前置检查（软链/硬链/非普通文件；删除的目标必须存在）
  for (const item of plan) {
    const problem = await inspectExistingTarget(item.abs);
    if (problem) return { ok: false, error: `${problem}：${item.abs}` };
    if (item.kind === "delete" && problem === null) {
      const exists = fs.existsSync(item.abs);
      if (!exists) return { ok: false, error: `要删除的文件不存在：${item.abs}` };
    }
  }

  const writes = plan.filter((p) => p.kind === "write");
  const deletes = plan.filter((p) => p.kind === "delete");

  // 阶段 1：全部写到同目录 tmp 并 fsync（原文件在这阶段完全不动）
  const staged = [];
  try {
    for (const item of writes) {
      const dir = path.dirname(item.abs);
      const tmp = path.join(
        dir,
        `.${path.basename(item.abs)}.heming-tmp-${crypto.randomBytes(6).toString("hex")}`,
      );
      const handle = await fsp.open(tmp, "w");
      try {
        await handle.writeFile(item.content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      staged.push({ item, tmp });
    }
  } catch (e) {
    // 清理已 stage 的 tmp：原文件一个字节都没动
    for (const s of staged) {
      try {
        await fsp.unlink(s.tmp);
      } catch {
        /* 清理失败不影响结论：tmp 文件残留不会破坏原文件 */
      }
    }
    return { ok: false, error: `写入失败（原文件未改动）：${e && e.message ? e.message : String(e)}` };
  }

  // 阶段 2：统一 rename 覆盖（同目录 rename 在 NTFS 上是原子的）
  const results = [];
  for (const s of staged) {
    try {
      await fsp.rename(s.tmp, s.item.abs);
      results.push({ path: s.item.abs, ok: true });
    } catch (e) {
      try {
        await fsp.unlink(s.tmp);
      } catch {
        /* 同上 */
      }
      results.push({ path: s.item.abs, ok: false, error: `替换失败：${e && e.message ? e.message : String(e)}` });
    }
  }

  // 阶段 3：删除（改名语义下这一步必须在写入成功之后）
  for (const item of deletes) {
    try {
      await fsp.unlink(item.abs);
      results.push({ path: item.abs, ok: true });
    } catch (e) {
      results.push({ path: item.abs, ok: false, error: `删除失败：${e && e.message ? e.message : String(e)}` });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    results,
    written: writes.length,
    deleted: deletes.length,
    ...(failed.length ? { error: `${failed.length} 个文件未能完成（其余已写入）` } : {}),
  };
}

/**
 * 注册 IPC。放在模块里而不是 main.js，是为了能用假 ipcMain/dialog 单测。
 *
 * 每个通道第一步都校验**调用来源**（只接受主窗口的 webContents）：
 * 桌宠窗口、未来的其它渲染进程都不能通过这里改用户的文件。
 * 未注入校验函数时按「拒绝」处理（fail-closed）——忘了接线是安全问题，不能被默认放行掩盖。
 *
 * @param {object} ipcMain
 * @param {object} deps
 * @param {{showOpenDialog: Function}} deps.dialog
 * @param {() => any} [deps.getMainWindow]
 * @param {(event: any) => boolean} [deps.isTrustedSender]
 */
function registerFileIpc(ipcMain, deps) {
  const dialog = deps && deps.dialog;
  const getMainWindow = deps && deps.getMainWindow;
  const isTrustedSender = (deps && deps.isTrustedSender) || (() => false);

  const untrusted = { ok: false, code: "untrusted-sender", error: "未授权的调用来源" };

  /** 写操作串行队列：并发请求排队执行，避免两个 rename 交错。 */
  let writeQueue = Promise.resolve();

  ipcMain.handle("file:read", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    try {
      const roots = normalizeRoots(payload && payload.roots);
      if (roots.length === 0) return { ok: false, code: "no-roots", error: "尚未配置任何根目录" };
      return await readFile(roots, payload && payload.path);
    } catch (e) {
      return { ok: false, code: "io", error: `读取失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  ipcMain.handle("file:write", async (event, payload) => {
    if (!isTrustedSender(event)) return untrusted;
    const roots = normalizeRoots(payload && payload.roots);
    const ops = payload && payload.ops;
    const task = writeQueue.then(() => writeBatch(roots, ops));
    // 队列自身不能被一次失败卡死：catch 掉再继续排下一次
    writeQueue = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } catch (e) {
      return { ok: false, error: `写入失败：${e && e.message ? e.message : String(e)}` };
    }
  });

  ipcMain.handle("file:pick-root", async (event) => {
    if (!isTrustedSender(event)) return null;
    if (!dialog || typeof dialog.showOpenDialog !== "function") return null;
    const options = {
      title: "选择可写目录",
      properties: ["openDirectory", "createDirectory"],
    };
    const win = typeof getMainWindow === "function" ? getMainWindow() : null;
    let result;
    try {
      result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    } catch {
      return null;
    }
    if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });
}

module.exports = {
  registerFileIpc,
  normalizeRoots,
  findRoot,
  readFile,
  writeBatch,
  looksBinary,
  MAX_FILE_BYTES,
  MAX_PATCH_BYTES,
  MAX_FILES,
};
