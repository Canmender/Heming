import type { PluginManifest } from "./manifest.js";

/**
 * 插件清单的**内容指纹**（d.66）。
 *
 * ★ 诚实边界：这是「内容指纹」，用于发现「上一次装的内容和这次不一样」
 *   （例如同 id、同版本，但技能指令/权限/服务地址被人悄悄改过）。
 *   **它不是密码学签名**：不证明来源、不证明作者身份，也没有密钥参与；
 *   能改清单的人同样能重算指纹。要证明来源必须引入签名与分发链（密钥管理、
 *   信任锚、吊销机制），本轮不建，另立规格再做。
 *
 * 只覆盖**清单语义字段**（id/version/name/description/author/permissions/contributions）；
 * 安装时间、记录 id 等运行时字段不参与——它们不随清单内容变化。
 */

/** FNV-1a 64 位的两个常量（第一轮）。 */
const FNV_OFFSET_A = 0xcbf29ce484222325n;
const FNV_PRIME_A = 0x100000001b3n;
/**
 * 第二轮换一组 offset/prime：单轮 FNV 的碰撞可以被构造，
 * 两轮用不同常量混合能抬高「随手改一个字符碰撞不变」的概率——
 * 但这依然只是校验和级别的防护，不是安全边界（见文件头）。
 *
 * ★ 必须强制奇数（`| 1n`）：XOR 出来的 prime 末位可能是 0，偶数乘数在每一轮
 *   都会把状态整体左移（丢低位），跑过几十个字符后第二轮输出就只与**文本末尾**
 *   有关——d.64.2.23.0 首版正是这个 bug：同长度不同内容的后 8 位指纹完全相同。
 *   d.64.2.24.0 修正为奇数，并把前缀升到 `fnv1a64b:`，旧值读取时按新算法重算。
 */
const FNV_OFFSET_B = 0x84222325cbf29ce4n;
const FNV_PRIME_B = (0x100000001b3n ^ 0x9e3779b97f4a7c15n) | 1n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(text: string, offset: bigint, prime: bigint): bigint {
  let hash = offset & MASK64;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & MASK64;
  }
  return hash;
}

/** 递归规范化为「键排序、无 undefined」的普通值（数组顺序保留）。 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) out[key] = stableValue(item);
    }
    return out;
  }
  return value;
}

/**
 * 通用规范化 JSON 文本：键排序、无空白、丢弃 `undefined`（数组顺序保留）。
 *
 * 内容指纹与清单签名（`signature.ts`）必须共用同一套规范化，否则
 * 「本机验签」与「`scripts/sign-plugin.mjs` 签名」会各算一份文本、互相不认。
 */
export function canonicalJsonText(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

/**
 * 规范化清单文本：键排序 + 无空白的稳定 JSON。
 *
 * 只挑语义字段重排，而不是对 `PluginManifest` 整体序列化：
 * 以后给记录加运行时字段（安装来源、上次检查时间等）不会改变指纹。
 * 对象键顺序、空白与末尾换行都不影响结果（安装弹窗粘贴同一份清单的不同排版 = 同一指纹）。
 */
export function canonicalManifestText(manifest: PluginManifest): string {
  return canonicalJsonText({
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    author: manifest.author,
    permissions: manifest.permissions,
    contributions: manifest.contributions,
    // v5 起把 engines/meta 纳入内容指纹（否则「同版本只改 engines 或上架元数据」
    // 不会触发指纹变化，安装预览发现不了内容被改）。v1–v4 没有这两个字段，
    // canonicalJsonText 会丢弃 undefined → 旧包指纹逐字节不变（现有测试钉住了这点）。
    engines: manifest.engines,
    meta: manifest.meta,
  });
}

/**
 * 内容指纹：两轮 FNV-1a 各取低 32 位拼成 16 hex，第二轮 offset 混入文本长度。
 *
 * 形如 `fnv1a64b:8f3a1c02d9b4e765`（`b` = 第二轮质数修正后的算法版本；
 * 旧记录的 `fnv1a64:` 前缀读取时按新算法重算，避免「算法升级导致假告警」）。
 */
/** 当前指纹算法版本前缀；旧前缀（`fnv1a64:`）读取时按新算法重算，避免假告警。 */
export const FINGERPRINT_PREFIX = "fnv1a64b:";

export function contentFingerprint(manifest: PluginManifest): string {
  const text = canonicalManifestText(manifest);
  const first = fnv1a64(text, FNV_OFFSET_A, FNV_PRIME_A);
  const second = fnv1a64(text, FNV_OFFSET_B ^ BigInt(text.length), FNV_PRIME_B);
  const head = (first & 0xffffffffn).toString(16).padStart(8, "0");
  const tail = (second & 0xffffffffn).toString(16).padStart(8, "0");
  return `${FINGERPRINT_PREFIX}${head}${tail}`;
}
