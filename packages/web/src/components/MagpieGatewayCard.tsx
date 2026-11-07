import { useState } from "react";
import { useLlmStore } from "../store/llm.js";
import { DEFAULT_GATEWAY, normalizeGatewayBaseUrl } from "../lib/magpieClient.js";

/**
 * 设置区 · 模型（d.89：magpie 原生组件）。
 *
 * 和鸣不再直连各家模型供应商：账号、订阅、多 Key 轮换与额度选路都由本机 magpie 负责，
 * 这里只配一条「网关地址 + 网关 Key」，并从网关目录里列出模型。
 *
 * 为什么不再有服务商预设 / 协议选择 / 手填 BaseURL+Key：
 * 那套东西等于让用户在和鸣里重新维护一份供应商账号，与「用已有 Agent 的 token」相悖；
 * 模型清单以网关 `/v1/models` 为准，增删模型在 magpie 里做。
 *
 * 数据边界：网关 Key 只存本机（与旧 Key 一样走本机存储），不发往和鸣服务端；
 * 本页的「读取模型」只请求本机/用户填的网关地址，不经过云端。
 */
function fieldClass(): string {
  return "mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-hidden focus:border-[#bbb]";
}

export function MagpieGatewayCard() {
  const gateway = useLlmStore((s) => s.gateway);
  const models = useLlmStore((s) => s.models);
  const gatewayVersion = useLlmStore((s) => s.gatewayVersion);
  const setGateway = useLlmStore((s) => s.setGateway);
  const refreshCatalog = useLlmStore((s) => s.refreshCatalog);

  const [baseUrl, setBaseUrl] = useState(gateway.baseUrl);
  const [key, setKey] = useState(gateway.key);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const normalize = (value: string) => normalizeGatewayBaseUrl(value);

  const saveOnly = () => {
    setGateway({ baseUrl: normalize(baseUrl), key });
    setStatus({ kind: "ok", text: "已保存网关配置。点「读取模型」从 magpie 拉取当前可用的模型。" });
  };

  const connect = async () => {
    setBusy(true);
    setStatus(null);
    try {
      setGateway({ baseUrl: normalize(baseUrl), key });
      const catalog = await refreshCatalog();
      setStatus({
        kind: "ok",
        text: catalog.models.length
          ? `已连接${catalog.version ? `（magpie ${catalog.version}）` : ""}，读到 ${catalog.models.length} 个模型。`
          : "已连上网关，但网关里还没有可用模型：先去 magpie 里添加供应商或登录账号。",
      });
    } catch (err) {
      setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const resetDefault = () => {
    setBaseUrl(DEFAULT_GATEWAY.baseUrl);
    setKey(DEFAULT_GATEWAY.key);
    setStatus(null);
  };

  return (
    <section className="mt-3 rounded-xl border border-line bg-white p-4 shadow-card" aria-label="模型">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-bold text-muted">模型</span>
          <span className="ui-caption">由本机 magpie 网关提供，和鸣不直连供应商</span>
        </div>
        <span className="ui-caption">
          {gatewayVersion ? `magpie ${gatewayVersion}` : models.length ? "上次读到的模型" : "尚未连接"}
        </span>
      </div>

      <p className="mt-1 ui-caption">
        订阅账号、API Key、多账号轮换与额度选路都在 magpie 里管理；这里填它的网关地址与网关 Key。
        本机默认 `{DEFAULT_GATEWAY.baseUrl}`，Key 填 `{DEFAULT_GATEWAY.key}` 即可。
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block ui-caption">
          网关地址
          <input
            aria-label="magpie 网关地址"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_GATEWAY.baseUrl}
            className={fieldClass()}
          />
        </label>
        <label className="block ui-caption">
          网关 Key
          <input
            aria-label="magpie 网关 Key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={DEFAULT_GATEWAY.key}
            className={fieldClass()}
          />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void connect()} disabled={busy} className="ui-btn ui-btn-md ui-btn-primary">
          {busy ? "连接中…" : "读取模型"}
        </button>
        <button type="button" onClick={saveOnly} disabled={busy} className="ui-btn ui-btn-md ui-btn-ghost">
          仅保存
        </button>
        <button type="button" onClick={resetDefault} disabled={busy} className="ui-btn ui-btn-md ui-btn-ghost">
          恢复本机默认
        </button>
        <span className="ui-caption">「读取模型」只请求上面这个地址，不经过和鸣服务端。</span>
      </div>

      {status && (
        <div
          role={status.kind === "error" ? "alert" : "status"}
          className={`mt-2 ui-body-sm ${status.kind === "error" ? "text-[#b42318]" : "text-muted"}`}
        >
          {status.text}
        </div>
      )}

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-bold text-muted">可用模型（{models.length}）</span>
          <span className="ui-caption">模型由 magpie 提供；增减请去 magpie 里操作</span>
        </div>
        {models.length === 0 ? (
          <p className="mt-1 ui-caption">
            还没有读到模型。确认 magpie 在运行后点「读取模型」；新装和鸣的用户先去 magpie 里添加供应商或登录已有账号。
          </p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="ui-table min-w-[560px]" aria-label="可用模型">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>网关 id</th>
                  <th>上下文</th>
                  <th>能力</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => (
                  <tr key={model.id}>
                    <td className="font-medium">{model.name}</td>
                    <td className="font-mono text-[11px] text-muted">{model.id}</td>
                    <td className="ui-numeric">
                      {model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K` : "未知"}
                    </td>
                    <td className="ui-caption">
                      {[
                        model.vision ? "看图" : "",
                        model.reasoningLevels.length ? `推理 ${model.reasoningLevels.join("/")}` : "",
                      ]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-3 ui-caption">
        智能体绑定与候选链绑定的都是「模型」；换模型不用改 Key。旧版保存的供应商连接已按本轮决定清除。
      </p>
    </section>
  );
}
