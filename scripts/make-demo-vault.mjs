#!/usr/bin/env node
/**
 * 生成一个**确定性的演示 vault**，用于知识库的手工验收与回归。
 *
 * 为什么需要：知识库的验收点里有一半只能在真实文件系统上看出来——
 * 代码块里的 `[[假链接]]` 不能被当成真链接、同名文件要判歧义、
 * 中文标题与 `.canvas`/图片要能正常渲染、`.obsidian/` 不能被扫描。
 * 用一个可复现的夹具，避免每次手搓笔记（也避免「这次刚好没测到那条」）。
 *
 * 用法：
 *   node scripts/make-demo-vault.mjs                 # 生成到 ~/Heming/demo-vault
 *   node scripts/make-demo-vault.mjs D:/tmp/vault    # 指定目录
 *   node scripts/make-demo-vault.mjs --force         # 覆盖已存在的同名文件
 *
 * 只写这一个目录，不碰任何既有 vault。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const force = args.includes("--force");
const target = args.find((a) => !a.startsWith("--")) ?? path.join(os.homedir(), "Heming", "demo-vault");

const files = {
  "README.md": `---
tags: [说明]
---
# 演示知识库

这是 \`scripts/make-demo-vault.mjs\` 生成的夹具，用来验证和鸣知识库：

- 双链：[[实体/和鸣]]、[[概念/记忆召回]]
- 别名链接：[[概念/记忆召回|记忆是怎么召回的呢]]
- 锚点链接：[[概念/记忆召回#三层记忆]]
- 嵌入：![[附件/模型图.png]]
- 未解析链接：[[还没写的页面]]
- 标签：#演示 #构建/知识库
`,

  "实体/和鸣.md": `---
aliases: [Heming, 和鸣平台]
tags: [产品, 桌面端]
---
# 和鸣

原生桌面端智能体平台。核心红线：

1. 智能体本地驱动；
2. 云端只负责名册与动向摘要；
3. 个人数据不出设备。

相关：[[概念/记忆召回]]、[[概念/能力内核]]
`,

  "概念/记忆召回.md": `---
tags: [记忆, 机制]
---
# 记忆召回

## 三层记忆

工作层 / 情景层 / 语义层。召回时按主题相似度 + 时效 + 个性化权重排序。

## 预算

注入预算 1200 字，超出的条目标注「被预算挤掉」。

## 关联

- 知识库条目在 d.114 之后也参与召回：[[实体/和鸣]]
- 反链应该出现在这里：被 [[概念/能力内核]] 提到
`,

  "概念/能力内核.md": `---
tags: [机制, 工具]
aliases: [capability kernel]
---
# 能力内核

工具从「手工拼桥」变成「注册表」：mcp → charts → tone → wiki → self。
和 [[概念/记忆召回]] 一样，都属于不改变用户可见面、但改变内部结构的改造。
`,

  "概念/同名页.md": `# 同名页（根目录）

故意与 \`子目录/同名页.md\` 同名，用来验证「链接歧义」提示。
`,

  "子目录/同名页.md": `# 同名页（子目录）

同样叫「同名页」，指向它的 [[同名页]] 必须被判为歧义。
`,

  "笔记/代码块里的链接.md": `# 代码块里的链接

下面这些**不是**链接，解析器必须跳过：

\`\`\`markdown
[[实体/和鸣]]
[[概念/记忆召回#三层记忆]]
\`\`\`

行内代码 \`[[概念/记忆召回]]\` 也不算。

真正的链接只有一个：[[实体/和鸣]]
`,

  "笔记/表格与任务.md": `# 表格与任务

| 项 | 状态 |
|---|---|
| 多库 | 完成 |
| 反链 | 完成 |

- [x] 解析 frontmatter
- [ ] Canvas 编辑（第二轮）

标签在正文里：#演示 #任务
`,

  "inbox/.keep": "",
  "inbox/memory-称呼-20261108.md": `---
source: heming-memory
key: 称呼
createdAt: 2026-11-08
---
用户希望被称为「老师」。
`,

  "附件/模型图.png": null, // 下面单独写二进制
  "画布/流程.canvas": JSON.stringify(
    {
      nodes: [
        { id: "a", type: "text", text: "输入笔记", x: 0, y: 0, width: 200, height: 60 },
        { id: "b", type: "text", text: "建立索引", x: 300, y: 0, width: 200, height: 60 },
        { id: "c", type: "text", text: "参与召回", x: 600, y: 0, width: 200, height: 60 },
      ],
      edges: [
        { id: "e1", fromNode: "a", toNode: "b" },
        { id: "e2", fromNode: "b", toNode: "c" },
      ],
    },
    null,
    2,
  ),

  // 必须被忽略：Obsidian 自己的配置与隐藏目录
  ".obsidian/app.json": "{}\n",
  ".obsidian/workspace.json": "{}\n",

  // 必须被忽略：不支持的类型
  "附件/脚本.sh": "#!/bin/sh\necho hi\n",
};

/** 1×1 透明 PNG（确定性字节，不依赖外部资源）。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let written = 0;
let skipped = 0;

for (const [rel, content] of Object.entries(files)) {
  const abs = path.join(target, rel);
  if (fs.existsSync(abs) && !force) {
    skipped += 1;
    continue;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (content === null) fs.writeFileSync(abs, PNG);
  else fs.writeFileSync(abs, content, "utf8");
  written += 1;
}

console.log(`演示库：${target}`);
console.log(`写入 ${written} 个文件${skipped ? `，跳过 ${skipped} 个已存在（--force 覆盖）` : ""}`);
console.log("验收要点：");
console.log("  1. 代码块与行内代码里的 [[链接]] 不该出现在反链/图谱里");
console.log("  2. 两个「同名页」应被标为歧义，而不是静默选一个");
console.log("  3. .obsidian/ 与 .sh 文件不应出现在文件树");
console.log("  4. 中文标题、别名、锚点、图片嵌入、.canvas 都要能正常展示");
