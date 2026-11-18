import { ChevronIcon } from "../icons.js";
import { Avatar } from "./Avatar.js";
import type { DomesticAgent } from "../../lib/magpieDomestic.js";

/**
 * 国内智能体的一张卡片（模型页 → 来源 → 订阅账号 → 国内智能体）。
 *
 * 这些端的账号由社区插件供给（内核的登录流只认 Claude/ChatGPT/Copilot/Gemini/
 * Antigravity），所以卡片右侧要如实说清下一步：还没装插件是「先装插件」，
 * 装好没登录是「登录」，登录过就报一共有几个账号——三句话对应三种状态，
 * 不拿「登录」两个字糊住一条走不通的路。
 *
 * `local` 是「这台机器上装了它的客户端」（从 `magpie ls` 读出来的）：装了却还没
 * 登录，比一张孤零零的「先装插件」更能说明「这里本来就有一个账号可以借」。
 */
export interface DomesticCardProps {
  item: DomesticAgent;
  /** 这个端已经登录了几个账号。 */
  signedIn: number;
  /** 有插件在服务这个端：没有它，登录与额度都读不到。 */
  pluginReady: boolean;
  /** 本机检测到这个端的客户端。 */
  local?: boolean;
  busy: boolean;
  onPress: (item: DomesticAgent) => void;
}

export function DomesticCard({ item, signedIn, pluginReady, local = false, busy, onPress }: DomesticCardProps) {
  const state =
    signedIn > 0 ? `已登录${signedIn > 1 ? ` ${signedIn} 个` : ""}` : pluginReady ? "登录" : "先装插件";
  return (
    <button
      type="button"
      className="ui-card ui-card-interactive flex items-center gap-2 px-3 py-2 text-left disabled:opacity-50"
      disabled={busy}
      onClick={() => onPress(item)}
      title={item.risk}
    >
      <Avatar name={item.label} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="min-w-0 truncate text-ui-md font-semibold">{item.label}</span>
          {item.checkin && <span className="ui-chip">签到</span>}
          {local && (
            <span className="ui-chip border-success-line bg-success-soft text-success" title="magpie ls 在本机找到了它">
              本机已装
            </span>
          )}
        </span>
        <span className="block ui-caption">{item.desc}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-ui-xs text-muted">
        {state}
        <ChevronIcon width={14} height={14} />
      </span>
    </button>
  );
}
