import { useState } from "react";

import { Button } from "../ui/Button.js";
import { TextField } from "../ui/Field.js";
import { ChevronIcon } from "../icons.js";
import {
  compactArgs,
  compactSummary,
  contextCapArgs,
  contextCapSummary,
  parseCompact,
  parseContextCap,
  suffixArgs,
  suffixSummary,
  SUFFIX_LABEL,
  type CompactState,
  type ContextCapState,
  type SuffixState,
} from "../../lib/modelGlobals.js";

export interface GlobalModelSettingsProps {
  suffix: SuffixState;
  compact: CompactState;
  contextCap: ContextCapState;
  /** 内核认不认识 `model context-cap`：不认识就整块不摆（保存必报错的控件比没有更糟）。 */
  capSupported: boolean;
  cliReady: boolean;
  onRun: (title: string, args: string[]) => Promise<boolean>;
}

/** magpie 的全局模型设置：名字后缀、压缩窗口、窗口上限。 */
export function GlobalModelSettings({
  suffix,
  compact,
  contextCap,
  capSupported,
  cliReady,
  onRun,
}: GlobalModelSettingsProps) {
  const [suffixMode, setSuffixMode] = useState<"on" | "own" | "off" | "">("");
  const [compactMode, setCompactMode] = useState<"keep" | "on" | "off">("keep");
  const [compactSize, setCompactSize] = useState("");
  const [capValue, setCapValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, title: string, args: string[]) => {
    setBusy(key);
    const ok = await onRun(title, args);
    setBusy(null);
    return ok;
  };

  return (
    <details className="ui-disclosure mt-3">
      <summary className="cursor-pointer ui-caption">
        <ChevronIcon width={12} height={12} className="ui-disclosure-chevron" />
        全局模型设置 · {compactSummary(compact)}
      </summary>
      <div className="mt-2 grid gap-4 rounded-lg border border-line bg-subtle px-3 py-3">
        <p className="ui-caption">
          这三项是全局的，会影响所有智能体看到的模型。
        </p>

        <div className="grid gap-1">
          <span className="ui-caption">名字后缀 · {suffixSummary(suffix)}</span>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="ui-input w-64"
              aria-label="模型名字后缀"
              value={suffixMode}
              disabled={!cliReady || busy !== null}
              onChange={(event) =>
                setSuffixMode(event.target.value as "on" | "own" | "off" | "")
              }
            >
              <option value="">保持不改</option>
              <option value="on">{SUFFIX_LABEL.on}</option>
              <option value="own">{SUFFIX_LABEL.own}</option>
              <option value="off">{SUFFIX_LABEL.off}</option>
            </select>
            <Button
              type="button"
              size="sm" variant="ghost"
              busy={busy === "suffix"}
              disabled={!cliReady || busy !== null || suffixMode === ""}
              onClick={async () => {
                if (suffixMode === "") return;
                const ok = await run("suffix", "设置模型名字后缀", suffixArgs(suffixMode));
                if (ok) setSuffixMode("");
              }}
            >
              保存后缀
            </Button>
          </div>
        </div>

        <div className="grid gap-1">
          <span className="ui-caption">压缩窗口 · {compactSummary(compact)}</span>
          <div className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1">
              <span className="ui-caption">怎么压缩</span>
              <select
                className="ui-input w-56"
                aria-label="压缩窗口"
                value={compactMode}
                disabled={!cliReady || busy !== null}
                onChange={(event) =>
                  setCompactMode(event.target.value as "keep" | "on" | "off")
                }
              >
                <option value="keep">保持不改</option>
                <option value="on">压缩（默认压缩点）</option>
                <option value="off">整个窗口，不压缩</option>
              </select>
            </label>
            <TextField
              label="压缩到（如 500k）"
              placeholder="留空用默认压缩点"
              value={compactSize}
              onChange={(event) => setCompactSize(event.target.value)}
            />
            <Button
              type="button"
              size="sm" variant="ghost"
              busy={busy === "compact"}
              disabled={!cliReady || busy !== null || compactMode === "keep"}
              onClick={async () => {
                const args =
                  compactMode === "off"
                    ? compactArgs("off")
                    : compactArgs(compactMode === "on" ? compactSize : "");
                const ok = await run("compact", "设置压缩窗口", args);
                if (ok) {
                  setCompactMode("keep");
                  setCompactSize("");
                }
              }}
            >
              保存压缩
            </Button>
          </div>
        </div>

        {capSupported && (
          <div className="grid gap-1">
            <span className="ui-caption">窗口上限 · {contextCapSummary(contextCap)}</span>
            <div className="flex flex-wrap items-end gap-2">
              <TextField
                label="窗口上限（如 200k，或 all）"
                placeholder="off / 200k / all"
                value={capValue}
                onChange={(event) => setCapValue(event.target.value)}
              />
              <Button
                type="button"
                size="sm" variant="ghost"
                busy={busy === "cap"}
                disabled={!cliReady || busy !== null || capValue.trim() === ""}
                onClick={async () => {
                  const ok = await run("cap", "设置窗口上限", contextCapArgs(capValue));
                  if (ok) setCapValue("");
                }}
              >
                保存上限
              </Button>
              <Button
                type="button"
                size="sm" variant="ghost"
                disabled={!cliReady || busy !== null}
                onClick={() => void run("cap", "关掉窗口上限", contextCapArgs(""))}
              >
                关掉上限
              </Button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
