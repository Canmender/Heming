// Tailwind v4 把 PostCSS 插件拆成了独立包 `@tailwindcss/postcss`：
// v3 那种直接写 `tailwindcss: {}` 的写法在 v4 会报「找不到 tailwindcss 插件」。
// autoprefixer 也一起去掉 —— v4 内置 Lightning CSS 负责加浏览器前缀，
// 两套前缀管线同时跑既冗余又可能互相覆盖。
export default { plugins: { "@tailwindcss/postcss": {} } };
