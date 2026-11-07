from __future__ import annotations

import argparse
import json
import sys
import time

from . import agent as agent_mod
from . import daily as daily_mod
from . import digest as digest_mod
from . import push as push_mod
from . import wecom_bot
from .agenda import due_label, group_by_day, rebuild, summary, to_ics, update_agenda
from .config import CONFIG_PATH, load_config
from .kb import export_all
from .sync import open_store, sync_all
from .voice import download_model, sync_voice


def _print_progress(stage: str, current: int, total: int) -> None:
    width = 28
    ratio = (current / total) if total else 0
    filled = int(width * ratio)
    bar = "#" * filled + "-" * (width - filled)
    sys.stdout.write(f"\r[{bar}] {current}/{total}  {stage[:60]:<60}")
    sys.stdout.flush()


def cmd_sync(args) -> int:
    cfg = load_config()
    sources = [s.strip() for s in args.source.split(",") if s.strip()]
    store = open_store(cfg)
    agenda = None
    kb_stats = None
    try:
        reports = sync_all(
            cfg,
            store=store,
            sources=sources,
            full=args.full,
            progress=None if args.quiet else _print_progress,
        )
        agenda = update_agenda(store, cfg)
        if (cfg.kb or {}).get("auto_export"):
            kb_stats = export_all(cfg, store, progress=None if args.quiet else _print_progress)
    finally:
        store.close()
    if not args.quiet:
        sys.stdout.write("\n")
    payload = [
        {
            "source": r.source,
            "conversations": r.conversations,
            "added": r.added,
            "updated": r.updated,
            "scanned_files": r.scanned_files,
            "skipped": r.skipped,
            "errors": r.errors,
            "elapsed": round(r.elapsed, 2),
        }
        for r in reports
    ]
    if args.json:
        print(json.dumps({"reports": payload, "agenda": agenda, "kb": kb_stats}, ensure_ascii=False, indent=2))
    else:
        for item in payload:
            if item["source"] == "voice":
                print(f"语音: 新转写 {item['added']} 条（缓存命中 {item['skipped']}，"
                      f"回填正文 {item['updated']}），耗时 {item['elapsed']}s")
            else:
                print(f"{item['source']}: 会话 {item['conversations']}，新增 {item['added']} 条，"
                      f"跳过文件 {item['skipped']}，耗时 {item['elapsed']}s")
            for err in item["errors"][:5]:
                print(f"  ! {err}")
        if agenda:
            print(f"日程: 扫描 {agenda['scanned']} 条新消息，识别 {agenda['total']} 项"
                  f"（本次新增 {agenda['inserted']}，{agenda['mode']}），耗时 {agenda['elapsed']}s")
            if agenda.get("ai_error"):
                print(f"  ! AI 日程识别失败，已用规则：{agenda['ai_error'][:80]}")
        if kb_stats:
            print_kb(kb_stats)
    return 0 if all(not r.errors for r in reports) else 1


def print_kb(result: dict) -> None:
    if result.get("error"):
        print(f"知识库: {result['error']}")
        return
    agenda = result.get("agenda") or {}
    notices = result.get("notices") or {}
    media = result.get("media") or {}
    if agenda:
        print(f"知识库·日程: {agenda['rows']} 项 → {agenda['path']}"
              f"{'（已更新）' if agenda['changed'] else '（无变化）'}")
    if notices:
        print(f"知识库·通知候选: {notices['candidates']} 条（已勾选 {notices['checked']}）"
              f" → {notices['path']}{'（已更新）' if notices['changed'] else '（无变化）'}")
    if media:
        extra = ""
        if media.get("compressed"):
            extra = f"，压缩旧图 {media['compressed']} 张（省 {media['saved'] / 1024 / 1024:.0f}MB）"
        print(f"知识库·资源: 扫描 {media['scanned']}，新增 {media['new']}，复用 {media['reused']}，"
              f"缺失 {media['missing']}，累计 {media['unique']} 个{extra} → {media['path']}"
              f"{'（已更新）' if media['changed'] else '（无变化）'}")
    print(f"知识库·耗时 {result.get('elapsed', 0)}s")


