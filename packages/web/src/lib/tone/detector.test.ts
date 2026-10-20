import { describe, it, expect } from "vitest";
import {
  detectAiTone,
  detectWhenClauses,
  runToneDetect,
  TONE_RULES,
  NOT_A_TELLS,
} from "./detector.js";

/** 命中了某条规则？ */
function hasRule(text: string, rule: number): boolean {
  return detectAiTone(text).hits.some((h) => h.rule === rule);
}

describe("去 AI 味检测器", () => {
  it("规则 1：识别翻案腔的已知句式", () => {
    expect(hasRule("真正的壁垒不是技术，而是认知。", 1)).toBe(true);
    expect(hasRule("这并非一个工具的问题，而是一个思维方式的问题。", 1)).toBe(true);
    expect(hasRule("与其说他在努力，不如说他没在努力。", 1)).toBe(true);
    expect(hasRule("表面上是效率问题，实际是分工问题。", 1)).toBe(true);
    // 跨逗号也算：上游说的「表面…实际…」本就是跨分句形态
    expect(hasRule("表面看起来是效率问题，实际上是分工问题。", 1)).toBe(true);
  });

  it("规则 1：普通陈述不误报", () => {
    expect(hasRule("这个方案的优点是实现简单，缺点是扩展性差。", 1)).toBe(false);
  });

  it("规则 2：顿号串三项以上要报，两项不报", () => {
    expect(hasRule("采集、存储、展示，三件事一起做。", 2)).toBe(true);
    expect(hasRule("他买了苹果，然后走了。", 2)).toBe(false);
  });

  it("规则 4：破折号要报", () => {
    expect(hasRule("答案其实很简单——专注。", 4)).toBe(true);
  });

  it("规则 5：提示语引出的冒号要报，句中冒号不报", () => {
    expect(hasRule("一句话总结：这个方案成本太高。", 5)).toBe(true);
    expect(hasRule("核心是：先解决支付失败的问题。", 5)).toBe(true);
    expect(hasRule("人擅长的是：判断业务逻辑。", 5)).toBe(false);
  });

  it("规则 6：小标题序数词连续三个才报", () => {
    const three = "## 一、先写\n\n正文\n\n## 二、再写\n\n正文\n\n## 三、后写";
    expect(hasRule(three, 6)).toBe(true);
    const two = "## 一、先写\n\n正文\n\n## 二、再写";
    expect(hasRule(two, 6)).toBe(false);
  });

  it("规则 7：拟人化喻体要报，具体的人当喻体不报", () => {
    expect(hasRule("它就像一位智慧的导师，不仅传授结论，更传授看待世界的多元视角。", 7)).toBe(true);
    // 具体的人当喻体是人类的写法，不该报
    expect(hasRule("他像一个老师傅，手上功夫很稳。", 7)).toBe(false);
  });

  it("规则 9：禁用起手式要报", () => {
    expect(hasRule("说白了，这个项目没有足够的预算。", 9)).toBe(true);
    expect(hasRule("先说结论，这个方案能省钱。", 9)).toBe(true);
    // 不带逗号的「说穿了…」是正常句子，不是起手式
    expect(hasRule("说穿了这个现象背后的机制。", 9)).toBe(false);
  });

  it("规则 10：五种翻译腔要报，其余不报", () => {
    expect(hasRule("当所有人都能用 AI 写文章时，内容本身就不再是竞争优势。", 10)).toBe(true);
    expect(hasRule("对于早期团队来说，招人是最难的事。", 10)).toBe(true);
    expect(hasRule("然而，这个方案并不适用于所有场景。", 10)).toBe(true);
    expect(hasRule("留存率涨到了 72%。这意味着产品找到了 PMF。", 10)).toBe(true);
    // 被动句、名词化、抽象被动：人类同样这么写，不该报
    expect(hasRule("这个问题被认为很重要。", 10)).toBe(false);
    expect(hasRule("团队进行了组织架构的调整。", 10)).toBe(false);
  });

  it("规则 11：段首零回指评论要报，有回指词的不报", () => {
    expect(hasRule("听起来像一条功能描述，其实底下换掉了一样更根本的东西。", 11)).toBe(true);
    // 有「这」回指上文 → 不该报
    expect(hasRule("这听起来像一条功能描述，其实底下换掉了一样更根本的东西。", 11)).toBe(false);
  });

  it("规则 8：概括表述盖住同段已有的具体数据才报", () => {
    expect(hasRule("新系统实现了效率的提升。处理时间从两小时缩短到四十分钟。", 8)).toBe(true);
    // 原文确实只有概括、没有具体材料 → 不该报
    expect(hasRule("团队完成了对流程的优化。", 8)).toBe(false);
  });

  it("【重要】不查的：比喻、正文设问、句长参差、句内排比", () => {
    // 比喻：人类用得比 AI 多（2.4 倍），不该报
    expect(hasRule("时间像一位沉默的保管员，替我们收好那些被忽略的细节。", 7)).toBe(false);
    // 正文设问：人类是 AI 的 17 倍，不该报
    expect(hasRule("这样真的好吗？我也在问自己这个问题。", 11)).toBe(false);
    // 句内同构排比：人类用得不比 AI 少，不该报（规则 3 只管句间重复）
    expect(hasRule("提升效率，降低成本，优化体验。", 3)).toBe(false);
  });

  it("干净文本不报任何规则", () => {
    const clean = "他今天下午去了趟超市，买了牛奶和面包。回来路上顺手取了个快递。";
    const report = detectAiTone(clean);
    expect(report.hits).toHaveLength(0);
    expect(report.verdict).toBe("clean");
  });

  it("报告按规则分组并给出行号", () => {
    const text = "第一行正常。\n\n答案其实很简单——专注。\n\n第三行也正常。";
    const report = detectAiTone(text);
    expect(report.byRule[4]).toBe(1);
    const hit = report.hits.find((h) => h.rule === 4);
    expect(hit?.line).toBe(2);
  });

  it("报告里给出密度与判定", () => {
    const report = detectAiTone("答案其实很简单——专注。说白了，这是对的。");
    expect(report.chars).toBeGreaterThan(0);
    expect(report.perKilo).toBeGreaterThan(0);
    expect(["clean", "some", "many"]).toContain(report.verdict);
  });

  it("「当…时」单独检测可用", () => {
    const hits = detectWhenClauses("当所有人都能用 AI 写文章时，内容就不再是优势。");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].rule).toBe(10);
  });

  it("空文本与超长文本不崩", () => {
    expect(() => detectAiTone("")).not.toThrow();
    expect(detectAiTone("").hits).toHaveLength(0);
    expect(() => detectAiTone("字".repeat(300_000))).not.toThrow();
  });
});

describe("工具输出", () => {
  it("干净文本明确说「不要改写」", () => {
    const out = runToneDetect("他今天下午去了趟超市，买了牛奶和面包。");
    expect(out).toContain("不要改写");
  });

  it("有命中时列出规则编号、位置与改写要求", () => {
    const out = runToneDetect("答案其实很简单——专注。");
    expect(out).toContain("第 4 条");
    expect(out).toContain("逐字保留");
    expect(out).toContain("自检");
  });

  it("超长文本给出明确提示而不是抛异常", () => {
    const out = runToneDetect("字".repeat(200_001));
    expect(out).toContain("不合法");
  });
});

describe("元数据", () => {
  it("11 条规则都有名字", () => {
    for (let i = 1; i <= 11; i++) {
      expect(TONE_RULES[i]).toBeTruthy();
    }
  });

  it("排除表覆盖流行但站不住的判断", () => {
    const features = NOT_A_TELLS.map((x) => x.feature).join(" ");
    expect(features).toContain("比喻");
    expect(features).toContain("设问");
    expect(features).toContain("句长");
  });
});
