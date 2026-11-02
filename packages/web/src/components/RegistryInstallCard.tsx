import { useRef, useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useHitlStore, usePendingHitl } from "../store/hitl.js";
import {
  sanitizeHeaders,
  type InstallDecision,
  type RegistryInstallPreview,
} from "../lib/registry/preview.js";

/**
 * 安装第三方 MCP 服务的确认卡。
 *
 * 三条不可动摇的规则（设计 §5.4）：
 * 1. **永远询问**——`HitlMode` 的三档都不作用于安装；
 * 2. **不提供「本会话内允许」**——那是工具执行的粒度，不是供应链决策；
 * 3. **活跃标记不是安全审核**——这句话每次都要出现，不能因为风险低就省略。
 */
export function RegistryInstallCard() {
  const pending = usePendingHitl();
  if (!pending || pending.kind !== "registry-install") return null;
  return (
    <RegistryInstallDialog
      key={pending.requestId}
      requestId={pending.requestId}
      preview={pending.payload as RegistryInstallPreview}
    />
  );
}

export interface RegistryInstallDialogProps {
  requestId: string;
  preview: RegistryInstallPreview;
  /** 测试注入：不走全局 store。 */
  onDecide?: (decision: InstallDecision) => void;
}

const RISK_LABEL = { low: "低风险", medium: "中风险", high: "高风险" } as const;

const RISK_STYLE = {
  low: "border-[#d7e9dc] bg-[#f2faf5] text-[#1d6b3a]",
  medium: "border-[#f0e0b8] bg-[#fff8e6] text-[#8a5a00]",
  high: "border-[#f3c2bd] bg-[#fdf6f6] text-[#b42318]",
} as const;

export function RegistryInstallDialog({ requestId, preview, onDecide }: RegistryInstallDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const hints = preview.headerHints;
  const missingRequired = hints.some((h) => h.isRequired && !(values[h.name] ?? "").trim());

  const finish = (decision: InstallDecision) => {
    if (onDecide) {
      onDecide(decision);
      return;
    }
    useHitlStore.getState().decide({ requestId, verdicts: [], data: decision });
  };

  const approve = () => {
    const checked = sanitizeHeaders(hints, values);
    if (checked.error) {
      setError(checked.error);
      return;
    }
    finish({ approved: true, headers: checked.headers });
  };

  const footer = (
    <>
      <button
        type="button"
        ref={cancelRef}
        onClick={() => finish({ approved: false })}
        className="rounded-lg border border-line px-3 py-1.5 text-[12px] text-red-600 shadow-card hover:bg-[#fafafa]"
      >
        取消安装
      </button>
      <button
        type="button"
        disabled={missingRequired}
        title={missingRequired ? "请填写必填请求头" : undefined}
        onClick={approve}
        className="rounded-lg bg-ink px-3 py-1.5 text-[12px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        确认安装
      </button>
    </>
  );

  return (
    <ConfirmDialog
      title={`安装 ${preview.title}`}
      onCancel={() => finish({ approved: false })}
      initialFocusRef={cancelRef}
      footer={footer}
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-line px-3 py-2">
          {preview.rows.map((row) => (
            <div key={row.label} className="flex gap-2 py-0.5 text-[11px]">
              <span className="w-[52px] shrink-0 text-muted">{row.label}</span>
              <span className="min-w-0 flex-1 break-all font-mono text-[11px]">{row.value}</span>
            </div>
          ))}
        </div>

        <div className={`rounded-lg border px-3 py-2 text-[11px] ${RISK_STYLE[preview.risk.level]}`}>
          <div className="font-bold">
            {RISK_LABEL[preview.risk.level]} · {preview.risk.message}
          </div>
          {preview.risk.detail && (
            <div className="mt-1 break-all opacity-80">参考：{preview.risk.detail}</div>
          )}
        </div>

        <p className="text-[11px] text-muted">
          活跃标记只表示该条目未被下架，不代表已通过安全审核。
        </p>

        {hints.length > 0 && (
          <div className="rounded-lg border border-line px-3 py-2">
            <div className="text-[11px] font-bold text-[#777]">该服务需要以下请求头</div>
            {hints.map((h) => (
              <label key={h.name} className="mt-2 block text-[11px] text-muted">
                {h.name}
                {h.isRequired ? "（必填）" : "（可选）"}
                <input
                  aria-label={`请求头 ${h.name}`}
                  type={h.isSecret ? "password" : "text"}
                  autoComplete="off"
                  value={values[h.name] ?? ""}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [h.name]: e.target.value }));
                    setError(null);
                  }}
                  placeholder={h.placeholder ?? (h.isSecret ? "敏感值，仅保存在本机" : "")}
                  className="mt-1 block w-full rounded-lg border border-line px-3 py-2 font-mono text-[11px] text-ink outline-hidden focus:border-[#bbb]"
                />
                {h.description && <span className="mt-0.5 block text-[10px] text-[#999]">{h.description}</span>}
              </label>
            ))}
          </div>
        )}

        {error && (
          <p role="alert" className="text-[11px] text-[#b42318]">
            {error}
          </p>
        )}

        <p className="text-[11px] text-muted">
          安装后服务会出现在接口区，<strong>工具默认全部关闭</strong>，需要你逐个授权。
        </p>
      </div>
    </ConfirmDialog>
  );
}