def cmd_kb(args) -> int:
    cfg = load_config()
    if args.vault:
        cfg.raw.setdefault("kb", {})["vault"] = args.vault
    if args.days:
        cfg.raw.setdefault("kb", {})["notice_days"] = args.days
        cfg.raw["kb"]["agenda_days"] = args.days
        cfg.raw["kb"]["agenda_overdue_days"] = args.days
    parts = []
    if not args.no_agenda:
        parts.append("agenda")
    if not args.no_notices:
        parts.append("notices")
    if not args.no_media:
        parts.append("media")
    store = open_store(cfg)
    try:
        if args.rebuild:
            rebuild(store)
            store.set_agenda_cursor(store.max_message_id(), "manual rebuild")
        result = export_all(
            cfg,
            store,
            parts=parts,
            progress=None if args.quiet else _print_progress,
            now_ts=int(time.time()),
        )
    finally:
        store.close()
    if not args.quiet:
        sys.stdout.write("\n")
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_kb(result)
    return 1 if result.get("error") else 0


def cmd_agenda(args) -> int:
    cfg = load_config()
    store = open_store(cfg)
    try:
        if args.rebuild:
            rebuild(store)
            store.set_agenda_cursor(store.max_message_id(), "manual rebuild")
        now = int(time.time())
        rows = store.agenda(now - args.overdue * 86400, now + args.days * 86400)
    finally:
        store.close()
    if args.ics:
        path = args.ics
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(to_ics(rows))
        print(f"已导出 {len(rows)} 项日程 → {path}")
        return 0
    if args.json:
        payload = [
            {
                "title": r["title"],
                "due": r["due_ts"],
                "all_day": bool(r["all_day"]),
                "kind": r["kind"],
                "source": r["source"],
                "conversation": r["conv_name"],
                "sender": r["sender_name"],
                "detail": r["detail"],
            }
            for r in rows
        ]
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    overdue, today, week = summary(rows, now)
    print(f"日程 · 逾期 {overdue} · 今天 {today} · 未来 7 天 {week} · 共 {len(rows)} 项")
    if not rows:
        print("没有识别到日程。先运行 `infohub sync`，或加 --rebuild。")
        return 0
    for label, group in group_by_day(rows, now):
        print(f"\n{label}")
        for r in group:
            source = "QQ" if r["source"] == "qq" else "微信"
            print(f"  {due_label(r):>5}  {r['title'][:60]}  [{source}] {r['conv_name']}")
    return 0


def cmd_stats(args) -> int:
    cfg = load_config()
    store = open_store(cfg)
    stats = store.stats()
    states = {
        key: {"status": row["status"], "last_run": row["last_run_ts"], "detail": row["detail"]}
        for key, row in store.source_states().items()
    }
    store.close()
    print(json.dumps({"stats": stats, "sources": states, "db": str(cfg.archive_db)}, ensure_ascii=False, indent=2))
    return 0


def cmd_search(args) -> int:
    cfg = load_config()
    store = open_store(cfg)
    rows = store.search(args.query, limit=args.limit)
    for row in rows:
        print(f"[{row['source']}] {row['conv_name']} · {row['sender_name']} · {row['ts']}\n  {row['content'][:200]}")
    print(f"共 {len(rows)} 条")
    store.close()
    return 0


def cmd_mcp(args) -> int:
    """本机 MCP 采集桥（HTTP）：只有和鸣桌面端/本机客户端需要，默认 127.0.0.1:8776。

    只允许回环地址：这个端点没有鉴权，回环就是边界；非回环直接拒绝启动，
    免得用户误开 `--host 0.0.0.0` 把个人归档暴露到局域网。
    """
    host = (args.host or "").strip() or "127.0.0.1"
    if host not in ("127.0.0.1", "localhost", "::1"):
        print(
            f"采集桥只允许监听本机回环地址（127.0.0.1 / localhost / ::1），拒绝 {host}",
            file=sys.stderr,
        )
        return 2
    # 延迟导入：mcp_server 只在真正要起服务时才加载，其它子命令不受影响。
    from .mcp_server import run

    run(host=host, port=args.port)
    return 0


def cmd_config(args) -> int:
    cfg = load_config()
    print(json.dumps({"path": str(CONFIG_PATH), "config": cfg.raw}, ensure_ascii=False, indent=2))
    return 0


