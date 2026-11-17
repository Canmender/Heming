/**
 * `/init` 的任务描述（d.219）。
 *
 * 为什么不把这段写在 ChatPage 里：它是一段**给模型看的规矩**，与界面无关；
 * 放在这里就能被单测直接盯住（口径变了会红），也方便以后调措辞。
 *
 * 口径：让它先读再写、必须合并而不是覆盖、篇幅封顶、不许编造。
 * 这些都来自实际踩过的坑：不读就写会写出「这个仓库里不存在的命令」，
 * 覆盖会毁掉用户手写的那份约定（而 d.174 每轮都会读它）。
 */

import { INIT_COMMAND } from "./slashCommands.js";

export const INIT_PROMPT = `请摸清这个仓库，然后写一份 AGENTS.md（给以后每一轮的我读的项目约定）。

做法：
1. 先看：用 file_glob 列出工作区根目录与主要源码目录，再 file_read 读 README、package.json、以及 2–3 个有代表性的源文件。不要一次读太多。
2. 只写「以后做任务时真的用得上」的东西：怎么构建与跑测试（真实命令）、各个目录分别装什么、代码风格与注释口径、哪些文件是生成的不许手改、有哪些坑。
3. 写到工作区根目录的 AGENTS.md：如果它已经存在，先 file_read 读一遍，在原文基础上合并——保留用户手写的内容，不要覆盖、不要重排。
4. 不超过 200 行；不要写这个仓库里没有的东西，也不要把整份 README 抄进去。
5. 写完用一句话告诉我你读了哪几个文件、AGENTS.md 现在有多少行。

注意：不要改其它任何文件；落盘会走确认流程，只写 AGENTS.md 这一个文件。`;

/** 把输入拆成「命令 + 任务描述」：命中 `/init` 时返回提示词，否则原样返回 null。 */
export function expandInitCommand(text: string): string | null {
  return text.trim() === INIT_COMMAND ? INIT_PROMPT : null;
}
