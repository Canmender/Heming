import { ModuleCatalogResponseSchema, type ModuleCatalogEntry } from "@heming/shared";
import { api } from "../api.js";

/**
 * 云端模块目录（d.117）：客户端不再写死「内置模块」列表，只显示服务端真实提供的模块。
 *
 * 边界：
 * - 只读；目录不可用时插件页显示空/错误，不把任何模块画成「已存在」；
 * - 安装动作仍走本机 `useModuleStore`（装过才有入口），不在这里改任何状态；
 * - 目录是公开产物，不含用户数据。
 */
export async function fetchModuleCatalog(): Promise<ModuleCatalogEntry[]> {
  let raw: unknown;
  try {
    raw = await api<unknown>("/api/modules");
  } catch (err) {
    throw new Error(
      `模块目录获取失败：${err instanceof Error && err.message ? err.message : "网络不可用"}`,
    );
  }
  const parsed = ModuleCatalogResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("模块目录格式不对（服务端返回内容无法识别）");
  return parsed.data.modules;
}
