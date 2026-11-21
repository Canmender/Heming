import { useEffect, useRef, useState } from "react";
import { getMagpieCliBridge, stripAnsi, tailText, type MagpieCliEvent } from "../../lib/magpieCli.js";
import { engineText } from "../../lib/engineText.js";
import { Button } from "../../components/ui/Button.js";

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
    // onCli 是全局总线：每个窗口都收到全部命令的事件。只认自己那次 begin 的
    // runId，绝不能用事件里的 start 覆盖——否则别人的 start 会把口令写到
    // 别人的进程 stdin，别人的 stdout/exit 也会冒充成本命令的输出/结束。
    let myRunId: string | null = null;
    const pending: MagpieCliEvent[] = [];
    const applyEvent = (event: MagpieCliEvent) => {
      // "exit" 是运行时事件，但 MagpieCliEventType 的类型字面量未包含它，先判它。
      if ((event.type as string) === "exit") {
        if (!alive) return;
        const ok = (event as { ok?: boolean }).ok === true;
        setStatus(ok ? "done" : "error");
        if (!ok) setError(engineText((event as { error?: string }).error || "命令失败"));
        doneRef.current?.({ ok, error: (event as { error?: string }).error });
        return;
      }
      if (event.type === "stdout" || event.type === "stderr") {
        bufferRef.current += event.text ?? "";
        if (alive) setOutput(engineText(tailText(stripAnsi(bufferRef.current))));
      }
    };
    const unsubscribe = bridge.onCli((event: MagpieCliEvent) => {
      if (!alive || event.type === "start") return;
      if (myRunId === null) {
        // begin 还没回来：先暂存，拿到自己的 runId 后只回放确实属于本命令的。
        if (pending.length < 200) pending.push(event);
        return;
      }
      if (event.runId !== myRunId) return;
      applyEvent(event);
    });
    void (async () => {
      try {
        const started = await bridge.cliBegin(args);
        if (!alive) return;
        if (!started.ok) {
          const message = started.error || "无法启动命令";
          setStatus("error");
          setError(message);
          doneRef.current?.({ ok: false, error: message });
          return;
        }
        myRunId = started.runId ?? "";
        setRunId(started.runId ?? null);
        const buffered = pending.splice(0);
        for (const event of buffered) {
          if (event.runId === myRunId) applyEvent(event);
        }
      } catch (err) {
        if (!alive) return;
        const message = err instanceof Error ? err.message : String(err);
        setStatus("error");
        setError(message);
        doneRef.current?.({ ok: false, error: message });
      }
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
    <div className="rta-enter mt-3 rounded-lg border border-line-soft bg-subtle p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-ui-sm font-semibold">
          {title}
          <span className="ml-2 font-normal text-muted">
            {status === "running" ? "进行中…" : status === "done" ? "已完成" : "失败"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {status === "running" && runId && (
            <Button
              type="button"
              size="sm" variant="ghost"
              onClick={() => void bridge?.cliKill(runId)}
            >
              取消
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
      {hint && <p className="mt-1 ui-caption">{hint}</p>}
      {error && <p className="mt-1 text-ui-sm text-danger">{error}</p>}
      <pre
        aria-label="命令输出"
        className="mt-2 h-44 overflow-auto rounded-lg bg-console-bg p-3 text-ui-sm text-console-ink"
      >
        {output || "（输出会出现在这里）"}
      </pre>
      <div className="mt-2 flex gap-2">
        <input
          aria-label="命令输入"
          className="ui-input flex-1 font-mono text-ui-sm"
          type="password"
          placeholder="输入口令/回答，回车发送（只在本面板内存里）"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          disabled={status !== "running"}
        />
        <Button
          type="button"
          size="sm" variant="primary"
          disabled={status !== "running" || !runId}
          onClick={() => void send()}
        >
          发送
        </Button>
      </div>
    </div>
  );
}