def cmd_notice(args) -> int:
    cfg = load_config()
    if args.no_ai:
        cfg.raw.setdefault("notice", {})["ai"] = False
    store = open_store(cfg)
    try:
        notice = daily_mod.build(store, cfg)
    finally:
        store.close()
    if notice is None:
        print("每日通知: 没有需要转达的班级事务")
        return 0
    if args.json:
        print(
            json.dumps(
                {
                    "date": notice.date,
                    "items": notice.items,
                    "mode": notice.mode,
                    "ai_error": notice.ai_error,
                    "path": notice.path,
                    "text": notice.text,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(notice.text)
        print(f"（{notice.mode} · {notice.items} 条 · {notice.path}）")
    if args.push:
        sent = daily_mod.push_notice(cfg, notice)
        daily_mod.save_state(
            cfg,
            notice.date,
            "sent" if sent.ok else "failed",
            f"{sent.channel}：{sent.detail} · {notice.mode}",
            notice.items,
        )
        print(f"推送[{sent.channel}]: {'成功' if sent.ok else '失败'} · {sent.detail}")
    return 0


def cmd_digest(args) -> int:
    cfg = load_config()
    store = open_store(cfg)
    try:
        result = digest_mod.run(
            store,
            cfg,
            hours=args.hours or None,
            advance=not args.no_advance,
            obsidian=not args.no_obsidian,
            ai=not args.no_ai,
        )
    finally:
        store.close()
    text = digest_mod.to_text(result)
    markdown = digest_mod.to_markdown(result)
    if args.json:
        payload = {
            "since": result.since,
            "until": result.until,
            "total": result.total,
            "by_source": result.by_source,
            "conversations": len(result.convs),
            "mentions": len(result.mentions),
            "new_events": [e["title"] for e in result.new_events],
            "media": result.media,
            "transcripts": result.transcripts,
            "headline": digest_mod.headline(result),
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(markdown if args.markdown else text)
    if args.push:
        if result.empty and not (cfg.push or {}).get("send_empty"):
            print("推送: 本时段没有新消息，跳过")
            return 0
        subject = "InfoHub 简报 " + time.strftime("%m-%d %H:%M")
        sent = push_mod.push(
            cfg, subject, text, digest_mod.to_html(result), digest_mod.to_wecom_markdown(result)
        )
        print(f"推送[{sent.channel}]: {'成功' if sent.ok else '失败'} · {sent.detail}")
        return 0 if sent.ok else 2
    return 0


def cmd_push(args) -> int:
    cfg = load_config()
    if args.channel:
        cfg.raw.setdefault("push", {})["channel"] = args.channel
        cfg.raw["push"]["enabled"] = True
    opts = push_mod.settings(cfg)
    if args.test:
        cfg.raw.setdefault("push", {})["enabled"] = True
        subject = "InfoHub 推送自检"
        body = (
            f"这是一条自检消息，发送于 {time.strftime('%Y-%m-%d %H:%M:%S')}。\n"
            f"通道：{opts['channel']}；收到即说明 InfoHub 能主动发给你。"
        )
        result = push_mod.push(cfg, subject, body, f"<p>{body.replace(chr(10), '<br>')}</p>", body)
    else:
        if args.file:
            with open(args.file, encoding="utf-8") as fh:
                body = fh.read()
        else:
            body = sys.stdin.read()
        subject = args.subject or ("InfoHub 简报 " + time.strftime("%m-%d %H:%M"))
        result = push_mod.push(cfg, subject, body)
    print(f"推送[{result.channel}]: {'成功' if result.ok else '失败'} · {result.detail}")
    return 0 if result.ok else 2


def _fmt_ts(value) -> str:
    if not value:
        return "—"
    return time.strftime("%m-%d %H:%M:%S", time.localtime(int(value)))


def cmd_agent(args) -> int:
    cfg = load_config()
    if args.run:
        plan = [x.strip() for x in (args.plan or "").split(",") if x.strip()] or None
        store = open_store(cfg)
        try:
            run = agent_mod.run(
                cfg,
                store,
                hours=(args.hours or None),
                archive=(False if args.no_archive else None),
                push=(False if args.no_push else None),
                plan=plan,
                progress=None if args.quiet else (
                    lambda text: (sys.stdout.write("\r  " + text[:78].ljust(78)), sys.stdout.flush())
                ),
            )
        finally:
            store.close()
        if not args.quiet:
            sys.stdout.write("\n")
        if args.json:
            print(json.dumps(run.to_dict(), ensure_ascii=False, indent=2))
            return 0 if run.ok else 2
        stamp = time.strftime("%m-%d %H:%M:%S", time.localtime(run.started))
        print(f"智能体 {stamp} · {run.summary()}" + (f" · {run.headline}" if run.headline else ""))
        marks = {"ok": "完成", "warn": "提醒", "skip": "跳过", "error": "失败"}
        for index, step in enumerate(run.steps, 1):
            print(f"  {index}. {step.label} [{marks.get(step.status, step.status)}]"
                  f" {step.seconds:.2f}s · {step.detail}")
        print(f"运行日志: {run.path}")
        return 0 if run.ok else 2

    latest = agent_mod.latest_run(cfg)
    plan = (cfg.agent or {}).get("plan") or list(agent_mod.PLAN_DEFAULT)
    if args.json:
        print(json.dumps({"plan": plan, "latest": latest}, ensure_ascii=False, indent=2))
        return 0
    print("智能体计划: " + " → ".join(agent_mod.TOOLS[n][0] if n in agent_mod.TOOLS else n for n in plan))
    if not latest:
        print("还没有运行记录；用 infohub agent --run 跑一轮")
        return 0
    stamp = time.strftime("%m-%d %H:%M:%S", time.localtime(int(latest.get("started") or 0)))
    print(f"最近一次 {stamp} · {latest.get('summary')}"
          + (f" · {latest.get('headline')}" if latest.get("headline") else ""))
    marks = {"ok": "完成", "warn": "提醒", "skip": "跳过", "error": "失败"}
    for index, step in enumerate(latest.get("steps") or [], 1):
        print(f"  {index}. {step.get('label')} [{marks.get(step.get('status'), step.get('status'))}]"
              f" {float(step.get('seconds') or 0):.2f}s · {step.get('detail')}")
    return 0


def cmd_llm(args) -> int:
    from . import llm as llm_mod

    cfg = load_config()
    opts = llm_mod.settings(cfg)
    if args.test:
        ok, detail = llm_mod.test(cfg)
        print(f"大模型[{opts['model'] or '未填模型'}]：{'可用' if ok else '不可用'} · {detail}")
        return 0 if ok else 2
    if args.summary:
        ok, detail = llm_mod.chat(cfg, args.summary)
        print(detail if ok else f"失败：{detail}")
        return 0 if ok else 2
    if args.profile:
        print(llm_mod.profile_text(opts).strip())
        return 0
    if args.report:
        from . import digest as digest_mod
        from .store import Store

        store = open_store(cfg)
        try:
            window = digest_mod.build(
                store, cfg, int(time.time()) - int(args.report) * 3600
            )
        finally:
            store.close()
        if window.empty:
            print(f"最近 {args.report} 小时没有新消息，跳过分析")
            return 0
        ok, result = llm_mod.report(cfg, digest_mod.to_text(window))
        if not ok:
            print(f"失败：{result}")
            return 2
        print(f"AI 分析报告 · 最近 {args.report} 小时 · {digest_mod.headline(window)}")
        for section in result:
            if not section["items"]:
                continue
            print(f"\n【{section['title']}】")
            for item in section["items"]:
                print(f"· {item}")
        return 0
    print(json.dumps({
        "enabled": opts["enabled"],
        "base_url": opts["base_url"],
        "model": opts["model"],
        "local": llm_mod.is_local(opts["base_url"]),
        "allow_remote": opts["allow_remote"],
        "available": llm_mod.available(cfg),
        "api_key": "已设置" if opts["api_key"] else "未设置",
        "agent_prompt": "自定义" if str(opts.get("agent_prompt") or "").strip() else "内置档案",
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_bot(args) -> int:
    cfg = load_config()
    if not wecom_bot.configured(cfg):
        print("缺 wecom_bot_id / wecom_bot_secret：在 config.json 的 push 里填，或用环境变量 "
              "INFOHUB_WECOM_BOT_ID / INFOHUB_WECOM_BOT_SECRET")
        return 2
    if args.serve:
        return wecom_bot.serve(cfg)
    if args.stop:
        ok, detail = wecom_bot.stop_daemon(cfg)
        print(f"后台：{'已停止' if ok else '未停止'} · {detail}")
        return 0 if ok else 1
    if args.send:
        result = wecom_bot.push(cfg, args.send)
        print(f"推送[{result.channel}]: {'成功' if result.ok else '失败'} · {result.detail}")
        return 0 if result.ok else 2
    st = wecom_bot.ensure_daemon(cfg)
    if args.json:
        print(json.dumps(st or {"ok": False}, ensure_ascii=False, indent=2))
        return 0 if st else 1
    if not st:
        print(f"后台没起来，看日志 {wecom_bot.log_path(cfg)}")
        return 1
    st = wecom_bot.wait_ready(cfg) or st
    print(f"后台 pid={st.get('pid')} 端口={st.get('port')} 运行 {st.get('uptime')}s")
    print(f"长连接：{'已认证' if st.get('connected') else '未就绪'}  {st.get('last_error') or ''}".rstrip())
    print(f"会话：{'已记录 ' + ('群聊' if st.get('chat_type') == 2 else '单聊') if st.get('chat_known') else '还没收到你的消息，先在企微里给机器人发一条'}")
    print(f"最近收到 {_fmt_ts(st.get('last_seen'))} · 最近发送 {_fmt_ts(st.get('last_sent'))}")
    print(f"状态文件 {wecom_bot.state_path(cfg)} · 日志 {wecom_bot.log_path(cfg)}")
    return 0


def cmd_voice(args) -> int:
    cfg = load_config()
    if args.model_dir:
        cfg.raw.setdefault("voice", {})["model_dir"] = args.model_dir
    if args.download:
        path = download_model(cfg, progress=None if args.quiet else _print_progress)
        if not args.quiet:
            sys.stdout.write("\n")
        print(f"语音模型 {path}")
        if args.model_only:
            return 0
    store = open_store(cfg)
    try:
        report = sync_voice(
            store,
            cfg,
            progress=None if args.quiet else _print_progress,
            rebuild=args.rebuild,
            limit=args.limit,
        )
    finally:
        store.close()
    if not args.quiet:
        sys.stdout.write("\n")
    payload = {
        "transcribed": report.added,
        "cached": report.skipped,
        "updated": report.updated,
        "scanned": report.scanned_files,
        "errors": report.errors,
        "elapsed": round(report.elapsed, 2),
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"语音: 扫描 {report.scanned_files} 条，新转写 {report.added}，"
              f"缓存命中 {report.skipped}，回填正文 {report.updated}，"
              f"失败 {len(report.errors)}，耗时 {report.elapsed:.1f}s")
        for err in report.errors[:5]:
            print(f"  ! {err}")
    return 0 if not report.errors else 1


def cmd_qqnt(args) -> int:
    import shutil
    import sqlite3
    import tempfile
    from pathlib import Path

    from .sources import qqnt

    db = Path(args.db) if args.db else qqnt.find_db(args.account)
    if db is None:
        print("没有找到 nt_msg.db", file=sys.stderr)
        return 2
    meta = qqnt.read_meta(db)
    print(f"库 {db}")
    print(f"  {meta.size / 1e6:.1f} MB · {meta.pages} 页 · salt {meta.salt.hex()}")
    started = time.time()
    try:
        key, reserve, how = qqnt.capture_key(meta, timeout=args.timeout)
    except qqnt.KeyCapture as exc:
        print(f"密钥抓取失败：{exc}", file=sys.stderr)
        return 3
    print(f"密钥 {key.hex()[:8]}… · reserve={reserve} · 来源 {how} · {time.time() - started:.1f}s")

    workdir = Path(args.out).parent if args.out else Path(tempfile.mkdtemp(prefix="qqnt_plain_"))
    plain = Path(args.out) if args.out else workdir / "nt_msg_plain.db"
    plain.parent.mkdir(parents=True, exist_ok=True)
    qqnt.decrypt_file(db, plain, key, reserve)
    print(f"明文库 {plain} ({plain.stat().st_size / 1e6:.1f} MB)")

    con = sqlite3.connect(plain)
    try:
        names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        rows = []
        for name in names:
            try:
                n = con.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
            except sqlite3.DatabaseError:
                n = -1
            rows.append((name, n))
        if args.json:
            print(json.dumps({"db": str(db), "tables": rows}, ensure_ascii=False, indent=2))
        else:
            print(f"表 {len(rows)} 个")
            for name, n in sorted(rows, key=lambda r: -r[1]):
                print(f"  {name:<40} {n:>8}")
            if args.schema:
                for name in names:
                    if any(k in name.lower() for k in ("msg", "message", "c2c", "group")):
                        sql = con.execute(
                            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)
                        ).fetchone()[0]
                        print(f"\n-- {name}\n{sql}")
    finally:
        con.close()
    if not args.keep and not args.out:
        shutil.rmtree(workdir, ignore_errors=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="infohub", description="InfoHub 信息中枢")
    sub = parser.add_subparsers(dest="command")

    p_sync = sub.add_parser("sync", help="采集 QQNT / 微信消息")
    p_sync.add_argument("--source", default="qq,wechat", help="qq / wechat / qq,wechat")
    p_sync.add_argument("--full", action="store_true", help="全量重读（忽略增量游标）")
    p_sync.add_argument("--json", action="store_true")
    p_sync.add_argument("--quiet", action="store_true")
    p_sync.set_defaults(func=cmd_sync)

    p_stats = sub.add_parser("stats", help="查看归档统计")
    p_stats.set_defaults(func=cmd_stats)

    p_search = sub.add_parser("search", help="全文检索")
    p_search.add_argument("query")
    p_search.add_argument("--limit", type=int, default=50)
    p_search.set_defaults(func=cmd_search)

    p_agenda = sub.add_parser("agenda", help="查看从消息里识别出的日程")
    p_agenda.add_argument("--days", type=int, default=14, help="往后看多少天")
    p_agenda.add_argument("--overdue", type=int, default=30, help="往前看多少天（逾期）")
    p_agenda.add_argument("--json", action="store_true")
    p_agenda.add_argument("--ics", default="", help="导出 .ics 日历文件到指定路径")
    p_agenda.add_argument("--rebuild", action="store_true", help="先重扫消息再输出")
    p_agenda.set_defaults(func=cmd_agenda)

    p_mcp = sub.add_parser("mcp", help="本机 MCP 采集桥（HTTP，只监听回环；供和鸣桌面端/插件使用）")
    p_mcp.add_argument("--host", default="127.0.0.1", help="监听地址（只允许 127.0.0.1 / localhost / ::1）")
    p_mcp.add_argument("--port", type=int, default=8776, help="监听端口（默认 8776）")
    p_mcp.set_defaults(func=cmd_mcp)

    p_config = sub.add_parser("config", help="查看配置")
    p_config.set_defaults(func=cmd_config)

    p_kb = sub.add_parser("kb", help="导出日程/通知候选/资源到 Obsidian 知识库")
    p_kb.add_argument("--vault", default="", help="知识库根目录（默认读配置）")
    p_kb.add_argument("--days", type=int, default=0, help="覆盖日程与通知窗口天数")
    p_kb.add_argument("--rebuild", action="store_true", help="先重扫日程再导出")
    p_kb.add_argument("--no-agenda", action="store_true")
    p_kb.add_argument("--no-notices", action="store_true")
    p_kb.add_argument("--no-media", action="store_true")
    p_kb.add_argument("--json", action="store_true")
    p_kb.add_argument("--quiet", action="store_true")
    p_kb.set_defaults(func=cmd_kb)

    p_voice = sub.add_parser("voice", help="语音转写：保原文 + SenseVoice 转文字回填正文")
    p_voice.add_argument("--download", action="store_true", help="先下载/解压 SenseVoice 模型")
    p_voice.add_argument("--model-only", action="store_true", help="只下载模型，不转写")
    p_voice.add_argument("--model-dir", default="", help="覆盖模型目录")
    p_voice.add_argument("--rebuild", action="store_true", help="忽略缓存重新转写")
    p_voice.add_argument("--limit", type=int, default=0, help="本次最多转写多少条")
    p_voice.add_argument("--json", action="store_true")
    p_voice.add_argument("--quiet", action="store_true")
    p_voice.set_defaults(func=cmd_voice)

    p_digest = sub.add_parser("digest", help="生成小时简报（可选推送到企业微信/邮箱）")
    p_digest.add_argument("--hours", type=float, default=0, help="回看多少小时（默认读配置，1）")
    p_digest.add_argument("--push", action="store_true", help="生成后按配置推送")
    p_digest.add_argument("--markdown", action="store_true", help="打印 Markdown 而不是纯文本")
    p_digest.add_argument("--no-advance", action="store_true", help="不推进简报游标（调试用）")
    p_digest.add_argument("--no-obsidian", action="store_true", help="不写 Obsidian 简报页")
    p_digest.add_argument("--no-ai", action="store_true", help="跳过 AI 分析报告（默认开启时调用已配置的大模型）")
    p_digest.add_argument("--json", action="store_true")
    p_digest.set_defaults(func=cmd_digest)

    p_notice = sub.add_parser("notice", help="每日通知：汇总班级公共事务（可选推送）")
    p_notice.add_argument("--push", action="store_true", help="生成后按配置推送")
    p_notice.add_argument("--no-ai", action="store_true", help="只用规则渲染，不调大模型")
    p_notice.add_argument("--json", action="store_true")
    p_notice.set_defaults(func=cmd_notice)

    p_agent = sub.add_parser("agent", help="小时智能体：同步→AI→Obsidian→日程→推送")
    p_agent.add_argument("--run", action="store_true", help="立即执行一轮流水线")
    p_agent.add_argument("--hours", type=float, default=0, help="回看多少小时（默认读 digest.hours）")
    p_agent.add_argument("--plan", default="", help="覆盖步骤，逗号分隔：sync,analyze,archive,agenda,push")
    p_agent.add_argument("--no-archive", action="store_true", help="本轮不写 Obsidian")
    p_agent.add_argument("--no-push", action="store_true", help="本轮不推送")
    p_agent.add_argument("--json", action="store_true")
    p_agent.add_argument("--quiet", action="store_true")
    p_agent.set_defaults(func=cmd_agent)

    p_push = sub.add_parser("push", help="推送通道自检 / 发送一段文本")
    p_push.add_argument("--test", action="store_true", help="发送一条自检消息")
    p_push.add_argument("--channel", default="", choices=["", "smtp", "wecom", "wecom_bot"],
                        help="临时覆盖通道")
    p_push.add_argument("--file", default="", help="从文件读取正文（默认读 stdin）")
    p_push.add_argument("--subject", default="")
    p_push.set_defaults(func=cmd_push)

    p_bot = sub.add_parser("bot", help="企业微信智能机器人长连接后台")
    p_bot.add_argument("--serve", action="store_true", help="前台运行后台服务（内部用）")
    p_bot.add_argument("--stop", action="store_true", help="停止后台")
    p_bot.add_argument("--send", default="", help="经后台上行一段 Markdown")
    p_bot.add_argument("--json", action="store_true", help="打印原始状态 JSON")
    p_bot.set_defaults(func=cmd_bot)

    p_llm = sub.add_parser("llm", help="大模型配置查看 / 连通性自检")
    p_llm.add_argument("--test", action="store_true", help="发一条最小请求测试接口")
    p_llm.add_argument("--summary", default="", help="把一段文本交给模型总结")
    p_llm.add_argument(
        "--report", type=int, default=0, metavar="HOURS",
        help="对最近 N 小时的真实消息生成分析报告并打印",
    )
    p_llm.add_argument("--profile", action="store_true", help="打印当前生效的系统提示词（身份/人物档案）")
    p_llm.set_defaults(func=cmd_llm)

    p_qqnt = sub.add_parser("qqnt", help="调试：抓取 QQNT 本地库密钥、解密并列出表结构")
    p_qqnt.add_argument("--account", default="", help="QQ 号；默认取最近更新的账号")
    p_qqnt.add_argument("--db", default="", help="直接指定 nt_msg.db 路径")
    p_qqnt.add_argument("--timeout", type=float, default=90, help="等待密钥出现的秒数")
    p_qqnt.add_argument("--out", default="", help="明文库输出路径（默认临时目录）")
    p_qqnt.add_argument("--schema", action="store_true", help="打印消息相关表的建表语句")
    p_qqnt.add_argument("--json", action="store_true")
    p_qqnt.add_argument("--keep", action="store_true", help="保留临时明文库")
    p_qqnt.set_defaults(func=cmd_qqnt)

    args = parser.parse_args(argv)
    if not args.command:
        from .ui.main_window import run_app

        return run_app()
    return args.func(args)
