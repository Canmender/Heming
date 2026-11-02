/**
 * 在线登记（d.54 团队系统）。
 *
 * 只存在于服务端进程内：WS 鉴权成功即 +1，该用户最后一个连接断开即 -1。
 * 不落库、不广播；`GET /api/team` 读取在线集合，前端轮询叠加最近活跃时间。
 * 进程重启后集合清空，这是预期语义——「在线」本来就只描述当前进程的连接。
 */
const socketsByUser = new Map<string, number>();

export const presence = {
  online(userId: string): void {
    socketsByUser.set(userId, (socketsByUser.get(userId) ?? 0) + 1);
  },
  offline(userId: string): void {
    const next = (socketsByUser.get(userId) ?? 0) - 1;
    if (next > 0) socketsByUser.set(userId, next);
    else socketsByUser.delete(userId);
  },
  isOnline(userId: string): boolean {
    return (socketsByUser.get(userId) ?? 0) > 0;
  },
  count(): number {
    return socketsByUser.size;
  },
  /** 测试用：清空登记。生产路径不调用。 */
  reset(): void {
    socketsByUser.clear();
  },
};
