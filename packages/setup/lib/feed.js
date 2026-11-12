"use strict";
/**
 * 解析更新服务器上的 latest.yml，并挑出 Windows 安装包。
 *
 * 为什么不引 yaml 依赖：这里只会出现 electron-builder generic provider 生成的
 * 固定结构（version / files[] / path / sha512 / size），一百来行手写解析足够，
 * 而且能顺便抓住「服务端结构变了」这种错误——重新引入一套 YAML 语义不是本任务的目标。
 *
 * latest.yml 实例（v135 实际产物）：
 *   version: 135.3.54
 *   files:
 *     - url: 和鸣%20Setup%20d.135.3.54.7.exe
 *       sha512: 9xY...
 *       size: 361236480
 *   path: 和鸣 Setup d.135.3.54.7.exe
 *   sha512: 9xY...
 *   releaseDate: '2026-11-10T09:12:00.000Z'
 *
 * 注意：这里的 version 是 electron-builder 的 semver（三段），用户看到的 5 段版本
 * （d.135.3.54.7）只存在于安装包文件名里，所以模块同时提供 versionFromInstallerName。
 */

/**
 * @typedef {{url: string, sha512: string|null, size: number|null}} FeedFile
 * @typedef {{version: string|null, files: FeedFile[], path: string|null, sha512: string|null, size: number|null}} LatestFeed
 */

/**
 * 解析 latest.yml 文本。结构不认识时返回空壳，不抛异常——调用方统一按「feed-invalid」处理。
 * @param {string} text
 * @returns {LatestFeed}
 */
function parseLatestYml(text) {
  const feed = { version: null, files: [], path: null, sha512: null, size: null };
  if (typeof text !== "string" || !text.trim()) return feed;

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  /** @type {FeedFile|null} */
  let current = null;
  let inFiles = false;

  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;

    // files: 下面的列表项：`  - url: ...`
    const itemMatch = /^\s*-\s+([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (itemMatch && inFiles) {
      current = { url: "", sha512: null, size: null };
      feed.files.push(current);
      assignFileField(current, itemMatch[1], itemMatch[2]);
      continue;
    }

    const keyMatch = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
    if (!keyMatch) {
      // 列表项内部的缩进字段（url 之外的 sha512 / size）：缩进行既不是列表项、
      // 也不是顶层键，必须在这里接住，否则整行的 sha512/size 会被丢掉。
      const indentedKey = /^[ \t]+([A-Za-z][\w-]*):\s*(.*)$/.exec(raw);
      if (indentedKey && current && inFiles) {
        assignFileField(current, indentedKey[1], indentedKey[2]);
      }
      continue;
    }
    const key = keyMatch[1];
    const value = unquote(keyMatch[2].trim());

    if (key === "files") {
      inFiles = true;
      current = null;
      continue;
    }

    inFiles = false;
    current = null;

    if (key === "version") {
      feed.version = value || null;
    } else if (key === "path") {
      feed.path = value || null;
    } else if (key === "sha512") {
      feed.sha512 = value || null;
    } else if (key === "size") {
      const size = Number.parseInt(value, 10);
      feed.size = Number.isFinite(size) ? size : null;
    }
  }

  // 顶层 path 就是当前全量安装包；files 里没有 exe 时用它兜底
  if (feed.files.length === 0 && feed.path) {
    feed.files.push({ url: feed.path, sha512: feed.sha512, size: feed.size });
  }
  return feed;
}

/**
 * @param {FeedFile} file
 * @param {string} key
 * @param {string} rawValue
 */
function assignFileField(file, key, rawValue) {
  const value = unquote(rawValue.trim());
  if (key === "url") file.url = value;
  else if (key === "sha512") file.sha512 = value || null;
  else if (key === "size") {
    const size = Number.parseInt(value, 10);
    file.size = Number.isFinite(size) ? size : null;
  }
}

/**
 * YAML 里字符串可能带单双引号，跟着 releaseDate 一起剥掉。
 * @param {string} value
 */
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * 从 feed 里挑 Windows 安装包。
 * 差分包的 blockmap、macOS 的 dmg 都排除；没有 .exe 时退回到 path（老服务端只有 path）。
 * @param {LatestFeed} feed
 * @returns {FeedFile|null}
 */
function pickWindowsInstaller(feed) {
  if (!feed || !Array.isArray(feed.files)) return null;
  const exe = feed.files.find((file) => file && typeof file.url === "string" && /\.exe(\?.*)?$/i.test(file.url));
  if (exe) return exe;
  if (feed.path) {
    return { url: feed.path, sha512: feed.sha512, size: feed.size };
  }
  return null;
}

/**
 * 把 feed 里的相对地址拼成绝对地址。
 * base 结尾没有斜杠时必须补一个，否则 `new URL("x.exe", ".../updates")` 会把 updates 当文件名吃掉。
 * @param {string} base 例如 http://47.92.39.184/updates
 * @param {string} rel 例如 和鸣%20Setup%20d.135.3.54.7.exe
 * @returns {string}
 */
function resolveDownloadUrl(base, rel) {
  if (/^https?:\/\//i.test(rel)) return rel;
  const normalized = base.endsWith("/") ? base : `${base}/`;
  return new URL(rel, normalized).toString();
}

/**
 * 从内层安装包文件名里取 5 段版本；取不到返回 null。
 * 安装包名字是用户唯一能看到 5 段版本的地方（latest.yml 里只有 semver）。
 * @param {string} name
 * @returns {string|null}
 */
function versionFromInstallerName(name) {
  if (typeof name !== "string") return null;
  const match = /[dmc]\.\d+\.\d+\.\d+\.\d+(?:-dev\.\d+)?/.exec(name);
  return match ? match[0] : null;
}

/** 把 URL 的文件名部分解码成人类可读的本地文件名（用于展示与离线兜底匹配）。 */
function decodeFileName(url) {
  const clean = String(url).split(/[?#]/)[0];
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

module.exports = {
  parseLatestYml,
  pickWindowsInstaller,
  resolveDownloadUrl,
  versionFromInstallerName,
  decodeFileName,
};
