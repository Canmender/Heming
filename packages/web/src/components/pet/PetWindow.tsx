import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { loadPetPrefs, petModelUrl } from "../../lib/petPrefs.js";
import { classifyPointerUp, isInteractiveAt, shouldReportChange, type Rect } from "./petInteraction.js";
import { useLive2D } from "./useLive2D.js";
import { usePetChat } from "./usePetChat.js";

/**
 * 桌宠窗口（d.46）。
 *
 * 这个组件同时是「画面」和「输入设备」：
 * - 画面：pixi + Live2D（懒加载，见 useLive2D）
 * - 输入：拖拽移动窗口、单击呼出输入框、双击播动作、右键菜单；
 *   并且要持续告诉主进程「光标现在是不是在角色上」，主进程据此决定挡不挡鼠标。
 *
 * ★ 全部用原生 mousemove/mousedown 而不是 React 的 onPointerMove：
 *   窗口处于「穿透」状态时，Electron 的 forward 转发的是 mouse 事件，
 *   PointerEvent 在部分平台不会到达——用 React 合成事件会表现为「角色永远点不中」。
 */

const BUBBLE_MAX_WIDTH = 260;

export function PetWindow() {
  const prefs = useMemo(() => loadPetPrefs(), []);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 300 : window.innerWidth || 300,
    height: typeof window === "undefined" ? 420 : window.innerHeight || 420,
  }));
  const [inputOpen, setInputOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  /**
   * canvas 元素用 state 承载，不用 useRef。
   *
   * ★ 这里踩过一次：ref.current 在首次渲染时是 null，而 useLive2D 的 effect 依赖它——
   *   effect 拿到 null 直接早退，之后 ref 被赋值也不会触发重渲染，于是模型永远不加载，
   *   表现为「透明窗口在、角色不在、控制台还没有任何报错」。用 state 才能让赋值触发重跑。
   */
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLFormElement | null>(null);
  const inputElRef = useRef<HTMLInputElement | null>(null);

  const chat = usePetChat(prefs.agentId);

  // 模型与 Core 都从当前页面的源取（app://heming 或部署站点），不联网。
  //
  // ★ 不能用 window.location.origin：自定义 scheme（app://heming）下它不是
  //   "app://heming"，而是字符串 "null" 或空——拼出来的地址是 "null/pet/..."，
  //   Cubism Core 与模型都会 404，表现是「窗口在、角色不在、控制台也没报错」。
  //   改为从 href 截掉文件名得到目录基址，两条路径都成立：
  //     app://heming/pet.html        → app://heming/
  //     http://host/sub/pet.html     → http://host/sub/
  const assetBase = useMemo(() => {
    if (typeof window === "undefined") return "";
    const href = window.location.href.split("#")[0].split("?")[0];
    return href.replace(/[^/]*$/, "");
  }, []);
  const modelUrl = petModelUrl(prefs.modelPath, assetBase);
  const coreUrl = `${assetBase}pet/live2dcubismcore.min.js`;

  const stage = useLive2D({
    canvas: canvasEl,
    modelUrl,
    coreUrl,
    width: viewport.width,
    height: viewport.height,
  });

  /**
   * ★ 解构出稳定引用后再进 effect 依赖。
   * `useLive2D` 每次渲染都返回一个新对象，若把整个 stage 放进依赖数组，
   * 每个 effect（含口型那个 rAF 循环）都会在每次渲染时拆掉重建——表现是口型抖动、
   * 事件监听反复解绑重绑。hook 内部这些方法都是 useCallback 稳定的，单独依赖即可。
   */
  const { setMouthOpen, playMotion, focus, focusCenter } = stage;
  /** hitBox 会随视口尺寸变化，用 ref 读，避免把 mousemove 监听绑到它身上。 */
  const hitBoxRef = useRef<Rect | null>(stage.hitBox);
  hitBoxRef.current = stage.hitBox;

  /* ────────────── 透明底：窗口没有底色，页面也不能有 ────────────── */
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlBg: html.style.background,
      bodyBg: body.style.background,
      bodyOverflow: body.style.overflow,
    };
    html.style.background = "transparent";
    body.style.background = "transparent";
    body.style.overflow = "hidden";
    return () => {
      html.style.background = prev.htmlBg;
      body.style.background = prev.bodyBg;
      body.style.overflow = prev.bodyOverflow;
    };
  }, []);

  /* ────────────── 尺寸跟随主进程的缩放 ────────────── */
  useEffect(() => {
    const onResize = () => {
      setViewport({
        width: window.innerWidth || 300,
        height: window.innerHeight || 420,
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* ────────────── 口型：随流式文字到达振荡，停下就归零 ────────────── */
  const mouthRef = useRef(0);
  useEffect(() => {
    if (!chat.streaming) {
      mouthRef.current = 0;
      setMouthOpen(0);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // 衰减：每收到一段文字把目标顶上去，然后自然回落到闭嘴
      mouthRef.current = Math.max(0, mouthRef.current - dt * 4.5);
      setMouthOpen(mouthRef.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [chat.streaming, setMouthOpen]);

  /** 有新字到达就顶一次口型（用 reply 长度变化判断，不额外挂钩子）。 */
  const replyLenRef = useRef(0);
  useEffect(() => {
    if (chat.reply.length > replyLenRef.current) {
      mouthRef.current = 0.55 + Math.random() * 0.4;
    }
    replyLenRef.current = chat.reply.length;
  }, [chat.reply]);

  /* ────────────── 可交互区与穿透上报 ────────────── */
  const interactiveRef = useRef(false);
  const extraRects = useCallback((): Array<Rect | null> => {
    const toRect = (el: HTMLElement | null): Rect | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    return [toRect(bubbleRef.current), toRect(inputRef.current)];
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      focus(x, y);

      const next = isInteractiveAt([hitBoxRef.current, ...extraRects()], x, y);
      if (shouldReportChange(interactiveRef.current, next)) {
        interactiveRef.current = next;
        window.__heming_pet?.setInteractive(next);
      }
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [focus, extraRects]);

  /* ────────────── 拖拽 / 点击 / 双击 ────────────── */
  const dragRef = useRef<{
    startX: number;
    startY: number;
    dragging: boolean;
    lastTapAt: number;
  } | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      // 输入框与菜单内的点击不该触发拖拽
      if (target && target.closest("[data-pet-ui]")) return;
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        lastTapAt: dragRef.current?.lastTapAt ?? 0,
      };
    };

    const onMoveDrag = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (!d.dragging) {
        const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        if (moved < 4) return; // 阈值内还算点击，交给 mouseup 判定
        d.dragging = true;
        window.__heming_pet?.dragStart();
      }
      window.__heming_pet?.dragMove();
    };

    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (d.dragging) {
        window.__heming_pet?.dragEnd();
        return;
      }
      const verdict = classifyPointerUp(d.startX, d.startY, e.clientX, e.clientY);
      if (verdict !== "tap") return;

      // 双击：播动作；单击：呼出输入框
      const now = Date.now();
      if (now - d.lastTapAt < 320) {
        playMotion("TapBody");
        return;
      }
      setInputOpen(true);
      setMenu(null);
      requestAnimationFrame(() => inputElRef.current?.focus());
      dragRef.current = { ...d, lastTapAt: now };
    };

    const onLeave = () => {
      focusCenter();
      if (interactiveRef.current) {
        interactiveRef.current = false;
        window.__heming_pet?.setInteractive(false);
      }
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMoveDrag);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMoveDrag);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mouseleave", onLeave);
    };
  }, [playMotion, focusCenter]);

  /* ────────────── 右键菜单 ────────────── */
  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-pet-ui]")) return;
      e.preventDefault();
      // 菜单贴着窗口边缘时往回收，别被裁掉
      setMenu({
        x: Math.min(e.clientX, Math.max(0, viewport.width - 132)),
        y: Math.min(e.clientY, Math.max(0, viewport.height - 180)),
      });
    };
    const onClickAway = () => setMenu(null);
    window.addEventListener("contextmenu", onContext);
    window.addEventListener("mousedown", onClickAway);
    return () => {
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("mousedown", onClickAway);
    };
  }, [viewport.width, viewport.height]);

  /* ────────────── 发送 ────────────── */
  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    if (!chat.hasConnection) {
      // 没配置连接时不假装能聊：直接把出口摆出来
      return;
    }
    await chat.send(text);
  }, [chat, draft]);

  const bubbleText = chat.error
    ? chat.error
    : chat.reply || (chat.streaming ? "…" : "");

  const showBubbleHint = !chat.hasConnection && inputOpen;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "transparent",
        userSelect: "none",
        fontFamily:
          '"PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, -apple-system, sans-serif',
      }}
    >
      <canvas
        ref={setCanvasEl}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
      />

      {(bubbleText || showBubbleHint) && (
        <div
          ref={bubbleRef}
          data-pet-ui="bubble"
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            right: 8,
            maxWidth: BUBBLE_MAX_WIDTH,
            margin: "0 auto",
            padding: "9px 12px",
            background: "rgba(255,255,255,0.96)",
            border: "1px solid #e6e6e6",
            borderRadius: 12,
            boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
            fontSize: 13,
            lineHeight: 1.55,
            color: chat.error ? "#b42318" : "#2f2f2f",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 150,
            overflowY: "auto",
          }}
        >
          {showBubbleHint && !bubbleText ? (
            <span>
              还没有可用的模型连接。
              <button
                type="button"
                onClick={() => window.__heming_pet?.openSettings()}
                style={{
                  marginLeft: 4,
                  padding: 0,
                  border: "none",
                  background: "none",
                  color: "#1f6feb",
                  fontSize: 13,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                去设置
              </button>
            </span>
          ) : (
            bubbleText
          )}
        </div>
      )}

      {inputOpen && (
        <form
          ref={inputRef}
          data-pet-ui="input"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            right: 8,
            display: "flex",
            gap: 6,
            padding: 6,
            background: "rgba(255,255,255,0.97)",
            border: "1px solid #e6e6e6",
            borderRadius: 12,
            boxShadow: "0 6px 20px rgba(0,0,0,0.12)",
          }}
        >
          <input
            ref={inputElRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.blur();
                setInputOpen(false);
              }
            }}
            placeholder={chat.hasConnection ? "说点什么…" : "先配置模型连接"}
            disabled={!chat.hasConnection}
            aria-label="和桌宠说话"
            style={{
              flex: 1,
              minWidth: 0,
              padding: "6px 9px",
              border: "1px solid #ececec",
              borderRadius: 8,
              fontSize: 13,
              color: "#2f2f2f",
              background: chat.hasConnection ? "#fff" : "#f7f7f7",
              outline: "none",
              userSelect: "text",
            }}
          />
          {chat.streaming ? (
            <button
              type="button"
              onClick={() => chat.stop()}
              style={btnStyle}
              aria-label="停止回复"
            >
              停
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim() || !chat.hasConnection} style={btnStyle}>
              发
            </button>
          )}
        </form>
      )}

      {menu && (
        <div
          data-pet-ui="menu"
          style={{
            position: "absolute",
            left: menu.x,
            top: menu.y,
            width: 128,
            padding: 4,
            background: "#fff",
            border: "1px solid #e6e6e6",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
            fontSize: 12.5,
            color: "#2f2f2f",
          }}
        >
          <MenuItem
            onClick={() => {
              setMenu(null);
              setInputOpen(true);
              requestAnimationFrame(() => inputElRef.current?.focus());
            }}
          >
            说点什么
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(null);
              window.__heming_pet?.setScale({ dir: 1 });
            }}
          >
            放大一档
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(null);
              window.__heming_pet?.setScale({ dir: -1 });
            }}
          >
            缩小一档
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(null);
              window.__heming_pet?.openSettings();
            }}
          >
            设置
          </MenuItem>
          <MenuItem
            onClick={() => {
              setMenu(null);
              window.__heming_pet?.hide();
            }}
          >
            隐藏
          </MenuItem>
        </div>
      )}

      {stage.status === "error" && (
        <div
          data-pet-ui="error"
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            right: 8,
            padding: "8px 10px",
            background: "rgba(255,255,255,0.97)",
            border: "1px solid #f0c2bd",
            borderRadius: 10,
            fontSize: 12,
            lineHeight: 1.5,
            color: "#b42318",
          }}
        >
          桌宠没能加载：{stage.error}
        </div>
      )}
    </div>
  );
}

const btnStyle: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #ececec",
  borderRadius: 8,
  background: "#fafafa",
  fontSize: 12.5,
  color: "#2f2f2f",
  cursor: "pointer",
};

function MenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        padding: "6px 8px",
        border: "none",
        borderRadius: 6,
        background: "transparent",
        textAlign: "left",
        fontSize: 12.5,
        color: "#2f2f2f",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "#f2f2f2";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
