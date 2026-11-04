import { useEffect, useRef, useState } from "react";
import {
  MAX_PLUGINS,
  publicKeyFingerprint,
  verifyManifestSignature,
  type PluginInstallOptions,
  type PluginInstallPreview,
  type PluginManifest,
  type PublisherTrustStore,
  type SignatureCheck,
} from "../../lib/plugins/index.js";
import { useModalA11y } from "../useModalA11y.js";
import { XIcon } from "../icons.js";
import { PluginPermissionList } from "./PluginPermissionList.js";
import {
  BTN_GHOST,
  BTN_GHOST_SM,
  BTN_PRIMARY,
  CHIP,
  ERROR_TEXT,
  HINT,
  DiffLine,
  hasPreviewChanges,
  serverDiffLine,
} from "./shared.js";
import {
  authorChangeText,
  contributionText,
  manifestContributionCounts,
  permissionViewOf,
  shortFingerprint,
  signatureStatusLabel,
  trustStatusText,
} from "./viewModel.js";

/**
 * 安装 / 更新弹窗（d.64 · T2）。
 *
 * 解析成功后就地展示 v3 摘要：schemaVersion、贡献计数、权限清单（网络主机 ≤3 行 +
 * 共 N 项、风险上限、文件根）、与已装项差异（沿用 DiffChips）。
 * v1/v2 包可以安装，但明确标注「旧版清单（vN）：未声明权限，按既有口径处理」。
 */
