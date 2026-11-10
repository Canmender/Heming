import type { JSX, SVGProps } from "react";
import {
  ArchiveIcon,
  AutomationIcon,
  BookIcon,
  ChatIcon,
  FileIcon,
  FolderIcon,
  GearIcon,
  InfoHubIcon,
  MenuIcon,
  PackageIcon,
  RouteIcon,
  ShieldIcon,
  SkillsIcon,
  SparkIcon,
  TaskIcon,
  VideoIcon,
  WorkflowIcon,
} from "../icons.js";
import {
  normalizePluginPageIcon,
  type PluginPageIconId,
} from "../../lib/pages/icons.js";

/**
 * 插件页面图标（d.124）。
 *
 * 清单只写词表 id（`page.icon`），这里映射到既有线条图标——插件作者不用带图标文件，
 * 视觉与宿主一致。未知 id 回落包裹图标，不报错、不空白。
 */
const ICON_COMPONENTS: Record<
  PluginPageIconId,
  (props: SVGProps<SVGSVGElement>) => JSX.Element
> = {
  activity: AutomationIcon,
  book: BookIcon,
  calendar: TaskIcon,
  chart: SparkIcon,
  database: ArchiveIcon,
  file: FileIcon,
  folder: FolderIcon,
  globe: InfoHubIcon,
  grid: PackageIcon,
  hammer: WorkflowIcon,
  key: ShieldIcon,
  layers: SkillsIcon,
  layout: MenuIcon,
  link: RouteIcon,
  list: TaskIcon,
  message: ChatIcon,
  package: PackageIcon,
  play: VideoIcon,
  settings: GearIcon,
  shield: ShieldIcon,
  terminal: AutomationIcon,
};

export interface PluginPageIconProps {
  /** 清单里的图标 id；未知/缺省回落包裹图标。 */
  icon?: string | null;
  /** 边长（px）：导航轨 17、页头 20、详情 18。 */
  size?: number;
  className?: string;
}

export function PluginPageIcon({ icon, size = 18, className }: PluginPageIconProps): JSX.Element {
  const Icon = ICON_COMPONENTS[normalizePluginPageIcon(icon)];
  return <Icon width={size} height={size} className={className} aria-hidden="true" />;
}
