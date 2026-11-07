/**
 * 集成节点注册入口。
 *
 * 先注册「通用集成」（日期/加密/XML），再注册「和鸣能力」（大模型/归档/通知）：
 * 注册顺序即调色板顺序，用户先看到通用能力，再看到和鸣专属能力。
 */

import { registerNodeType } from "../../registry.js";
import { cryptoNode } from "./crypto.js";
import { dateTimeNode } from "./dateTime.js";
import { integrationNodes } from "./harmony.js";
import { xmlNode } from "./xml.js";

/** 注册全部集成节点；重复注册会因 registry 查重而抛错（只该被 registerAllNodes 调一次）。 */
export function registerIntegrationNodes(): void {
  registerNodeType(dateTimeNode);
  registerNodeType(cryptoNode);
  registerNodeType(xmlNode);
  for (const node of integrationNodes) registerNodeType(node);
}
