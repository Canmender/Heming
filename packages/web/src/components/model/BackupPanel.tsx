import { useCallback, useEffect, useState } from "react";
import { getMagpieCliBridge, type CloudBackupFile } from "../../lib/magpieCli.js";
import { ArchiveIcon, AlertIcon } from "../icons.js";
import { SectionCard } from "./SectionCard.js";
import { ConsolePanel } from "./ConsolePanel.js";

/**
 * 备份与恢复（d.112）：页面内列出备份、一键新建/恢复。
 *
 * 备份文件放在应用自己的目录（主进程提供），口令在交互面板里输入，只存在内存中。
 * 恢复前会要求确认——这是会覆盖当前来源与账号配置的操作。
 */
export function BackupPanel() {
  const bridge = getMagpieCliBridge();
  const [dir, setDir] = useState("");
  const [files, setFiles] = useState<CloudBackupFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ title: string; args: string[]; hint?: string } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!bridge) {
      setLoading(false);
      return;
    }
    try {
      const info = await bridge.backupInfo();
      setDir(info.dir);
      setFiles(info.files);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  const startBackup = () => {
    if (!bridge || !dir) return;
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 12);
    const path = `${dir}\\model-${stamp}.backup`;
    setPending({
      title: "新建备份",
      args: ["backup", path],
      hint: "会要求输入一个加密口令：输入后回车，再输一次确认。",
    });
  };

  const startRestore = (filePath: string) => {
    setConfirmRestore(null);
    setPending({
      title: "恢复备份",
      args: ["restore", filePath],
      hint: "会要求输入备份时的口令；恢复会覆盖当前的来源、账号与设置。",
    });
  };

  const pickRestore = async () => {
    if (!bridge) return;
    const picked = await bridge.backupPick();
    if (picked) setConfirmRestore(picked);
  };

  const formatSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  };

  return (
    <SectionCard
      icon={<ArchiveIcon width={16} height={16} />}
      title="备份与恢复"
      description="备份包含来源、Key 与账号登录，用口令加密；口令只在下面的面板里输入。"
      action={
        <div className="flex gap-2">
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-ghost"
            disabled={!bridge}
            onClick={() => void pickRestore()}
          >
            从文件恢复…
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-primary"
            disabled={!bridge || !dir}
            onClick={startBackup}
          >
            新建备份
          </button>
        </div>
      }
    >
      {error && (
        <div role="alert" className="ui-alert ui-alert-danger">
          <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {loading ? (
        <div className="space-y-2" aria-label="读取备份">
          {[0, 1].map((index) => (
            <div key={index} className="h-12 animate-pulse rounded-xl bg-[var(--subtle-3)]" />
          ))}
        </div>
      ) : files.length === 0 ? (
        <p className="ui-caption">还没有备份。点「新建备份」会生成一个加密文件放在本机。</p>
      ) : (
        <ul className="divide-y divide-line">
          {files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-bold">{file.name}</span>
                <span className="block ui-caption">
                  {new Date(file.mtime).toLocaleString("zh-CN", { hour12: false })} ·{" "}
                  {formatSize(file.size)}
                </span>
              </span>
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                disabled={!bridge}
                onClick={() => setConfirmRestore(file.path)}
              >
                恢复
              </button>
            </li>
          ))}
        </ul>
      )}

      {confirmRestore && (
        <div role="alert" className="ui-alert ui-alert-danger rta-enter mt-3 block">
          <div className="flex items-start gap-2">
            <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-[12px] font-bold">确认恢复这个备份？</div>
              <p className="mt-1 ui-caption break-all">{confirmRestore}</p>
              <p className="mt-1 ui-caption">恢复会覆盖当前的来源、账号与设置。系统会先保留一份自动备份。</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-danger"
                  onClick={() => startRestore(confirmRestore)}
                >
                  确认恢复
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-sm ui-btn-ghost"
                  onClick={() => setConfirmRestore(null)}
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <ConsolePanel
          title={pending.title}
          args={pending.args}
          hint={pending.hint}
          onClose={() => {
            setPending(null);
            void load();
          }}
          onDone={() => {
            setPending((current) => {
              if (current) void load();
              return current;
            });
          }}
        />
      )}
    </SectionCard>
  );
}
