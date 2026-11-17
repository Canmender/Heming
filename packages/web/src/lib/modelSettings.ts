/**
 * 原版 magpie Settings › Models 的 Images 一段：挑一个「能看图的模型」替看不了图的模型描述图片，
 * 再挑一个「画图模型」给 `generate_image` 工具用。
 *
 * 这两个都是全站设置，不是某个模型的属性，所以走 `magpie settings`：
 *   settings get vision   / settings set vision <provider/model> / settings reset vision
 *   settings get imageGen / settings set imageGen <provider/model> / settings reset imageGen
 *
 * `settings get` 把值当 JSON 打出来（空值是 `""`），这里两种形态都认。
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** `settings get <key>` 的输出 → 现在的值（空串 = 没指定）。 */
export function parseSettingsValue(raw: string): string {
  const text = raw.replace(ANSI, "").trim();
  if (!text) return "";
  if (text.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === "string" ? parsed.trim() : "";
    } catch {
      return text.replace(/^"|"$/g, "").trim();
    }
  }
  return text;
}

/** 保存一项：有值就 set，清空就 reset（`settings set` 不接受空值）。 */
export function settingArgs(key: string, value: string): string[] {
  const clean = value.trim();
  return clean ? ["settings", "set", key, clean] : ["settings", "reset", key];
}

/** 三个键的中文标签与说明，界面与文案共用。 */
export const IMAGE_SETTING_LABEL = {
  vision: {
    title: "看图模型",
    hint: "让这个模型替看不了图的模型描述图片；不指定就自动挑一个，选「关掉」则带图片的请求直接拒绝。",
  },
  visionEffort: {
    title: "看图模型的思考档",
    hint: "看图模型描述图片时想多深；不指定就用它自己的默认。",
  },
  imageGen: {
    title: "画图模型",
    hint: "智能体要生成图片时交给它；填 provider/model，不指定就关掉。",
  },
} as const;
