import { StaffPage } from "./components/StaffPage.js";
import { StaffHomeCard } from "./components/StaffHomeCard.js";
import { useStaffLoop } from "./lib/staff/loop.js";

/** 幕僚模块（d.131 M2）：页面、后台巡检、首页卡由模块自己提供。 */
export const manifest = { id: "staff", version: "1.0.0" };

export const pages = { staff: StaffPage };
export const homeCards = { staff: StaffHomeCard };

/** 后台巡检：宿主按模块生效状态渲染 <Background active={...}/>。 */
export function StaffBackground({ active }: { active: boolean }) {
  useStaffLoop(active);
  return null;
}

export const background = { staff: StaffBackground };
