import { useState } from "react";

export interface AvatarUser {
  displayName: string;
  avatar?: string;
}

/**
 * 圆形头像（全站统一）：
 * - 有 avatar → 圆形 <img>（object-cover），加载失败（onError）回退首字；
 * - 无 avatar → 昵称首字圆底（浅灰 #f1f1f1），替代旧人形图标。
 */
export function Avatar({
  user,
  size = 28,
  className = "",
}: {
  user: AvatarUser;
  /** 雷达节点/悬浮卡用到 38/40；29 为外圈 far 节点小号。 */
  size?: 22 | 28 | 29 | 32 | 38 | 40;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = user.displayName.trim().charAt(0) || "?";
  const fontSize = size >= 38 ? 15 : size >= 32 ? 14 : size >= 28 ? 12 : 11;

  if (user.avatar && !failed) {
    return (
      <img
        src={user.avatar}
        alt=""
        style={{ width: size, height: size }}
        className={`shrink-0 rounded-full object-cover ${className}`}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      style={{ width: size, height: size, fontSize }}
      className={`flex shrink-0 items-center justify-center rounded-full bg-[#f1f1f1] font-medium text-[#555] ${className}`}
    >
      {initial}
    </span>
  );
}
