"""覆盖率解析与「真实跑测试命令」这条链路（对抗环的判定依据）。

对抗模式靠这段代码判断「改完的代码覆盖率到没到目标」。解析错了会直接骗过
Critic：把 40% 读成 0.4 还行，把没跑起来的命令读成 100% 就会误放行。
"""

from __future__ import annotations

import sys

import pytest

from agent_pipeline.runtime import make_coverage_runner, parse_coverage


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("TOTAL   124    18    85%", 0.85),
        ("coverage: 91.5%", 0.915),
        ("All files | 72% | 12 |", 0.72),
        ("TOTAL 100%", 1.0),
        ("TOTAL 0%", 0.0),
    ],
)
def test_parse_coverage_reads_common_formats(output: str, expected: float) -> None:
    assert parse_coverage(output) == expected


def test_parse_coverage_takes_the_first_reliable_number() -> None:
    """先出现 TOTAL 就以它为准，别被后面「coverage: 12%」的局部数字带偏。"""
    output = "some output\nTOTAL   99%   20\ncoverage: 12%"
    assert parse_coverage(output) == 0.99


@pytest.mark.parametrize("output", ["", "no numbers here", "TOTAL 140%", "TOTAL -5%", "100% but not labelled"])
def test_parse_coverage_returns_none_instead_of_guessing(output: str) -> None:
    """解析不到就返回 None——调用方据此判 ok=False，宁可让流程早收口也不误放行。"""
    assert parse_coverage(output) is None


def _python(code: str) -> str:
    return f'"{sys.executable}" -c "{code}"'


def test_make_coverage_runner_reports_ok_for_real_command() -> None:
    runner = make_coverage_runner(_python("print('TOTAL 87%')"))
    result = runner()
    assert result["coverage"] == 0.87
    assert result["ok"] is True
    assert "TOTAL 87%" in result["output"]
    assert result["duration_ms"] >= 0


def test_make_coverage_runner_fails_when_command_fails() -> None:
    """命令退出码非 0：即使打印了覆盖率也不能算通过（测试可能是红的）。"""
    runner = make_coverage_runner(_python("print('TOTAL 99%'); raise SystemExit(2)"))
    result = runner()
    assert result["coverage"] == 0.99
    assert result["ok"] is False


def test_make_coverage_runner_fails_when_output_has_no_number() -> None:
    runner = make_coverage_runner(_python("print('all tests passed')"))
    result = runner()
    assert result["coverage"] is None
    assert result["ok"] is False


def test_make_coverage_runner_times_out_without_hanging_forever() -> None:
    runner = make_coverage_runner(_python("import time; time.sleep(5)"), timeout_s=0.3)
    result = runner()
    assert result["coverage"] is None
    assert result["ok"] is False
    assert "超时" in result["output"]