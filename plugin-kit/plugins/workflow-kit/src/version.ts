/**
 * 应用版本：从 package.json 读取，不在代码里手写。
 *
 * 为什么：`/api/health`、MCP `serverInfo.version`、外部 MCP 握手的 clientInfo
 * 都要报版本号；写死常量必然随发版漂移（自检时就发现健康检查一直报 0.1.0）。
 * 只读本机文件，不发网络。
 */
import { readFileSync } from "node:fs";

let cached: string | null = null;

/** 读项目根 package.json 的 version；读不到回退 0.0.0（不影响功能，只影响展示）。 */
export function appVersion(): string {
  if (cached) return cached;
  try {
    const url = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    cached = typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
