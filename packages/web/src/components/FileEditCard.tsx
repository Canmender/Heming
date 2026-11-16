import { useState } from "react";
import { getDefaultRootPath, getFileBridge, type FileFsBridge } from "../lib/fileEdit/bridge.js";
import {
  MAX_FILE_ROOTS,
  DEFAULT_WORKSPACE_ROOT_NAME,
  FileRootsStore,
  activeWorkspace,
  fileRootsStore,
  type FileRootsConfig,
} from "../lib/fileEdit/roots.js";
import { MAX_FILE_BYTES, MAX_FILES_PER_PATCH, MAX_PATCH_BYTES } from "../lib/fileEdit/limits.js";
import { isFileEditTool } from "../lib/fileEdit/ruleTargets.js";
import { FOCUS_RING } from "../lib/a11y/focus.js";
import { HitlPolicyStore } from "../lib/hitl/policy.js";
import { Button } from "../components/ui/Button.js";
import { RollbackList } from "./RollbackList.js";
import { useChatStore } from "../store/chat.js";
import { useUiStore } from "../store/ui.js";

/**
 * 设置区 · 文件编辑卡。
 *
 * 三件事：
 * 1. **额外授权根**（增删 + read/write 切换）。会话工作区已经自动成为可写根
 *    （产品决策：用户明确要求工作区默认可读写），所以这里**不再是**「文件能力的唯一开关」——
 *    它管的是「工作区之外还想授权哪些目录」；
 * 2. **越界处理**（问 / 直接拒绝）；
 * 3. **展示**已记住的目录授权规则（来自确认卡「记住本次选择」，按目录前缀）。
 *
 * 自动工作区根**不落 localStorage**、也不在本卡列表里（它是会话属性，跟着会话走：
 * 换会话就换根，删会话就失效）。浏览器端没有文件桥，整卡显示「仅桌面端可用」，
 * 不说「自动可写」——没有桥却宣称可写就是假能力。
 */
