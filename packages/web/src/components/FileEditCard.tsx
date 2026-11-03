import { useState } from "react";
import { getFileBridge, type FileFsBridge } from "../lib/fileEdit/bridge.js";
import {
  MAX_FILE_ROOTS,
  FileRootsStore,
  fileRootsStore,
  type FileRootsConfig,
} from "../lib/fileEdit/roots.js";
import { MAX_FILE_BYTES, MAX_FILES_PER_PATCH, MAX_PATCH_BYTES } from "../lib/fileEdit/limits.js";
import { isFileEditTool } from "../lib/fileEdit/ruleTargets.js";
import { HitlPolicyStore } from "../lib/hitl/policy.js";

/**
 * 设置区 · 文件编辑卡。
 *
 * 三件事：
 * 1. **可写根**（增删 + read/write 切换）——这是文件编辑能力的唯一开关，
 *    没有根时 `file_patch` / `file_read` 对模型根本不可见；
 * 2. **越界处理**（问 / 直接拒绝）；
 * 3. **展示**已记住的目录授权规则（来自确认卡「记住本次选择」，按目录前缀）。
 *
 * 与 MCP「装完默认全关」同口径：这里默认一条根都没有，必须用户显式添加。
 * 浏览器端没有文件桥，整卡显示「仅桌面端可用」而不是给一个假的添加按钮。
 */
