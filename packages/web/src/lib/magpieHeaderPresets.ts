/** 常见客户端的请求头：有些中转按客户端名字认人，抄对一份才有对应待遇。
 *
 * 每一条的值都是那个客户端自己发出来的（出处写在上面一行注释里），不伪造 Claude Code。
 * 抄进草稿只是草稿——真正发出去要用户自己点保存。
 */

export type HeaderPreset = {
  name: string;
  /** 出处一句话，显示在下拉旁边。 */
  from: string;
  headers: [string, string][];
};

export const HEADER_PRESETS: HeaderPreset[] = [
  {
    name: "Codex CLI",
    from: "codex-rs 的 default_client.rs（originator、User-Agent、version）",
    headers: [
      ["originator", "codex_cli_rs"],
      ["User-Agent", "codex_cli_rs/0.167.0 (Mac OS 26.6.0; arm64) Apple_Terminal/455"],
      ["version", "0.167.0"],
    ],
  },
  {
    name: "Gemini CLI",
    from: "gemini-cli 的 Code Assist User-Agent",
    headers: [["User-Agent", "GeminiCLI/0.67.0/gemini-2.5-pro (darwin; arm64; terminal)"]],
  },
  {
    name: "OpenCode",
    from: "opencode 的 core/src/app.ts：opencode/${channel}/${version}/${name}",
    headers: [["User-Agent", "opencode/latest/2.2.7/cli"]],
  },
  {
    name: "Kilo Code",
    from: "kilocode 的 request.ts 与 kilo-gateway headers.ts",
    headers: [
      ["HTTP-Referer", "https://kilocode.ai"],
      ["X-Title", "Kilo Code"],
      ["User-Agent", "Kilo-Code/7.8.27"],
      ["X-KILOCODE-EDITORNAME", "Kilo CLI 7.8.27"],
    ],
  },
  {
    name: "Cline",
    from: "cline 的 sdk/packages/llms/src/providers/cline-client-headers.ts（桌面端）",
    headers: [
      ["HTTP-Referer", "https://cline.bot"],
      ["X-Title", "Cline"],
      ["X-IS-MULTIROOT", "false"],
      ["X-CLIENT-TYPE", "cline-desktop"],
      ["X-CLIENT-VERSION", "3.5.54"],
      ["User-Agent", "Cline/3.5.54"],
    ],
  },
  {
    name: "Roo Code",
    from: "Roo-Code 的 src/api/providers/constants.ts DEFAULT_HEADERS",
    headers: [
      ["HTTP-Referer", "https://github.com/RooVetGit/Roo-Cline"],
      ["X-Title", "Roo Code"],
      ["User-Agent", "RooCode/3.53.0"],
    ],
  },
  {
    name: "Cherry Studio",
    from: "cherry-studio 的 src/main/utils/http.ts defaultAppHeaders",
    headers: [
      ["HTTP-Referer", "https://cherry-ai.com"],
      ["X-Title", "Cherry Studio"],
    ],
  },
];

/** 一行的名字与值：名字是按第一个冒号/等号切的，值可以为空（那代表「删掉这个头」）。 */
function splitLine(line: string): { name: string; value: string } {
  const trimmed = line.trim();
  const at = trimmed.search(/[:：=]/);
  if (at < 0) return { name: trimmed, value: "" };
  return { name: trimmed.slice(0, at).trim(), value: trimmed.slice(at + 1).trim() };
}

/**
 * 把一份预设抄进草稿：
 * - 草稿里已有同名（不分大小写）且**有值**的头，保留用户自己的值；
 * - 同名但**没值**的（写成 `Name:` 意思是删掉），填上预设的值；
 * - 草稿里没有的，追加到末尾；
 * - 空行顺手去掉（它们本来就会被解析器忽略）。
 */
export function applyHeaderPreset(text: string, preset: HeaderPreset): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  for (const [name, value] of preset.headers) {
    const at = lines.findIndex((line) => splitLine(line).name.toLowerCase() === name.toLowerCase());
    if (at < 0) {
      lines.push(`${name}: ${value}`);
      continue;
    }
    if (splitLine(lines[at] ?? "").value === "") lines[at] = `${name}: ${value}`;
  }
  return lines.join("\n");
}
