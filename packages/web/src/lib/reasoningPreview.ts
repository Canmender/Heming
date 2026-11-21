/**
 * 思考片段的大小控制（d.247）。
 *
 * 为什么单独抽出来：思考过程是模型的自言自语，长度不受控——实测一次能写几千到几万字，
 * 而它渲染在**正文上方**。不设上限时有两个后果：①本条气泡把正文顶到屏幕外，
 * 用户要滚半天才看到答案；②一条消息就上万字，滚动与重排都变卡（流式还在逐字追加）。
 *
 * 这里的口径是**按内容截断**，不是加内层滚动条：`AgentStreamBubble` 里有一条既有决定
 * （B 轨 E5）——轨迹区域只保留一层滚动，嵌套滚动条在触控板上会「卡在里层」，用户滚不到
 * 消息列表。所以这里用「只显示一段 + 展开全部」，不制造第二个滚动容器。
 *
 * 两个方向各有道理，分开给：
 * - 流式中（`mode: "tail"`）：用户关心的是**它现在想到哪**，留尾巴。
 * - 回看时（`mode: "head"`）：用户想从头读，留开头。
 */
export const REASONING_PREVIEW_LINES = 12;
export const REASONING_PREVIEW_CHARS = 800;

export interface ReasoningPreview {
  /** 要渲染的那一段（流式中是尾巴，回看是开头）。 */
  text: string;
  /** 是否被截断了（false 时 text 就是全文，调用方不该出现「展开全部」）。 */
  clipped: boolean;
  /** 没显示出来的字数。 */
  hiddenChars: number;
  /** `tail` = 保留末尾、`head` = 保留开头。 */
  mode: "head" | "tail";
}

/**
 * 把一段思考文本压到「最多 N 行且不超过 M 字」。
 *
 * 为什么两个上限都要：只有字数时，长段落会被截成一行超长文本（阅读体验差、还会撑宽）；
 * 只有行数时，一行两万字的段落照样能把气泡撑满。取两者中更严格的那个。
 *
 * `mode: "tail"` 时从末尾往回取，并保证不把代理对（emoji）切一半。
 */
export function previewReasoning(
  text: string,
  options: { mode?: "head" | "tail"; lines?: number; chars?: number } = {},
): ReasoningPreview {
  const mode = options.mode ?? "head";
  const maxLines = Math.max(1, options.lines ?? REASONING_PREVIEW_LINES);
  const maxChars = Math.max(1, options.chars ?? REASONING_PREVIEW_CHARS);
  if (text === "") return { text: "", clipped: false, hiddenChars: 0, mode };

  const byChars = clipByChars(text, maxChars, mode);
  const byLines = clipByLines(text, maxLines, mode);
  // 两种截法取「更短」的那个：谁更省空间就用谁，但绝不把短文本误判成被截断。
  const chosen = byChars.length <= byLines.length ? byChars : byLines;
  if (chosen.length >= text.length) {
    return { text, clipped: false, hiddenChars: 0, mode };
  }
  return { text: chosen, clipped: true, hiddenChars: text.length - chosen.length, mode };
}

function clipByChars(text: string, maxChars: number, mode: "head" | "tail"): string {
  if (text.length <= maxChars) return text;
  if (mode === "tail") {
    // 从末尾取，且不切断代理对。边界落点分两种：
    //   · 落在一个**低**代理（0xDC00–0xDFFF）上：它前面的高代理没被包含进来，
    //     这个 emoji 已经被劈成一半 → 起点前进 1，把落单的低代理丢掉。
    //   · 落在一个**高**代理（0xD800–0xDBFF）上：紧随其后的低代理会被一起 slice 进来，
    //     代理对是完整的 → 绝不能跳过，跳过反而会把完整 emoji 劈开。
    // 旧实现把这两种情况判反了：只在落点是高代理时 start += 1，结果要么漏过落单的低代理，
    // 要么把本来完整的 emoji 劈成两半。
    let start = text.length - maxChars;
    const first = text.charCodeAt(start);
    if (first >= 0xdc00 && first <= 0xdfff) start += 1;
    return text.slice(start);
  }
  // 从开头取：结尾若正好是高代理，说明第 maxChars 个字符只是某个 emoji 的前半，
  // 退回一格把它留给下一次渲染，避免输出落单的高代理。
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function clipByLines(text: string, maxLines: number, mode: "head" | "tail"): string {
  // 流式每帧都调这里（AgentStreamBubble 渲染思考尾巴）。旧实现 `text.split("\n")`
  // 把整段思考切成数组再取头/尾——思考能写几万字，逐字追加时每帧重建上万元素的数组，
  // 总分配量是最终文本的几百倍（O(n²)）。改成从需要的那一端扫描到 maxLines 个换行即停：
  //   · tail：从末尾数到第 maxLines 个换行，取它之后的内容（最后 maxLines 行）；
  //   · head：从开头数到第 maxLines 个换行，取它之前的内容（最前 maxLines 行）。
  // 不足 maxLines 行时返回全文，与 split().slice() 的口径完全一致。
  if (mode === "tail") {
    let seen = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text.charCodeAt(i) === 10 /* \n */ && ++seen === maxLines) return text.slice(i + 1);
    }
    return text;
  }
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */ && ++seen === maxLines) return text.slice(0, i);
  }
  return text;
}

/** 「…前面/后面还有 N 字没显示」——方向由 mode 决定，免得用户以为内容丢了。 */
export function describeReasoningClip(preview: ReasoningPreview): string {
  if (!preview.clipped) return "";
  return preview.mode === "tail"
    ? `前面还有 ${preview.hiddenChars} 字没显示`
    : `后面还有 ${preview.hiddenChars} 字没显示`;
}
