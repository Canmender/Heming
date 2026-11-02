import { useUiStore } from "../store/ui.js";
import { FolderIcon } from "./icons.js";

/**
 * 工作区：去 IM 后不再承载联系人雷达/会话概览，只保留「共享文件 → 智能体对话」这条路。
 *
 * 文件目录本身常驻右侧边栏（跨页可见），这里不再复制一份列表；
 * 页面只解释目录怎么用，并给出进入智能体的入口。
 */
export function WorkspacePage() {
  const setPage = useUiStore((s) => s.setPage);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2.5 border-b border-line-soft px-5 py-3">
        <FolderIcon width={18} height={18} />
        <span className="text-[15px] font-bold">工作区</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="max-w-[560px]">
          <h2 className="text-[14px] font-bold">共享文件与智能体对话</h2>
          <p className="mt-2 text-[12px] leading-6 text-muted">
            右侧目录是本实例的共享文件区，所有页面都能看到。把文件绑定到当前智能体对话后，
            智能体会在下一轮对话里收到这份附件；文件本身（含大小与类型）会保存在服务端共享库。
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <section className="rounded-xl border border-line-soft bg-[#fafafa] p-4">
              <h3 className="text-[12px] font-bold">上传</h3>
              <p className="mt-1 text-[11px] leading-5 text-muted">
                目录栏的「上传」把本地文件放进共享库；「绑定」会在当前对话里直接发送一份附件。
                没有打开对话时，绑定会提示先选一个智能体。
              </p>
            </section>
            <section className="rounded-xl border border-line-soft bg-[#fafafa] p-4">
              <h3 className="text-[12px] font-bold">隐私边界</h3>
              <p className="mt-1 text-[11px] leading-5 text-muted">
                共享库里的文件是显式共享的明文；消息附件的加密链路仍然独立，
                需要解密密钥才能打开。团队动向只含摘要，不包含文件名或对话正文。
              </p>
            </section>
          </div>

          <button
            type="button"
            onClick={() => setPage("chat")}
            className="mt-5 rounded-lg bg-ink px-3 py-1.5 text-[12px] font-medium text-white"
          >
            去智能体对话
          </button>
        </div>
      </div>
    </div>
  );
}
