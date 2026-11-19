import { useCallback, useEffect, useState } from "react";
import { getMagpieCliBridge } from "../../lib/magpieCli.js";
import {
  describeAuto,
  describeSync,
  labelOf,
  parseSyncStatus,
  syncAutoArgs,
  syncNowArgs,
  syncOffArgs,
  syncOnArgs,
  type SyncKind,
  type SyncStatus,
} from "../../lib/magpieSync.js";
import { RefreshIcon, AlertIcon } from "../icons.js";
import { SectionCard } from "./SectionCard.js";
import { Button } from "../ui/Button.js";
import { TextField } from "../ui/Field.js";

/**
 * 云同步（d.392）：几台电脑用同一份设置。
 *
 * 内核把这件事分成三步——看状态（`magpie webdav`）、立刻同步一次（`now`）、
 * 自己隔多久同步（`auto`）；开与关要输密码或令牌，所以那两步交给终端，
 * 页面只负责把现状说清、把「现在同步一次」做成按钮。
 */

const KINDS: { key: SyncKind; label: string; hint: string }[] = [
  { key: "webdav", label: "WebDAV", hint: "坚果云这类网盘，填它给的 WebDAV 地址" },
  { key: "s3", label: "S3 桶", hint: "s3://<桶>/<前缀>，可以用自家 MinIO" },
  { key: "github", label: "GitHub 仓库", hint: "github://<owner>/<repo>[/<folder>]" },
];

/** 自动同步的可选档位：内核只认这几档。 */
const AUTO_CHOICES: { value: string; label: string }[] = [
  { value: "", label: "不改" },
  { value: "off", label: "只在我点的时候" },
  { value: "3", label: "每 3 分钟" },
  { value: "15", label: "每 15 分钟" },
  { value: "30", label: "每 30 分钟" },
  { value: "60", label: "每 60 分钟" },
];

export function CloudSyncCard() {
  const bridge = getMagpieCliBridge();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const [kind, setKind] = useState<SyncKind>("webdav");
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [auto, setAuto] = useState("");

  const load = useCallback(async () => {
    if (!bridge) {
      setLoading(false);
      return;
    }
    try {
      const result = await bridge.cli(["webdav"]);
      const text = `${result.stdout}${result.stderr}`;
      const next = parseSyncStatus(text);
      setStatus(next);
      if (next.on) setKind(next.kind);
      setError(result.ok ? null : result.stderr.trim() || result.error || "读不出云同步现状");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (title: string, args: string[]) => {
    if (!bridge) return;
    setBusy(true);
    try {
      const result = await bridge.cli(args);
      if (!result.ok) {
        setSaid("");
        setError(result.stderr.trim() || result.error || `${title}没成`);
      } else {
        setError(null);
        setSaid(`${title}：${firstLine(result.stdout) || "好了"}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startSync = () => {
    if (!status) return;
    void send("同步了一次", syncNowArgs(status.kind));
  };

  const applyAuto = () => {
    if (!status) return;
    const args = syncAutoArgs(status.kind, auto === "off" ? "off" : Number(auto));
    if (!args) {
      setError("内核只认「关、3、15、30、60」这几档。");
      return;
    }
    void send("改了同步间隔", args);
  };

  const turnOff = () => {
    if (!status) return;
    void send("关掉了云同步", syncOffArgs(status.kind));
  };

  const turnOn = async () => {
    if (!bridge) return;
    const args = syncOnArgs(kind, address, user);
    if (!args) {
      setError("先填地址：它在哪，同步就放在哪。");
      return;
    }
    try {
      const result = await bridge.openTerminal(args);
      if (!result.ok) {
        setError(result.error ?? "打不开终端");
        return;
      }
      setError(null);
      setSaid("终端里会让你输密码或令牌；填完回到这里点一下「读一次现状」。");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const hint = status?.on ? describeAuto(status.auto) : "";

  return (
    <SectionCard
      icon={<RefreshIcon width={16} height={16} />}
      title="云同步"
      description="几台电脑用同一份来源、设置与技能库；文件在你自己指定的地方，用你的密码封着。"
      action={
        <div className="flex gap-2">
          {status?.on && (
            <Button type="button" size="sm" variant="ghost" disabled={!bridge || busy} onClick={turnOff}>
              关掉
            </Button>
          )}
          {status?.on ? (
            <Button type="button" size="sm" variant="primary" disabled={!bridge || busy} onClick={startSync}>
              {busy ? "正在同步…" : "现在同步一次"}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="primary" disabled={!bridge} onClick={() => void turnOn()}>
              开云同步…
            </Button>
          )}
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
        <div className="mt-2 h-10 animate-pulse rounded-xl bg-subtle-3" aria-label="读取云同步" />
      ) : status?.on ? (
        <div className="mt-2 space-y-2">
          <p className="ui-caption">{describeSync(status)}</p>
          {status.who.length > 0 && (
            <p className="ui-caption">跟着地址的说明：{status.who.join("、")}。</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label className="ui-caption" htmlFor="cloud-sync-auto">
              它自己多久同步一次
            </label>
            <select
              id="cloud-sync-auto"
              className="ui-input"
              aria-label="自动同步间隔"
              value={auto}
              disabled={!bridge || busy}
              onChange={(event) => setAuto(event.target.value)}
            >
              {AUTO_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.value === "" && hint ? `${choice.label}（现在：${hint}）` : choice.label}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!bridge || busy || auto === ""}
              onClick={applyAuto}
            >
              应用
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
              读一次现状
            </Button>
          </div>
          {said && <p className="ui-caption text-muted">{said}</p>}
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <p className="ui-caption">{describeSync((status ?? emptyStatus(kind)) as SyncStatus)}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="ui-caption" htmlFor="cloud-sync-kind">
              放在哪儿
            </label>
            <select
              id="cloud-sync-kind"
              className="ui-input"
              aria-label="云同步的类型"
              value={kind}
              disabled={!bridge}
              onChange={(event) => setKind(event.target.value as SyncKind)}
            >
              {KINDS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <p className="ui-caption">{KINDS.find((item) => item.key === kind)?.hint}</p>
          <TextField
            label="地址"
            hint={`${labelOf(kind)}的地址，例如 ${
              kind === "s3" ? "s3://my-bucket/magpie" : kind === "github" ? "github://me/my-settings" : "https://dav.jianguoyun.com/dav/"
            }`}
            placeholder={kind === "s3" ? "s3://…" : kind === "github" ? "github://…" : "https://…"}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          {kind === "webdav" && (
            <TextField
              label="账号（可选）"
              hint="网盘登录用的邮箱或用户名"
              placeholder="me@example.com"
              value={user}
              onChange={(event) => setUser(event.target.value)}
            />
          )}
          <p className="ui-caption">
            点「开云同步…」会在终端里问密码或令牌——它不经过页面，也不存在页面里。
          </p>
          {said && <p className="ui-caption text-muted">{said}</p>}
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
            读一次现状
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

/** 还没读到时不编内容：只说没开。 */
function emptyStatus(kind: SyncKind): SyncStatus {
  return { on: false, kind, url: "", who: [], parts: [], last: "", error: "", auto: null };
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").trim();
}
