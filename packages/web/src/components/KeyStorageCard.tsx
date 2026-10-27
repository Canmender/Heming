import type { SVGProps } from "react";
import { secureStorageStatus } from "../lib/secureStorage.js";

/** 三个受保护键的中文名：状态提示要能点名，不能只说「部分密钥」。 */
const KEY_LABELS: Record<string, string> = {
  "heming.llmConfigs": "模型连接密钥",
  "heming.mcp.servers.v1": "MCP 服务请求头",
  "heming.e2e.identity": "设备身份私钥",
};

function labelOf(key: string): string {
  return KEY_LABELS[key] ?? key;
}

/** 系统安全存储的名字：文案要说清楚密钥交给了谁。 */
function platformStorageName(): string {
  const platform = typeof window !== "undefined" ? window.heming?.platform : undefined;
  if (platform === "win32") return "Windows DPAPI";
  if (platform === "darwin") return "macOS 钥匙串";
  return "系统密钥环";
}

function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/**
 * 设置区 · 密钥存储状态（d.36）。
 *
 * 文案是**承诺的边界**：只覆盖三把钥匙，不写成「所有数据都已加密」。
 * 承诺错的地方比不承诺更糟——用户会据此决定把什么交给这个应用。
 */
export function KeyStorageCard() {
  const status = secureStorageStatus();
  const plaintext = status.plaintextKeys.map(labelOf);
  const undecryptable = status.undecryptableKeys.map(labelOf);

  let mainLine: string;
  let tone = "text-muted";
  if (!status.desktop) {
    mainLine = "浏览器端不落安全存储，密钥明文保存在浏览器本地";
  } else if (!status.available) {
    // 不可用时磁盘上可能既有明文、也有解不开的旧密文；文案必须只说「新写入」，
    // 否则会和下面「密文仍在、本机解不开」的提示自相矛盾。
    mainLine = "注意：本机安全存储不可用，新写入的密钥将以明文保存";
    if (plaintext.length > 0) mainLine += `（当前以明文保存：${plaintext.join("、")}）`;
    tone = "text-amber-700";
  } else if (plaintext.length > 0) {
    mainLine = `注意：以下密钥未能加密，以明文保存：${plaintext.join("、")}`;
    tone = "text-amber-700";
  } else {
    mainLine = `密钥已用系统安全存储加密（${platformStorageName()}）`;
  }

  return (
    <section
      aria-label="密钥存储"
      className="mt-3 max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card"
    >
      <div className="flex items-center gap-1.5 text-[12px] font-bold text-[#777]">
        <LockIcon className="text-[#999]" />
        密钥存储
      </div>
      <div className={`mt-1 text-[11px] ${tone}`}>{mainLine}</div>
      <div className="mt-1 text-[11px] text-muted">
        覆盖模型 Key、MCP 请求头与设备身份私钥；消息明文缓存与加密链状态尚未加密（后续单独处理）。
      </div>
      {undecryptable.length > 0 && (
        <div className="mt-1 text-[11px] text-amber-700">
          以下密钥无法在本机解密（密文仍在，可能来自其他设备或系统账户）：
          {undecryptable.join("、")}
        </div>
      )}
    </section>
  );
}
