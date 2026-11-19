import { useCallback, useEffect, useState } from "react";
import { getMagpieCliBridge, type CloudBackupFile } from "../../lib/magpieCli.js";
import {
  BACKUP_PARTS,
  RESTORE_PARTS,
  backupArgs,
  defaultBackupParts,
  defaultRestoreParts,
  describeBackupParts,
  describeRestoreParts,
  restoreArgs,
} from "../../lib/magpieBackupParts.js";
import { ArchiveIcon, AlertIcon } from "../icons.js";
import { SectionCard } from "./SectionCard.js";
import { ConsolePanel } from "./ConsolePanel.js";
import { Button } from "../../components/ui/Button.js";

/**
 * 备份与恢复（d.112）：页面内列出备份、一键新建/恢复。
 *
 * 备份文件放在应用自己的目录（主进程提供），口令在交互面板里输入，只存在内存中。
 * 恢复前会要求确认——这是会覆盖当前来源与账号配置的操作。
 *
 * d.374 起「带上什么 / 覆盖什么」不再需要记内核的 flag：三块各自一个勾，默认值与内核一致
 * （见 `lib/magpieBackupParts.ts`），勾完在面板里用一句人话说清会发生什么。
 */
export function BackupPanel() {
  const bridge = getMagpieCliBridge();
  const [dir, setDir] = useState("");
  const [files, setFiles] = useState<CloudBackupFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ title: string; args: string[]; hint?: string } | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [backupParts, setBackupParts] = useState(defaultBackupParts);
  const [restoreParts, setRestoreParts] = useState(defaultRestoreParts);

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
      args: backupArgs(path, backupParts),
      hint: `会要求输入一个加密口令：输入后回车，再输一次确认。这一次${describeBackupParts(backupParts)}。`,
    });
  };

  const startRestore = (filePath: string) => {
    setConfirmRestore(null);
    setPending({
      title: "恢复备份",
      args: restoreArgs(filePath, restoreParts),
      hint: `会要求输入备份时的口令。这一次${describeRestoreParts(restoreParts)}；来源与账号总会恢复。`,
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
          <Button
            type="button"
            size="sm" variant="ghost"
            disabled={!bridge}
            onClick={() => void pickRestore()}
          >
            从文件恢复…
          </Button>
          <Button
            type="button"
            size="sm" variant="primary"
            disabled={!bridge || !dir}
            onClick={startBackup}
          >
            新建备份
          </Button>
        </div>
      }
    >
      <div className="mt-3 rounded-lg border border-line bg-subtle px-3 py-2">
        <p className="ui-caption">新建备份时带上这三块里的哪些：</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          {BACKUP_PARTS.map((part) => (
            <label key={part.key} className="flex items-center gap-2 ui-caption" title={part.hint}>
              <input
                type="checkbox"
                className="accent-brand"
                aria-label={`新建备份：${part.label}`}
                checked={backupParts[part.key]}
                disabled={!bridge}
                onChange={(event) =>
                  setBackupParts({ ...backupParts, [part.key]: event.target.checked })
                }
              />
              {part.label}
            </label>
          ))}
        </div>
        <p className="mt-1 ui-caption">现在：{describeBackupParts(backupParts)}。</p>
      </div>

      {error && (
        <div role="alert" className="ui-alert ui-alert-danger">
          <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {loading ? (
        <div className="space-y-2" aria-label="读取备份">
          {[0, 1].map((index) => (
            <div key={index} className="h-12 animate-pulse rounded-xl bg-subtle-3" />
          ))}
        </div>
      ) : files.length === 0 ? (
        <p className="ui-caption">还没有备份。点「新建备份」会生成一个加密文件放在本机。</p>
      ) : (
        <ul className="divide-y divide-line">
          {files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-sm font-semibold">{file.name}</span>
                <span className="block ui-caption">
                  {new Date(file.mtime).toLocaleString("zh-CN", { hour12: false })} ·{" "}
                  {formatSize(file.size)}
                </span>
              </span>
              <Button
                type="button"
                size="sm" variant="ghost"
                disabled={!bridge}
                onClick={() => setConfirmRestore(file.path)}
              >
                恢复
              </Button>
            </li>
          ))}
        </ul>
      )}

      {confirmRestore && (
        <div role="alert" className="ui-alert ui-alert-danger rta-enter mt-3 block">
          <div className="flex items-start gap-2">
            <AlertIcon width={14} height={14} className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-ui-sm font-semibold">确认恢复这个备份？</div>
              <p className="mt-1 ui-caption break-all">{confirmRestore}</p>
              <p className="ui-caption">这次恢复要覆盖哪些：</p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2">
                {RESTORE_PARTS.map((part) => (
                  <label key={part.key} className="flex items-center gap-2 ui-caption" title={part.hint}>
                    <input
                      type="checkbox"
                      className="accent-brand"
                      aria-label={`恢复：${part.label}`}
                      checked={restoreParts[part.key]}
                      onChange={(event) =>
                        setRestoreParts({ ...restoreParts, [part.key]: event.target.checked })
                      }
                    />
                    {part.label}
                  </label>
                ))}
              </div>
              <p className="mt-1 ui-caption">
                {describeRestoreParts(restoreParts)}；来源与账号总会恢复。系统会先保留一份自动备份。
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  size="sm" variant="danger"
                  onClick={() => startRestore(confirmRestore)}
                >
                  确认恢复
                </Button>
                <Button
                  type="button"
                  size="sm" variant="ghost"
                  onClick={() => setConfirmRestore(null)}
                >
                  取消
                </Button>
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
