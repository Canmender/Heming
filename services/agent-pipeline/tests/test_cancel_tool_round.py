"""工具轮中途取消：不再启动新的工具调用，但保留「哪些没做」的痕迹。

以前取消只在节点边界检查：`execute` 节点里模型一次发 3 个工具调用，用户在第 1 个
执行到一半时点取消，服务仍会把 2、3 跑完（每次可能是几十秒的 http_get / run_command），
用户看到的就是「点了取消，界面还在转」。这里钉住新的收口方式。
"""

from __future__ import annotations

import json

from agent_pipeline.config import Settings
from agent_pipeline.graph import run_pipeline
from agent_pipeline.protocol import TaskSpec


class EchoLLM:
    """第一轮 plan，execute 轮发三个工具调用，reflect 收尾。"""

    def __init__(self) -> None:
        self.calls: list[list[dict]] = []

    def chat(self, messages, tools, **_kwargs):  # noqa: ANN001, ANN003 - 协议形状
        from agent_pipeline.llm import LLMResponse

        self.calls.append(list(messages))
        system = "\n".join(str(item.get("content", "")) for item in messages if item.get("role") == "system")
        if "规划者" in system:
            payload = {"steps": [{"goal": "跑三个工具", "done_when": "都有结果"}]}
            return LLMResponse(text=json.dumps(payload, ensure_ascii=False))
        if "执行者" in system:
            if any(m.get("role") == "tool" for m in messages):
                return LLMResponse(text="做完了")
            tool_calls = [
                {"id": f"call_{i}", "name": "echo", "arguments": {"text": f"第{i}个"}}
                for i in range(1, 4)
            ]
            return LLMResponse(text="先跑三个", tool_calls=tool_calls)
        if "评判者" in system:
            return LLMResponse(text=json.dumps({"score": 0.9, "blocking_issues": []}, ensure_ascii=False))
        if "总结者" in system:
            return LLMResponse(text=json.dumps({"answer": "按取消前的结果收尾", "citations": []}, ensure_ascii=False))
        return LLMResponse(text=json.dumps({"verdict": "done", "reasons": ["完成"]}, ensure_ascii=False))


def test_cancel_mid_tool_round_stops_remaining_calls(runtime_factory, tmp_path) -> None:
    executed: list[str] = []
    cancel_state = {"on": False}

    def echo(args: dict) -> dict:
        executed.append(str(args.get("text")))
        # 第一个工具一执行就把取消标记打开，模拟「用户在这一步点了取消」
        cancel_state["on"] = True
        return {"echo": args.get("text")}

    llm = EchoLLM()
    settings = Settings(log_path=str(tmp_path / "runs.jsonl"), db_path=":memory:")
    runtime = runtime_factory([])
    runtime.llm = llm
    runtime.settings = settings
    runtime.tools.registry.tool(
        name="echo", description="回显", risk="read", schema={"type": "object", "properties": {"text": {"type": "string"}}}
    )(echo)
    runtime.cancel = lambda _run_id: cancel_state["on"]

    state = run_pipeline(runtime, TaskSpec(goal="取消要看得到剩下的没跑", cwd="."), run_id="run-cancel-tools")

    assert state["status"] == "aborted"
    assert state["stop_reason"] == "cancelled"
    # 只有第一个工具真的执行了；后两个只留观测，没有真的跑
    assert executed == ["第1个"], executed
    errors = [str(obs.get("error") or "") for obs in state["observations"]]
    assert sum("用户取消了本次运行" in text for text in errors) == 2, errors
    # 不再多烧模型：plan + execute 之后直接收口，没有第二轮 execute
    assert len(llm.calls) <= 3, len(llm.calls)