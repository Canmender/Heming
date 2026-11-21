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
        info: "var(--info)",
        /*
         * 2026-11-14 审计 C5：以下 token 此前只存在于 CSS 变量，ClassName 里写不出来，
         * 于是全仓积累了 623 处 `[var(--…)]` 字面量（既有命名类、也有手拼任意值）。
         * 这里把「确实需要按变量取色」的一组登记进来，剩下的字面量迁命名类。
         */
        accent: "var(--heming-accent)",
        "accent-on": "var(--heming-on-accent)",
        scrim: "var(--scrim)",
        // 视觉重构：编辑部铜色锚点（栏目小标 / 竖线 / 强调描边），独立于用户主题色。
        "editorial-rule": "var(--editorial-rule)",
        "editorial-surface": "var(--editorial-surface)",
        "chart-1": "var(--chart-1)",
        "chart-2": "var(--chart-2)",
        "chart-grid": "var(--chart-grid)",
        "chart-label": "var(--chart-label)",
        "avatar-1": "var(--avatar-1)",
        "avatar-2": "var(--avatar-2)",
        "avatar-3": "var(--avatar-3)",
        "avatar-4": "var(--avatar-4)",
        "avatar-5": "var(--avatar-5)",
        "avatar-6": "var(--avatar-6)",
        // C5 第二批：告警/成功/信息的底色与描边，以及控制台、mark 等语义色。
        // 之前它们只在 CSS 里有变量，ClassName 写不出来，才攒成 [var(--…)] 字面量。
        "success-soft": "var(--success-soft)",
        "success-line": "var(--success-line)",
        "success-on": "var(--success-on)",
        "warn-soft": "var(--warn-soft)",
        "warn-line": "var(--warn-line)",
        "info-soft": "var(--info-soft)",
        "info-line": "var(--info-line)",
        "danger-on": "var(--danger-on)",
        "console-bg": "var(--console-bg)",
        "console-ink": "var(--console-ink)",
        "mark-bg": "var(--mark-bg)",
        "mark-ink": "var(--mark-ink)",
      },
      spacing: {
        // 对话区左右留白：值随「阅读宽度」设置变化，Class 里改用 px-chat-gutter。
        "chat-gutter": "var(--chat-gutter)",
      },
      boxShadow: {
        card: "0 4px 14px rgba(0, 0, 0, 0.07)",
        float: "3px 3px 0 rgba(0, 0, 0, 0.08)",
      },
    },
  },
  plugins: [],
};
