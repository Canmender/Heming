from __future__ import annotations

import ipaddress
import json
import os
import re
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlparse

from .config import Config

DEFAULTS = {
    "enabled": False,
    "base_url": "http://127.0.0.1:11434/v1",
    "model": "qwen2.5:7b",
    "api_key": "",
    "timeout": 60,
    "max_chars": 6000,
    "allow_remote": False,
    "prompt": "",
    "agent_prompt": "",
}

USER_AGENT = "InfoHub/0.1 (local digest)"
# OpenCode Go 网关按会话路由，缺这个头会直接 400
SESSION_ID = uuid.uuid4().hex
EMPTY_WORDS = {"无", "暂无", "没有", "无。", "暂无。", "（无）", "(无)"}
# QQ 是工作信息源，微信是私人生活源；报告按来源分节
SECTIONS = (
    "工作 · 结论",
    "工作 · 待办与截止",
    "工作 · 通知与风险",
    "生活 · 动态",
    "生活 · 待办与提醒",
)
LEGACY_SECTIONS = ("结论", "待办与截止", "重要通知", "风险提醒")
ALL_SECTIONS = SECTIONS + LEGACY_SECTIONS

# 只吃文本，不传图片/文件；提示词要求不编造，宁缺毋滥
REPORT_PROMPT = (
    "你是班长付梓杨的信息助理。用户会给你一段时间内的聊天原文，已按「工作（QQ）」和"
    "「生活（微信）」分组；工作消息主要是班级、学院和学生会事务，生活消息主要是私人往来。\n"
    "请判断哪些内容真正需要他本人知道或处理，严格按下面五段输出，段名原样保留，"
    "每段用「## 段名」单独一行：\n"
    "## 工作 · 结论\n"
    "一段话，不超过 60 字，说清这段时间最要紧的工作事项和整体状态；没有就写「无」。\n"
    "## 工作 · 待办与截止\n"
    "每条以时间开头，例如「10-31 18:00 交报名表」；最多 4 条；没有就写「无」。\n"
    "## 工作 · 通知与风险\n"
    "上级通知、规则变化、@我未回、时间冲突、截止临近等，每条不超过 40 字；最多 5 条；没有就写「无」。\n"
    "## 生活 · 动态\n"
    "私人生活里值得知道的 1-3 条，每条不超过 40 字；寒暄、刷屏和无关闲聊不写；没有就写「无」。\n"
    "## 生活 · 待办与提醒\n"
    "私人待办、约会、缴费、家人交代等，每条不超过 40 字；最多 3 条；没有就写「无」。\n"
    "只依据给定内容，禁止编造人名、数字、时间和链接；拿不准就不写。"
    "不要输出其它段名、表格、寒暄或解释。"
)

AGENDA_PROMPT = (
    "你是日程抽取器。输入是一个 JSON 数组，元素为 {id, conv, sender, time, text}。\n"
    "只抽取明确带日期或时间的待办、截止、会议、活动、考试、缴费、报名；"
    "寒暄、提问、纯转发、没有时间的信息一律不要。\n"
    "以每条消息的 time 为基准解释「明天」「下周三」等相对时间；"
    "没有具体时刻就把 all_day 设为 true，due 用当天 00:00。\n"
    "只输出 JSON 数组，不要 markdown 代码块、不要解释：\n"
    '[{"id": 消息id, "title": "不超过24字的动作", "due": "YYYY-MM-DD HH:MM", '
    '"all_day": false, "kind": "task", "detail": "原消息里的依据，最多60字"}]\n'
    "kind 只能是 task/meeting/activity/exam/signup/payment。没有可抽取的日程就输出 []。"
    "禁止编造时间、人名和地点；拿不准就丢弃。"
)

AGENDA_KINDS = {"task", "meeting", "activity", "exam", "signup", "payment"}

DAILY_PROMPT = (
    "你是班长付梓杨的通知撰写助手。输入是一个 JSON，包含 today、deadlines（已有日程）"
    "和 notices（近期通知原文）。\n"
    "请整理成一份可以直接转发到班级群的《每日通知》，严格按下面的纯文本格式输出：\n"
    "第一行：{class_name} 每日通知（{month} 月 {day} 日）\n"
    "空一行，随后每条：\n"
    "1、事项标题\n"
    "正文两三句，写清截止时间、要交的材料或地点、同学需要做什么。\n\n"
    "规则：\n"
    "- 合并同一主题的多条材料；按截止时间从近到远排序；最多 {max_items} 条。\n"
    "- 只使用给定材料，禁止编造日期、金额、地点、人名和材料；材料里没有的细节不写。\n"
    "- 材料里出现「重要」「务必」「逾期视为放弃」的，在标题后加「（重要）」。\n"
    "- 不要输出 markdown 符号（**、#、-）、解释或前后缀；标题行和编号必须保留。\n"
    "- 如果材料不足以写成完整通知，就只输出标题行和一句「今天暂无需要转达的班级事务」。"
)

