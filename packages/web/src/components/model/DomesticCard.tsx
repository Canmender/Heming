import { ChevronIcon } from "../icons.js";
import { Avatar } from "./Avatar.js";
import { QUOTA_BADGE } from "./quotaBadge.js";
import type { DomesticAgent } from "../../lib/magpieDomestic.js";
import type { AgentQuota } from "../../lib/agentQuota.js";

/**
 * 国产智能体的一张卡片（模型页 → 来源 → 订阅账号 → 国产智能体）。
 *
 * 这些端的账号来自它们自己的登录态：点一下就把这份登录接进和鸣，登录过就报一共
 * 有几个账号，全都失效了才说「重新登录」——接入这一步对用户是不可见的，
 * 不拿「登录」两个字糊住一条走不通的路。
 *
 * `local` 是「这台机器上装了它的客户端」（本机扫描时读出来的）：装了却还没
 * 登录，比一张孤零零的「接入」更能说明「这里本来就有一个账号可以借」。
 *
 * `quota`（d.284）把「这份免费额度还剩多少」直接搬到卡片上：登录之后不必再往
 * 上面的订阅账号列表里找——国内端的免费额度就是这一组卡片的事，就地看他一眼。
 * 徽标放在右侧、文案与配色来自 model/quotaBadge.ts，与「智能体」分区同一套；
 * 它在的时候就不再重复写「已登录 N 个」（那枚徽标已经说明有账号了）。
 */
export interface DomesticCardProps {
  item: DomesticAgent;
  /** 这个端已经登录了几个账号。 */
  signedIn: number;
  /** 这个端里有几个账号的登录已经失效（要重新登录才能读额度）。 */
  lapsed?: number;
  /** 本机检测到这个端的客户端。 */
  local?: boolean;
  /** 这个端最紧的那份额度；没有账号或读不到时是 null。 */
  quota?: AgentQuota | null;
  busy: boolean;
  onPress: (item: DomesticAgent) => void;
}

export function DomesticCard({
  item,
  signedIn,
  lapsed = 0,
  local = false,
  quota = null,
  busy,
  onPress,
}: DomesticCardProps) {
  const allLapsed = signedIn > 0 && lapsed >= signedIn;
  // 悬停一句话说全：额度怎么分的、本机装没装、这家的风险。
  const hint = [quota?.detail, local ? "本机扫描时找到了它的客户端" : "", item.risk]
    .filter((part) => part)
    .join(" · ");
  const state = allLapsed ? "重新登录" : signedIn > 0 ? `已登录${signedIn > 1 ? ` ${signedIn} 个` : ""}` : "接入";
  return (
    <button
      type="button"
      className="ui-card ui-card-interactive flex items-center gap-2 px-3 py-2 text-left disabled:opacity-50"
      disabled={busy}
      onClick={() => onPress(item)}
      title={hint || undefined}
    >
      <Avatar name={item.label} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="min-w-0 truncate text-ui-md font-semibold">{item.label}</span>
          {allLapsed && (
            <span className="ui-chip shrink-0 bg-warn-soft text-warn" title="登录过期了，重新登录一次就能继续读额度">
              登录已失效
            </span>
          )}
          {item.checkin && <span className="ui-chip shrink-0">签到</span>}
          {local && !quota && (
            <span className="ui-chip shrink-0 border-success-line bg-success-soft text-success" title="本机扫描时找到了它">
              本机已装
            </span>
          )}
        </span>
        <span className="block ui-caption">{item.desc}</span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-ui-xs text-muted">
        {quota ? (
          <span className={`ui-chip ${QUOTA_BADGE[quota.tone]}`} title={quota.detail}>
            {quota.label}
          </span>
        ) : (
          state
        )}
        <ChevronIcon width={14} height={14} />
      </span>
    </button>
  );
}
