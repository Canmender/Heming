import json
from dataclasses import replace
from agent_pipeline.config import Budget, Settings
from agent_pipeline.llm import FakeLLM
from agent_pipeline.protocol import TaskSpec
from agent_pipeline.runtime import build_runtime, run_once

def node(messages):
    s="\n".join(str(m.get("content","")) for m in messages if m.get("role")=="system")
    for kw,name in (("规划者","plan"),("执行者","execute"),("反思者","reflect"),("评审者","critic")):
        if kw in s: return name
    return "summarize"

def test_plan_prompt_mentions_step_limit(tmp_path):
    prompts=[]
    def script(messages, tools):
        n=node(messages)
        if n=="plan":
            prompts.append("\n".join(str(m.get("content","")) for m in messages))
            return {"text": json.dumps({"steps":[{"goal":f"步骤{i}","done_when":"完成"} for i in range(1,5)]})}
        if n=="execute": return {"text":"不用工具"}
        if n=="reflect": return {"text": json.dumps({"verdict":"done","reasons":["够了"]})}
        if n=="critic": return {"text": json.dumps({"score":0.9,"blocking_issues":[],"suggestions":[]})}
        return {"text": json.dumps({"answer":"好","citations":[]})}
    st = replace(Settings(db_path=":memory:", log_path=str(tmp_path/"runs.jsonl")), budget=Budget(max_steps=2))
    rt = build_runtime(st, llm=FakeLLM(script=[script]*10))
    res,_ = run_once(rt, TaskSpec(goal="四步任务"), run_id="run-plan-limit")
    assert "最多 2 个步骤" in prompts[0], prompts[0][-200:]
    assert len(res.plan) == 2, res.plan
