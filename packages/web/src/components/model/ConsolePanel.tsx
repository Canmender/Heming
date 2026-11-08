import { useEffect, useRef, useState } from "react";
import { getMagpieCliBridge, stripAnsi, tailText, type MagpieCliEvent } from "../../lib/magpieCli.js";

/**
 * 交互式命令面板（d.112）：备份/恢复这类要口令的命令在这里跑。
 *
 * 命令的输出逐块显示，输入框把每一行写回命令的 stdin；口令只在本组件的内存里，
 * 不落盘、不进日志。关闭面板会终止仍在运行的命令。
 */
export function ConsolePanel({
  title,
  args,
  hint,
  onClose,
  onDone,
}: {
  title: string;
  args: string[];
  hint?: string;
  onClose: () => void;
  onDone?: (result: { ok: boolean; error?: string }) => void;
}) {
  const bridge = getMagpieCliBridge();
  const [runId, setRunId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [error, setError] = useState<string | null>(null);
  const bufferRef = useRef("");
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!bridge) {
      setStatus("error");
      setError("这个操作只在和鸣桌面端可用。");
      return;
    }
    let alive = true;
    const unsubscribe = bridge.onCli((event: MagpieCliEvent) => {
      if (event.type === "start") {
        if (alive) setRunId(event.runId);
        return;
      }
      if (event.type === "stdout" || event.type === "stderr") {
        bufferRef.current += event.text ?? "";
        if (alive) setOutput(tailText(stripAnsi(bufferRef.current)));
        return;
      }
      if (event.type === "exit") {
        if (!alive) return;
        const ok = (event as { ok?: boolean }).ok === true;
        setStatus(ok ? "done" : "error");
        if (!ok) setError((event as { error?: string }).error || "命令失败");
        doneRef.current?.({ ok, error: (event as { error?: string }).error });
      }
    });
    void (async () => {
      const started = await bridge.cliBegin(args);
      if (!alive) return;
      if (!started.ok) {
        setStatus("error");
        setError(started.error || "无法启动命令");
        return;
      }
      setRunId(started.runId ?? null);
    })();
    return () => {
      alive = false;
      unsubscribe();
    };
    // args 只在打开面板时确定；面板关闭即销毁。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  const send = async () => {
    if (!bridge || !runId) return;
    const text = `${input}\n`;
    setInput("");
    await bridge.cliInput(runId, text);
  };

  return (
    <div className="rta-enter mt-3 rounded-xl border border-line bg-[#fafafa] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12px] font-bold">
          {title}
          <span className="ml-2 font-normal text-muted">
            {status === "running" ? "进行中…" : status === "done" ? "已完成" : "失败"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {status === "running" && runId && (
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-ghost"
              onClick={() => void bridge?.cliKill(runId)}
            >
              取消
            </button>
          )}
          <button type="button" className="ui-btn ui-btn-sm ui-btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
      {hint && <p className="mt-1 ui-caption">{hint}</p>}
      {error && <p className="mt-1 text-[12px] text-[#b42318]">{error}</p>}
      <pre
        aria-label="命令输出"
        className="mt-2 h-44 overflow-auto rounded-xl bg-[#111] p-3 text-[12px] text-[#e8e8e8]"
      >
        {output || "（输出会出现在这里）"}
      </pre>
      <div className="mt-2 flex gap-2">
        <input
          aria-label="命令输入"
          className="ui-input flex-1 font-mono text-[12px]"
          type="password"
          placeholder="输入口令/回答，回车发送（只在本面板内存里）"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          disabled={status !== "running"}
        />
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-primary"
          disabled={status !== "running" || !runId}
          onClick={() => void send()}
        >
          发送
        </button>
      </div>
    </div>
  );
}
