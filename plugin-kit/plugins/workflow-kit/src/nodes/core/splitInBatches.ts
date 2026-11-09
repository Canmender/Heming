/**
 * 分批循环（Split In Batches）：每运行一次输出一批，跑完了再从「完成」口收尾。
 *
 * 输出口 0（循环）：本批数据，通常连回自己的输入形成回环；
 * 输出口 1（完成）：全部数据都处理完之后走这里（带原始全部数据，便于收尾汇总）。
 *
 * 「当前处理到第几批」用 `context.runIndex` 推出来，而不是记在 staticData 里：
 * - runIndex 是引擎对同一节点第几次运行的无状态计数，天然跟回环次数对齐；
 * - 不落盘、不需要 reset，回环被中止也不会留下「下次从哪里继续」的脏状态。
 * 代价是它假设「同一节点的运行次数单调递增」，这与引擎执行栈的运行次数语义一致。
 */

import type { INodeType } from "../../types.js";
import { clampBatchSize, inputItems, readNumber } from "./helpers.js";

export const splitInBatchesNode: INodeType = {
  description: {
    type: "splitInBatches",
    displayName: "分批循环",
    group: "flow",
    description: "把数据按批处理：循环口每次输出一批，全部处理完后从完成口输出。",
    icon: "repeat",
    inputs: 1,
    outputs: 2,
    outputNames: ["循环", "完成"],
    version: 1,
    properties: [
      {
        name: "batchSize",
        displayName: "每批条数",
        type: "number",
        default: 10,
        description: "每次循环处理多少条数据。",
      },
      {
        name: "notice",
        displayName: "用法",
        type: "notice",
        default: "",
        description: "把「循环」输出接回本节点输入形成回环；循环体跑完后从「完成」继续。",
      },
    ],
  },

  async execute(context) {
    const items = inputItems(context);
    const batchSize = clampBatchSize(readNumber(context, "batchSize", 10));
    const start = context.runIndex * batchSize;
    if (start >= items.length) {
      // 全部批次已发完：循环口空、完成口带全部数据。
      return { main: [[], items] };
    }
    return { main: [items.slice(start, start + batchSize), []] };
  },
};
