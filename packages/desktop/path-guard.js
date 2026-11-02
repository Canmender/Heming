"use strict";
/**
 * 共享的路径判定（桌面端主进程）。
 *
 * 从 `wiki-fs.js` 的 `resolveInside()` 抽出来：现在有三处要判「这个路径是不是被夹在
 * 某个根目录里」——知识库（wiki-fs）、文件编辑（file-fs）以及将来可能的新桥。
 * 各抄一份的话，某一处改了判定口径（例如补 NUL 检查）另外两处不会跟着改，
 * 而这种分叉在安全判定上就是漏洞。
 *
 * 与 web 侧 `packages/web/src/lib/fileEdit/paths.ts` 的关系：
 * 那边负责把**模型给的字符串**收敛成「根 + 相对路径」（纯函数、进浏览器 bundle），
 * 这边是**主进程的最后一道**：渲染层传来的绝对路径在这里再夹一次。
 * 两处实现刻意分开（进程边界不同），但口径必须一致——两个文件的注释互相指向。
 */

const path = require("node:path");
const fs = require("node:fs");

/** 路径长度上限（与 web 侧一致）。 */
const MAX_PATH_CHARS = 300;

/** Windows 设备保留名：即使用作中间文件名也会出问题，一律拒绝创建。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * 把相对路径解析成根目录内的绝对路径；越界返回 null。
 *
 * ★ 行为与抽取前的 `wiki-fs.js:42-51` **逐字等价**（含「去掉前导斜杠」这一步）：
 * 知识库那边传进来的本来就是相对路径，去前导斜杠是为了挡住 Windows 风格绝对路径。
 * 文件编辑桥不走这条（它传绝对路径，见 `checkAbsoluteInside`）。
 *
 * @param {string} rootAbs 根目录绝对路径
 * @param {string} rel 相对路径
 * @returns {string|null}
 */
function resolveInsideRoot(rootAbs, rel) {
  if (typeof rel !== "string" || !rel) return null;
  if (typeof rootAbs !== "string" || !rootAbs) return null;
  // 反斜杠统一成 /，顺手挡掉 Windows 风格的绝对路径
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm.includes("\0")) return null;
  if (norm.length > MAX_PATH_CHARS) return null;
  const root = path.resolve(rootAbs);
  const abs = path.resolve(root, norm);
  const relCheck = path.relative(root, abs);
  // 越界判定：relative 出了根目录，或以 .. 开头，或就是根本身
  if (relCheck === "" || relCheck.startsWith("..") || path.isAbsolute(relCheck)) return null;
  return abs;
}

/** 绝对路径是否落在根内（含子目录与文件；不含根本身）。大小写不敏感（Windows 口径）。 */
function isInsideRoot(rootAbs, absPath) {
  if (typeof rootAbs !== "string" || !rootAbs) return false;
  if (typeof absPath !== "string" || !absPath) return false;
  if (absPath.includes("\0")) return false;
  const root = path.resolve(rootAbs);
  const full = path.resolve(absPath);
  const relCheck = path.relative(root, full);
  return relCheck !== "" && !relCheck.startsWith("..") && !path.isAbsolute(relCheck);
}

/**
 * 校验渲染层传来的绝对路径：必须绝对、无 NUL、不超长、且落在某个根内。
 *
 * @param {string} absPath 绝对路径
 * @param {string} rootAbs 期望所属的根
 * @returns {{ok:true, abs:string}|{ok:false, error:string}}
 */
function checkAbsoluteInside(absPath, rootAbs) {
  if (typeof absPath !== "string" || !absPath.trim()) {
    return { ok: false, error: "路径不能为空" };
  }
  if (absPath.includes("\0")) return { ok: false, error: "路径里含非法字符（NUL）" };
  if (absPath.length > MAX_PATH_CHARS) return { ok: false, error: `路径过长（超过 ${MAX_PATH_CHARS} 字符）` };
  if (!path.isAbsolute(absPath)) return { ok: false, error: "路径必须是绝对路径" };
  const abs = path.resolve(absPath);
  if (!isInsideRoot(rootAbs, abs)) return { ok: false, error: "路径不在可写根内" };
  return { ok: true, abs };
}

/** 文件名是否是 Windows 保留名（`con.txt` 也算）。 */
function isReservedName(name) {
  return WINDOWS_RESERVED.test(String(name ?? ""));
}

/**
 * 逐个祖先目录检查软链（从根到目标的父目录）。
 *
 * 为什么必须逐级查：只 `lstat` 目标本身挡不住「根下某个子目录是软链」的情况——
 * 目标文件本身是普通文件，但它的父目录指向根外，写进去就出界了。
 *
 * @param {string} rootAbs 根目录
 * @param {string} targetAbs 目标绝对路径
 * @returns {{ok:true}|{ok:false, error:string}}
 */
function assertNoSymlinkAncestor(rootAbs, targetAbs) {
  const root = path.resolve(rootAbs);
  const full = path.resolve(targetAbs);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: "路径不在可写根内" };
  }
  const segs = rel.split(path.sep).filter(Boolean);
  let current = root;
  for (let i = 0; i < segs.length; i += 1) {
    current = path.join(current, segs[i]);
    const isLast = i === segs.length - 1;
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { ok: true }; // 还没创建：没有软链可绕
      return { ok: false, error: `检查路径失败：${e && e.message ? e.message : String(e)}` };
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, error: "路径中包含符号链接（软链），为避免绕出可写根，已拒绝" };
    }
    if (!isLast && !stat.isDirectory()) {
      return { ok: false, error: "路径中间存在非目录项" };
    }
  }
  return { ok: true };
}

module.exports = {
  MAX_PATH_CHARS,
  resolveInsideRoot,
  isInsideRoot,
  checkAbsoluteInside,
  isReservedName,
  assertNoSymlinkAncestor,
};
