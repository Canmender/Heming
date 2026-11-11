import { InfohubPage as Page } from "./components/InfohubPage.js";
import { InfohubHomeCard } from "./components/InfohubHomeCard.js";

/**
 * 信息中枢模块（d.131 M4）：页面与首页卡由模块提供；
 * 与 Python 引擎的通信仍走宿主桥（`lib/infohub/client`）——那是宿主能力，不在 UI 包里重写。
 */
export const manifest = { id: "infohub", version: "1.0.0" };

export const pages = { infohub: Page };
export const homeCards = { infohub: InfohubHomeCard };
