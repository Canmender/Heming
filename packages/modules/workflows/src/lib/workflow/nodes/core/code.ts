/**
 * 代码（Code）：在本机 Web Worker 沙箱里跑一小段 JS，用来做内置节点覆盖不到的数据变换。
 *
 * 安全边界（CONTRACT 红线 3）：节点**不执行**任何代码，只调用宿主注入的
 * `context.helpers.runUserCode`（Web Worker 沙箱，无网络/文件/存储入口）。
 * 没有注入沙箱时宁可报错，也不偷偷退回 `eval`/`new Function`——那等于绕过沙箱。
 *
 * 两种运行方式：
 * - 一次性处理全部 items（默认）：代码拿到全部输入，返回数组/对象/`{json}` 数组；
 * - 逐项处理：对每条 item 调一次，返回该条的新数据（返回空则保留一条空 item，
 *   避免「其中一条返回 undefined 就整条丢失」这种难以发现的行为差异）。
 */

import type { INodeType, Item } from "../../types";
import {
  clampInteger,
  errorText,
  inputItems,
  normalizeToItems,
  readNumber,
  readOption,
  readString,
  WorkflowNodeError,
} from "./helpers";

export const CODE_MODES = ["runOnceForAllItems", "runOnceForEachItem"] as const;
export type CodeMode = (typeof CODE_MODES)[number];

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 120_000;

const DEFAULT_CODE = `// 输入数据：$input.all() / $json / items（以实际沙箱注入为准）
// 返回值：数组、单个对象，或 { json: … } 数组
return $input.all().map((item) => ({ json: item.json }));`;

export const codeNode: INodeType = {
  description: {
    type: "code",
    displayName: "代码",
    group: "action",
    description: "在本机沙箱里运行一小段 JS 做数据变换；不能访问网络、文件与页面存储。",
    icon: "code",
    inputs: 1,
    outputs: 1,
    version: 1,
    properties: [
      {
        name: "mode",
        displayName: "运行方式",
        type: "options",
        default: "runOnceForAllItems",
        description: "一次性处理全部数据，还是对每条数据单独执行一次代码。",
        options: [
          { name: "全部数据一次处理", value: "runOnceForAllItems" },
          { name: "逐条处理", value: "runOnceForEachItem" },
        ],
      },
      {
        name: "code",
        displayName: "代码",
        type: "code",
        default: DEFAULT_CODE,
        rows: 12,
        required: true,
        description: "返回数组/对象即可作为输出；语法错误或超时会让节点失败。",
      },
      {
        name: "timeoutMs",
        displayName: "超时（毫秒）",
        type: "number",
        default: DEFAULT_TIMEOUT_MS,
        description: `单次执行的超时，${MIN_TIMEOUT_MS}–${MAX_TIMEOUT_MS} 毫秒。`,
      },
    ],
  },

  async execute(context) {
    const runner = context.helpers.runUserCode;
    if (!runner) {
      throw new WorkflowNodeError("代码运行器未注入", {
        description: "代码节点需要宿主在 helpers.runUserCode 上注入 Web Worker 沙箱实现。",
      });
    }
    const code = readString(context, "code", "");
    if (!code.trim()) {
      throw new WorkflowNodeError("代码节点没有可执行的代码");
    }
    const mode = readOption<CodeMode>(context, "mode", CODE_MODES, "runOnceForAllItems");
    const timeoutMs = clampInteger(
      readNumber(context, "timeoutMs", DEFAULT_TIMEOUT_MS),
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    const items = inputItems(context);

    if (mode === "runOnceForEachItem") {
      const output: Item[] = [];
      for (let index = 0; index < items.length; index += 1) {
        let result: unknown;
        try {
          result = await runner({
            code,
            mode,
            items,
            itemIndex: index,
            timeoutMs,
            signal: context.abortSignal,
          });
        } catch (error) {
          throw wrapCodeError(error, index);
        }
        const normalized = normalizeToItems(result);
        // 逐条模式下返回空值保留一条空 item：条数与输入对齐，下游不会少处理一条。
        output.push(...(normalized.length > 0 ? normalized : [{ json: {} }]));
      }
      return { main: [output] };
    }

    let result: unknown;
    try {
      result = await runner({
        code,
        mode,
        items,
        timeoutMs,
        signal: context.abortSignal,
      });
    } catch (error) {
      throw wrapCodeError(error);
    }
    return { main: [normalizeToItems(result)] };
  },
};

function wrapCodeError(error: unknown, itemIndex?: number): WorkflowNodeError {
  if (error instanceof WorkflowNodeError) return error;
  return new WorkflowNodeError(`代码执行失败：${errorText(error)}`, {
    itemIndex,
    description: "检查代码语法、返回值形状，或是否访问了沙箱里不存在的全局对象。",
    cause: error,
  });
}