export function FileEditCard({
  rootsStore,
  policyStore,
  bridge,
  workspace,
}: {
  rootsStore?: FileRootsStore;
  policyStore?: HitlPolicyStore;
  /** 测试注入；缺省读 `window.__heming_files`。 */
  bridge?: FileFsBridge | null;
  /**
   * 当前会话工作区（绝对路径）。缺省从「当前活动会话」读；
   * 设置页没有活动会话时为空——那时只展示通用说明，不编造一个路径。
   */
  workspace?: string;
}) {
  const store = rootsStore ?? fileRootsStore;
  const policy = policyStore ?? new HitlPolicyStore();
  const fileBridge = bridge === undefined ? getFileBridge() : bridge;

  const activeConversationId = useUiStore((state) => state.activeConversationId);
  const conversationWorkspace = useChatStore((state) => {
    const conv = state.conversations.find((c) => c.id === activeConversationId);
    return conv?.workspace ?? "";
  });
  // 数据源优先级：显式 prop（测试/调用方）→ 聊天页当前会话 → roots 模块记下的活动工作区。
  // 第三级是必要的：设置页会清空 activeConversationId（store/ui 的 setPage），只看会话列表
  // 会把「工作区自动可写」显示成「没有工作区」，和闸门实际口径对不上。
  const autoWorkspace = (workspace ?? conversationWorkspace ?? activeWorkspace() ?? "").trim();
  // 未分组会话的兜底写根（桌面端 preload 同步下发的「文档\和鸣」；老安装包没有 → null）。
  const defaultRoot = getDefaultRootPath();

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

  /*
   * 规则是直接读 localStorage 的（没有订阅），所以撤销后必须手动触发一次重渲染，
   * 否则界面还显示着刚被删掉的那条——用户会以为撤销没生效，再点一次。
   */
  const [ruleVersion, bumpRuleVersion] = useState(0);
  const [clearArmed, setClearArmed] = useState(false);

  const revokeRule = (rule: (typeof rules)[number]) => {
    const removed = policy.removeRule(rule);
    bumpRuleVersion(ruleVersion + 1);
    setClearArmed(false);
    setError(removed ? null : "撤销失败：这条规则可能已被其它页面删除，刷新后重试。");
    setStatus(removed ? "已撤销该目录授权，之后该目录内的改动会重新逐次询问" : null);
  };

  const clearAllRules = () => {
    if (!clearArmed) {
      setClearArmed(true);
      setStatus(null);
      return;
    }
    policy.clearRules();
    bumpRuleVersion(ruleVersion + 1);
    setClearArmed(false);
    setError(null);
    setStatus("已清空全部记住的规则");
  };

    return (
    <section aria-label="文件编辑" className="ui-card mt-3 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <div className="ui-section-title">文件编辑</div>
      </div>
      <div className="mt-1 ui-caption">
        {fileBridge ? (
          <>
            会话工作区会自动成为可写根（无需手动添加）；这里配置的根用于额外授权工作区之外的目录。
          </>
        ) : (
          <>
            默认没有任何可写根。添加后 `file_read` 才会出现在智能体工具里；至少一条可写根才会出现 `file_patch`。
          </>
        )}
      </div>

      {fileBridge && autoWorkspace && (
        <div className="mt-2 rounded-lg border border-line-soft bg-subtle-2 px-3 py-2 ui-caption">
          工作区（自动）：<span className="break-all font-mono">{autoWorkspace}</span>
          <span className="text-muted"> · 无需手动添加</span>
        </div>
      )}

      {fileBridge && !autoWorkspace && defaultRoot && (
        <div className="mt-2 rounded-lg border border-line-soft bg-subtle-2 px-3 py-2 ui-caption">
          {DEFAULT_WORKSPACE_ROOT_NAME}（自动）：<span className="break-all font-mono">{defaultRoot}</span>
          <span className="text-muted"> · 未分组的会话也可直接读写，无需手动添加</span>
        </div>
      )}

      {fileBridge && !autoWorkspace && !defaultRoot && (
        <div className="mt-2 rounded-lg border border-line-soft bg-subtle-2 px-3 py-2 ui-caption">
          未分组的会话没有自动可写目录：给它选一个工作区，或在下面添加一条可写根。
        </div>
      )}

      {!fileBridge ? (
        <div className="mt-2 rounded-lg border border-line-soft bg-subtle-2 px-3 py-2 ui-caption">
          仅桌面端可用：浏览器里没有文件系统访问能力，因此不提供文件编辑工具。
        </div>
      ) : (
        <>
          <div className="mt-3">
            <div className="flex items-center justify-between">
              <div className="ui-body-sm font-semibold text-ink">
                可写根{config.roots.length ? `（${config.roots.length}/${MAX_FILE_ROOTS}）` : ""}
              </div>
              {config.roots.length > 0 && (
                <span className="text-ui-xs text-muted">路径只存在本机，不上传</span>
              )}
            </div>
            {config.roots.length === 0 ? (
              <div className="mt-1 rounded-lg border border-line-soft bg-subtle-2 px-3 py-2 ui-caption">
                还没有额外配置的可写根。会话工作区里的文件智能体已经可以读写；想授权工作区之外的目录，在下面添加。建议选一个你希望它维护的目录（例如 Obsidian 库的某个子目录），不要选整个盘。
              </div>
            ) : (
              <ul className="mt-1 flex flex-col gap-1">
                {config.roots.map((root) => (
                  <li
                    key={root.path}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-line-soft px-2 py-1.5"
                  >
                    <span className="ui-body-sm font-semibold">{root.name}</span>
                    <span className="min-w-0 flex-1 truncate font-mono ui-caption" title={root.path}>
                      {root.path}
                    </span>
                    <select
                      aria-label={`${root.name} 读写模式`}
                      value={root.mode}
                      onChange={(e) => changeMode(root.path, e.target.value as "read" | "write")}
                      className="rounded-lg border border-line-strong px-2 py-0.5 text-ui-xs outline-hidden focus:border-ink"
                    >
                      <option value="write">可写</option>
                      <option value="read">只读</option>
                    </select>
                    <button
                      type="button"
                      aria-label={`删除根 ${root.name}`}
                      onClick={() => removeRoot(root.path)}
                      className="rounded-lg border border-line px-2 py-0.5 text-ui-xs text-danger hover:bg-subtle-2"
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
            <Button
              type="button"
              onClick={pickDirectory}
              size="sm" variant="ghost"
            >
              选择目录
            </Button>
            <Button
              type="button"
              onClick={addRoot}
              size="sm" variant="primary"
            >
              添加
            </Button>
          </div>
          {error && (
            <div role="alert" className="mt-2 ui-caption text-danger">
              {error}
            </div>
          )}
          {status && (
            <div role="status" className="mt-2 ui-caption">
              {status}
            </div>
          )}

          <label className="mt-3 block text-ui-sm">
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
            <span className="mt-1 block text-ui-xs text-muted">
              写盘层无论如何都只写可写根内；这里只是决定「先问一次再失败」还是「直接失败」。
            </span>
          </label>

            <div className="mt-3 border-t border-line-soft pt-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="ui-body-sm font-semibold text-ink">
                  已记住的目录授权{rules.length ? `（${rules.length} 条）` : ""}
                </div>
                {rules.length > 0 ? (
                  <button
                    type="button"
                    onClick={clearAllRules}
                    className={`rounded-sm px-2 py-0.5 text-ui-xs ui-hit ${FOCUS_RING} ${
                      clearArmed ? "bg-danger-soft text-danger" : "text-muted hover:text-ink"
                    }`}
                    aria-label={clearArmed ? "确认清空全部记住的目录授权" : "清空全部记住的目录授权"}
                  >
                    {clearArmed ? "再点一次确认清空" : "全部清空"}
                  </button>
                ) : null}
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
                      className="flex flex-wrap items-baseline gap-1.5 rounded-sm border border-line-soft px-2 py-1 text-ui-xs"
                    >
                      <span
                        className={`rounded-sm px-1 ${
                          rule.effect === "deny"
                            ? "bg-danger-soft text-danger"
                            : "bg-success-soft text-success"
                        }`}
                      >
                        {rule.effect === "deny" ? "拒绝" : "允许"}
                      </span>
                      <span className="font-mono text-body">{rule.tool}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-muted" title={rule.resource}>
                        {rule.resource}
                      </span>
                      <button
                        type="button"
                        onClick={() => revokeRule(rule)}
                        className={`rounded-sm px-1.5 py-0.5 ui-hit text-muted hover:text-danger ${FOCUS_RING}`}
                        aria-label={`撤销 ${rule.effect === "deny" ? "拒绝" : "允许"}规则：${rule.tool} ${rule.resource}`}
                      >
                        撤销
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-1 text-ui-xs text-muted">
                拒绝优先于允许；文件编辑只能按目录前缀授权，不能放行整个工具。
                撤销一条只影响那一条目录，其它授权不受影响。
              </div>
            </div>

          <div className="mt-3 border-t border-line-soft pt-2 ui-caption">
            上限：单文件 {Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB、单次补丁{" "}
            {Math.round(MAX_PATCH_BYTES / 1024 / 1024)} MB、单次最多 {MAX_FILES_PER_PATCH} 个文件；
            只处理 UTF-8 文本，软链/硬链接与二进制文件一律拒绝。
          </div>

          {/* d.171：把 d.170 的 file_undo 从「只有模型会调」变成用户能点的入口 */}
          <RollbackList bridge={fileBridge} />
        </>
      )}
    </section>
  );
}