SYSTEM_PROMPT = REPORT_PROMPT

# 人物与身份档案：默认按本机归档实证整理，可在设置里改
PROFILE_PROMPT = (
    "## 用户身份\n"
    "付梓杨，武汉轻工大学经济学院金融学 2026 级（金融2601班）本科生。\n"
    "职务：金融2601班班长（兼体育委员、治保委员）；经济学院学生会秘书处干事。\n"
    "群名片/别名：林寸、金融2601付梓杨、金融2601班长付梓杨、秘书处 付梓杨。\n"
    "工作习惯：常在班级群发「每日通知」；上级通知需要他转达到班群。\n\n"
    "## 关键人物\n"
    "- 叶老师：2026 级辅导员，发布学院与班团通知、评奖评优、班团任免。\n"
    "- 周康：金融2601导学员（学长），也是私下高频联系人。\n"
    "- 卓思晓：金融2601副班长，常代发班级通知；市调赛队友。\n"
    "- 宋佳琦：金融2601团支书（兼宣传、心理委员）。\n"
    "- 张航：金融2601组织委员（兼文娱委员）。\n"
    "- 黄皓雨：金融2601学习委员（兼生活委员）。\n"
    "- 伍霭玲：院学生会秘书处负责人。\n"
    "- 陈思雨：活动指导部部长；唐楷淇、鲁至文：学生会主席团。\n"
    "- 潘原伊、谭乔月：学建部，负责寝室检查和生活委员线。\n"
    "- 陈羽熙、陈梓琦、黄梦怡：市场调查分析大赛（市调赛）队友。\n"
    "- 陶奕如：金融2603班长，班团对接。\n"
    "- 付文兵：家人，常聊家里事；朱琳：常聊好友。\n\n"
    "## 群聊语境\n"
    "- 金融2601班群：本班事务，他在这里以班长身份发通知。\n"
    "- 秘书处大家庭（无主席版）：院学生会秘书处工作。\n"
    "- 经济学院26级新生群、26级本科生班团群：辅导员与各班班团通知。\n"
    "- 市调赛：比赛小组；活动指导部工作群、经院生活委员治保群：任务对接。\n"
    "- 劳动先疯队2601版：课程/比赛小组，成员多用 QQ 号昵称。\n\n"
    "## 分析偏好\n"
    "- 叶老师、主席团、部长发的是上级任务，优先级高于普通群聊。\n"
    "- 班级事务要判断是否需要他转达到班群；@我 的尽量给出回复对象。\n"
    "- 人物不在名单里时按群名片称呼，不要猜职务；关系拿不准就不写。\n"
)

_BULLET = re.compile(r"^\s*(?:[-*·•>]+|\d+\s*[.、)])\s*")
_LIMITS = {
    "工作 · 结论": (1, 120),
    "工作 · 待办与截止": (4, 60),
    "工作 · 通知与风险": (5, 60),
    "生活 · 动态": (3, 80),
    "生活 · 待办与提醒": (3, 60),
    "结论": (1, 120),
    "待办与截止": (4, 60),
    "重要通知": (3, 60),
    "风险提醒": (3, 60),
}


def _canon_title(text: str) -> str:
    raw = str(text or "").strip()
    raw = re.sub(r"^#{1,4}\s*", "", raw)
    raw = raw.replace("**", "").replace("__", "").replace("`", "")
    raw = re.sub(r"[（(][^）)]*[）)]\s*$", "", raw)
    raw = raw.replace("・", "·").replace("•", "·")
    raw = re.sub(r"\s+", "", raw)
    return raw.strip("：:，,。.")


_TITLES = {_canon_title(title): title for title in ALL_SECTIONS}


def _split_header(line: str) -> tuple[str, str] | None:
    """只把已知段名当标题；普通消息里的冒号不会误判。"""
    raw = line.strip()
    raw = re.sub(r"^#{1,4}\s*", "", raw)
    raw = raw.replace("**", "").replace("__", "").strip("` ")
    if not raw or raw[0] in "-*·•>0123456789":
        return None
    rest = ""
    for sep in ("：", ":"):
        if sep in raw:
            raw, _, rest = raw.partition(sep)
            break
    title = _TITLES.get(_canon_title(raw))
    if not title:
        return None
    return title, rest


