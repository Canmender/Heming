# n8n 许可证事实与代码复用边界

> 调研对象：n8n（[github.com/n8n-io/n8n](https://github.com/n8n-io/n8n)），master 分支 commit `bb832f106c9c`（2026-11-03），monorepo 版本 2.46.0
> 调研方法：GitHub API 元数据、浅克隆（blobless）直接读取仓库文件、npm registry 元数据与发布 tarball 逐包核对、n8n 官方文档（docs.n8n.io）与 fair-code 官网交叉验证。取证命令见附录 A。
> 用途与免责：本文是给工程与产品决策用的技术分析，不是法律意见。涉及商业发布前，请由法务复核；如需权威解释，n8n 官方指定渠道是 `license@n8n.io` 与 `sales@n8n.io`。

---

## 1. 一句话结论

**不能直接复用 n8n 的代码，也基本不能把 n8n 的代码打包进和鸣的发行物。** n8n 主仓库自 2022-03-17 起使用 Sustainable Use License（SUL），属于 fair-code 许可（源码可见，但不是 OSI 开源许可）：它只允许"自用/内部业务用途"与"非商业用途"，禁止以收费方式分发、禁止对外提供工作流搭建能力。我们**可以**自由借鉴它的架构概念、接口语义与错误处理策略（概念不受版权保护），并在独立实现的前提下写出同类能力；**不可以**复制源码、逐行改写、或把它当作随产品分发的依赖。

---

## 2. 许可证事实表

### 2.1 仓库根

| 对象 | 事实 | 证据 |
|---|---|---|
| `LICENSE.md` | 主体是 **Sustainable Use License v1.0**（SUL），前置三条例外：① master 之外的分支内容**不授权**；② 文件名含 `.ee.` 或目录名含 `.ee` 的源码**不在 SUL 下**，需 Enterprise 许可；③ 第三方组件沿用其原始许可 | [LICENSE.md#L5-L18](https://github.com/n8n-io/n8n/blob/master/LICENSE.md#L5-L18) |
| `LICENSE_EE.md` | **n8n Enterprise License**（专有许可）。未持有效 Enterprise 许可不得用于生产环境；可用于开发测试；禁止复制/合并/发布/再许可/销售 | [LICENSE_EE.md#L1-L12](https://github.com/n8n-io/n8n/blob/master/LICENSE_EE.md#L1-L12) |
| GitHub 元数据 | GitHub 的 license 字段为 `NOASSERTION`（"Other"），**未被识别为任何 OSI 开源许可**——这正是"源码可见 ≠ 开源"的机器可读证据 | [api.github.com/repos/n8n-io/n8n](https://api.github.com/repos/n8n-io/n8n) |
| 仓库根 `package.json` | `private: true`，**没有 `license` 字段**（许可证只由 LICENSE.md 声明） | [package.json#L4](https://github.com/n8n-io/n8n/blob/master/package.json#L4) |
| 许可体系 | n8n 自称 "fair-code"，官方声明 n8n 是 fair-code 项目，SUL 是 fair-code 认可许可之一 | [README#L49-L59](https://github.com/n8n-io/n8n/blob/master/README.md#L49-L59)、[faircode.io](https://faircode.io/) |

### 2.2 子包：并非"全部同许可"，但**核心包全部是 SUL**

共 61 个 `package.json`（含根）。按 `license` 字段统计：

| 许可证 | 数量 | 说明 |
|---|---|---|
| `LicenseRef-n8n-sustainable-use` | 54 | SUL 的 SPDX 自定义引用写法，含全部核心包 |
| `MIT` | 4 | `@n8n/codemirror-lang`、`@n8n/codemirror-lang-html`、`@n8n/codemirror-lang-sql`、`@n8n/typeorm` |
| `ISC` | 1 | `@n8n/json-schema-to-zod` |
| `Apache-2.0` | 1 | `@n8n/tournament` |
| 无字段 | 1 | 仓库根（private） |

**与"能不能复用"直接相关的关键包（全部 SUL，不是 Apache-2.0 / 不是 MIT）：**

| 包 | npm 名 | 许可证 | 证据 |
|---|---|---|---|
| `packages/workflow` | `n8n-workflow` | `LicenseRef-n8n-sustainable-use` | [packages/workflow/package.json#L105](https://github.com/n8n-io/n8n/blob/master/packages/workflow/package.json#L105) |
| `packages/core` | `n8n-core` | `LicenseRef-n8n-sustainable-use` | [packages/core/package.json#L103](https://github.com/n8n-io/n8n/blob/master/packages/core/package.json#L103) |
| `packages/nodes-base` | `n8n-nodes-base` | `LicenseRef-n8n-sustainable-use` | [packages/nodes-base/package.json#L1048](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/package.json#L1048) |
| `packages/cli` | `n8n` | `LicenseRef-n8n-sustainable-use` | [packages/cli/package.json#L304](https://github.com/n8n-io/n8n/blob/master/packages/cli/package.json#L304) |
| `packages/@n8n/engine` | `@n8n/engine`（执行引擎 v2） | `LicenseRef-n8n-sustainable-use` | [README](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/engine/README.md) |
| `packages/@n8n/expression-runtime` | `@n8n/expression-runtime`（隔离表达式运行时） | `LicenseRef-n8n-sustainable-use` | [README](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/expression-runtime/README.md) |
| `packages/@n8n/task-runner` | `@n8n/task-runner`（Code 节点沙箱） | `LicenseRef-n8n-sustainable-use` | [package.json](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/task-runner/package.json) |
| `packages/@n8n/scheduler` | `@n8n/scheduler`（持久化调度器） | `LicenseRef-n8n-sustainable-use` | [README](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/scheduler/README.md) |

**确实不是 SUL 的包（源码层面可用的"宽松许可孤岛"）：**

| 包 | 许可证 | 仓库内证据 | 备注 |
|---|---|---|---|
| `@n8n/tournament` | Apache-2.0 | [package.json#L39](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/tournament/package.json#L39) + [LICENSE.md](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/tournament/LICENSE.md) | 表达式模板引擎（用于表达式解析），若需参考其解析算法，这是唯一许可宽松的核心相关包 |
| `@n8n/typeorm` | MIT | [package.json#L5](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/typeorm/package.json#L5) + [LICENSE](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/typeorm/LICENSE) | TypeORM 的 fork（上游本就 MIT） |
| `@n8n/json-schema-to-zod` | ISC | [package.json#L58](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/json-schema-to-zod/package.json#L58) + [LICENSE](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/json-schema-to-zod/LICENSE) | 上游 Stefan Terdell 的 ISC 许可 |
| `@n8n/codemirror-lang`、`-html`、`-sql` | MIT | [package.json#L6](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/codemirror-lang/package.json#L6) + LICENSE | CodeMirror 6 语言支持 fork，上游 MIT |
| `@n8n/extension-sdk` | SUL（不算孤岛） | 其 `LICENSE` 文件只有一行："See LICENSE.md in the root of this repository" | 容易被误当作独立许可，实际是 SUL |

另有无 `license` 字段但标 `private` 的内部包（`@n8n/eslint-config`、`@n8n/oxlint-config`、`@n8n/stylelint-config`、`@n8n/module-cli`、`@n8n/mcp-browser-extension`、`n8n-node-dev` 等），不发布到 npm，对复用无意义。

### 2.3 npm 包与仓库声明：**不一致，且是个陷阱**

| 检查项 | 结果 |
|---|---|
| `npm view n8n-workflow license` | `SEE LICENSE IN LICENSE.md`（**不是合法 SPDX id**，也不是 Apache/MIT） |
| `npm view n8n-workflow dist-tags` | `latest: 2.16.0`、`stable: 2.45.4`、`beta: 2.46.4`、`rc: 3.0.1` |
| 发布 tarball 内容（`n8n-workflow@2.16.0`） | 包含 `package/LICENSE.md`（**SUL 全文**）与 `package/LICENSE_EE.md` |
| `npm view @n8n/tournament license` | `SEE LICENSE IN LICENSE.md` —— **但仓库内该包是 Apache-2.0** |
| `@n8n/tournament@1.15.0` tarball | 内含 `LICENSE.md` 为 **SUL 全文**，`LICENSE.md` 里没有任何 Apache 字样；仓库里那份 Apache-2.0 文本没有被发布 |
| `@n8n/codemirror-lang@0.13.0`、`@n8n/json-schema-to-zod@1.18.0` tarball | 同样被塞入根 `LICENSE.md`（SUL）+ `LICENSE_EE.md`，`license` 字段同样被改写成 `SEE LICENSE IN LICENSE.md`；`json-schema-to-zod` 甚至同时带了自家 ISC 的 `LICENSE` 与 SUL 的 `LICENSE.md`，两份互相矛盾 |

结论：**npm 元数据不能作为授权依据**。n8n 的发布流水线会把根许可文件复制进每个包并改写 `license` 字段，导致即使源码是 MIT/Apache-2.0 的包，发布物也在法律上呈现为 SUL。对 `n8n-workflow` 来说结论没有争议（源码与发布物都是 SUL）；对 `@n8n/tournament` 这类包，若要依赖它，必须按"最严格解释"处理（视为 SUL），或直接找 n8n 书面确认 Apache-2.0 的适用范围。

### 2.4 许可证历史：**n8n 从来没有做过 OSI 开源许可**

| 时间 | 事件 | 证据 |
|---|---|---|
| 2019-06-23（首次提交） | 首版 `LICENSE` 即 **Apache 2.0 + Commons Clause**（Licensor: Jan Oberhauser）。Commons Clause 禁止 "Sell"：不得向第三方收费提供"价值主要来源于该软件"的产品或服务 | [首个 commit](https://github.com/n8n-io/n8n/commit/9cb9804eeec1576d935817ecda6bd345480b97fa) |
| 2022-03-17 | 提交 `521cf51e7c`：**从 Apache-2.0 + Commons Clause 切换为 Sustainable Use License**（PR #2932） | [PR #2932](https://github.com/n8n-io/n8n/pull/2932) |
| 2022-03-20 | **首个包含 SUL 的 npm 发布 = `n8n@0.169.0`**；`n8n@0.168.0`（2022-03-14 发布）仍是 Commons Clause | npm publish 时间；`packages/workflow/LICENSE.md` 在 `n8n@0.168.0` 首行为 Commons Clause，在 `n8n@0.169.0` 首行为 `# Sustainable Use License` |
| 2022-08-29 | 提交 `3939d52851`：引入 **n8n Enterprise License**（PR #3945），`.ee.` 文件脱离 SUL | [PR #3945](https://github.com/n8n-io/n8n/pull/3945) |
| 2022-10-26 | 提交 `d1b4d428cb`：把 SUL **限定到 master 分支内容**（PR #4450），非主分支内容不再授权 | [PR #4450](https://github.com/n8n-io/n8n/pull/4450) |
| 2024-04-27 | 提交 `442aaba116`：进一步说明 SUL 的适用范围（PR #9233） | [PR #9233](https://github.com/n8n-io/n8n/pull/9233) |

官方文档对此有明确表述："n8n was licensed under Apache 2.0 with Commons Clause until 17 March 2022"，并解释了切换原因（Commons Clause 措辞模糊、且限制咨询与支持服务等）。见 [License FAQ](https://docs.n8n.io/n8n-community-license/community-license/license-faq)。

**"旧版本能不能复用"的准确答案：** 能拿到的是 `n8n@0.168.0` 及更早版本，许可为 **Apache-2.0 + Commons Clause**（不是纯 Apache-2.0，更不是 MIT）。它允许复制、修改、再分发并保留归属声明，但 Commons Clause 禁止"收费销售价值主要来源于该软件的产品/服务"。也就是说：免费分发 + 主要价值不来自 n8n 的嵌入场景，旧版本比 SUL 宽松；但**收费产品里"卖 n8n 能力本身"依然不行**。此外旧版本代码停留在 2022 年，安全与功能上都不现实。

### 2.5 三个最容易踩的陷阱（先记住这三条）

1. **根许可不是开源许可，而且带"分支/文件级"例外**：master 之外分支内容**完全不授权**（[LICENSE.md#L5](https://github.com/n8n-io/n8n/blob/master/LICENSE.md#L5)），`.ee.` 文件不在 SUL 内（[LICENSE.md#L6-L10](https://github.com/n8n-io/n8n/blob/master/LICENSE.md#L6-L10)）。从 n8n 的 PR、feature 分支、或 `.ee.` 文件里取代码，连"内部自用"的授权都没有。
2. **`n8n-workflow` / `n8n-core` 从来不是 Apache-2.0 或 MIT**：2019 年起就是 Apache-2.0 + Commons Clause，2022-03-17 起是 SUL。网上大量"n8n-workflow 是 Apache-2.0，可以随便用"的说法是错的；npm 上的 `SEE LICENSE IN LICENSE.md` 也不是宽松信号，而是"去看那个 SUL 文件"。
3. **"用户看不到 n8n UI"不等于合规**：官方 FAQ 明确把"SaaS 产品内嵌工作流搭建器（即使用户看不到 n8n）"列为不允许，判据是**谁控制工作流逻辑**，而不是界面是否可见。见 [License FAQ](https://docs.n8n.io/n8n-community-license/community-license/license-faq)。

---

## 3. SUL 条款逐条白话解释

原文全部来自 [LICENSE.md#L16-L88](https://github.com/n8n-io/n8n/blob/master/LICENSE.md#L16-L88)。

### 3.1 版权授权（Copyright License）—— 给了什么

| 原文要点 | 白话 | 判定 |
|---|---|---|
| 授予非独占、免版税、全球、**不可再许可、不可转让**的许可，可"使用、复制、分发、向他人提供、创作衍生作品" | 表面上权利很宽（甚至包含分发），但每一项都受下面的限制条款约束 | 允许（受限制） |

### 3.2 限制（Limitations）—— 三条硬约束

| 原文 | 白话 | 判定 |
|---|---|---|
| "You may use or modify the software only for your own internal business purposes or for non-commercial or personal use." | 只能用于**自己的内部业务**，或非商业/个人用途 | **需要条件**：内部自用 OK；"帮客户做"要看是否算内部业务（官方 FAQ 给了细化口径） |
| "You may distribute the software or provide it to others only if you do so free of charge for non-commercial purposes." | 只有**免费且非商业目的**才能分发或提供给他人 | **需要条件**：仅"免费 + 非商业"可分发；收费分发被禁止，商业目的的免费分发属高风险 |
| "You may not alter, remove, or obscure any licensing, copyright, or other notices..." + 商标使用受法律约束 | 不得删改任何许可/版权声明；不得用 n8n 商标 | **需要条件**：保留声明、不白标 |

官方对 "internal business purpose" 的细化定义（这是最关键的一条解释）：**"在组织内部或产品中使用 n8n，且组织外部的人可以接收或看到你的工作流产出的内容"** —— 也就是说，"外部能看到产出"本身不构成越界，越界的判据是**外部的人能不能自己搭建/配置工作流**。见 [License FAQ](https://docs.n8n.io/n8n-community-license/community-license/license-faq)。

官方 FAQ 的"可以 / 不可以"清单（原文并列，直接决定我们的场景判断）：

| 允许（Community 许可下免费） | 禁止 |
|---|---|
| 用 n8n 支撑自己的业务运营 | 把 n8n 当作服务托管，让客户在上面搭工作流 |
| 个人项目、学习、研究 | 让外部终端用户通过你的产品搭建/配置自己的工作流（无论走自研 UI、n8n API、MCP，还是 AI 代理代为操作） |
| 在自己的实例上为客户构建自动化，**前提是客户不能创建或编辑它们** | Fork n8n 代码去做自己的自动化产品 |
| 向客户收"工作流搭建/配置/维护"服务费、培训与咨询费 | 去掉 n8n 品牌、白标后原样提供 |
| 在自有产品背后静默使用 n8n（用户只能触发/使用你搭好的自动化，甚至可以接入他们自己的账号） | 使用需要 license key 的企业功能而没有 Enterprise 许可 |
| 运行多个 n8n 实例 | — |

### 3.3 专利（Patents）

| 原文要点 | 白话 | 判定 |
|---|---|---|
| 授予以 SUL 为条件的专利许可；**不覆盖**你通过修改/新增而导致的专利侵权；你或你公司对 n8n 发起专利诉讼，专利许可立即终止 | 别起诉 n8n，否则专利授权即时失效 | 需要条件 |

### 3.4 声明（Notices）

| 原文 | 白话 | 判定 |
|---|---|---|
| "You must ensure that anyone who gets a copy of any part of the software from you also gets a copy of these terms." | 你把软件给别人，必须同时给出这份条款 | **需要条件**：附 SUL 全文 |
| "If you modify the software, you must include in any modified copies ... a prominent notice stating that you have modified the software." | 改了就要在修改版里**显著注明"已修改"** | **需要条件**：显著修改声明 |

### 3.5 终止（Termination）与免责

| 原文要点 | 白话 | 判定 |
|---|---|---|
| 违约使用 = 未获授权，许可自动终止；收到通知后 30 天内停止违约可**追溯恢复**；恢复后再违约则**永久终止** | 有 30 天整改窗口，但别赌第二次 | 严厉 |
| 无担保、不承担任何损害赔偿 | 出事自己扛 | — |

### 3.6 定义（Definitions）

| 原文 | 白话 | 判定 |
|---|---|---|
| "Your company" 包含你所在法律实体及其控制/被控制/共同控制的全部组织 | 集团内多主体一并计算，"换家公司用"没用 | 注意 |
| "software" = licensor 在该条款下提供的软件，**包括其任何部分** | 拆出一个包、一段代码、一个文件，仍然受 SUL 约束 | 关键 |

---

## 4. 对和鸣的三种场景判断

前提：和鸣是 Electron 桌面端智能体平台（`packages/desktop`、`web`、`server`、`shared`、`infohub`），当前定位为内部自用，未来可能商业分发。以下判断针对"把 n8n 以某种形式卷进和鸣"。

### 场景 A：纯内部自用（推荐基线）

**用法**：公司/团队内部部署或由和鸣后端静默调用 n8n，用来跑我们自己的自动化；和鸣的用户（内部员工或外部客户）**不搭建工作流**，只消费结果。

**结论：允许，不构成许可风险。**
依据：SUL "Limitations" 第一条——"for your own internal business purposes"。官方 FAQ 亦明确"用 n8n 支撑自己的业务运营"免费可用；"在自有产品背后静默使用 n8n（用户只触发预建工作流）"也在允许清单里。

**合规清单**：
- 不修改 n8n 源码直接用自托管实例，最干净；
- 若修改（打补丁/换 UI 文案以外的东西），在修改版里显著注明"已修改"，并随附 SUL 全文；
- 不使用需要 license key 的企业功能（`.ee.` 文件、SSO、Environments、外部存储等）；
- 不把 n8n 品牌用于对外宣传；不白标对外宣称自研引擎；
- 内部文档写清"n8n 为外部依赖，SUL，未修改/已修改"。

**注意**：即使是内部自用，也**不建议把 n8n 代码 vendor 进和鸣仓库**——一旦仓库将来要开源或对外分发构建产物，历史提交里的 SUL 代码会污染整个分发链。

### 场景 B：免费公开分发（高风险，默认否决）

**用法**：和鸣开源，或发布免费桌面版，构建里包含 n8n 代码（哪怕只是 `n8n-workflow` 的一个子功能）。

**结论：默认不可行，应否决。**
依据：
1. 打包进发行物 = "distribute the software or provide it to others"。SUL 只允许"免费且非商业目的"的分发。
2. 和鸣即使免费，若属于公司商业产品的一部分（引流、付费增值、企业版），是否满足"non-commercial purposes"存在实质争议；n8n 的 FAQ 判据是"谁的商业利益被服务"，而不是"是否收费"。
3. 更直接的禁令：官方 FAQ 明确"Fork n8n's code to launch your own automation product"属于禁止行为。把 SUL 代码嵌进一个自动化/智能体产品并对外分发，正落在这条上。

**若确有必要走这条路**：唯一合规姿势是拿到 n8n 的书面商业许可（见场景 C 的协议路径），而不是靠"免费"来豁免。

### 场景 C：商业分发 / SaaS（需要商业协议）

**用法**：和鸣作为付费产品销售，或对客户提供托管服务。

**结论：在包含 n8n 代码、或对外提供工作流构建能力时，必须有 n8n 的商业协议；否则禁止。**

按接触面细分：

| 接触面 | 是否需要协议 | 依据 |
|---|---|---|
| 发行物里**包含** n8n 代码（桌面安装包、Docker 镜像、npm 依赖打进 bundle） | **需要**（distribution for commercial purposes 被禁） | [LICENSE.md#L32-L35](https://github.com/n8n-io/n8n/blob/master/LICENSE.md#L32-L35) |
| 我们的**后端**静默调用自建 n8n 实例，终端用户不能搭建/配置工作流，且产品价值主要不来自 n8n | **不需要**（在允许清单内） | [License FAQ](https://docs.n8n.io/n8n-community-license/community-license/license-faq)、[OEM 页](https://docs.n8n.io/deploy/host-n8n/deploy-as-an-oem-integration) |
| 用户在我们的界面里**搭建自己的工作流**（自研画布、n8n 当后端） | **需要**（"embedded workflow builder" 明确列为禁止；判据是谁控制工作流逻辑，不是 UI 是否可见） | [License FAQ](https://docs.n8n.io/n8n-community-license/community-license/license-faq) |
| 把 n8n **编辑器界面**嵌进和鸣 UI 里 | **需要 OEM 商业协议**，且必须保留 n8n 品牌 | [Deploy as an OEM integration](https://docs.n8n.io/deploy/host-n8n/deploy-as-an-oem-integration) |
| 产品价值"完全或主要"来自 n8n 的自动化能力（卖的就是"自动化能力"） | **需要**（"automation-as-a-service" 反例） | [License FAQ](https://docs.n8n.io/n8n-community-license/community-license/license-faq) |

**给和鸣的取舍建议**：如果未来要做"用户自己编排智能体/工作流"的功能，**不要**把 n8n 放在这个功能身后——那正好命中 SUL 的核心禁区，而且会让产品叙事("我们的编排能力")与许可事实冲突。这类功能应完全自研（见第 5 节 A/B 路线）。n8n 只适合放在"我们自己运维的、用户看不见的后台"位置。

---

## 5. 推荐做法

### A) 概念与架构借鉴（安全）

**安全**。著作权保护的是表达，不是思想、方法、流程、系统设计。可以自由学习并使用以下内容，无需任何许可：

- 执行模型：主实例负责触发/计时、worker 负责执行、Redis 队列解耦（queue mode）；
- 数据模型概念：workflow / node / connection / execution / run data 的划分；
- 错误处理模型：Error Trigger + 工作流级 error workflow + 结构化错误上下文（`execution`/`workflow`/`trigger` 三块）；
- 表达式模型：`{{ }}` 模板 + 内置函数 + 受限 JS 沙箱；
- 运维概念：执行数据保留策略（按年龄/条数修剪 + 软删缓冲）、并发上限、外部存储卸载、多主模式；
- 产品边界概念：Community / 付费版的 gating 方式。

**唯一需要守的规矩**：不要照着 n8n 的源码结构去"等价摆放"我们的类与函数。以官方文档描述的**行为语义**为准（文档就是给外部读者看的，引用它是安全的），不要把源码当规格书逐文件翻译。

### B) 语义移植 + 独立实现（清室重写）（安全，但需注明来源与许可）

**安全，前提是"独立实现"而不是"逐行改写"。**

- 可以做：读完文档后，用我们自己的类型体系重新设计，实现同等行为（例如"执行失败时触发一个专门的处理流程，并传入结构化错误上下文"）。
- 需要警惕：**逐行改写、改语言转写、仅改变量名的搬运，在法律上仍可能构成演绎作品**，仍受 SUL 约束。我们这次调研已经读过 n8n 源码（浅克隆），所以严格的 clean-room（从未见过原码的实现者）在我们这里并不成立——实现时必须刻意脱离源码结构，按我们自己的领域模型写。
- 需要在文档注明：来源（n8n 项目 + 具体文档页 URL + 我们读过的版本/commit）、许可（SUL 1.0）、我们做了什么（仅借鉴概念/语义，未复制代码）、结论（本实现不受 SUL 约束）。
- 常见误区：认为"改了 30% 就不算复制"、"换个语言重写就没事"——都不成立。判据是表达是否实质相似。

### C) 直接复制代码（在极窄条件下可接受）

| 情形 | 判定 |
|---|---|
| 复制 `.ee.` 文件或目录（含 `.ee.`） | **不可接受**。连 SUL 都不覆盖，必须持 Enterprise 许可（[LICENSE.md#L6-L10](https://github.com/n8n-io/n8n/blob/master/LICENSE.md#L6-L10)） |
| 复制 master 之外分支（PR、feature 分支、dev 分支）的代码 | **不可接受**。该内容"not licensed"（[LICENSE.md#L5](https://github.com/n8n-io/n8n/blob/master/LICENSE.md#L5)） |
| 复制主仓库 SUL 代码进和鸣并随产品分发 | **不可接受**（除非拿到商业协议）。分发限制 + "不得删改声明" |
| 复制主仓库 SUL 代码仅用于内部工具、且不出仓库 | 技术上被 SUL 允许（内部业务用途），但**不建议**：会污染仓库历史、影响将来开源/分发，收益远小于风险 |
| 复制 `@n8n/tournament`（Apache-2.0）或 `@n8n/typeorm`（MIT）等宽松包 | 源码层面**可以**（保留版权与许可声明、Apache-2.0 需附 NOTICE），但注意发布物 tarball 里的许可文本与之冲突（见 2.3），商用前需书面确认 |
| 复制 n8n 的**文档文字** | 不建议。文档也随仓库受 SUL 约束；我们只应转述事实，不整段翻译搬运 |

### D) 引入为依赖（是否可行）

| 用法 | 判定 | 说明 |
|---|---|---|
| 内部构建脚本 / 内部工具里 `npm i n8n-workflow`，产物不对外 | **可行** | SUL 允许内部业务用途；随包保留 LICENSE 文本；锁版本 |
| 和鸣桌面端 / 服务端 bundle 里打包 `n8n-workflow` 或 `n8n-core` 并对外发行 | **不可行** | 属于收费/商业目的的分发；且 SUL 明确"software 包括其任何部分" |
| 自托管 n8n 作为**服务**（不打包进和鸣），和鸣后端通过 webhook/API 触发预建工作流 | **可行**（场景 A/C 的"静默后端"位置） | 前提：和鸣用户不能搭建/配置工作流；产品价值不主要来自 n8n；n8n 实例由我们运维 |
| 依赖 `@n8n/tournament`（Apache-2.0）做表达式解析 | **有条件可行** | 优先使用上游 `tournament`/`codemirror` 等原始 MIT/Apache 包，绕开 n8n fork 的许可歧义 |
| 长期依赖 n8n 的 API 契约（节点类型、webhook 格式） | **谨慎** | 不是许可问题而是工程锁定问题：n8n 迭代快（monorepo 2.46.0，`n8n` npm latest 2.45.7，`n8n-workflow` 的 `rc` 已到 3.0.1），接口可能变 |

### 本项目应采用的策略（建议直接采纳）

1. **不 vendor、不打包、不复制**：和鸣仓库里不出现任何 n8n 源码；`node_modules` 里也不引入 SUL 包进分发链。
2. **能力自研，概念借鉴**：工作流/智能体编排能力按我们自己的领域模型实现；借鉴 queue mode、error workflow、执行数据修剪、表达式沙箱这四类**概念**。
3. **如果短期必须用 n8n 提效，只走"自托管后台服务"路线**：独立部署、和鸣后端单向调用、用户不可见、不进发行物；在部署文档里写明这是外部 SUL 依赖。
4. **商业版本规划时，把"用户可自建工作流"划为禁入与 n8n 相关的功能**；该功能若要做，必须完全自研。
5. **留痕**：凡借鉴过的文档页，在对应设计文档里登记（用下面的模板），形成可审计的来源清单。这既是合规需要，也是将来对方主张"你们抄我们"时最有力的反证。

### 「来源与许可」声明模板（可直接抄进规格文档）

```markdown
## 来源与许可

本能力的**设计思路**参考了 n8n 项目的公开文档，**未使用其源代码**。

- 参考项目：n8n（https://github.com/n8n-io/n8n），调研版本 monorepo 2.46.0，commit bb832f106c9c（2026-11-03）
- 参考页面：
  - <主题一>：https://docs.n8n.io/...
  - <主题二>：https://docs.n8n.io/...
- 对方许可证：Sustainable Use License 1.0（https://github.com/n8n-io/n8n/blob/master/LICENSE.md）。该许可**不授予**我们复制其代码、或在商业产品中分发其代码的权利。
- 我们的实现方式：独立实现。仅借鉴不受版权保护的概念、接口语义与行为约定（例如"执行失败触发独立处理流程并携带结构化错误上下文"），未复制、未逐行改写其源码。
- 许可证影响：本实现为和鸣自有代码，按本仓库许可证发布，不受 SUL 约束。
- 记录人 / 日期：<姓名> / <YYYY-MM-DD>
```

CHANGELOG / 版本说明用的短版本：

```markdown
- 新增 <能力名>：独立实现。设计参考 n8n 公开文档（<页面链接>），未使用其代码；n8n 采用 Sustainable Use License 1.0，不适用于本实现。
```

反向声明（当我们在文档里**明确不使用**某方案时，也值得写一句，避免后来者误引）：

```markdown
- 明确排除：本模块不引入 n8n 源码或其 npm 包。原因：n8n 自 2022-03-17 起采用 Sustainable Use License 1.0，仅允许内部自用与非商业分发，商业分发与对外提供工作流搭建能力均需单独商业协议。
```

---

## 6. n8n 能力与架构要点表

标注说明：**概念可学** = 可直接借鉴设计思想（不受版权保护）；**实现可参考** = 实现细节值得读、但要独立编写，不得逐行改写；**仅概念** = 实现与 n8n 强绑定（数据模型/协议/企业功能），只学思路不要照搬。

| # | 主题 | 要点 | 官方文档 | 我们怎么用 |
|---|---|---|---|---|
| 1 | 运行模式与 queue mode | 主实例只负责触发与计时（webhook/timer），把 execution ID 投进 Redis 队列（Bull），worker 从队列取任务、从 DB 读 workflow、执行后写回结果并通知主实例；worker 可横向增删；不支持 queue mode + 文件系统二进制存储；需要共享 encryption key | [Enable queue mode](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/enable-queue-mode) | **概念可学**：和鸣若做服务端编排，这套"控制面/执行面分离 + 队列解耦"是最值得抄的架构 |
| 2 | Workers 与并发控制 | worker 进程可设 `--concurrency`；普通模式用 `N8N_CONCURRENCY_PRODUCTION_LIMIT` 限制生产执行并发，超限 FIFO 排队；并发限制只对 webhook/trigger 触发的生产执行生效，不适用手动/子流程/错误流程 | [Control concurrency](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/control-concurrency) | **概念可学**：并发预算按"执行来源"分类，而不是全局一刀切 |
| 3 | 执行数据（execution data） | 可选择只存失败执行、不存成功执行、不存逐节点进度、不存手动执行；修剪按年龄（默认 336h）与条数（默认 10000）双条件，先软删后硬删，带 1h 安全缓冲；`new/running/waiting` 不修剪、被标注的执行永不修剪 | [Manage execution data](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/manage-execution-data) | **概念可学**：和鸣的会话/轨迹留存可直接套用"双阈值 + 软删缓冲 + 保护标记"策略 |
| 4 | 二进制/外部存储 | 大对象可外置 S3（兼容 R2/B2 但官方不背书）；该能力在自托管属 Business/Enterprise 付费功能，无有效 license 时 `s3` 模式直接拒绝启动 | [Use external storage](https://docs.n8n.io/deploy/host-n8n/configure-n8n/scaling/use-external-storage) | **仅概念**：外置存储的思路可用，具体实现与付费边界无关 |
| 5 | 错误处理与错误工作流 | 每个工作流可指定一个 error workflow；失败时触发，必须以 **Error Trigger** 节点开头；收到结构化错误上下文（`execution.id/url/retryOf/error.message/stack/lastNodeExecuted/mode` + `workflow.id/name`）；若失败发生在触发器节点本身，则上下文换成 `trigger.*`（含 `WorkflowActivationError`）；可用 Stop And Error 节点主动制造失败 | [Handle errors gracefully](https://docs.n8n.io/build/flow-logic/handle-errors-gracefully) | **实现可参考**：错误上下文的字段划分（执行/工作流/触发源三段）是很成熟的设计，值得借鉴字段而非代码 |
| 6 | 执行与编排语义 | 执行分 manual / production；分支执行顺序在 1.0 前后不同（旧：逐层推进；新：按画布位置逐分支完成）；子流程会把父子执行关联；支持执行数据 pinning 便于调试；可对执行数据脱敏 | [Understand executions](https://docs.n8n.io/build/understand-workflows/understand-executions)、[Understand execution order](https://docs.n8n.io/build/flow-logic/understand-execution-order) | **概念可学**：分支执行顺序必须是**显式定义并有版本号**的语义，否则升级即破坏兼容——这是我们自己设计时要提前定死的东西 |
| 7 | 表达式与沙箱 | 表达式是运行时求值的 JS 片段，可出现在任意节点参数里；三种引擎：`vm`（V8 isolate，默认）、`quickjs`（WASM 沙箱，浏览器端推荐）、`legacy`（无隔离，计划废弃）；双端独立配置（后端 `N8N_EXPRESSION_ENGINE`、编辑器 `N8N_EXPRESSION_ENGINE_FRONTEND`）；隔离实现基于 `isolated-vm`，带 isolate 池与表达式缓存 | [Expression engine](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/expression-engine)、[Code in n8n](https://docs.n8n.io/build/code-in-n8n) | **实现可参考**：和鸣已有"AI 生成代码/表达式"场景，沙箱隔离 + isolate 池 + 缓存是必须自己实现的，思路可学，代码不可抄 |
| 8 | 持久化调度器 | 不把定时器放内存：先把"即将发生的运行"写进共享存储，再由任意节点认领执行；用 claim/lease/recovery 逼近"恰好一次"，重启不丢、多副本不重复 | [@n8n/scheduler README](https://github.com/n8n-io/n8n/blob/master/packages/@n8n/scheduler/README.md) | **概念可学**：这是"桌面端 + 云端并存"场景下定时任务的关键设计，强烈建议借鉴思路 |
| 9 | 版本与升级 | 官方建议高频升级（至少每月）、升级前看 release notes 的破坏性变更、用 Environments 先建测试实例验证；`n8n` npm 当前 latest 2.45.7，monorepo 2.46.0；`n8n-workflow` 的 `rc` dist-tag 已到 3.0.1 | [Update n8n](https://docs.n8n.io/deploy/host-n8n/keep-n8n-running/update-n8n) | **概念可学**：与和鸣自己的 5 段版本号/升级策略对照（见 docs/VERSION-MANAGEMENT.md），注意 n8n 2.x→3.0 的破坏性变更 |
| 10 | 版本边界（Community / Registered / Business / Enterprise） | Community 免费但不含：自定义变量、Environments、外部密钥、二进制外置存储、日志流式外发、multi-main、Projects、SSO、共享、Git 版本控制；注册邮箱免费解锁 folders / debug in editor / 自定义执行数据；Business/Enterprise 用 license key 解锁 | [Compare editions](https://docs.n8n.io/deploy/host-n8n/community-edition-features) | **仅概念**：值得学的是"免费版给到 80% 功能 + 少数运维/治理功能收费"的切分方式，而不是具体清单 |
| 11 | 与产品集成的三种姿势 | ① 后端静默调用（webhook/API 触发预建流程，用户看不到 UI）——标准许可即可；② OEM 嵌入（把 n8n 编辑器嵌进你的 UI，用户自己搭流程）——需单独 OEM 商业协议且必须保留 n8n 品牌；③ 官方明确区分的"产品价值主要来自 n8n"的自动化即服务——需商业协议 | [Deploy as an OEM integration](https://docs.n8n.io/deploy/host-n8n/deploy-as-an-oem-integration) | **必读**：这是判断我们"能不能用 n8n 当引擎"的分界线 |
| 12 | 架构文档现状 | 官方"How n8n works"页明确写着 "This section is a work in progress"（目前是空壳），架构细节基本只能从源码与运维文档反推 | [Understand the architecture](https://docs.n8n.io/deploy/host-n8n/understand-the-architecture) / [How n8n works](https://docs.n8n.io/deploy/host-n8n/understand-the-architecture/how-n8n-works) | **提示**：不要指望官方架构文档；我们自己的架构文档反而应该比它更完整 |

**目录层面的概念地图**（读源码时只看形状，不抄实现）：`packages/workflow` 工作流模型与表达式求值、`packages/core` 执行引擎与凭证、`packages/cli` 服务端（REST/认证/队列/许可）、`packages/nodes-base` 节点库、`packages/@n8n/engine` 执行引擎 v2（目前是脚手架）、`packages/@n8n/expression-runtime` 隔离表达式运行时、`packages/@n8n/task-runner` Code 节点沙箱、`packages/@n8n/scheduler` 持久化调度器、`packages/@n8n/db` ORM 封装、`packages/@n8n/config` 配置系统。

---

## 附录 A：取证方法（可复现）

```bash
# 1) 仓库元数据（看 GitHub 如何认定许可证）
curl -s https://api.github.com/repos/n8n-io/n8n | jq '{license, default_branch, pushed_at}'
# -> license.key = "other", spdx_id = "NOASSERTION"

# 2) 只拉树、不拉 blob 的浅克隆（几秒钟，几百 KB）
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/n8n-io/n8n.git n8n-src
cd n8n-src

# 3) 列出所有 LICENSE 文件
git ls-tree -r --name-only HEAD | grep -iE '(^|/)LICEN[SC]E'

# 4) 逐个读取 package.json 的 license 字段（61 个）
#    统计结果：54 × LicenseRef-n8n-sustainable-use、4 × MIT、1 × ISC、1 × Apache-2.0、1 × 无字段

# 5) LICENSE.md 的修改历史（确认切换时间点）
curl -s "https://api.github.com/repos/n8n-io/n8n/commits?path=LICENSE.md&per_page=30"
# -> 2022-03-17 521cf51e7c  :scroll: Change to the Sustainable Use License #2932

# 6) 定位首个包含 SUL 的发布版本
for t in 0.168.0 0.169.0 0.170.0; do
  curl -s "https://raw.githubusercontent.com/n8n-io/n8n/n8n@$t/packages/workflow/LICENSE.md" | head -1
done
# -> 0.168.0: “Commons Clause” License Condition v1.0
# -> 0.169.0: # Sustainable Use License

# 7) npm 元数据 vs 发布物实际内容
npm view n8n-workflow license dist-tags        # -> SEE LICENSE IN LICENSE.md
npm pack n8n-workflow@2.16.0 && tar -tzf n8n-workflow-2.16.0.tgz | grep LICENSE
```

文档侧取证：`docs.n8n.io` 的每个页面在 URL 后加 `.md` 即可取到 Markdown 原文（例如 [license-faq.md](https://docs.n8n.io/n8n-community-license/community-license/license-faq.md)），全部来源已在上文逐条给出链接。

## 附录 B：需要法务/对方确认的开放问题

1. `@n8n/tournament` 等包的仓库声明（Apache-2.0 / MIT / ISC）与 npm 发布物（SUL 全文 + `SEE LICENSE IN LICENSE.md`）冲突，实际授权以哪份为准？若我们要用它，需要 n8n 书面确认。
2. "内部业务用途"在**集团多主体**（"your company" 定义含共同控制实体）下的边界：和鸣团队与将来的商业实体是否被视为同一 "your company"。
3. 若和鸣长期把 n8n 放在"自托管后台服务"位置，当和鸣商业价值越来越依赖自动化能力时，何时会跨过"value derives entirely or substantially from n8n"的界线——建议在功能规划阶段就设红线，而不是等争议发生。
4. 旧版本（≤ 0.168.0，Apache-2.0 + Commons Clause）在"免费但商业运营"的分发场景下是否可用：Commons Clause 的 "Sell" 定义与"substantially derives"判定需要法务给结论；本文的工程建议是不使用该路径。
