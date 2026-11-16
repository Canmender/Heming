import { useEffect, useMemo, useRef, useState } from "react";
import { SYSTEM_AGENT_ID } from "@heming/shared";
import { useLlmStore } from "../store/llm.js";
import { DEFAULT_SYSTEM_PROMPT, resolveBasePrompt } from "../lib/agentRuntime/defaultPrompt.js";
import { Button } from "./ui/Button.js";

/**
 * 智能体人设卡（设置 → 高级 → 智能体）。
 *
 * ★ 为什么需要这张卡：d.156 之前「人设」只存在于代码常量里——
 * `store/llm.ts` 有 `prompts` 与 `setPrompt`，但全仓没有任何调用方，
 * 用户看见智能体的行为、却没有任何入口改它。d.156 补了内置人设，
 * 这张卡补上「用户能看见、能改、能撤回」的那一半。
 *
 * 口径（与 `resolveBasePrompt` 严格一致）：
 * - 没写过 / 写空白 / 删掉 → 用内置人设；
 * - 写过非空 → **完全**按用户写的来，不拼接、不追加内置人设的任何一句。
 *   所以卡上要明确说「它会完全替代内置人设」，否则用户会以为是在内置人设上叠加。
 */
export function PersonaCard({ agentId = SYSTEM_AGENT_ID }: { agentId?: string }) {
  const prompts = useLlmStore((s) => s.prompts);
  const setPrompt = useLlmStore((s) => s.setPrompt);
  const clearPrompt = useLlmStore((s) => s.clearPrompt);

  const saved = prompts[agentId] ?? "";
  const [draft, setDraft] = useState(saved);
  const [status, setStatus] = useState<"idle" | "saved">("idle");

  /*
   * 保存后 store 变了、或者别处（例如恢复默认）改了同一个键，
   * 输入框要跟着回到已保存值，否则界面显示的和实际生效的会分叉。
   *
   * 用 `lastSaved` 记住「我们刚写进去的值」：自己保存引起的变化不该把
   * 「已保存」提示冲掉，只有**外部**改动才需要同步输入框并收起提示。
   */
  const lastSaved = useRef(saved);
  useEffect(() => {
    if (saved === lastSaved.current) return;
    lastSaved.current = saved;
    setDraft(saved);
    setStatus("idle");
  }, [saved]);

  const dirty = draft !== saved;
  const custom = saved.trim().length > 0;
  /** 实际生效的底座：与 `ChatPage.buildSystemPrompt` 同一函数，避免两套判据。 */
  const effective = useMemo(() => resolveBasePrompt(saved), [saved]);
  const effectiveIsDefault = effective === DEFAULT_SYSTEM_PROMPT;

  const save = () => {
    const text = draft.trim();
    // 先记下「这次是我们自己写的」，避免下面的 useEffect 把「已保存」提示冲掉。
    lastSaved.current = text;
    if (!text) {
      clearPrompt(agentId);
    } else {
      setPrompt(agentId, text);
    }
    setDraft(text);
    setStatus("saved");
  };

  return (
    <section aria-label="智能体人设" className="ui-card p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="ui-section-title">智能体人设</h2>
        <span className="ui-caption">决定它「怎么做事」，每轮对话都会带上</span>
      </div>
      <div className="mt-1 ui-caption">
        内置人设会要求它先看现场再回答、这一轮没有的工具就说做不到、三步以上的任务先列清单、改完自己回头验证。
        你在这里写的会<strong className="font-semibold text-body">完全替代</strong>内置人设（不是叠加）；
        留空或点「恢复内置人设」就回到默认。
      </div>

      <label htmlFor="agent-persona-text" className="mt-3 block text-ui-sm font-semibold text-muted">
        提示词
      </label>
      <textarea
        id="agent-persona-text"
        aria-label="智能体人设提示词"
        value={draft}
        rows={10}
        placeholder="留空 = 使用内置人设（推荐）。要改就写整套提示词：它会完全替代内置人设。"
        onChange={(e) => {
          setDraft(e.target.value);
          setStatus("idle");
        }}
        className="mt-1 block min-h-[140px] w-full resize-y rounded-lg border border-line-strong px-3 py-2 ui-body-sm outline-hidden focus:border-ink"
      />

      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ui-caption">
        <span role="status">
          当前生效：{effectiveIsDefault ? "内置人设" : `自定义（${effective.length} 字）`}
        </span>
        <span>·</span>
        <span>{draft.length} 字</span>
        {dirty && <span className="text-warn">· 有未保存的修改</span>}
        {status === "saved" && !dirty && <span className="text-success">· 已保存，下一轮对话生效</span>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="primary" onClick={save} disabled={!dirty}>
          保存
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(DEFAULT_SYSTEM_PROMPT);
            setStatus("idle");
          }}
        >
          填入内置人设（可改）
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft("");
            setStatus("idle");
            if (custom) {
              lastSaved.current = "";
              clearPrompt(agentId);
            }
          }}
        >
          恢复内置人设
        </Button>
        {!custom && <span className="ui-caption">当前没有自定义内容，用的就是内置人设。</span>}
      </div>
    </section>
  );
}