def settings(cfg: Config) -> dict:
    out = dict(DEFAULTS)
    out.update(cfg.raw.get("llm") or {})
    base = str(os.environ.get("INFOHUB_LLM_BASE_URL") or out.get("base_url") or "")
    base = base.strip().rstrip("/")
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    out["base_url"] = base
    out["api_key"] = str(
        os.environ.get("INFOHUB_LLM_API_KEY") or out.get("api_key") or ""
    ).strip()
    out["model"] = str(
        os.environ.get("INFOHUB_LLM_MODEL") or out.get("model") or ""
    ).strip()
    try:
        out["timeout"] = max(5, int(out.get("timeout") or 60))
        out["max_chars"] = max(500, int(out.get("max_chars") or 6000))
    except (TypeError, ValueError):
        out["timeout"], out["max_chars"] = 60, 6000
    return out


def profile_text(opts: dict) -> str:
    return str(opts.get("agent_prompt") or "").strip() or PROFILE_PROMPT


def is_local(base_url: str) -> bool:
    host = (urlparse(base_url or "").hostname or "").lower()
    if host in ("localhost", "::1"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private


def available(cfg: Config) -> bool:
    opts = settings(cfg)
    if not (opts["enabled"] and opts["base_url"] and opts["model"]):
        return False
    if is_local(opts["base_url"]):
        return True
    return bool(opts["allow_remote"])


def _clip(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _http_hint(code: int, body: str) -> str:
    """把常见 HTTP 错误翻成能直接照做的中文。"""
    low = body.lower()
    if code == 402 or "insufficient" in low or "balance" in low or "fund" in low:
        return "账户余额/额度不足，需要充值或换一个接口"
    if code == 401:
        return "API Key 无效或没带，检查 Key 是否填对"
    if code == 403:
        if "1010" in body or "cloudflare" in low:
            return "被对方站点的 Cloudflare 拦截：这不是 API 地址，或地址少了 /v1"
        return "无权访问：检查 Key 权限，或地址是否为 OpenAI 兼容的 /v1 接口"
    if code == 404:
        return "接口地址不对：OpenAI 兼容地址通常以 /v1 结尾"
    if code == 400 and "session" in low:
        return "网关要求会话头 x-opencode-session，当前版本应已自动带上，请升级或换地址"
    if code == 429 or "rate" in low or "free usage limit" in low:
        return "请求被限流或免费额度用完，稍后再试或换模型"
    if code >= 500:
        return "接口服务端出错，稍后再试"
    return "接口返回错误"


def _headers(opts: dict, url: str) -> dict:
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    if (urlparse(url).hostname or "").endswith("opencode.ai"):
        headers["x-opencode-session"] = SESSION_ID
    if opts.get("api_key"):
        headers["Authorization"] = f"Bearer {opts['api_key']}"
    return headers


def _post(opts: dict, payload: dict, timeout: float | None = None) -> tuple[bool, str]:
    url = opts["base_url"].rstrip("/") + "/chat/completions"
    headers = _headers(opts, url)
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout or opts["timeout"]) as resp:  # noqa: S310
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:200]
        except OSError:
            pass
        return False, f"HTTP {exc.code} · {_http_hint(exc.code, body)}（{body or exc.reason}）"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, f"连不上 {opts['base_url']}：{type(exc).__name__}: {exc}"
    try:
        data = json.loads(raw)
    except ValueError:
        return False, f"返回不是 JSON：{raw[:120]}"
    if isinstance(data.get("error"), dict):
        return False, str(data["error"].get("message") or data["error"])[:200]
    try:
        message = data["choices"][0]["message"]
        content = message["content"]
    except (KeyError, IndexError, TypeError):
        return False, f"返回里没有 choices：{raw[:120]}"
    text = str(content or "").strip()
    if not text:
        if str(message.get("reasoning_content") or "").strip():
            return False, "模型只输出了推理、没写正文：调大 max_tokens 或换非推理模型"
        return False, "模型返回空内容"
    return True, text


