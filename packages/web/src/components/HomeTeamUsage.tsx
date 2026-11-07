import { useCallback, useEffect, useState } from "react";
import type { TeamUsageResponse } from "@heming/shared";
import { fetchTeamUsage, uploadTeamUsage } from "../lib/api.js";
import { collectCurrentTeamUsage, useTeamShareStore } from "../lib/team/share.js";
import { dayKeyOf } from "../store/tokenUsage.js";
import { useAuthStore } from "../store/auth.js";
import { useUiStore } from "../store/ui.js";
import { fmtTokens } from "../lib/format/tokens.js";
import { EmptyState } from "./ui/EmptyState.js";
import { SkeletonLine } from "./ui/Skeleton.js";

const TOP_N = 5;

/**
 * 首页「Token 用量」卡片的「团队」页签：近 30 天全站用量排行（前 5 名 + 我的合计）。
 *
 * 边界与团队页一致：
 * - 关闭「用量」共享时不采集、不上传、不请求；只给一句说明与开启入口，不拿旧数据冒充。
 * - 排行只显示**显示名 + 聚合 token 数**，模型名、连接名、对话内容都不露；
 *   服务端契约本身也只返回这两列（见 `TeamUsageRankRowSchema`）。
 * - 打开页签时先按团队页同一套白名单摘要同步一次（服务端 `(actor,date,model)` 幂等），
 *   否则用户没先去团队页时这里永远是空榜。
 */
export function HomeTeamUsage() {
  const share = useTeamShareStore((s) => s.settings);
  const setLastSync = useTeamShareStore((s) => s.setLastSync);
  const me = useAuthStore((s) => s.user);
  const setPage = useUiStore((s) => s.setPage);
  const [data, setData] = useState<TeamUsageResponse | null>(null);
  const [ready, setReady] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  const usageOn = share.usage;

  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const items = collectCurrentTeamUsage(useTeamShareStore.getState().settings);
      if (items.length > 0) await uploadTeamUsage(items);
      const next = await fetchTeamUsage({
        range: "30d",
        to: dayKeyOf(new Date().toISOString()),
      });
      setData(next);
      setError("");
      setLastSync(Date.now());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "网络异常");
    } finally {
      setReady(true);
      setSyncing(false);
    }
  }, [setLastSync]);

  useEffect(() => {
    if (!usageOn) {
      setData(null);
      setReady(true);
      return;
    }
    void sync();
  }, [usageOn, sync]);

  if (!usageOn) {
    return (
      <div className="mt-2">
        <p className="text-[11px] leading-5 text-muted">
          「用量」共享未开启：不上传、不采集，也看不到全站排行。开启后只同步近 30
          天的 token 数、模型名与连接名。
        </p>
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-ghost mt-2"
          onClick={() => setPage("team")}
        >
          去团队页开启
        </button>
      </div>
    );
  }

  if (!ready) {
    return (
      <div role="status" aria-label="正在加载团队用量" className="mt-2 flex flex-col gap-1.5">
        {[0, 1, 2].map((i) => (
          <SkeletonLine key={i} className="h-6 rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-2 flex items-center gap-2">
        <span role="alert" className="min-w-0 flex-1 truncate text-[11px] text-muted">
          用量排行加载失败：{error}
        </span>
        <button
          type="button"
          className="ui-link shrink-0"
          disabled={syncing}
          onClick={() => void sync()}
        >
          {syncing ? "重试中…" : "重试"}
        </button>
      </div>
    );
  }

  const ranking = data?.ranking ?? [];
  const selfTotal = data?.self.total ?? 0;

  return (
    <div className="mt-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] text-muted">近 30 天 · 全站排行（只含显示名与 token 数）</span>
        <button
          type="button"
          className="ui-link ml-auto shrink-0"
          onClick={() => setPage("team")}
        >
          团队页
        </button>
      </div>

      {ranking.length === 0 ? (
        <EmptyState
          compact
          className="px-0 py-2"
          title="还没有排行数据"
          desc="共享已开启，但近 30 天还没有可统计的调用。在「团队」页点一次同步后，这里会出现前 5 名。"
        />
      ) : (
        <ol className="mt-1.5 space-y-1">
          {ranking.slice(0, TOP_N).map((row, i) => (
            <li key={row.userId} className="flex items-baseline gap-2 text-[11px]">
              <span className="w-4 shrink-0 tabular-nums text-muted">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">
                {row.displayName}
                {row.userId === me?.id ? <span className="ml-1 text-muted">（我）</span> : null}
              </span>
              <span className="shrink-0 tabular-nums font-semibold">{fmtTokens(row.tokens)}</span>
            </li>
          ))}
        </ol>
      )}

      {selfTotal > 0 ? (
        <div className="mt-1.5 border-t border-line-soft pt-1.5 text-[11px] text-muted">
          我的用量 <b className="tabular-nums">{fmtTokens(selfTotal)}</b>
        </div>
      ) : null}
    </div>
  );
}
