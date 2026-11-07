import { useCallback, useState } from "react";

/**
 * 宿主页内部 Tab 的会话级记忆（d.80）。
 *
 * 与 `store/ui.ts` 的「页面 + 会话」快照同一条口径：**刷新保留、关窗清空**。
 * 为什么不用 localStorage：Tab 是「这一次使用」的上下文，不是需要长期记住的偏好；
 * 用户关掉应用再开，回到默认视图比回到上个月的某个 Tab 更符合预期。
 *
 * 为什么不用 URL：项目没有路由（Electron `app://` 内嵌产物），见
 * `docs/superpowers/specs/2026-11-07-heming-core-round2.md` §1。
 */

function viewStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null; // 隐私模式/禁用存储：只在本次内存里切 Tab
  }
}

/** 读会话级值；缺失/脏值/不在允许集合里一律回落 fallback（不猜）。 */
export function readSessionValue<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
  storage: Pick<Storage, "getItem"> | null = viewStorage(),
): T {
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string" && (allowed as readonly string[]).includes(parsed)) {
      return parsed as T;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** 写会话级值；写失败静默（内存态已生效，刷新回默认 Tab 不是错误）。 */
export function writeSessionValue(
  key: string,
  value: string,
  storage: Pick<Storage, "setItem"> | null = viewStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满/隐私模式：忽略 */
  }
}

/**
 * 组件级 Tab 状态：与 sessionStorage 同步，刷新后回到同一个 Tab。
 *
 * 只收 `string` 字面量联合：Tab 类型都是小集合，用 `allowed` 白名单校验脏值，
 * 不把任意字符串灌进组件 state（旧版本遗留/手改存储都挡掉）。
 */
export function useSessionTab<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readSessionValue(key, fallback, allowed));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeSessionValue(key, next);
    },
    [key],
  );
  return [value, set];
}