def chat(cfg: Config, user_text: str, system: str | None = None,
         max_tokens: int = 1200, timeout: float | None = None) -> tuple[bool, str]:
    """OpenAI 兼容 /chat/completions；成功返回 (True, 文本)。"""
    opts = settings(cfg)
    if not available(cfg):
        if not opts["enabled"]:
            return False, "未启用大模型"
        if not is_local(opts["base_url"]) and not opts["allow_remote"]:
            return False, "接口不是本机地址，需要在设置里确认允许上传"
        return False, "缺接口地址或模型名"
    if system is None:
        system = profile_text(opts) + "\n你是中文信息整理助手，回答简洁，只依据给到的内容。"
    text = _clip(str(user_text or "").strip(), opts["max_chars"])
    payload = {
        "model": opts["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
        "temperature": 0.3,
        "max_tokens": max_tokens,
        "stream": False,
    }
    return _post(opts, payload, timeout=timeout)


def _clean_item(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("**", "").replace("__", "")).strip(" 　")


def parse_report(text: str) -> list[dict]:
    """把模型输出整理成 [{"title", "items"}]，认不出段落时退化成单段。"""
    found: dict[str, list[str]] = {}
    order: list[str] = []
    current: str | None = None
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("```"):
            continue
        header = _split_header(line)
        if header:
            current, rest = header
            if current not in found:
                found[current] = []
                order.append(current)
            rest = _clean_item(_BULLET.sub("", rest))
            if rest and rest not in EMPTY_WORDS:
                found[current].append(rest)
            continue
        if current is None:
            continue
        item = _clean_item(_BULLET.sub("", line))
        if item and item not in EMPTY_WORDS:
            found[current].append(item)

    sections: list[dict] = []
    for title in order:
        cap, width = _LIMITS[title]
        items = []
        for item in found.get(title, []):
            if item not in items:
                items.append(_clip(item, width))
        if title.endswith("结论"):
            items = [_clip(" ".join(items), width)] if items else []
        else:
            items = items[:cap]
        sections.append({"title": title, "items": items})
    if any(section["items"] for section in sections):
        return sections

    # 模型没按格式走：保留原文，按单段「要点」展示，不丢内容
    loose = [_clean_item(_BULLET.sub("", line)) for line in (text or "").splitlines()]
    loose = [_clip(x, 120) for x in loose if x and x not in EMPTY_WORDS]
    if not loose:
        return []
    return [{"title": "要点", "items": [_clip(" ".join(loose), 600)]}]


def report(cfg: Config, digest_text: str) -> tuple[bool, list[dict] | str]:
    """分析简报并生成分段报告；失败返回 (False, 中文错误)。"""
    opts = settings(cfg)
    extra = str(opts.get("prompt") or "").strip()
    system = (
        profile_text(opts) + "\n" + REPORT_PROMPT
        + ("\n额外要求：" + extra if extra else "")
    )
    ok, text = chat(cfg, digest_text, system=system, max_tokens=1800)
    if not ok:
        return False, text
    sections = parse_report(text)
    if not sections:
        return False, f"模型返回里没有可用内容：{_clip(text.strip(), 80) or '(空)'}"
    return True, sections


def parse_agenda_items(text: str) -> list[dict] | None:
    """解析日程 JSON；认不出数组返回 None（区别于合法的 []）。"""
    raw = text or ""
    start, end = raw.find("["), raw.rfind("]")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(raw[start : end + 1])
    except ValueError:
        return None
    if not isinstance(data, list):
        return None
    items: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            msg_id = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        due = str(item.get("due") or "").strip()
        title = re.sub(r"\s+", " ", str(item.get("title") or "")).strip(" ，,。;；")
        if not title or not due:
            continue
        kind = str(item.get("kind") or "task").strip().lower()
        items.append(
            {
                "id": msg_id,
                "title": _clip(title, 46),
                "due": due,
                "all_day": bool(item.get("all_day")),
                "kind": kind if kind in AGENDA_KINDS else "task",
                "detail": _clip(str(item.get("detail") or "").strip(), 120),
            }
        )
    return items


def agenda_events(cfg: Config, messages: list[dict]) -> tuple[bool, list[dict] | str]:
    """让模型从新消息里抽日程；成功返回 (True, items)，失败返回中文错误。"""
    opts = settings(cfg)
    system = profile_text(opts) + "\n" + AGENDA_PROMPT
    payload = json.dumps(messages, ensure_ascii=False)
    ok, text = chat(cfg, payload, system=system, max_tokens=1400)
    if not ok:
        return False, text
    items = parse_agenda_items(text)
    if items is None:
        return False, f"模型没有返回可解析的 JSON：{_clip(text.strip(), 80)}"
    return True, items


def daily_notice(
    cfg: Config,
    material: str,
    *,
    class_name: str,
    month: int,
    day: int,
    max_items: int,
    max_tokens: int = 6000,
    timeout: float = 180,
) -> tuple[bool, str]:
    """把日程与通知原文写成班级每日通知；返回纯文本。"""
    opts = settings(cfg)
    prompt = (
        DAILY_PROMPT.replace("{class_name}", class_name)
        .replace("{month}", str(month))
        .replace("{day}", str(day))
        .replace("{max_items}", str(max_items))
    )
    system = profile_text(opts) + "\n" + prompt
    # 推理模型会先花几千 token 思考，max_tokens 给小了正文直接为空
    return chat(cfg, material, system=system, max_tokens=max_tokens, timeout=timeout)


def test(cfg: Config) -> tuple[bool, str]:
    ok, text = chat(cfg, "只回复：ok", system="你是连通性测试助手。", max_tokens=64)
    if not ok:
        return False, text
    return True, f"模型 {settings(cfg)['model']} 返回：{text[:40] or '(空)'}"
