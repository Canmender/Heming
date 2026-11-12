"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CARD_KEY,
  CARD_MAX_BYTES,
  readOverrides,
  projectCard,
  collectCards,
  applyPatch,
} = require("./home-cards");

/** 一条清单里声明了首页卡片的记录（宿主投影不需要其余字段）。 */
function record(overrides = {}) {
  return {
    id: "acme.plugin",
    name: "示例插件",
    version: "1.0.0",
    enabled: true,
    homeCards: [
      {
        id: "brief",
        title: "今日简报",
        summary: "每天 8 点汇总",
        icon: "assets/brief.png",
        page: "plugin:acme.plugin",
        primary: "等待第一次汇总",
      },
    ],
    ...overrides,
  };
}

test("projectCard：清单 primary 作为初始文案，覆盖值优先且字段都是 string", () => {
  const spec = record().homeCards[0];
  const base = projectCard(record(), spec, null);
  assert.deepEqual(base, {
    pluginId: "acme.plugin",
    pluginName: "示例插件",
    id: "brief",
    title: "今日简报",
    summary: "每天 8 点汇总",
    icon: "assets/brief.png",
    page: "plugin:acme.plugin",
    text: "等待第一次汇总",
    detail: "",
    badge: "",
  });

  const covered = projectCard(record(), spec, { text: "3 条待办", badge: "3" });
  assert.equal(covered.text, "3 条待办");
  assert.equal(covered.badge, "3");
  assert.equal(covered.detail, "");
});

test("projectCard：插件名缺省回落到 id，page 缺省补 plugin:<id>", () => {
  const card = projectCard(
    { id: "acme.plugin", name: "", enabled: true },
    { id: "brief", title: "简报", primary: "" },
    null,
  );
  assert.equal(card.pluginName, "acme.plugin");
  assert.equal(card.page, "plugin:acme.plugin");
  assert.equal(card.text, "");
});

test("readOverrides：读不到/坏 JSON/非法字段一律当没有覆盖（首页不能整块空掉）", () => {
  assert.deepEqual(readOverrides(() => null, "acme.plugin"), {});
  assert.deepEqual(
    readOverrides(() => {
      throw new Error("磁盘坏了");
    }, "acme.plugin"),
    {},
  );
  assert.deepEqual(readOverrides(() => ["不是对象"], "acme.plugin"), {});
  assert.deepEqual(
    readOverrides(
      () => ({
        brief: { text: "  有效文案  ", detail: 42, extra: "忽略" },
        "bad id!": { text: "非法 cardId" },
        empty: { text: "   " },
      }),
      "acme.plugin",
    ),
    { brief: { text: "有效文案" } },
  );
});

test("collectCards：只收已安装+启用+文件完好的插件，并按覆盖表合并", () => {
  const overrides = { brief: { text: "3 条待办" } };
  const readData = (id, key) => {
    assert.equal(key, CARD_KEY);
    return id === "acme.plugin" ? overrides : null;
  };
  const cards = collectCards(
    [
      record(),
      record({ id: "acme.disabled", enabled: false }),
      record({ id: "acme.broken", error: "插件文件缺失，请重新安装" }),
      { id: "acme.empty", name: "空", enabled: true, homeCards: [] },
    ],
    readData,
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].pluginId, "acme.plugin");
  assert.equal(cards[0].text, "3 条待办");
});

test("collectCards：单插件卡片数量按清单上限截断（防止首页被一个插件刷屏）", () => {
  const many = Array.from({ length: 12 }, (_value, index) => ({
    id: `card-${index}`,
    title: `卡片 ${index}`,
    primary: "",
  }));
  const cards = collectCards([record({ homeCards: many })], () => null);
  assert.equal(cards.length, 8);
});

test("applyPatch：写覆盖值、空串清除、未知字段忽略", () => {
  const first = applyPatch({}, "brief", { text: "3 条待办", badge: "3", unknown: "忽略" });
  assert.equal(first.ok, true);
  assert.deepEqual(first.next, { brief: { text: "3 条待办", badge: "3" } });

  const cleared = applyPatch(first.next, "brief", { badge: "" });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.next, { brief: { text: "3 条待办" } });

  // 纯未知字段：报错而不是静默成功（插件作者会以为文案改好了）
  const unknown = applyPatch({}, "brief", { unknown: "x" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /至少要包含/);
});

test("applyPatch：cardId / patch / 字段类型 / 体积都有硬校验", () => {
  assert.equal(applyPatch({}, "", { text: "x" }).ok, false);
  assert.equal(applyPatch({}, "bad id!", { text: "x" }).ok, false);
  assert.equal(applyPatch({}, "brief", null).ok, false);
  assert.equal(applyPatch({}, "brief", { text: 42 }).ok, false);

  // 单字段 200 字上限：超长截断，不报错（展示字段的合理降级）
  const long = applyPatch({}, "brief", { text: "字".repeat(400) });
  assert.equal(long.ok, true);
  assert.equal(long.next.brief.text.length, 200);

  // 总量上限：4 张卡 × 3 字段 × 200 字 ≈ 2.4KB > 2KB
  const big = {};
  for (let index = 0; index < 4; index += 1) {
    big[`card-${index}`] = {
      text: "字".repeat(200),
      detail: "字".repeat(200),
      badge: "字".repeat(200),
    };
  }
  const overflow = applyPatch(big, "brief", { text: "追加" });
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, new RegExp(`超过 ${CARD_MAX_BYTES} 字节`));
});

test("applyPatch：不改入参（写盘失败时调用方保持原状）", () => {
  const current = { brief: { text: "旧" } };
  const result = applyPatch(current, "brief", { text: "新" });
  assert.equal(result.ok, true);
  assert.equal(current.brief.text, "旧");
  assert.equal(result.next.brief.text, "新");
});
