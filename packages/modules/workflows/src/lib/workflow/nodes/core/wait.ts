/**
 * 等待（Wait）：在本次执行内暂停一段时间再继续。
 *
 * v1 的等待是**内存等待**：走 `helpers.sleep`（可被取消），不写盘、不跨重启。
 * 所以这里对超过单次执行上限（WORKFLOW_LIMITS.maxExecutionMs）的等待直接报错——
 * 引擎到点会中止整条执行，让用户以为「节点卡住了」，不如在节点上给出明确原因。
 */

import type { INodeType } from "../../types";
import { WORKFLOW_LIMITS } from "../../types";
import { errorText, inputItems, readNumber, readOption, WorkflowNodeError } from "./helpers";

const UNITS = ["seconds", "minutes", "hours", "days"] as const;
type WaitUnit = (typeof UNITS)[number];

const UNIT_MS: Record<WaitUnit, number> = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

export const waitNode: INodeType = {
  description: {
    type: "wait",
    displayName: "等待",
    group: "flow",
    description: "在本次执行内暂停一段时间后继续；可被「停止」取消。",
    icon: "clock",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "amount",
        displayName: "时长",
        type: "number",
        default: 1,
        description: "等待多久，配合下面的单位。",
      },
      {
        name: "unit",
        displayName: "单位",
        type: "options",
        default: "seconds",
        options: [
          { name: "秒", value: "seconds" },
          { name: "分钟", value: "minutes" },
          { name: "小时", value: "hours" },
          { name: "天", value: "days" },
        ],
      },
    ],
  },

  async execute(context) {
    const amount = readNumber(context, "amount", 1);
    const unit = readOption<WaitUnit>(context, "unit", UNITS, "seconds");
    if (!Number.isFinite(amount) || amount < 0) {
      throw new WorkflowNodeError("等待时长必须是不小于 0 的数字");
    }
    const millis = Math.round(amount * UNIT_MS[unit]);
    if (!Number.isFinite(millis)) {
      throw new WorkflowNodeError("等待时长超出可计算范围");
    }
    if (millis > WORKFLOW_LIMITS.maxExecutionMs) {
      throw new WorkflowNodeError("等待时长超过单次执行上限", {
        description: `单次执行最长 ${Math.round(WORKFLOW_LIMITS.maxExecutionMs / 60_000)} 分钟；更长的等待请拆成多次定时触发。`,
      });
    }
    context.emitProgress?.(`等待 ${millis} 毫秒`);
    try {
      await context.helpers.sleep(millis, context.abortSignal);
    } catch (error) {
      // 取消不是节点错误：把原始信息交给引擎判取消；这里补一句可读说明即可。
      throw new WorkflowNodeError(`等待被中断：${errorText(error)}`, { cause: error });
    }
    return { main: [inputItems(context)] };
  },
};
