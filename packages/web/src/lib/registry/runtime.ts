/**
 * 本机运行时探测（本地包安装的前置条件，d.25）。
 *
 * ## 为什么必须探测
 * Registry 的 npm / pypi 类服务要在**用户机器上**跑 `npx` / `uvx`，而我们刻意不内置
 * 这两个运行时（内置 = 安装包 +30MB，且上游一发新版就得重打包）。于是「能不能装」
 * 不是常量和：装了跑不起来的包，用户只会在连接阶段看到一句「已保存配置，但连接失败」，
 * 完全不知道该装 Node 还是该换服务。
 *
 * ## 探测的时机
 * ★ **在 HITL 确认之前**，不是之后：让用户逐项确认一个根本跑不起来的东西没有意义，
 * 也会让「安装必问」这件事变得廉价。
 *
 * 「先探测再确认」与「安装永远要确认」是两条独立的约束，后者不因前者放松
 * （供应链决策 ≠ 工具执行）。
 *
 * 纯函数 + 一个桥读取，零 React、零 store，可单测。
 */

import { hasStdioBridge, stdioBridge } from "../mcp/stdioClient.js";
import { isInstallable } from "./map.js";
import type { InstallOption } from "./types.js";

/** 本机运行时种类。 */
export type RuntimeKey = "npm" | "pypi";

/** 主进程 `runtime:probe` 的返回值（渲染层只关心这四个字段）。 */
export interface LocalRuntimeStatus {
  platform: string;
  /** 能不能跑 npm 包（Windows 上要求 node.exe 与 npx-cli.js 都在）。 */
  npm: boolean;
  /** 能不能跑 pypi 包（uvx 或 uv 在 PATH 里）。 */
  pypi: boolean;
  /** 主进程给的整段说明，界面用作 tooltip。 */
  note: string;
}

/** 给用户的运行时名称：既要说出命令，也要说出该装什么。 */
export const RUNTIME_LABEL: Record<RuntimeKey, string> = {
  npm: "Node.js（npx）",
  pypi: "uv（uvx）",
};

/** 需要装什么才能补上这个运行时。 */
const RUNTIME_FIX: Record<RuntimeKey, string> = {
  npm: "安装 Node.js",
  pypi: "安装 uv（提供 uvx）",
};

export interface RuntimeBridgeApi {
  probe: () => Promise<unknown>;
}

/** 取桥（浏览器里没有 → undefined）。 */
export function runtimeBridge(): RuntimeBridgeApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { __heming_runtime?: RuntimeBridgeApi }).__heming_runtime;
}

/**
 * 主进程回来的东西一律当外部输入：逐字段校验，坏数据按「探测失败」处理。
 * 探测失败**不当成「运行时不存在」**——两者在界面上要说的话完全不同。
 */
function normalize(raw: unknown): LocalRuntimeStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.npm !== "boolean" || typeof r.pypi !== "boolean") return null;
  return {
    platform: typeof r.platform === "string" ? r.platform : "",
    npm: r.npm,
    pypi: r.pypi,
    note: typeof r.note === "string" ? r.note : "",
  };
}

/** 探测本机运行时。**永不抛**：拿不到就返回 null，由调用方决定怎么说。 */
export async function probeLocalRuntime(): Promise<LocalRuntimeStatus | null> {
  const bridge = runtimeBridge();
  if (!bridge || typeof bridge.probe !== "function") return null;
  try {
    return normalize(await bridge.probe());
  } catch {
    return null;
  }
}

/** 这个装法依赖本机哪个运行时；远程装法与认不出的包类型返回 null（不需要探测）。 */
export function runtimeRequirementFor(option: InstallOption): RuntimeKey | null {
  if (option.kind !== "stdio") return null;
  if (option.registryType === "npm") return "npm";
  if (option.registryType === "pypi") return "pypi";
  return null;
}

/**
 * 本机跑不了的原因（可直接展示）；`null` 表示不拦。
 *
 * `status` 为 null 时分两种情况：
 * - 浏览器环境（连 stdio 桥都没有）→ 明确说不支持，这是确定的事实；
 * - 桌面端但探测失败 → 不拦。探测失败是我们的问题，不该变成用户的安装障碍；
 *   真跑不起来时启动阶段会给出「本机未找到 …」的具体错误。
 */
export function missingRuntimeReason(
  option: InstallOption,
  status: LocalRuntimeStatus | null,
): string | null {
  const req = runtimeRequirementFor(option);
  if (!req) return null;
  if (!hasStdioBridge()) return "本地包服务需要桌面版（浏览器无法拉起本机进程）";
  if (!status) return null;
  if (status[req]) return null;
  return `本机未检测到 ${RUNTIME_LABEL[req]}。${RUNTIME_FIX[req]}后再装，或改用远程服务。`;
}

/** 综合原因：先 Registry 侧支不支持，再本机跑不跑得起来。 */
export function blockedReason(
  option: InstallOption,
  status: LocalRuntimeStatus | null,
): string | null {
  if (!isInstallable(option)) return option.unsupported ?? "该服务暂不支持安装";
  return missingRuntimeReason(option, status);
}

/** 能不能装（`blockedReason` 为空的另一种写法，便于在列表里当谓词用）。 */
export function installableWithRuntime(
  option: InstallOption,
  status: LocalRuntimeStatus | null,
): boolean {
  return blockedReason(option, status) === null;
}
