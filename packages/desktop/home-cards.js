"use strict";

/**
 * 首页卡片（`contributions.homeCards`）的数据层：清单声明 + 运行期覆盖 + 主窗投影。
 *
 * 为什么单独一个纯函数模块：同一份卡片值要被三处用到——主窗 `plugins:homecards`
 * 的列表、`widget:homecard-set` 的写盘与广播、安装/升级后的回填。把「读覆盖 → 合并 →
 * 投影成 PluginHomeCard」收在一处，三处就不会各写一份字段名然后互相漂移。
 *
 * 覆盖值存插件自己的数据目录（`plugins/<id>/data/homecards.json`，走 plugin-store 的
 * readData/writeData）：它属于插件数据，卸载时跟 data 一起清理；也不必把随运行期
 * 变化的文案塞进注册表（注册表是安装态，改了要整体重写，收益为零）。
 *
 * 安全口径：`id/title/icon/page` 来自清单（安装时已验签），运行期只允许改
 * `text/detail/badge` 三个展示字段；未知字段一律忽略，长度与体积都有硬上限，
 * 避免插件把「首页卡片」当成一个不限量的状态存储。
 */

/** 覆盖值的存储键：`plugins/<id>/data/homecards.json`。 */
const CARD_KEY = "homecards";

/** 插件运行期可以覆盖的字段。 */
const CARD_FIELDS = ["text", "detail", "badge"];

/** 单字段长度上限（字符）。卡片是首页摘要，不是正文。 */
const CARD_FIELD_MAX = 200;

/** 单卡覆盖对象的 JSON 上限（字节）。 */
const CARD_MAX_BYTES = 2 * 1024;

/** 单插件卡片数量上限（与 plugin-package 的清单校验保持同一口径）。 */
const MAX_HOME_CARDS = 8;

/** cardId 与 data key 用同一套字符集：它同时是覆盖表里的键。 */
const CARD_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 归一化一个可覆盖字段：非字符串/空串 → null（视为「清除覆盖，回落清单值」）。 */
function fieldValue(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > CARD_FIELD_MAX ? text.slice(0, CARD_FIELD_MAX) : text;
}

/**
 * 读某插件的覆盖表（`{ [cardId]: { text?, detail?, badge? } }`）。
 *
 * 读不到、格式损坏、字段类型不对都按「没有覆盖」处理：首页不能因为一个坏 JSON
 * 整块空掉（宿主渲染的是清单声明的卡片，覆盖只是可选增强）。
 */
function readOverrides(readData, pluginId) {
  if (typeof readData !== "function") return {};
  let stored = null;
  try {
    stored = readData(pluginId, CARD_KEY);
  } catch {
    return {};
  }
  if (!isPlainObject(stored)) return {};
  const overrides = {};
  for (const [cardId, value] of Object.entries(stored)) {
    if (!CARD_ID_RE.test(cardId) || !isPlainObject(value)) continue;
    const entry = {};
    for (const field of CARD_FIELDS) {
      const text = fieldValue(value[field]);
      if (text !== null) entry[field] = text;
    }
    if (Object.keys(entry).length > 0) overrides[cardId] = entry;
  }
  return overrides;
}

/**
 * 把一条清单声明投影成主窗要的 `PluginHomeCard`（字段全是 string，缺省补空串）。
 *
 * 主窗只负责画，不判断「插件是否启用 / 文件是否完好」——那些是宿主的选择，
 * 在 `collectCards` 里先筛掉，渲染层拿到的每一张卡都该是能点开的。
 */
function projectCard(record, spec, override) {
  const entry = isPlainObject(override) ? override : {};
  return {
    pluginId: record.id,
    pluginName: typeof record.name === "string" && record.name ? record.name : record.id,
    id: spec.id,
    title: spec.title,
    summary: typeof spec.summary === "string" ? spec.summary : "",
    icon: typeof spec.icon === "string" ? spec.icon : "",
    page: typeof spec.page === "string" && spec.page ? spec.page : `plugin:${record.id}`,
    // primary 是清单里的初始文案；插件跑起来后用 homeCardSet 覆盖
    text: entry.text || (typeof spec.primary === "string" ? spec.primary : ""),
    detail: entry.detail || "",
    badge: entry.badge || "",
  };
}

/**
 * 收集所有可展示的首页卡片。
 *
 * 只收「已安装 + enabled + 没有文件错误」的插件（与宿主建窗、页面视图同一口径）：
 * 停用/损坏插件的卡片留在首页会变成点不开的死链。
 */
function collectCards(records, readData) {
  const cards = [];
  if (!Array.isArray(records)) return cards;
  for (const record of records) {
    if (!record || record.enabled !== true || record.error) continue;
    const specs = Array.isArray(record.homeCards) ? record.homeCards.slice(0, MAX_HOME_CARDS) : [];
    if (specs.length === 0) continue;
    const overrides = readOverrides(readData, record.id);
    for (const spec of specs) {
      if (!spec || typeof spec.id !== "string") continue;
      cards.push(projectCard(record, spec, overrides[spec.id]));
    }
  }
  return cards;
}

/**
 * 应用一次 `homeCardSet(cardId, patch)`：返回**新的**覆盖表（不改入参，便于调用方
 * 失败时保持原状）。
 *
 * patch 里只认 CARD_FIELDS：多余字段静默忽略（插件框架版本不同可能带新字段，
 * 不该因此整次调用失败），但一个可识别字段都没有则报错——静默成功会让插件作者
 * 以为文案已经改好了。
 */
function applyPatch(overrides, cardId, patch) {
  if (typeof cardId !== "string" || !CARD_ID_RE.test(cardId)) {
    return { ok: false, error: "homeCardSet：cardId 必须是 1-64 位字母/数字/点/下划线/连字符" };
  }
  if (!isPlainObject(patch)) {
    return { ok: false, error: "homeCardSet：patch 必须是对象（text/detail/badge）" };
  }
  const recognized = CARD_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(patch, field));
  if (recognized.length === 0) {
    return { ok: false, error: "homeCardSet：patch 至少要包含 text / detail / badge 之一" };
  }
  const next = {};
  const current = isPlainObject(overrides) ? overrides : {};
  for (const [key, value] of Object.entries(current)) {
    if (key === cardId) continue;
    next[key] = { ...value };
  }
  const entry = { ...(isPlainObject(current[cardId]) ? current[cardId] : {}) };
  for (const field of recognized) {
    const value = patch[field];
    if (typeof value !== "string") {
      return { ok: false, error: `homeCardSet：${field} 必须是字符串` };
    }
    const text = fieldValue(value);
    if (text === null) delete entry[field];
    else entry[field] = text;
  }
  if (Object.keys(entry).length > 0) next[cardId] = entry;
  const bytes = Buffer.byteLength(JSON.stringify(next), "utf8");
  if (bytes > CARD_MAX_BYTES) {
    return { ok: false, error: `homeCardSet：首页卡片数据超过 ${CARD_MAX_BYTES} 字节上限` };
  }
  return { ok: true, next };
}

module.exports = {
  CARD_KEY,
  CARD_FIELDS,
  CARD_FIELD_MAX,
  CARD_MAX_BYTES,
  MAX_HOME_CARDS,
  CARD_ID_RE,
  readOverrides,
  projectCard,
  collectCards,
  applyPatch,
};
