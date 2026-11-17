/**
 * `panel_show`：让智能体自己把右侧「会话进度」栏打开（d.245）。
 *
 * 为什么给模型这个工具：进度栏里是「这一轮走到哪、还剩几步、调了哪些工具」——
 * 这些信息用户想看的时机，模型自己最清楚：它刚写完一份多步计划、刚跑完一段漫长构建、
 * 或者正要开始几轮改动时，摊开进度栏比在正文里写「我接下来要做 A、B、C」更有用也更省字数。
 * 而右上角那个按钮，用户往往想不起来。
 *
 * 为什么风险等级是 `read`：只是打开一个只读的展示栏，不改文件、不执行命令。
 * 让「打开面板」也弹确认卡，只会让确认卡变成噪音。
 *
 * 为什么不做「关闭」：关栏是用户的动作（他不想看就关掉）。模型能开不能关，
 * 避免出现「我刚打开想看，它自己又给关了」。
 */

import type { ToolBridge } from "../agentStream.js";

/** 工具名：动作在前，与 `todo_write` / `agent_task` 的命名一致。 */
export const PANEL_TOOL = "panel_show";

/** 理由的最大长度：面板头是一行小字，太长会截断成半句。 */
export const PANEL_REASON_MAX = 80;

const DESCRIPTION = [
  "把右侧「会话进度」栏打开，让用户看到这一轮的步骤、流程图与工具调用。",
  "在你刚写好一份多步计划、正要连做几步改动、或开始一段耗时操作时调用它；",
  "单步小问答不要调用（用户不需要为此多开一栏）。",
  `可选参数 reason：一句话说明「这一栏现在值得看什么」，不超过 ${PANEL_REASON_MAX} 字。`,
].join("");

export interface PanelToolDeps {
  /** 打开面板；`reason` 已 trim、已截断，可能为空串。 */
  onOpen: (reason: string) => void;
}

/**
 * 组装 `panel_show` 的工具桥。
 *
 * 为什么 `onOpen` 由外部注入而不是在这里直接改 React state：这个模块是纯逻辑，
 * 不依赖组件；ChatPage 传进来一个把 state 打开、并记住理由的回调即可。
 */
export function buildPanelToolBridge(deps: PanelToolDeps): ToolBridge {
  return {
    tools: [
      {
        type: "function" as const,
        function: {
          name: PANEL_TOOL,
          description: DESCRIPTION,
          parameters: {
            type: "object",
            properties: {
              reason: {
                type: "string",
                description: `一句话说明为什么现在值得看进度栏（可选，≤${PANEL_REASON_MAX} 字）`,
              },
            },
          },
        },
      },
    ],
    // 只读展示，不动文件与配置：不该进确认流程（见文件头注释）。
    meta: (name) =>
      name === PANEL_TOOL ? { risk: "read" as const, displayName: "打开会话进度栏" } : undefined,
    execute: async (call) => {
      if (call.name !== PANEL_TOOL) {
        return { text: `未知工具 ${call.name}`, ok: false };
      }
      let reason = "";
      try {
        const parsed: unknown = JSON.parse(call.arguments || "{}");
        const raw = parsed && typeof parsed === "object" ? (parsed as { reason?: unknown }).reason : undefined;
        if (typeof raw === "string") reason = raw.trim().slice(0, PANEL_REASON_MAX);
      } catch {
        // 参数坏了照样打开：开栏这个动作本身不依赖参数，没必要因此失败。
        reason = "";
      }
      deps.onOpen(reason);
      return {
        text: "已打开右侧「会话进度」栏（用户可以自己关掉）。",
        ok: true,
      };
    },
  };
}

/**
 * 把 `panel_show` 包到已有工具桥外面。
 *
 * 为什么用包装而不是注册成 capability provider：面板是**当前这个 ChatPage 实例**的状态
 * （用户切页面就没了），provider 在能力注册表里拿不到组件；包装时把组件回调带进来正好。
 * 面板工具是只读，放在计划模式过滤**之内**也没关系（计划模式下照样能开进度栏）。
 */
export function withPanelTool(bridge: ToolBridge, deps: PanelToolDeps): ToolBridge {
  const panel = buildPanelToolBridge(deps);
  return {
    tools: [...bridge.tools, ...panel.tools],
    meta: (name: string) => panel.meta?.(name) ?? bridge.meta?.(name),
    execute: async (call, opts) =>
      call.name === PANEL_TOOL ? panel.execute(call, opts) : bridge.execute(call, opts),
  };
}
