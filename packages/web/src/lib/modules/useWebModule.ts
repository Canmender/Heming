import { useEffect, useState } from "react";
import { loadWebModule, type WebModuleEntry } from "./webModules.js";

/**
 * React 侧模块包加载 hook（d.131 M2）。
 *
 * 加载失败（未安装/构建不存在/验签失败）只返回 error，由调用方回退内置实现或显示原因——
 * 迁移期绝不因为模块包缺失把页面打白。
 */
export function useWebModuleEntry(moduleId: string): {
  entry: WebModuleEntry | null;
  loading: boolean;
  error: string;
} {
  const [entry, setEntry] = useState<WebModuleEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    loadWebModule(moduleId)
      .then((mod) => {
        if (!alive) return;
        setEntry(mod);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setEntry(null);
        setError(err instanceof Error && err.message ? err.message : "模块包加载失败");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [moduleId]);

  return { entry, loading, error };
}
