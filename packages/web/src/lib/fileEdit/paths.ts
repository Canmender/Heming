/**
 * 路径口径（web 侧单一来源）。
 *
 * 为什么要自己写而不 require("node:path")：这段代码会进浏览器 bundle，
 * 渲染层没有 node:path。桌面端主进程另有一份 `packages/desktop/path-guard.js`
 * （那边的口径来自 `wiki-fs.js` 的 `resolveInside`，用 node:path 实现）——
 * 两份实现处理的是**不同的边界**：web 侧负责把模型给的路径收敛到「根 + 相对路径」，
 * 主进程负责在这道逻辑出 bug 时兜底再夹一次。两个文件顶部都写了同源说明。
 *
 * 本文件全部是纯函数：不碰磁盘、不读 localStorage、不依赖 window。
 */

/** 一次调用里可选的可写根（与设置区存储的结构一致）。 */
export interface FileRoot {
  /** 根名（工具参数 `root` 用它选中；重名不允许）。 */
  name: string;
  /** 根目录绝对路径（存正斜杠形式）。 */
  path: string;
  /** 读写模式：`read` 只能读，`write` 才能写。没有 `full-disk` 这种档。 */
  mode: "read" | "write";
}

/** NUL 字节在路径里一律非法（Windows API 会把字符串截断，是经典绕过手法）。 */
const NUL = "\u0000";

/** 路径长度上限：Windows 的 MAX_PATH 是 260，给中文字符留足余量仍不该超 300。 */
export const MAX_PATH_CHARS = 300;

/** 统一成正斜杠形式并压缩多余分隔符（不折叠 `.`/`..`，报错要原样回显）。 */
export function toPosixPath(input: string): string {
  return String(input ?? "")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
}

/** 是否像绝对路径（Windows 盘符 / POSIX 根；UNC 的前导 `//` 已被压缩成 `/`）。 */
export function isAbsolutePath(input: string): boolean {
  const p = toPosixPath(input).trim();
  return /^[A-Za-z]:\//.test(p) || /^[A-Za-z]:$/.test(p) || p.startsWith("/");
}

/** 拆成非空段（盘符算第一段，如 `D:`）。 */
export function segmentsOf(input: string): string[] {
  return toPosixPath(input)
    .split("/")
    .filter((s) => s.length > 0 && s !== ".");
}

/** 折 `.`/`..` 的公共实现：返回 {prefix, segs}，便于区分盘符与 POSIX 根。 */
function foldParts(input: string): { prefix: string; segs: string[]; isAbs: boolean } {
  const raw = toPosixPath(String(input ?? "").trim());
  const drive = /^([A-Za-z]):(?=\/|$)/.exec(raw);
  const isAbs = Boolean(drive) || raw.startsWith("/");
  let rest = raw;
  if (drive) rest = raw.slice(2);
  else if (raw.startsWith("/")) rest = raw.slice(1);
  const segs: string[] = [];
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (segs.length && segs[segs.length - 1] !== "..") segs.pop();
      else segs.push("..");
      continue;
    }
    segs.push(seg);
  }
  const prefix = drive ? `${drive[1]}:/` : isAbs ? "/" : "";
  return { prefix, segs, isAbs };
}

/**
 * 文本层面折掉 `.` 与 `..`（不碰磁盘，不解析软链）。
 *
 * 折完仍以 `..` 开头，说明越过了起点——调用方据此判越界。
 * 这是唯一允许「出现 `..`」的地方：规则资源归一化需要它（例如用户手填了
 * `D:/Obsidian/学院事务/../私人/`），而**补丁目标路径不允许**（见 `resolveInsideRoot`）。
 */
export function foldSegments(input: string): string {
  const { prefix, segs } = foldParts(input);
  const body = segs.join("/");
  if (!prefix) return body;
  if (!body) return prefix.replace(/\/$/, "");
  return `${prefix}${body}`;
}

/** 比较用的键：大小写不敏感、正斜杠、无尾斜杠。 */
export function compareKey(input: string): string {
  return foldSegments(input).replace(/\/+$/, "").toLowerCase();
}

/** 是否是「路径前缀」形状的规则资源（以 `/` 结尾，但盘符根 `D:/` 不算前缀规则）。 */
export function isPrefixResource(resource: string): boolean {
  if (!resource || resource === "*") return false;
  return /\/$/.test(resource) && !/^[A-Za-z]:\/$/.test(resource);
}

/**
 * 规则资源的归一化（**规则写入与匹配必须共用这一个函数**）。
 *
 * 为什么必须共用：各写一份会出现「写进去匹配不上」的幽灵规则——
 * 用户明明点了「允许这个目录」，下次还是弹窗，而设置区里那条规则看着没毛病。
 *
 * 归一化内容：分隔符、连续斜杠、`.`/`..` 折叠、尾斜杠压缩到一个。
 * **保留尾斜杠**：它是「前缀规则」的唯一标记（规格 §7）。
 * 不做大小写变换：展示要保留用户输入的形态，比较时再 `toLowerCase`。
 *
 * 非法资源（含 NUL、折叠后仍越界）退化成 `*`：宁可多问一次，
 * 也不要落一条永远匹配不上、却让用户以为授权了的规则。
 */
