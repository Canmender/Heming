"""请求体边界的实测：不是「pydantic 会管」，而是这几种越界真的会被 422 挡住。

为什么值得测：这些字段都会变成提示词、日志行、字典键或对抗环的判定阈值。
`coverage_target=5` 这种值会让对抗环永远不达标（白烧两轮模型），
超长的 `cwd`/`run_id` 会把日志行和内存里的键撑大，`constraints` 条数不封顶
等于让调用方决定我们花多少 token。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from agent_pipeline.service import create_app


def _client(runtime_factory) -> TestClient:
    return TestClient(create_app(runtime=runtime_factory(["ok"] * 8)))


def test_coverage_target_must_be_a_ratio(runtime_factory) -> None:
    with _client(runtime_factory) as client:
        for bad in (5, -0.1):
            response = client.post("/v1/runs", json={"goal": "x", "coverage_target": bad})
            assert response.status_code == 422, f"coverage_target={bad} 应当被拒：{response.text}"
        for good in (0, 1, 0.9):
            response = client.post("/v1/runs", json={"goal": "x", "coverage_target": good})
            assert response.status_code == 202, f"coverage_target={good} 应当被接受：{response.text}"


def test_constraints_and_tools_are_bounded(runtime_factory) -> None:
    with _client(runtime_factory) as client:
        too_many = client.post("/v1/runs", json={"goal": "x", "constraints": ["c"] * 21})
        assert too_many.status_code == 422

        too_long = client.post("/v1/runs", json={"goal": "x", "constraints": ["长" * 2001]})
        assert too_long.status_code == 422

        too_many_tools = client.post("/v1/runs", json={"goal": "x", "tools_allowed": ["t"] * 65})
        assert too_many_tools.status_code == 422

        long_tool_name = client.post("/v1/runs", json={"goal": "x", "tools_allowed": ["t" * 201]})
        assert long_tool_name.status_code == 422


def test_cwd_and_run_id_are_bounded(runtime_factory) -> None:
    with _client(runtime_factory) as client:
        assert client.post("/v1/runs", json={"goal": "x", "cwd": "c" * 1001}).status_code == 422
        assert client.post("/v1/runs", json={"goal": "x", "run_id": "r" * 201}).status_code == 422
        # 空 run_id 也不行：它会被当「指定了 id」但实际是空键
        assert client.post("/v1/runs", json={"goal": "x", "run_id": ""}).status_code == 422


def test_blank_goal_is_rejected(runtime_factory) -> None:
    with _client(runtime_factory) as client:
        assert client.post("/v1/runs", json={"goal": ""}).status_code == 422
        assert client.post("/v1/runs", json={"goal": "长" * 4001}).status_code == 422

def test_tune_window_is_bounded(runtime_factory, tmp_path) -> None:
    """negative/0 的 since_hours 会算出「未来」窗口 → 报告 0 个失败样本，看起来像很健康。"""
    log = tmp_path / "runs.jsonl"
    log.write_text("", encoding="utf-8")
    with _client(runtime_factory) as client:
        for bad in (-1, 0, 721):
            response = client.post("/v1/tune", json={"since_hours": bad})
            assert response.status_code == 422, (bad, response.status_code, response.text)
        assert client.post("/v1/tune", json={"since_hours": 1}).status_code == 200
