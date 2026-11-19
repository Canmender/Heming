/**
 * 云同步（`magpie webdav|s3|github`）：把这几台电脑的设置、来源与技能库放在同一处。
 *
 * 内核那条命令的三种形态共用同一套语义（`vendor/magpie-core/internal/cli/webdav_cli.go`）：
 * 不带参数就是「现在开着吗、连到哪儿、上次同步怎么样」，`now` 立刻同步一次，
 * `auto <分钟|off>` 改网关自己隔多久同步一次。开与关要输密码或令牌，所以那两步
 * 仍然走终端（`openTerminal`）——页面只负责看得见、推得动。
 *
 * 这里只做纯文本解析与命令拼装，方便单测。
 */

/** 三种云同步：WebDAV 盘、S3 桶、GitHub 仓库。 */
export type SyncKind = "webdav" | "s3" | "github";

/** 一份云同步现状，字段都按 `magpie webdav` 的输出取。 */
export interface SyncStatus {
  /** 现在开着吗。 */
  on: boolean;
  /** 开着时是哪一种；没开时按命令本身认（webdav/s3/github）。 */
  kind: SyncKind;
  /** 连到哪儿：WebDAV 地址、S3 桶、GitHub 地址。 */
  url: string;
  /** 跟随地址的说明：账号、区域、path-style、密码/令牌已存。 */
  who: string[];
  /** 同步哪些东西（providers、settings、profiles、library…）。 */
  parts: string[];
  /** 上次同步结果：一句人话。 */
  last: string;
  /** 上次同步失败的原因（没有就是空串）。 */
  error: string;
  /** 隔多少分钟自己同步一次；0 表示只在手动时同步；null 表示没读到。 */
  auto: number | null;
  /** 上次同步把服务器那份整套搬到了本机（内核说 `Restored from the server`）。 */
  restored: boolean;
  /** 上次同步换了本机的哪几份（另一台电脑的更新）。 */
  changedHere: string[];
  /** 上次同步换了服务器上的哪几份（本机更新）。 */
  changedThere: string[];
  /** 被换掉的那几份的旧副本放在哪（内核显示为 `~/…`）。 */
  saved: string;
  /** 同步下来的设置里用到、但本机还没登录的账号。 */
  signIns: string[];
}

const KIND_OF_PREFIX: Record<string, SyncKind> = {
  WebDAV: "webdav",
  S3: "s3",
  GitHub: "github",
};

