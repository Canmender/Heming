import { useRef, useState } from "react";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { FolderIcon } from "../icons.js";

/**
 * 工作区弹窗（d.147.4.91.11）。
 *
 * 一个工作区 = 本机一个文件夹的绝对路径；它只决定会话在左栏归到哪一组，
 * **不授予任何文件读写权限**（权限走 MCP 的 fs 能力，与这里无关）。
 *
 * 两种用途共用一张壳：
 * - `new`：新建一个工作区（栏头「新建工作区」）；
 * - `move`：把某段会话移进一个工作区（会话 ⋯ →「移动到工作区…」），
 *   额外给一个「移出工作区（未分组）」出口。
 *
 * 目录选择器是桌面端 preload 的可选能力（`window.heming.pickDirectory`）：
 * web 构建里没有，那就只留路径输入框，让用户自己粘贴——不为此报错。
 */

export type WorkspaceDialogMode = "new" | "move";

export interface WorkspaceDialogProps {
  /** 是否显示；`false` 时整棵子树不渲染（也没有焦点陷阱）。 */
  open: boolean;
  mode: WorkspaceDialogMode;
  /** 打开时输入框初值：move 传会话当前工作区，new 一般留空。 */
  initialPath?: string;
  /** 提交中：禁用所有按钮，避免重复提交。 */
  busy?: boolean;
  onCancel: () => void;
  /** `null` 只出现在 move 模式 = 移出工作区（未分组）。 */
  onConfirm: (path: string | null) => void;
}

/**
 * 桌面端 preload 暴露的目录选择器。web 端没有该 API，所以整条链路都按
 * 「可选能力」处理（不是每个入口都声明 `window.heming` 类型，这里就地断言）。
 */
type DirectoryPickerHost = {
  heming?: { pickDirectory?: (title?: string) => Promise<string | null> };
};

function readPickDirectory(): ((title?: string) => Promise<string | null>) | undefined {
  if (typeof window === "undefined") return undefined;
  const host = (window as unknown as DirectoryPickerHost).heming;
  return typeof host?.pickDirectory === "function" ? host.pickDirectory : undefined;
}

export function WorkspaceDialog(props: WorkspaceDialogProps) {
  // 关闭态不渲染内容子树：输入值每次打开都从 `initialPath` 重新开始，
  // 不会把上一次的目标路径带到下一段会话上。
  if (!props.open) return null;
  return <WorkspaceDialogBody {...props} />;
}

function WorkspaceDialogBody({
  mode,
  initialPath = "",
  busy = false,
  onCancel,
  onConfirm,
}: WorkspaceDialogProps) {
  const [path, setPath] = useState(initialPath);
  const [pickError, setPickError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pickDirectory = readPickDirectory();
  const trimmed = path.trim();
  const title = mode === "new" ? "新建工作区" : "移动到工作区";

  const choose = async () => {
    if (!pickDirectory) return;
    try {
      const picked = await pickDirectory("选择工作区文件夹");
      // 用户取消原生对话框 → null：保持输入框原样，不弹错。
      if (picked) {
        setPath(picked);
        setPickError("");
      }
    } catch {
      setPickError("打开文件夹选择器失败，可以直接粘贴路径。");
    }
  };

  const submit = () => {
    if (busy || !trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <Dialog
      ariaLabel={title}
      title={title}
      icon={<FolderIcon width={16} height={16} />}
      description="工作区是本机的一个文件夹；这一段对话会归到它下面。"
      size="sm"
      onClose={onCancel}
      initialFocusRef={inputRef}
      footer={
        <>
          {mode === "move" ? (
            <Button
              type="button"
              size="md"
              variant="ghost"
              className="mr-auto"
              disabled={busy}
              onClick={() => onConfirm(null)}
            >
              移出工作区（未分组）
            </Button>
          ) : null}
          <Button type="button" size="md" variant="ghost" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button
            type="button"
            size="md"
            variant="primary"
            busy={busy}
            disabled={!trimmed}
            onClick={submit}
          >
            确定
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            aria-label="工作区文件夹路径"
            placeholder={"例如 D:\\项目\\demo"}
            value={path}
            disabled={busy}
            onChange={(e) => {
              setPath(e.target.value);
              setPickError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            className="ui-input h-8 min-w-0 flex-1 font-mono text-ui-sm"
          />
          {pickDirectory ? (
            <Button type="button" size="md" variant="ghost" disabled={busy} onClick={() => void choose()}>
              选择文件夹…
            </Button>
          ) : null}
        </div>
        {pickError ? (
          <p role="alert" className="text-ui-sm text-danger">
            {pickError}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
