import { useUiStore } from "../store/ui.js";
import { RadarContacts } from "./RadarContacts.js";
import { ContactColumn } from "./ContactColumn.js";
import { ContactDetail } from "./ContactDetail.js";

/**
 * 工作区三态：无 detailContact = 雷达主视图；置位 = 左侧分组竖列 + 右侧联系人详情卡
 * （雷达节点点击进详情；竖列点头像切换详情）。
 */
export function WorkspacePage() {
  const detail = useUiStore((s) => s.detailContact);
  if (!detail) return <RadarContacts />;
  return (
    <div className="flex h-full min-h-0">
      <ContactColumn />
      <div className="min-w-0 flex-1">
        <ContactDetail target={detail} />
      </div>
    </div>
  );
}
