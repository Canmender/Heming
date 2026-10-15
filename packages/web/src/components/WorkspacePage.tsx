import { RadarContacts } from "./RadarContacts.js";

/**
 * 工作区 = 雷达通讯录主视图（定稿：圆形雷达三扇区）。
 * 原好友列表/申请表单/直聊列表已迁移：申请与待处理在「＋ 加好友」面板、
 * 直聊/群聊节点在雷达扇区（见 RadarContacts.tsx）。
 */
export function WorkspacePage() {
  return <RadarContacts />;
}
