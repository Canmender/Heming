/**
 * 来源 / 智能体的圆形首字母头像（从 ModelPage 抽出，模型目录面板也要用）。
 *
 * 色板走 CSS 变量（d.124）：暗色下有一整套更亮的同色相版本，
 * 写死十六进制会让暗色头像发闷、与主题不搭。
 */
const AVATAR_COLORS = [
  "var(--avatar-1)",
  "var(--avatar-2)",
  "var(--avatar-3)",
  "var(--avatar-4)",
  "var(--avatar-5)",
  "var(--avatar-6)",
];

export function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

export function Avatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ui-sm font-semibold text-white"
      style={{ backgroundColor: avatarColor(name) }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
