/**
 * 节点图标：按节点描述里的 `icon` key 映射成细线 SVG（1.5px，无 emoji）。
 *
 * 为什么不用图标库：本仓的视觉语言就是「细线 + 无 emoji」，引一个图标库等于
 * 换一套笔画与尺寸；这里每个 key 一个 24x24 的简单形状，未知 key 走兜底
 * （节点仍然能显示，不会因为描述写错一个 key 就空白）。
 */

import type { ReactElement, SVGProps } from "react";

const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

type IconProps = SVGProps<SVGSVGElement>;

const ICONS: Record<string, (props: IconProps) => ReactElement> = {
  play: (p) => (
    <svg {...base(p)}>
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  ),
  clock: (p) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  "alert-triangle": (p) => (
    <svg {...base(p)}>
      <path d="M12 4 2.8 20h18.4z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  ),
  "alert-octagon": (p) => (
    <svg {...base(p)}>
      <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z" />
      <path d="M12 8v5M12 16h.01" />
    </svg>
  ),
  workflow: (p) => (
    <svg {...base(p)}>
      <rect x="3" y="3" width="6" height="5" rx="1" />
      <rect x="15" y="9" width="6" height="5" rx="1" />
      <rect x="3" y="16" width="6" height="5" rx="1" />
      <path d="M9 5.5h3.5A1.5 1.5 0 0 1 14 7v5M9 18.5h3.5A1.5 1.5 0 0 0 14 17v-3" />
    </svg>
  ),
  globe: (p) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5z" />
    </svg>
  ),
  code: (p) => (
    <svg {...base(p)}>
      <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14" />
    </svg>
  ),
  sliders: (p) => (
    <svg {...base(p)}>
      <path d="M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="17" r="2" />
    </svg>
  ),
  "git-branch": (p) => (
    <svg {...base(p)}>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 8.2v7.6M6 15.8c5 0 7.5-2.4 10-5.6" />
    </svg>
  ),
  "git-fork": (p) => (
    <svg {...base(p)}>
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="5" cy="19" r="2.2" />
      <circle cx="19" cy="19" r="2.2" />
      <path d="M12 7.2v3.3M12 10.5 5 16.8M12 10.5l7 6.3" />
    </svg>
  ),
  merge: (p) => (
    <svg {...base(p)}>
      <path d="M5 5v4.5A4.5 4.5 0 0 0 9.5 14H17M5 19v-4.5A4.5 4.5 0 0 1 9.5 10H17" />
      <path d="m14 11 3 3-3 3" />
    </svg>
  ),
  repeat: (p) => (
    <svg {...base(p)}>
      <path d="M4 12a8 8 0 0 1 13.5-5.8L20 8M20 4v4h-4" />
      <path d="M20 12a8 8 0 0 1-13.5 5.8L4 16M4 20v-4h4" />
    </svg>
  ),
  split: (p) => (
    <svg {...base(p)}>
      <path d="M4 12h4l4-6h8M8 12l4 6h8" />
      <path d="m17 3 3 3-3 3M17 15l3 3-3 3" />
    </svg>
  ),
  filter: (p) => (
    <svg {...base(p)}>
      <path d="M3 5h18l-7 8v6l-4 2v-8z" />
    </svg>
  ),
  sort: (p) => (
    <svg {...base(p)}>
      <path d="M7 4v16M4 17l3 3 3-3M17 20V4M14 7l3-3 3 3" />
    </svg>
  ),
  list: (p) => (
    <svg {...base(p)}>
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </svg>
  ),
  copy: (p) => (
    <svg {...base(p)}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </svg>
  ),
  layers: (p) => (
    <svg {...base(p)}>
      <path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5" />
    </svg>
  ),
  square: (p) => (
    <svg {...base(p)}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  ),
  calendar: (p) => (
    <svg {...base(p)}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  ),
  lock: (p) => (
    <svg {...base(p)}>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </svg>
  ),
  sparkles: (p) => (
    <svg {...base(p)}>
      <path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.7l-1.6-5.5L5 10.6 10.4 9z" />
      <path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </svg>
  ),
  search: (p) => (
    <svg {...base(p)}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </svg>
  ),
  archive: (p) => (
    <svg {...base(p)}>
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </svg>
  ),
  bell: (p) => (
    <svg {...base(p)}>
      <path d="M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 18h15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  ),
};

/** 未知 key 的兜底：一个中性的方块，保证节点不空白。 */
function FallbackIcon(props: IconProps) {
  return (
    <svg {...base(props)}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 12h8" />
    </svg>
  );
}

/** 按节点描述的 icon key 渲染图标。 */
export function NodeIcon({ icon, ...props }: { icon?: string } & IconProps) {
  const Component = (icon && ICONS[icon]) || FallbackIcon;
  return <Component {...props} />;
}

/** 已知图标 key 列表（调色板/文档用）。 */
export const KNOWN_NODE_ICONS = Object.keys(ICONS);