export function normalizeRuleResource(resource: string): string {
  const raw = String(resource ?? "").trim();
  if (!raw || raw === "*") return "*";
  if (raw.includes(NUL)) return "*";
  const hadTrailing = /[\\/]$/.test(raw);
  const folded = foldSegments(raw);
  if (!folded || folded === ".." || folded.startsWith("../")) return "*";
  if (hadTrailing && !/^[A-Za-z]:$/.test(folded) && folded !== "/") return `${folded.replace(/\/+$/, "")}/`;
  return folded;
}

/**
 * 一条规则资源是否覆盖某个候选资源。
 *
 * 三种形状：
 * - `*`：该工具全部调用（**多目标工具不接受它，由 policy 另行判断**）；
 * - `xxx/`：路径前缀，候选以它开头（按路径段，不会把 `D:/a/` 误配到 `D:/ab/`）；
 * - 其他：精确相等。
 */
export function resourceCovers(rule: string, candidate: string): boolean {
  if (!rule) return false;
  if (rule === "*") return true;
  const r = normalizeRuleResource(rule);
  const c = normalizeRuleResource(candidate);
  const rk = compareKey(r);
  const ck = compareKey(c);
  if (isPrefixResource(r)) {
    // 目录本身也算被覆盖（前缀 `D:/a/` 覆盖 `D:/a`）——否则给目录建的规则匹配不上目录自身。
    return ck === rk || ck.startsWith(`${rk}/`);
  }
  return ck === rk;
}

/**
 * 把相对路径夹进根目录（对应 `wiki-fs.js:42-51` 的口径）。
 *
 * 与那边相比多一条**更严**的规则：相对路径里出现 `..` 直接返回 null，
 * 不做「折叠后仍在根内就放过」。理由：补丁来自模型，`..` 出现在补丁里
 * 从来不是笔误；折叠着放过等于把「越界」这件事藏起来，
 * 用户看不到一次可疑操作，而模型会以为这条路走得通。
 *
 * 返回绝对路径（正斜杠、无尾斜杠）；越界/非法返回 null。
 */
export function resolveInsideRoot(rootAbs: string, rel: string): string | null {
  if (typeof rel !== "string" || !rel) return null;
  if (rel.includes(NUL)) return null;
  if (rel.length > MAX_PATH_CHARS) return null;
  const relPosix = toPosixPath(rel).trim();
  if (!relPosix) return null;
  if (isAbsolutePath(relPosix)) return null;
  const segs = relPosix.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segs.length === 0) return null;
  if (segs.some((s) => s === "..")) return null;
  const root = toPosixPath(rootAbs).replace(/\/+$/, "");
  if (!root) return null;
  return `${root}/${segs.join("/")}`;
}

/** 绝对路径是否在根内（含子目录与文件；不含根本身）。 */
export function isInsideRoot(rootAbs: string, absPath: string): boolean {
  const root = compareKey(rootAbs);
  const target = compareKey(absPath);
  if (!root || !target) return false;
  return target.startsWith(`${root}/`);
}

/** 绝对路径相对根的部分；不在根内返回 null。 */
export function relFromRoot(rootAbs: string, absPath: string): string | null {
  if (!isInsideRoot(rootAbs, absPath)) return null;
  const rootSegs = toPosixPath(rootAbs)
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s.length > 0);
  // 按段截取而不是按字符长度：两边大小写/分隔符写得不一致时字符长度也会不一致。
  return toPosixPath(absPath)
    .split("/")
    .filter((s) => s.length > 0)
    .slice(rootSegs.length)
    .join("/");
}

/**
 * 一组路径的公共目录前缀（正斜杠、以 `/` 结尾）；没有公共目录返回 null。
 *
 * 用途：确认卡与 HITL 规则需要把「这次要改哪几个文件」收敛成一句「哪个目录」。
 * 公共前缀只到盘符（如 `D:/`）时返回 null——把整个盘授权出去是不能接受的。
 */
export function commonDirPrefix(paths: string[]): string | null {
  const list = paths.filter((p) => typeof p === "string" && p.trim()).map((p) => toPosixPath(p));
  if (list.length === 0) return null;
  const dirs = list.map((p) => {
    const segs = p.split("/");
    segs.pop(); // 最后一段是文件名，公共前缀只到目录
    return segs.filter((s) => s.length > 0);
  });
  const first = dirs[0];
  let common = first.length;
  for (let i = 1; i < dirs.length; i += 1) {
    const segs = dirs[i];
    let n = 0;
    while (n < common && n < segs.length && segs[n].toLowerCase() === first[n].toLowerCase()) n += 1;
    common = n;
  }
  // 公共前缀至少两段（盘符 + 一个目录）才算「一个目录」；只到盘符就是整盘，不能授权。
  if (common < 2) return null;
  return `${first.slice(0, common).join("/")}/`;
}

/** UTF-8 字节数（上限判定统一用它，不能用 `String.length`）。 */
export function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  // 极端兜底（不该走到）：按最坏情况估，宁可提前拒绝也不放过大文件。
  return text.length * 3;
}