export function FileEditCard({
  rootsStore,
  policyStore,
  bridge,
}: {
  rootsStore?: FileRootsStore;
  policyStore?: HitlPolicyStore;
  /** 测试注入；缺省读 `window.__heming_files`。 */
  bridge?: FileFsBridge | null;
}) {
  const store = rootsStore ?? fileRootsStore;
  const policy = policyStore ?? new HitlPolicyStore();
  const fileBridge = bridge === undefined ? getFileBridge() : bridge;

  const [config, setConfig] = useState<FileRootsConfig>(() => store.get());
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<"read" | "write">("write");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = () => setConfig(store.get());

  const addRoot = () => {
    const result = store.add({ path, mode });
    if (!result.ok) {
      setError(result.error);
      setStatus(null);
      return;
    }
    setError(null);
    setPath("");
    setStatus(`已添加可${result.root.mode === "write" ? "写" : "读"}根「${result.root.name}」`);
    refresh();
  };

  const pickDirectory = async () => {
    if (!fileBridge) return;
    try {
      const picked = await fileBridge.pickRoot();
      if (picked) {
        setPath(picked);
        setError(null);
      }
    } catch {
      setError("打开目录选择器失败，可以直接粘贴路径。");
    }
  };

  const removeRoot = (rootPath: string) => {
    store.remove(rootPath);
    setStatus("已删除该根");
    setError(null);
    refresh();
  };

  const changeMode = (rootPath: string, next: "read" | "write") => {
    store.setMode(rootPath, next);
    setStatus("已更新读写模式");
    refresh();
  };

  const changeOutOfRoot = (next: "ask" | "reject") => {
    store.setOutOfRoot(next);
    refresh();
  };

  // 已记住的文件编辑规则（由确认卡「记住本次选择」按目录前缀写入）
  const rules = policy.rules().filter((rule) => isFileEditTool(rule.tool));

  return (
    <section aria-label="文件编辑" className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card">
      <div className="text-[12px] font-bold text-muted">文件编辑</div>
      <div className="mt-1 ui-caption">
        允许智能体在你圈定的目录内用补丁改文件。默认没有任何可写根，
        添加之后 `file_patch` / `file_read` 才会出现在智能体的工具里：任意一条根（含只读）会让 `file_read` 可见，至少一条可写根才会让 `file_patch` 可见。
      </div>

      {!fileBridge ? (
        <div className="mt-2 rounded-lg border border-line-soft bg-[#fafafa] px-3 py-2 ui-caption">
          仅桌面端可用：浏览器里没有文件系统访问能力，因此不提供文件编辑工具。
        </div>
      ) : (
        <>
          <div className="mt-3">
            <div className="flex items-center justify-between">
              <div className="text-[12px] font-bold text-muted">
                可写根{config.roots.length ? `（${config.roots.length}/${MAX_FILE_ROOTS}）` : ""}
              </div>
              {config.roots.length > 0 && (
                <span className="text-[10px] text-muted">路径只存在本机，不上传</span>
              )}
            </div>
            {config.roots.length === 0 ? (
              <div className="mt-1 rounded-lg border border-line-soft bg-[#fafafa] px-3 py-2 ui-caption">
                还没有可写根。智能体目前不能改任何文件（若添加只读根，它可以读取那些目录）。建议选一个你希望它维护的目录
                （例如 Obsidian 库的某个子目录），不要选整个盘。
              </div>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {config.roots.map((root) => (
                  <li
                    key={root.path}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft px-2 py-1.5"
                  >
                    <span className="text-[12px] font-bold">{root.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono ui-caption" title={root.path}>
                      {root.path}
                    </span>
                    <select
                      aria-label={`${root.name} 读写模式`}
                      value={root.mode}
                      onChange={(e) => changeMode(root.path, e.target.value as "read" | "write")}
                      className="rounded-lg border border-line-strong px-2 py-0.5 text-[11px] outline-hidden focus:border-ink"
                    >
                      <option value="write">可写</option>
                      <option value="read">只读</option>
                    </select>
                    <button
                      type="button"
                      aria-label={`删除根 ${root.name}`}
                      onClick={() => removeRoot(root.path)}
                      className="rounded-lg border border-line px-2 py-0.5 text-[11px] text-red-600 hover:bg-[#fafafa]"
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 ui-caption">
              目录路径
              <input
                aria-label="可写根路径"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setError(null);
                }}
                placeholder="D:/Obsidian/学院事务"
                className="mt-1 block w-full ui-input"
              />
            </label>
            <select
              aria-label="新根的读写模式"
              value={mode}
              onChange={(e) => setMode(e.target.value as "read" | "write")}
              className="ui-input"
            >
              <option value="write">可写</option>
              <option value="read">只读</option>
            </select>
            <button
              type="button"
              onClick={pickDirectory}
              className="ui-btn ui-btn-sm ui-btn-ghost"
            >
              选择目录
            </button>
            <button
              type="button"
              onClick={addRoot}
              className="ui-btn ui-btn-sm ui-btn-primary"
            >
              添加
            </button>
          </div>
          {error && (
            <div role="alert" className="mt-2 text-[12px] text-red-600">
              {error}
            </div>
          )}
          {status && (
            <div role="status" className="mt-2 ui-caption">
              {status}
            </div>
          )}

          <label className="mt-3 block text-[12px]">
            目标不在可写根内时
            <select
              aria-label="越界处理方式"
              value={config.outOfRoot}
              onChange={(e) => changeOutOfRoot(e.target.value as "ask" | "reject")}
              className="mt-1 block ui-input"
            >
              <option value="ask">先问我（默认）</option>
              <option value="reject">直接拒绝</option>
            </select>
            <span className="mt-1 block text-[10px] text-muted">
              写盘层无论如何都只写可写根内；这里只是决定「先问一次再失败」还是「直接失败」。
            </span>
          </label>

          <div className="mt-3 border-t border-line-soft pt-2">
            <div className="text-[11px] font-bold text-muted">
              已记住的目录授权{rules.length ? `（${rules.length} 条）` : ""}
            </div>
            {rules.length === 0 ? (
              <div className="mt-1 ui-caption">
                还没有。在确认弹窗里勾选「记住本次选择」会按目标文件所在目录授权
                （如 `D:/Obsidian/学院事务/`），之后该目录内的改动不再逐次询问。
              </div>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {rules.map((rule) => (
                  <li
                    key={`${rule.tool}-${rule.resource}-${rule.at}`}
                    className="flex flex-wrap items-baseline gap-1.5 rounded-sm border border-line-soft px-2 py-1 text-[11px]"
                  >
                    <span
                      className={`rounded-sm px-1 ${
                        rule.effect === "deny"
                          ? "bg-[#fdf0ef] text-[#b42318]"
                          : "bg-[#eef6f0] text-[#1d6b3a]"
                      }`}
                    >
                      {rule.effect === "deny" ? "拒绝" : "允许"}
                    </span>
                    <span className="font-mono text-[#555]">{rule.tool}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-muted" title={rule.resource}>
                      {rule.resource}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-1 text-[10px] text-muted">
              拒绝优先于允许；文件编辑只能按目录前缀授权，不能放行整个工具。
              规则可在「工具调用确认」卡里一键清空。
            </div>
          </div>

          <div className="mt-3 border-t border-line-soft pt-2 ui-caption">
            上限：单文件 {Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB、单次补丁{" "}
            {Math.round(MAX_PATCH_BYTES / 1024 / 1024)} MB、单次最多 {MAX_FILES_PER_PATCH} 个文件；
            只处理 UTF-8 文本，软链/硬链接与二进制文件一律拒绝。改动即时生效，仅作用于本机。
          </div>
        </>
      )}
    </section>
  );
}
