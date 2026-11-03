/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      /*
       * d.67 T3 暗色主题：颜色原来写死 hex，暗色只能逐个 className 改；
       * 现在统一走 CSS 变量（`:root` 放 light 值 = 改造前逐像素一致，
       * `[data-theme="dark"]` 覆盖一套暗色值）。同名 token 语义不变，
       * 因此 500+ 处既有 className 一行都不用改。
       *
       * 为什么不带 <alpha-value>：全仓只有一处 `ring-ink/20` 用到透明度修饰，
       * 带 alpha 通道改造会把每个 token 拆成 r g b 三段，收益不抵成本；
       * 那一处改用字面量即可（见 TokenHeatmap）。
       */
      colors: {
        line: "var(--line)",
        "line-soft": "var(--line-soft)",
        "line-strong": "var(--line-strong)",
        muted: "var(--muted)",
        ink: "var(--ink)",
        panel: "var(--panel)",
        // 以下为暗色轮新增的语义 token（light 值见 index.css `:root`）
        surface: "var(--surface)",
        subtle: "var(--subtle)",
        "subtle-2": "var(--subtle-2)",
        "subtle-3": "var(--subtle-3)",
        "subtle-4": "var(--subtle-4)",
        body: "var(--body)",
        placeholder: "var(--placeholder)",
        danger: "var(--danger)",
        "danger-soft": "var(--danger-soft)",
        "danger-line": "var(--danger-line)",
        warn: "var(--warn)",
        success: "var(--success)",
      },
      boxShadow: {
        card: "0 4px 14px rgba(0, 0, 0, 0.07)",
        float: "3px 3px 0 rgba(0, 0, 0, 0.08)",
      },
    },
  },
  plugins: [],
};
