"""浸泡脚本自己的口径测试。

浸泡测试最容易出的一类错是「测了个寂寞」：脚本看着在跑工具，其实每次参数都一样、
全被幂等缓存吃掉（第一版就是这样，60 个 run 只记到 2 次工具调用）。这里把那条口径
钉住，免得以后改脚本又把浸泡变成「只测缓存」。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def _load_soak():
    if "soak_script" in sys.modules:
        return sys.modules["soak_script"]
    spec = importlib.util.spec_from_file_location("soak_script", SCRIPTS / "soak.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["soak_script"] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def soak():
    return _load_soak()


def _execute_messages(budget: int):
    from agent_pipeline.config import PROMPTS

    return [
        {"role": "system", "content": PROMPTS["execute"]},
        {"role": "user", "content": f"当前步骤 1/1：直接回答\n本步骤剩余工具调用预算：{budget}"},
    ]


def test_tools_mode_emits_distinct_arguments_every_call(soak):
    """每次工具调用的参数必须不同，否则幂等缓存命中，工具根本没执行。"""
    llm = soak.CycleLLM(tools=True)
    args = []
    for _ in range(3):
        response = llm.chat(_execute_messages(6))
        assert response.tool_calls, "满额预算下应当发起工具调用"
        args.append(response.tool_calls[0]["arguments"])
    keys = [tuple(sorted(item.items())) for item in args]
    assert len(set(keys)) == len(keys), f"参数重复会让幂等缓存吃掉工具执行：{args}"


def test_tools_mode_stops_calling_after_budget_consumed(soak):
    """预算被吃掉之后（剩余 < 满额）就该收尾成文本，不能无限调工具。"""
    llm = soak.CycleLLM(tools=True)
    assert llm.chat(_execute_messages(6)).tool_calls
    response = llm.chat(_execute_messages(5))
    assert response.tool_calls == []
    assert response.text


def test_tools_mode_off_never_calls_tools(soak):
    llm = soak.CycleLLM()
    response = llm.chat(_execute_messages(6), tools=[])
    assert response.tool_calls == []


def test_approval_mode_uses_write_tool(soak):
    """--approval 走的是写工具，才会真的挂审批闸（只读工具不挂）。"""
    llm = soak.CycleLLM(tools=True)
    llm.tool_name = "run_command"
    response = llm.chat(_execute_messages(6))
    assert response.tool_calls[0]["name"] == "run_command"
    assert "command" in response.tool_calls[0]["arguments"]