/** `providers with their API keys, settings, profiles` → 三段。 */
function splitParts(text: string | undefined): string[] {
  return (text ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 从 `magpie webdav` 的输出里读出云同步现状。 */
export function parseSyncStatus(text: string, fallback: SyncKind = "webdav"): SyncStatus {
  const lines = text.split(/\r?\n/);
  const head = lines.map((line) => line.trim()).find((line) => line !== "") ?? "";
  const status: SyncStatus = {
    on: true,
    kind: fallback,
    url: "",
    who: [],
    parts: [],
    last: "",
    error: "",
    auto: null,
    restored: false,
    changedHere: [],
    changedThere: [],
    saved: "",
    signIns: [],
  };

  const off = /^(WebDAV|S3|GitHub) sync is off$/.exec(head);
  if (off) {
    return { ...status, on: false, kind: KIND_OF_PREFIX[off[1] ?? ""] ?? fallback };
  }

  const on = /^(WebDAV|S3|GitHub) sync\s+(\S+)(?:\s+(.*))?$/.exec(head);
  if (on) {
    status.kind = KIND_OF_PREFIX[on[1] ?? ""] ?? fallback;
    status.url = on[2] ?? "";
    status.who = (on[3] ?? "")
      .split(/\s*·\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line === "") continue;

    const parts = /^syncs\s+(.+)$/.exec(line);
    if (parts) {
      status.parts = (parts[1] ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      continue;
    }

    const failed = /^couldn't sync:\s*(.+)$/.exec(line);
    if (failed) {
      status.error = failed[1]?.trim() ?? "";
      continue;
    }

    // 上次同步到底换了谁的东西：内核把这件事单独打在末尾，页面以前整段丢掉。
    const restored = /^Restored from the server:\s*(.+)$/.exec(line);
    if (restored) {
      status.restored = true;
      status.changedHere = splitParts(restored[1]);
      continue;
    }

    const here = /^Replaced here by newer ones from another computer:\s*(.+)$/.exec(line);
    if (here) {
      status.changedHere = splitParts(here[1]);
      continue;
    }

    const there = /^Replaced on the server by this computer's newer ones:\s*(.+)$/.exec(line);
    if (there) {
      status.changedThere = splitParts(there[1]);
      continue;
    }

    const kept = /\bkept in\s+(\S+)\s+\(/.exec(line);
    if (kept) {
      status.saved = kept[1]?.trim() ?? "";
      continue;
    }

    // 行里前面还有个 "(to use one here: magpie accounts add <id>)"，所以认最后一个 "): " 之后那段。
    const signIns = /not signed in on this computer.*\):\s*(.+)$/.exec(line);
    if (signIns) {
      status.signIns = (signIns[1] ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      continue;
    }

    if (/^not synced yet$/.test(line)) {
      status.last = "还没同步过";
      continue;
    }

    const synced = /^✓?\s*synced\s+(.+)$/.exec(line);
    if (synced) {
      status.last = `上次同步 ${synced[1]?.trim() ?? ""}`;
      continue;
    }

    const every = /every\s+(\d+)\s+minutes/.exec(line);
    if (every) {
      status.auto = Number(every[1]);
      continue;
    }

    if (/^Syncs only when asked/.test(line)) {
      status.auto = 0;
    }
  }

  return status;
}

/** 「现在同步一次」的命令。 */
export function syncNowArgs(kind: SyncKind): string[] {
  return [kind, "now"];
}

/**
 * 改「多久自己同步一次」：给分钟数就那一档，`off` 是只手动。
 * 内核只认 off|3|15|30|60，别的一律被它拒掉，所以这里先挡一层。
 */
export function syncAutoArgs(kind: SyncKind, minutes: number | "off"): string[] | null {
  if (minutes === "off") return [kind, "auto", "off"];
  if (![3, 15, 30, 60].includes(minutes)) return null;
  return [kind, "auto", String(minutes)];
}

/** 开云同步要输密码/令牌，交给终端；这里只拼前半段。 */
export function syncOnArgs(kind: SyncKind, address: string, user = ""): string[] | null {
  const url = address.trim();
  if (url === "") return null;
  const args = [kind, "on", url];
  const who = user.trim();
  if (who !== "") args.push(`user=${who}`);
  return args;
}

/** 关掉云同步：服务器上的文件留着，只是不再同步。 */
export function syncOffArgs(kind: SyncKind): string[] {
  return [kind, "off"];
}

/** 撤销上次「整套换成服务器那份」：把本机原来的设置拿回来。 */
export function syncUndoArgs(kind: SyncKind): string[] {
  return [kind, "undo"];
}

/** 只是别再提这件事——被换掉的旧副本仍然留着。 */
export function syncDismissArgs(kind: SyncKind): string[] {
  return [kind, "dismiss"];
}

/**
 * 上次同步到底动了什么：只在真有话说时返回。
 *
 * 三种情况：整套从服务器搬来（`restored`）、换了本机几份、换了服务器几份。
 * 有话说时页面还应该给「撤销」（只有整套搬来能撤）与「知道了」两个按钮。
 */
export function describeNotice(status: SyncStatus): string[] {
  const lines: string[] = [];
  if (status.restored) {
    lines.push(`上次同步把服务器那份整个搬来了：${status.changedHere.join("、") || "全部"}。`);
  } else {
    if (status.changedHere.length > 0) {
      lines.push(`上次同步换了本机的：${status.changedHere.join("、")}（另一台电脑比较新）。`);
    }
    if (status.changedThere.length > 0) {
      lines.push(`上次同步换了服务器上的：${status.changedThere.join("、")}（这台电脑比较新）。`);
    }
  }
  if (status.saved !== "") lines.push(`被换掉的那几份留在 ${status.saved}。`);
  if (status.signIns.length > 0) {
    lines.push(`同步来的设置要用这些账号，本机还没登录：${status.signIns.join("、")}。`);
  }
  return lines;
}

/** 有没有需要人看一眼的事（要撤销或至少要知情）。 */
export function hasNotice(status: SyncStatus): boolean {
  return describeNotice(status).length > 0;
}

/** 把现状说成一句话（没开也有话说）。 */
export function describeSync(status: SyncStatus): string {
  if (!status.on) return "云同步没开：这台电脑的设置只在本地。";
  const where = status.url || "（地址没读出来）";
  const what = status.parts.length > 0 ? `同步 ${status.parts.join("、")}` : "同步设置与来源";
  const when = status.error
    ? `上次没成：${status.error}`
    : status.last || "还没同步过";
  return `${labelOf(status.kind)} → ${where}：${what}；${when}。`;
}

/** 哪种云的中文叫法。 */
export function labelOf(kind: SyncKind): string {
  if (kind === "s3") return "S3 桶";
  if (kind === "github") return "GitHub 仓库";
  return "WebDAV";
}

/** 「多久同步一次」的中文说法。 */
export function describeAuto(auto: number | null): string {
  if (auto === null) return "";
  if (auto === 0) return "只在点「现在同步一次」时";
  return `网关跑着时每 ${auto} 分钟`;
}
