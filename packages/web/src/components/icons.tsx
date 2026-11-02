import type { SVGProps } from "react";

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

export const HomeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V21h14V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </svg>
);
export const ChatIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5.1A8 8 0 1 1 21 12z" />
  </svg>
);
/** 团队：两个人并排——名册与动向。 */
export const TeamIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M2.5 20c0-3.2 2.9-5.5 6.5-5.5s6.5 2.3 6.5 5.5" />
    <circle cx="17.5" cy="8.5" r="2.4" />
    <path d="M15.5 14.6c3 .2 5 2.3 5 5" />
  </svg>
);

/** 智能体：对话气泡 + 星点——本机智能体对话，不是人类 IM。 */
export const AssistantIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5z" />
    <path d="M16.8 4.2l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z" />
  </svg>
);

export const PlugIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 7V3M15 7V3M9 21v-4M15 21v-4" />
    <rect x="6" y="7" width="12" height="10" rx="2" />
  </svg>
);
export const MemoryIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 4a4 4 0 0 0-4 4 3.5 3.5 0 0 0-1 6.8V17a3 3 0 0 0 5 2.2A3 3 0 0 0 17 17v-2.2A3.5 3.5 0 0 0 16 8a4 4 0 0 0-4-4z" />
  </svg>
);
/** 归档：一个带盖子的收纳盒——比「文件夹」更能表达「收起来但还在」。 */
export const ArchiveIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </svg>
);
/** 自动化：时钟外圈 + 指针与顶部发条，表达「按时间自动发生」。 */
export const AutomationIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12.5" r="7.5" />
    <path d="M12 8.5v4.2l2.8 1.6" />
    <path d="M12 5V3M9.5 3h5" />
  </svg>
);
/** 幕僚：肩上的参谋——人形 + 一只小钟，表达「替你盯着」。 */
export const StaffIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="9.5" cy="7.5" r="3" />
    <path d="M4 20v-1.3a5 5 0 0 1 5-5h1" />
    <circle cx="17.5" cy="17" r="3.2" />
    <path d="M17.5 15.4V17l1 .7" />
  </svg>
);
/** 信息中枢：本地归档库（三层圆盘）+ 一个小节点，区别于「归档」的收纳盒。 */
export const InfoHubIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <ellipse cx="10" cy="6" rx="6" ry="2.5" />
    <path d="M4 6v5c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V6" />
    <path d="M4 11v5c0 1.4 2.7 2.5 6 2.5" />
    <circle cx="18" cy="17" r="2.5" />
    <path d="M16 15.5 12.5 13" />
  </svg>
);
export const GearIcon = (p: SVGProps<SVGSVGElement>) => (  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />
  </svg>
);
export const FileIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v4h4" />
  </svg>
);
export const FolderIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
export const SearchIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="M15 15l4 4" />
  </svg>
);

export const ChevronIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** 关闭：两条细线交叉。替代文本字形「× / ✕」（字号与线条随 currentColor 一致）。 */
export const XIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const UserIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c0-3.3 3.6-6 8-6s8 2.7 8 6" />
  </svg>
);
export const MenuIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
export const SmileIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5c1 1.2 2.2 1.8 3.5 1.8s2.5-.6 3.5-1.8" />
    <path d="M9 9.5h.01M15 9.5h.01" />
  </svg>
);
export const ImageIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.5" />
    <path d="M4 17l4.5-4.5 3 3L15 12l5 5" />
  </svg>
);
export const MicIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9.5" y="3" width="5" height="11" rx="2.5" />
    <path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V21" />
  </svg>
);
export const EyeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const PlusIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const TrashIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 7h16" />
    <path d="M6.5 7l1 13h9l1-13" />
    <path d="M9.5 7V4.5h5V7" />
    <path d="M10.5 10.5v6M13.5 10.5v6" />
  </svg>
);
export const DownloadIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 4v10.5" />
    <path d="M8 11l4 3.5 4-3.5" />
    <path d="M5 19.5h14" />
  </svg>
);
export const PhoneIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);
export const PhoneOffIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72" />
    <path d="M16.72 10.58a16 16 0 0 0-1.8-2.28M12.02 8.14A12.84 12.84 0 0 1 13.5 6.5a2 2 0 0 1 2 1.72" />
    <path d="M2 2l20 20" />
  </svg>
);
export const MicOffIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
    <path d="M5 10a7 7 0 0 0 11.9 4.9M19 10a7 7 0 0 1-.11 1.23" />
    <path d="M12 19v3" />
    <path d="M2 2l20 20" />
  </svg>
);
export const VolumeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M11 5 6 9H2v6h4l5 4z" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

/** 技能：层叠方块 + 星点，区别于记忆（层）与接口（插头）。 */
export const SkillsIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 8.5 10.5 5 17 8.5v7L10.5 19 4 15.5z" />
    <path d="M10.5 12v7" />
    <path d="M4 8.5 10.5 12 17 8.5" />
  </svg>
);

/** 插件区：打开的包裹箱——一个可整包装入/取出的能力包。 */
export const PackageIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M21 8.5 12 4 3 8.5v7L12 20l9-4.5z" />
    <path d="M3 8.5 12 13l9-4.5" />
    <path d="M12 13v7" />
    <path d="M7.5 6.2l4.5 2.3 4.5-2.3" />
  </svg>
);

/** 任务区：带勾选的清单——表达「一串待执行/已执行的事」，区别于聊天气泡。 */
export const TaskIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 4.5V3h6v1.5" />
    <path d="m8.5 10 1.5 1.5 2.5-2.5" />
    <path d="M14.5 11h3M8.5 16h9" />
  </svg>
);

/** 视频通话：摄像机轮廓 + 取景框。 */
export const VideoIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3" y="7" width="12" height="10" rx="2.5" />
    <path d="M15 11l5-3v8l-5-3z" />
  </svg>
);

/** 多选：方框内一个勾——区别于「任务清单」，这里只表达「挑出若干条」。 */
export const SelectIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="m8.5 12 2.5 2.5 5-5" />
  </svg>
);

/** 铃铛：免打扰开关。 */
export const BellIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
  </svg>
);

/** 免打扰（铃铛加斜线）。 */
export const BellOffIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M18 8a6 6 0 0 0-9.3-5" />
    <path d="M6.3 6.3A6 6 0 0 0 6 8c0 7-3 7-3 9h12" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
    <path d="M3 3l18 18" />
  </svg>
);

/** 置顶。 */
export const PinIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 4h6l-1 6 3 3H7l3-3-1-6z" />
    <path d="M12 13v7" />
  </svg>
);

/** 会话中心：列表。 */
export const SessionsIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h10" />
  </svg>
);
