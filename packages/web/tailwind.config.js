/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        line: "#e6e6e6",
        "line-soft": "#ececec",
        // 弱化文字：原 #888888 白底对比度 3.54:1（AA 正文要求 4.5），
        // ③-2 巡检按 token 实测后调到 #6f6f6f（白底 5.02:1 / 页面底 #fafafa 4.81:1）。
        muted: "#6f6f6f",
        ink: "#1a1a1a",
        panel: "#fcfcfc",
        // 表单控件边界专用（非文本 UI 需 ≥3:1）：纯分隔线继续用 line（1.25:1），
        // 只有 input/select/textarea 这类「靠边框标出可交互区域」的地方用它。
        // 取 #8c8c8c：白底 3.36 / #fafafa 3.22 / #fcfcfc 3.28，三种页面底色都过 3:1
        //（#949494 在 #fafafa 上只有 2.91，不达标）。
        "line-strong": "#8c8c8c",
      },
      boxShadow: {
        card: "0 4px 14px rgba(0, 0, 0, 0.07)",
        float: "3px 3px 0 rgba(0, 0, 0, 0.08)",
      },
    },
  },
  plugins: [],
};
