/**
 * Webhook 触发：由本机 HTTP 请求触发工作流。
 *
 * 为什么复用现有 HTTP 服务而不是再起一个端口：插件服务本来就监听回环地址，
 * 多一个端口只会增加用户配置负担与防火墙问题。Webhook 路由统一在 `/webhook/<路径>`，
 * 由服务端按「已启用（active）的工作流 + 匹配的路径与方法」找到触发器节点并启动执行。
 *
 * 安全边界：
 * - 只监听 127.0.0.1（与其余接口一致），不对外网开放；
 * - 默认路径 = 工作流 id（不可猜的 uuid）；可自定义更短路径；
 * - 可选访问令牌：填了之后必须带 `x-webhook-token` 头或 `?token=`；
 * - 只有 active=true 的工作流会响应，停用即视为不存在（避免信息泄露）。
 */

import type { INodeType } from "../../types.js";
import { inputItems } from "./helpers.js";

export const WEBHOOK_METHODS = ["POST", "GET", "PUT", "PATCH", "DELETE"] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];

export const webhookTrigger: INodeType = {
  description: {
    type: "webhookTrigger",
    displayName: "Webhook 触发",
    group: "trigger",
    description: "由本机 HTTP 请求触发：请求体作为数据输入；地址 /webhook/<路径>。",
    icon: "webhook",
    inputs: 0,
    outputs: 1,
    isTrigger: true,
    trigger: "webhook",
    version: 1,
    properties: [
      {
        name: "path",
        displayName: "路径",
        type: "string",
        default: "",
        placeholder: "留空 = 工作流 id",
        description: "小写字母/数字/-，1–64 字符；完整地址是 /webhook/<路径>。留空时用工作流 id。",
      },
      {
        name: "method",
        displayName: "方法",
        type: "options",
        default: "POST",
        options: WEBHOOK_METHODS.map((method) => ({ name: method, value: method })),
      },
      {
        name: "authToken",
        displayName: "访问令牌",
        type: "string",
        default: "",
        description: "可选。填了之后请求必须带 x-webhook-token 头或 ?token=，否则 401。",
      },
      {
        name: "notice",
        displayName: "说明",
        type: "notice",
        default: "",
        description:
          "示例：curl -X POST http://127.0.0.1:8777/webhook/<路径> -H 'content-type: application/json' -d '{\"a\":1}'。只有「启用」的工作流会响应。",
      },
    ],
  },

  async execute(context) {
    const items = inputItems(context);
    return { main: [items.length > 0 ? items : [{ json: {} }]] };
  },
};