export function InstallDialog({
  text,
  previewState,
  onTextChange,
  onFile,
  onInstall,
  onClose,
  publishers,
  verify = verifyManifestSignature,
  fingerprintOf = publicKeyFingerprint,
}: {
  text: string;
  previewState: { data: PluginInstallPreview | null; error: string | null };
  onTextChange: (next: string) => void;
  onFile: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** 带上已完成的信任结论交给 store（安装选项） */
  onInstall: (options: PluginInstallOptions) => void;
  onClose: () => void;
  /** 发布者信任表（TOFU）；确认安装且用户勾选/已信任时写入 */
  publishers: PublisherTrustStore;
  /** 验签实现（测试注入；默认 WebCrypto） */
  verify?: (manifest: PluginManifest) => Promise<SignatureCheck>;
  /** 公钥指纹实现（测试注入；默认 SHA-256） */
  fingerprintOf?: (publicKey: string) => Promise<string>;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, { active: true });

  const preview = previewState.data;
  const updating = Boolean(preview?.existing);
  const manifest = preview?.manifest ?? null;
  /** 覆盖确认勾选（d.66）：needsConfirm 时必须显式勾选，换清单就复位。 */
  const [trustAcked, setTrustAcked] = useState(false);
  /** 发布者信任勾选（d.67）：首次信任 / 换钥复核各一个，默认都不勾。 */
  const [trustPublisher, setTrustPublisher] = useState(false);
  const [ackKeyChange, setAckKeyChange] = useState(false);
  /** 异步验签结果；null = 尚未完成（含「校验中…」）。 */
  const [signatureCheck, setSignatureCheck] = useState<SignatureCheck | null>(null);
  const [publisherFingerprint, setPublisherFingerprint] = useState<string | null>(null);

  const trustFingerprint = preview?.trust.fingerprint ?? "";
  useEffect(() => {
    setTrustAcked(false);
    setTrustPublisher(false);
    setAckKeyChange(false);
  }, [trustFingerprint]);

  // 解析出清单后异步验签：用取消标记防竞态（用户改清单/关弹窗时旧结果不能回写）。
  useEffect(() => {
    if (!manifest) {
      setSignatureCheck(null);
      setPublisherFingerprint(null);
      return;
    }
    let cancelled = false;
    setSignatureCheck(null);
    setPublisherFingerprint(null);
    void (async () => {
      // 验签与指纹分开 try：指纹算不出来（弱环境/无 subtle）不能把「环境不支持」
      // 篡改成「签名无效」——那会让用户以为内容被篡改，实际只是浏览器给不了 WebCrypto。
      let check: SignatureCheck;
      try {
        check = await verify(manifest);
      } catch (error) {
        check = {
          status: "invalid",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (cancelled) return;
      setSignatureCheck(check);
      if (!manifest.publisher) return;
      try {
        const fingerprint = await fingerprintOf(manifest.publisher.publicKey);
        if (!cancelled) setPublisherFingerprint(fingerprint);
      } catch {
        // 指纹失败只影响展示与信任记录，不改变验签结论
        if (!cancelled) setPublisherFingerprint(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manifest, verify, fingerprintOf]);

  const needsTrustConfirm = Boolean(preview?.trust.needsConfirm);
  const trustConfirmId = "plugin-trust-confirm";
  const requirementsId = "plugin-install-requirements";
  // 只有「带签名的清单」在验签完成前禁止安装；未签名清单无需等待 WebCrypto。
  const verifying = Boolean(preview && manifest?.signature && !signatureCheck);
  const publisherId = manifest?.publisher?.id ?? "";
  const trustedPublisher = publisherId ? publishers.get(publisherId) : undefined;
  /**
   * 信任/换钥只在**验签通过**时才要求确认：未签名、环境不支持、无效签名都没有
   * 「可以信任的公钥结论」——对它们要求勾选只是让用户假装确认，记下的指纹也不可信。
   */
  const signatureVerified = signatureCheck?.status === "valid";
  /** 该发布者从没被信任过：首次信任必须勾选。 */
  const needsPublisherTrust = Boolean(signatureVerified && publisherId && !trustedPublisher);
  const needsKeyAck = Boolean(signatureVerified && preview?.trust.publisherKeyChanged);
  const invalidSignature = signatureCheck?.status === "invalid";
  const unmet =
    (needsTrustConfirm && !trustAcked) ||
    (needsPublisherTrust && !trustPublisher) ||
    (needsKeyAck && !ackKeyChange);
  const blocked = Boolean(
    preview &&
      (preview.conflicts.length > 0 || preview.limitReached || verifying || invalidSignature || unmet),
  );
  const authorChangedTip = preview ? authorChangeText(preview.trust, preview.manifest.author) : null;

  /** 确认安装：把验签结论与已确认的发布者交给 store；信任记录只在勾选/已信任时写。 */
  const submitInstall = () => {
    if (!preview || blocked) return;
    const publisher =
      signatureVerified && manifest?.publisher && publisherFingerprint
        ? { id: manifest.publisher.id, fingerprint: publisherFingerprint }
        : null;
    onInstall({
      publisher,
      signatureStatus: signatureCheck?.status ?? "unsupported",
    });
    if (publisher && signatureVerified && manifest?.publisher) {
      const trustedAll = (!needsPublisherTrust || trustPublisher) && (!needsKeyAck || ackKeyChange);
      if (trustedAll) {
        publishers.remember({
          id: publisher.id,
          publicKey: manifest.publisher.publicKey,
          fingerprint: publisher.fingerprint,
        });
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="安装插件"
        className="flex max-h-[88vh] w-[min(620px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          <span className="ui-section-title">安装 / 更新插件</span>
          <button
            type="button"
            aria-label="关闭安装面板"
            onClick={onClose}
            className="rounded-sm p-1 text-muted hover:bg-[#f3f3f3] hover:text-ink"
          >
            <XIcon width={14} height={14} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <label className="block ui-caption">
            插件清单 JSON
            <textarea
              aria-label="插件清单 JSON"
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              placeholder={`{\n  "schemaVersion": 3,\n  "id": "acme.finance",\n  "name": "财务助手包",\n  "version": "1.0.0",\n  "permissions": { "network": [], "tools": "read", "files": [] },\n  "contributions": {\n    "skills": [ ... ],\n    "mcpServers": [ ... ],\n    "commands": [ ... ]\n  }\n}`}
              className="mt-1 block min-h-[160px] w-full resize-y rounded-lg border border-line-strong px-3 py-2 font-mono text-[11px] outline-hidden focus:border-ink"
            />
          </label>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              id="plugin-file-input"
              type="file"
              accept=".json,application/json"
              aria-label="选择插件文件"
              onChange={onFile}
              className="hidden"
            />
            <label htmlFor="plugin-file-input" className={`cursor-pointer ${BTN_GHOST_SM}`}>
              选择 plugin.json 文件
            </label>
            <span className={HINT}>只读取本地 JSON；不会上传，也不会执行其中的内容。</span>
          </div>

          {previewState.error && (
            <p role="alert" className={`mt-3 ${ERROR_TEXT}`}>
              清单不合法：{previewState.error}
            </p>
          )}

          {preview && (
            <div className="mt-3 rounded-lg border border-line bg-[#fafafa] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ui-body-sm font-bold">{preview.manifest.name}</span>
                <span className={CHIP}>v{preview.manifest.version}</span>
                <span className={CHIP}>{updating ? "将覆盖更新" : "新插件"}</span>
                <span className={CHIP}>schemaVersion {preview.manifest.schemaVersion}</span>
              </div>
              <div className={`mt-0.5 ${HINT}`}>{preview.manifest.id}</div>
              <p className="mt-1 break-words ui-body-sm text-[#555]">
                {preview.manifest.description || "暂无描述"}
              </p>

              {/* 信任行（d.66）：内容指纹 + 首装/与上次相同/不同；不是签名，只发现悄悄改动 */}
              <div className="mt-1 flex flex-wrap items-center gap-2 ui-caption">
                <span
                  className="font-mono"
                  title={`内容指纹：用来发现内容是否被改过，不代表已审核来源：${preview.trust.fingerprint}`}
                >
                  内容指纹 {shortFingerprint(preview.trust.fingerprint)}
                </span>
                <span className={CHIP}>{trustStatusText(preview.trust)}</span>
              </div>
              {authorChangedTip && (
                <p role="alert" className={`mt-1 ${ERROR_TEXT}`}>
                  {authorChangedTip}
                </p>
              )}
              {preview.trust.sameVersionContentChanged && (
                <p role="alert" className={`mt-1 ${ERROR_TEXT}`}>
                  版本未变，但内容有变化
                </p>
              )}

              {/* 签名行（d.67）：异步 WebCrypto 验签；未验完不许装，失败绝不绕过 */}
              <div className="mt-1 flex flex-wrap items-center gap-2 ui-caption">
                <span>
                  签名：
                  <span role="status">
                    {verifying ? "校验中…" : signatureStatusLabel(signatureCheck?.status ?? "unsupported")}
                  </span>
                </span>
                {manifest?.publisher && (
                  <span
                    className="font-mono"
                    title={publisherFingerprint ? `发布者公钥指纹：${publisherFingerprint}` : undefined}
                  >
                    发布者：{manifest.publisher.id}
                    {publisherFingerprint ? ` · ${shortFingerprint(publisherFingerprint)}` : " · 指纹不可用"}
                  </span>
                )}
              </div>
              {signatureCheck?.reason && signatureCheck.status !== "valid" && (
                <p className={invalidSignature ? `mt-1 ${ERROR_TEXT}` : `mt-1 ${HINT}`}>
                  {signatureCheck.reason}
                </p>
              )}
              {invalidSignature && (
                <p role="alert" className={`mt-1 ${ERROR_TEXT}`}>
                  签名与清单内容不匹配，已拒绝安装。
                </p>
              )}
              {needsKeyAck && (
                <p role="alert" className={`mt-1 ${ERROR_TEXT}`}>
                  发布者公钥已变更：核对指纹后勾选下方「我已核对发布者公钥变更」才能继续。
                </p>
              )}

              {/* 贡献计数：与插件卡同一口径 */}
              <p className={`mt-1 ${HINT}`}>
                贡献：{contributionText(manifestContributionCounts(preview.manifest))}
              </p>

              <PluginPermissionList
                view={permissionViewOf(preview.manifest)}
                schemaVersion={preview.manifest.schemaVersion}
              />

              {updating ? (
                <div className="mt-2 space-y-2">
                  <DiffLine label="技能" diff={preview.skills} />
                  <DiffLine label="MCP 服务" diff={serverDiffLine(preview.servers)} />
                  <p className={HINT}>
                    {hasPreviewChanges(preview)
                      ? "确认后将保留：接口区补的请求头、已授权工具、插件启停状态与安装时间。"
                      : "清单与已装内容一致，确认后只刷新更新时间。"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {preview.manifest.contributions.skills.map((skill) => (
                      <span key={`skill:${skill.name}`} className={CHIP}>
                        {skill.name}
                      </span>
                    ))}
                    {preview.manifest.contributions.mcpServers.map((server) => (
                      <span key={`server:${server.key}`} className={CHIP} title={server.url}>
                        MCP · {server.name}
                      </span>
                    ))}
                    {preview.manifest.contributions.commands.map((command) => (
                      <span key={`command:${command.id}`} className={CHIP} title={command.description}>
                        命令 · {command.title}
                      </span>
                    ))}
                  </div>
                  <div className={`mt-2 ${HINT}`}>
                    新增 {preview.skills.added.length} 个技能、
                    {preview.servers.added.length} 台 MCP 服务
                  </div>
                </>
              )}

              {preview.manifest.contributions.mcpServers.length > 0 && (
                <div className={`mt-2 ${HINT}`}>
                  网络访问：{preview.hosts.join("、") || "—"}
                  <br />
                  安装后需到接口区连接并逐个启用工具；调用仍走人工确认。
                </div>
              )}

              {preview.conflicts.length > 0 && (
                <p role="alert" className={`mt-2 ${ERROR_TEXT}`}>
                  MCP 服务 id 冲突：
                  {preview.conflicts.map((item) => `${item.name}（${item.id}）`).join("、")}
                  ；请先到接口区删除或改名，再安装。
                </p>
              )}
              {preview.limitReached && (
                <p role="alert" className={`mt-2 ${ERROR_TEXT}`}>
                  插件数量已达上限（{MAX_PLUGINS} 个），请先卸载不用的插件。
                </p>
              )}

              {needsTrustConfirm && (
                <div className="mt-3 rounded-lg border border-[#f3d2ce] bg-[#fffafa] p-2.5">
                  <label className="flex items-start gap-2 ui-body-sm">
                    <input
                      type="checkbox"
                      checked={trustAcked}
                      onChange={(e) => setTrustAcked(e.target.checked)}
                      aria-describedby={`${trustConfirmId}-hint`}
                    />
                    我已确认这次覆盖更新
                  </label>
                  <p id={`${trustConfirmId}-hint`} className="mt-1 ui-caption">
                    该插件与已装版本内容不同（
                    {[
                      preview.trust.sameVersionContentChanged ? "版本未变" : "",
                      preview.trust.authorChanged ? "作者变化" : "",
                    ]
                      .filter(Boolean)
                      .join("、")}
                    ）。内容指纹只用于发现「内容被悄悄改过」，不是签名，不证明作者与来源。
                  </p>
                </div>
              )}

              {(needsPublisherTrust || needsKeyAck) && (
                <div className="mt-3 rounded-lg border border-[#f3d2ce] bg-[#fffafa] p-2.5">
                  {needsPublisherTrust && manifest?.publisher && (
                    <label className="flex items-start gap-2 ui-body-sm">
                      <input
                        type="checkbox"
                        checked={trustPublisher}
                        onChange={(e) => setTrustPublisher(e.target.checked)}
                        aria-describedby={requirementsId}
                      />
                      我信任发布者 {manifest.publisher.id} 的公钥
                    </label>
                  )}
                  {needsKeyAck && (
                    <label className="mt-1.5 flex items-start gap-2 ui-body-sm">
                      <input
                        type="checkbox"
                        checked={ackKeyChange}
                        onChange={(e) => setAckKeyChange(e.target.checked)}
                        aria-describedby={requirementsId}
                      />
                      我已核对发布者公钥变更
                    </label>
                  )}
                  <p id={requirementsId} className="mt-1 ui-caption">
                    你确认过的发布者会被记住；公钥变了会再问你一次。
                    验签失败或公钥变更未确认时，本次安装不会继续。
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            取消
          </button>
          <button
            type="button"
            onClick={submitInstall}
            disabled={!preview || blocked}
            aria-describedby={
              [
                needsTrustConfirm ? `${trustConfirmId}-hint` : "",
                needsPublisherTrust || needsKeyAck ? requirementsId : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            className={BTN_PRIMARY}
          >
            {updating ? "确认更新" : "确认安装"}
          </button>
        </div>
      </div>
    </div>
  );
}
