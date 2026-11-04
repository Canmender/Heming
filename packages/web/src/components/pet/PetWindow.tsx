import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { loadPetPrefs, petModelUrl } from "../../lib/petPrefs.js";
import {
  classifyPointerUp,
  createFrameCoalescer,
  isPrimaryButtonDown,
  resolveInteractive,
  shouldBeginDrag,
  shouldReportChange,
  type Rect,
} from "./petInteraction.js";
import { useLive2D } from "./useLive2D.js";
import { usePetChat } from "./usePetChat.js";
import { poseDrivesMouth, poseMotion, resolvePose, type PetPose } from "../../lib/petPose.js";
import {
  EMPTY_PET_PRESENCE,
  loadPetPresencePrefs,
  prunePetPresence,
  reducePetEvent,
  type PetEventRoute,
  type PetPresenceVisual,
} from "../../lib/petEvent.js";

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
  /** 菜单与错误条也要算进命中区（d.68）：否则穿透态下点击落到桌面，菜单永远收不到 click。 */
  const menuRef = useRef<HTMLDivElement | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  /** 根容器：菜单按 Esc 关闭后把焦点还到这里（tabIndex=-1，不参与 Tab 序列）。 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 最近一次已知光标位置：浮层开合时要按它主动重算可交互，不能等下一次 mousemove。 */
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  /** 菜单里显示的鼠标穿透当前值（打开菜单时异步读主进程状态，读不到就显示未知）。 */
  const [menuClickThrough, setMenuClickThrough] = useState<boolean | null>(null);
  /** 拖拽期间的冻结开关：ref 供事件闭包同步读取，state 只驱动光标样式。 */
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const chat = usePetChat(prefs.agentId);

  /**
   * 外部驱动（`pet:event`）：主进程/主窗口推来的姿态与文案（d.58 在场感）。
   *
   * 事件一律先过归约（`reducePetEvent` 内部解析校验）：
   * - 强度偏好（安静/正常/积极）决定「只换姿态 / 只冒泡 / 姿态+气泡+动作」；
   * - 气泡 4 秒后自动收回（`prunePetPresence`），姿态同理，不会卡在某个状态；
   * - 与用户对话（流式输出）期间新事件先排队，这一轮结束后再决定是否显示；
   * - 排队超过 10 秒直接丢弃——「错过不补发」，十分钟前的提醒没有价值。
   */
  const [presence, setPresence] = useState<PetPresenceVisual>({ ...EMPTY_PET_PRESENCE });
  /** 对话进行中收到的事件：只留最近一条，且不持久化（错过不补发）。 */
  const pendingPresenceRef = useRef<{ raw: unknown; at: number } | null>(null);
  const chatBusyRef = useRef(false);
  chatBusyRef.current = chat.streaming;

  useEffect(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_pet : undefined;
    if (!bridge?.onEvent) return;
    return bridge.onEvent((raw) => {
      // 强度每次现读：设置区改完立即生效，不必重开桌宠。
      const intensity = loadPetPresencePrefs().intensity;
      if (chatBusyRef.current) {
        pendingPresenceRef.current = { raw, at: Date.now() };
        return;
      }
      setPresence((prev) => reducePetEvent(prev, raw, { now: Date.now(), intensity }));
    });
  }, []);

  // 一轮对话结束后，只有「还新鲜」的排队事件才显示（错过不补发）。
  useEffect(() => {
    if (chat.streaming) return;
    const pending = pendingPresenceRef.current;
    pendingPresenceRef.current = null;
    if (!pending) return;
    if (Date.now() - pending.at > 10_000) return;
    const intensity = loadPetPresencePrefs().intensity;
    setPresence((prev) => reducePetEvent(prev, pending.raw, { now: Date.now(), intensity }));
  }, [chat.streaming]);

  // 到期清理：气泡与外部姿态都带 until，统一由一个定时器收尾。
  useEffect(() => {
    const deadlines = [presence.bubble?.until ?? null, presence.poseUntil].filter(
      (at): at is number => typeof at === "number",
    );
    if (deadlines.length === 0) return;
    const delay = Math.max(0, Math.min(...deadlines) - Date.now());
    const timer = window.setTimeout(
      () => setPresence((prev) => prunePetPresence(prev, Date.now())),
      delay + 10,
    );
    return () => window.clearTimeout(timer);
  }, [presence]);

  /**
   * 「被摸」的短窗口。用对象而不是布尔：连点时要能刷新计时（布尔在 true→true 时不触发 effect）。
   */
  const [celebrate, setCelebrate] = useState<{ at: number } | null>(null);
  useEffect(() => {
    if (!celebrate) return;
    const timer = window.setTimeout(() => setCelebrate(null), 900);
    return () => window.clearTimeout(timer);
  }, [celebrate]);

  // 姿态：外部事件指定优先（且带过期），否则由纯函数判定（见 petPose.ts）；
  // 表现由映射表决定——渲染代码不再认识任何具体动作组名
  const pose: PetPose = presence.pose ?? resolvePose({
    hasError: Boolean(chat.error),
    streaming: chat.streaming,
    inputOpen,
    celebrating: celebrate !== null,
  });
  const mouthDriven = poseDrivesMouth(pose);

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
  const { setMouthOpen, playMotion, focus, focusCenter, setPaused, resizeTo } = stage;
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
      // ★ 拖拽期间冻结窗口尺寸 / 模型适配：窗口正在连续移动，Chromium 会因跨屏 DPI 变化
      //   或客户区像素取整派发 resize。此时重新拟合会让画面在拖动中跳变（再叠加旧
      //   fitModel 的非幂等缺陷，观感就是「局部放大 / 角色只露一部分」）。
      //   直接忽略：dragEnd 后由 finishDrag 统一重测、重设分辨率、重拟合、补一帧。
      if (draggingRef.current) return;
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
    if (!mouthDriven) {
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
  }, [mouthDriven, setMouthOpen]);

  /** 有新字到达就顶一次口型（用 reply 长度变化判断，不额外挂钩子）。 */
  const replyLenRef = useRef(0);
  useEffect(() => {
    if (chat.reply.length > replyLenRef.current) {
      mouthRef.current = 0.55 + Math.random() * 0.4;
    }
    replyLenRef.current = chat.reply.length;
  }, [chat.reply]);

  /**
   * 进入新姿态时播一次对应动作。
   *
   * ★ 只有「开心」有映射（见 PET_POSES）：常驻窗口里给每种状态都配一个动作，
   *   很快就会变成噪音。其它表达交给角标、口型与输入框本身。
   *   模型缺少该动作组时 playMotion 内部静默跳过，换模型不会炸。
   */
  const prevPoseRef = useRef<PetPose>("idle");
  useEffect(() => {
    if (prevPoseRef.current === pose) return;
    prevPoseRef.current = pose;
    const motion = poseMotion(pose);
    if (motion) playMotion(motion);
  }, [pose, playMotion]);

  /* ────────────── 可交互区与穿透上报 ────────────── */
  const interactiveRef = useRef(false);
  /** 菜单 / 输入框是否打开。打开期间整窗拦截鼠标（否则穿透会把菜单一起「点穿」）。 */
  const floatingOpenRef = useRef(false);

  /**
   * 命中区**单一来源**：角色包围盒 ∪ 气泡 ∪ 输入框 ∪ 菜单 ∪ 错误条。
   *
   * ★ d.68 之前这里只有气泡与输入框：菜单和错误条不在命中区，默认穿透时鼠标点击
   *   直接落到桌面，窗口收不到 mousedown/click——「右键菜单里点了没反应」的第一根因。
   */
  const extraRects = useCallback((): Array<Rect | null> => {
    const toRect = (el: HTMLElement | null): Rect | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    };
    return [
      toRect(bubbleRef.current),
      toRect(inputRef.current),
      toRect(menuRef.current),
      toRect(errorRef.current),
    ];
  }, []);

  /** 按给定光标位置重算「该不该挡鼠标」；值没变就不发 IPC（mousemove 是高频事件）。 */
  const reportInteractiveAt = useCallback(
    (x: number, y: number) => {
      const next = resolveInteractive(
        hitBoxRef.current,
        extraRects(),
        x,
        y,
        floatingOpenRef.current,
      );
      if (shouldReportChange(interactiveRef.current, next)) {
        interactiveRef.current = next;
        window.__heming_pet?.setInteractive(next);
      }
    },
    [extraRects],
  );

  /**
   * 用最近一次已知光标位置重算一次。
   * 浮层开 / 合时调用：不能依赖下一次 mousemove（用户可能点了菜单后就不再动鼠标）。
   */
  const refreshInteractive = useCallback(() => {
    const pointer = lastPointerRef.current;
    reportInteractiveAt(pointer?.x ?? Number.NaN, pointer?.y ?? Number.NaN);
  }, [reportInteractiveAt]);

  /**
   * 浮层开合 → 主动重算并上报，不依赖下一次 mousemove。
   *
   * ★ 这是「菜单点了没反应」的第二处修复：菜单一打开就必须立刻停止穿透，
   *   否则用户点到菜单时事件落到桌面；关闭后立刻按当前指针恢复穿透。
   */
  useEffect(() => {
    floatingOpenRef.current = menu !== null || inputOpen;
    refreshInteractive();
    if (!menu) return;
    // 菜单打开后聚焦第一项：方向键 / 回车可用，焦点不会悬空
    requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
  }, [inputOpen, menu, refreshInteractive]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      // 拖拽期间冻结：不追视、不做命中判定、不报穿透。
      // 窗口在连续移动，此时切换 ignore-mouse 会让鼠标事件在透传/拦截之间抖动。
      if (draggingRef.current) return;
      focus(e.clientX, e.clientY);
      reportInteractiveAt(e.clientX, e.clientY);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [focus, reportInteractiveAt]);

  /* ────────────── 拖拽 / 点击 / 双击 ────────────── */

  /**
   * 移动上报的按帧合并器。
   *
   * ★ 这里必须有：原生 mousemove 直接逐次 IPC + 主进程逐次 setPosition，
   *   等于让透明置顶窗的 DWM 合成跟不上输入频率，表现就是拖动时的残影与边缘闪烁。
   *   合并后同一帧内任意多次移动只发一次，抬起时由 flush 补终值。
   */
  const dragMove = useMemo(
    () =>
      createFrameCoalescer(
        () => window.__heming_pet?.dragMove(),
        {
          schedule: (callback) => window.requestAnimationFrame(callback),
          cancel: (id) => window.cancelAnimationFrame(id),
        },
      ),
    [],
  );

  /** 进入 / 退出拖拽（ref 供事件闭包立刻可读，state 触发光标样式）。 */
  const setDraggingState = useCallback((next: boolean) => {
    if (draggingRef.current === next) return;
    draggingRef.current = next;
    setDragging(next);
  }, []);

  /** 当前按下会话；抬起即清空——拖拽状态绝不跨手势残留。 */
  const dragRef = useRef<{ startX: number; startY: number; dragging: boolean } | null>(null);
  /** 双击计时单独存，不塞回 dragRef（那正是「tap 后残留一次拖拽」的成因）。 */
  const lastTapAtRef = useRef(0);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      // 输入框与菜单内的点击不该触发拖拽
      if (target && target.closest("[data-pet-ui]")) return;
      dragRef.current = { startX: e.clientX, startY: e.clientY, dragging: false };
    };

    /**
     * 结束一次拖拽：补终值 → 通知主进程收尾（吸附/钳制在那边做）→ 补测尺寸并重拟合
     * → 恢复舞台 → 补穿透判定。
     * 三条退出路径共用（正常 mouseup / 拖拽中检测到左键已松开 / 窗口失焦），
     * 分开写会出现「某条路径忘了恢复 Live2D 或忘了 dragEnd」的半截状态。
     */
    const refitAfterDrag = () => {
      // 拖拽期间忽略了 resize（见尺寸 effect）：落点后重测一次真实客户区尺寸，
      // 重设分辨率（跨屏 DPR 可能变了）、重新拟合、立刻渲染一帧。
      const w = window.innerWidth || 300;
      const h = window.innerHeight || 420;
      setViewport((prev) =>
        prev.width === w && prev.height === h ? prev : { width: w, height: h },
      );
      resizeTo(w, h);
    };

    const finishDrag = (x: number, y: number) => {
      lastPointerRef.current = { x, y };
      dragMove.flush(); // 补一次终值：最后一帧的 rAF 可能还没执行
      window.__heming_pet?.dragEnd();
      setDraggingState(false);
      refitAfterDrag(); // 先出正确画面（尺寸/分辨率/拟合），再恢复 ticker
      setPaused(false); // 恢复舞台并立即渲染一帧，画面不会停在旧帧
      // 拖拽期间跳过了追视，结束后以当前指针重新对一次焦点（不做补间，补间会看到眼睛扫回来）
      focus(x, y);
      // 同理，穿透判定也在拖拽期间跳过了，这里按此刻位置补一次，避免状态停在拖拽前
      reportInteractiveAt(x, y);
    };

    const onMoveDrag = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.dragging) {
        // 中途丢了 mouseup（在窗口外松开、被别的窗口截走）：左键已抬起就收尾，
        // 否则会一直停在「拖拽中」——主进程也就一直不落盘、不响应穿透上报。
        if (!isPrimaryButtonDown(e.buttons)) {
          dragRef.current = null;
          finishDrag(e.clientX, e.clientY);
          return;
        }
        dragMove.request(); // 拖拽中：每帧最多一次 IPC
        return;
      }
      // 左键已经松开（tap 之后继续移动 / 在窗口外抬起）：丢掉会话，绝不开始拖拽。
      // 只按位移判拖拽的话，这里会把桌宠变成"被鼠标带着跑"。
      if (!isPrimaryButtonDown(e.buttons)) {
        dragRef.current = null;
        return;
      }
      if (!shouldBeginDrag(d, e.clientX, e.clientY, e.buttons)) return;

      d.dragging = true;
      setDraggingState(true);
      setPaused(true); // 冻结 Live2D：移动期间只搬静态位图，不给透明层叠加逐帧重绘
      window.__heming_pet?.dragStart();
      dragMove.request();
    };

    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (d.dragging) {
        finishDrag(e.clientX, e.clientY);
        return;
      }
      const verdict = classifyPointerUp(d.startX, d.startY, e.clientX, e.clientY);
      if (verdict !== "tap") return;

      // 双击：播动作；单击：呼出输入框
      const now = Date.now();
      if (now - lastTapAtRef.current < 320) {
        lastTapAtRef.current = 0; // 双击后重新计时，连点三下不会当成两次双击
        setCelebrate({ at: now }); // 姿态层负责播对应动作
        return;
      }
      lastTapAtRef.current = now;
      setInputOpen(true);
      setMenu(null);
      requestAnimationFrame(() => inputElRef.current?.focus());
    };

    /** 失焦（Alt+Tab / 别的窗口抢走焦点）：按下与拖拽状态都复位，不留幽灵拖拽。 */
    const onBlur = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d && d.dragging) {
        // 没有可信的光标坐标可用：让主进程按它自己拿到的屏幕光标收尾即可
        dragMove.flush();
        window.__heming_pet?.dragEnd();
        setDraggingState(false);
        refitAfterDrag(); // 拖拽期间攒下的 resize 同样要补
        setPaused(false);
      } else {
        dragMove.cancel();
      }
    };

    const onLeave = () => {
      if (draggingRef.current) return; // 拖拽中窗口跟着光标走，不该在这里清穿透
      dragRef.current = null; // 按下后移出窗口（还没进入拖拽）：会话作废，不留可被推进的状态
      if (floatingOpenRef.current) return; // 浮层开着：保持拦截，别把菜单一起点穿
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
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMoveDrag);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("blur", onBlur);
      dragMove.cancel();
    };
  }, [dragMove, focus, focusCenter, reportInteractiveAt, resizeTo, setDraggingState, setPaused]);

  /* 拖拽时给 body 加 grabbing：光标形状本身就是「正在拖」的反馈。 */
  useEffect(() => {
    if (!dragging) return;
    const body = document.body;
    const previous = body.style.cursor;
    body.style.cursor = "grabbing";
    return () => {
      body.style.cursor = previous;
    };
  }, [dragging]);

  /* ────────────── 右键菜单 ────────────── */

  /**
   * 菜单尺寸（最多 7 项 + 内边距）：贴边时往回收，别被窗口裁掉。
   *
   * ★ 估大不估小：菜单最小宽 156 + 左右 padding 8 + 边框 2 = 166，行高 28 × 7 + 8 ≈ 204。
   *   这里取 176 / 252 留余量——旧值 156/248 会让 300px 窗口下菜单右边缘溢出 10px
   *   （d.68 自检实测），点最右一列会被窗口裁掉。
   *   另有一个 useLayoutEffect 在挂载后按真实 rect 再夹一次（字体/缩放档不同也能兜住）。
   */
  const MENU_WIDTH = 176;
  const MENU_HEIGHT = 252;

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-pet-ui]")) return;
      e.preventDefault();
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      setMenu({
        x: Math.min(e.clientX, Math.max(0, viewport.width - MENU_WIDTH)),
        y: Math.min(e.clientY, Math.max(0, viewport.height - MENU_HEIGHT)),
      });
    };
    window.addEventListener("contextmenu", onContext);
    return () => window.removeEventListener("contextmenu", onContext);
  }, [viewport.width, viewport.height]);

  /**
   * 菜单挂载后按真实尺寸再夹一次。
   *
   * 常量估算是第一道；这里用 `useLayoutEffect` 在绘制前量真实 rect，
   * 只处理「右/下溢出」这一种情况，且只在坐标真的需要变时 setMenu，避免循环渲染。
   */
  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxX = Math.max(0, viewport.width - rect.width - 4);
    const maxY = Math.max(0, viewport.height - rect.height - 4);
    if (rect.right <= viewport.width - 2 && rect.bottom <= viewport.height - 2) return;
    setMenu((prev) => {
      if (!prev) return prev;
      const x = Math.min(prev.x, maxX);
      const y = Math.min(prev.y, maxY);
      if (x === prev.x && y === prev.y) return prev;
      return { x, y };
    });
  }, [menu, viewport.width, viewport.height]);

  /**
   * 点窗外关闭菜单。
   *
   * ★ 必须是 mousedown 且**跳过 `[data-pet-ui]`**：旧实现无条件 `setMenu(null)`，
   *   手指按在菜单项上时菜单在 mousedown 阶段就被卸载，click 永远不会派发到按钮——
   *   这是「点了没反应」的第二根因（与命中区漏了菜单叠加出现）。
   */
  useEffect(() => {
    if (!menu) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-pet-ui]")) return;
      setMenu(null);
    };
    window.addEventListener("mousedown", onDocMouseDown);
    return () => window.removeEventListener("mousedown", onDocMouseDown);
  }, [menu]);

  /** 菜单打开时读一次主进程的穿透状态，菜单项据此显示「已开 / 已关」。 */
  useEffect(() => {
    if (!menu) {
      setMenuClickThrough(null);
      return;
    }
    let alive = true;
    const bridge = typeof window !== "undefined" ? window.__heming_pet : undefined;
    if (!bridge?.state) return;
    void Promise.resolve(bridge.state())
      .then((s) => {
        if (!alive) return;
        setMenuClickThrough(s && typeof s.clickThrough === "boolean" ? s.clickThrough : null);
      })
      .catch(() => {
        if (alive) setMenuClickThrough(null);
      });
    return () => {
      alive = false;
    };
  }, [menu]);

  /**
   * Esc：关闭菜单并把焦点还给画布容器（菜单键盘可达的出口）。
   * 输入框自己的 Esc 由输入框处理，这里不抢。
   */
  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setMenu(null);
      requestAnimationFrame(() => rootRef.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menu]);

  /** 菜单内方向键导航（Enter / 空格由原生 button 触发 click）。 */
  const onMenuKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const index = items.findIndex((el) => el === document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = (Math.max(0, index) + step + items.length) % items.length;
      items[next]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  }, []);

  /** 点菜单项：先收起菜单，再执行动作（动作里的 focus 不会被菜单卸载打断）。 */
  const chooseMenu = useCallback((action: () => void) => {
    setMenu(null);
    action();
  }, []);

  /**
   * 能力探测（d.68 自检补）：**没有桥就不渲染桥专属菜单项**。
   *
   * 浏览器里直接打开 pet.html 时没有 `window.__heming_pet`，旧实现会渲染出
   * 「放大/缩小/设置/隐藏/鼠标穿透（读取中）」一排点了没反应的死按钮。
   * 现在只保留「说点什么」（纯渲染层能力），其余按桥能力逐项显示。
   */
  const capabilities = useMemo(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_pet : undefined;
    const b = bridge as
      | { resetPosition?: unknown; setScale?: unknown; setClickThrough?: unknown; state?: unknown }
      | undefined;
    return {
      hasBridge: !!bridge,
      canScale: typeof b?.setScale === "function",
      canResetPosition: typeof b?.resetPosition === "function",
      canToggleClickThrough:
        typeof b?.setClickThrough === "function" && typeof b?.state === "function",
    };
  }, []);
  const canResetPosition = capabilities.canResetPosition;

  /** 鼠标穿透开关：菜单里显示当前值，点击切换（复用既有 pet:set-click-through）。 */
  const toggleClickThrough = useCallback(() => {
    const bridge = typeof window !== "undefined" ? window.__heming_pet : undefined;
    if (!bridge) return;
    if (menuClickThrough !== null) {
      bridge.setClickThrough(!menuClickThrough);
      return;
    }
    // 状态没读到时再问一次主进程，别把「未知」当成「关」直接写反
    void Promise.resolve(bridge.state?.())
      .then((s) => {
        if (s && typeof s.clickThrough === "boolean") bridge.setClickThrough(!s.clickThrough);
      })
      .catch(() => {});
  }, [menuClickThrough]);

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

  /**
   * 点击在场感气泡 → 叫起主窗口并直达对应页面。
   *
   * 复用 `pet:open-settings` 单条反向通道（带上 page，不新增 IPC）：主进程原样转发，
   * 主窗口 App 的 handler 按 page 切页。旧 preload 不传 page 时退化为「打开设置」。
   */
  const openPresenceRoute = useCallback((route: PetEventRoute) => {
    const pet = window.__heming_pet as unknown as
      | { openSettings?: (page?: string) => void }
      | undefined;
    pet?.openSettings?.(route);
  }, []);

  const bubbleText = chat.error
    ? chat.error
    : chat.reply || (chat.streaming ? "…" : "") || presence.bubble?.text || "";

  const bubbleRoute = chat.error || chat.reply || chat.streaming ? undefined : presence.bubble?.route;

  const showBubbleHint = !chat.hasConnection && inputOpen;

  return (
    <div
      ref={rootRef}
      // 菜单按 Esc 关闭后把焦点还到这里：tabIndex=-1 让它可编程聚焦、但不进 Tab 序列
      tabIndex={-1}
      style={{
        position: "fixed",
        inset: 0,
        background: "transparent",
        userSelect: "none",
        outline: "none",
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
          onClick={bubbleRoute ? () => openPresenceRoute(bubbleRoute) : undefined}
          onKeyDown={
            bubbleRoute
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openPresenceRoute(bubbleRoute);
                  }
                }
              : undefined
          }
          tabIndex={bubbleRoute ? 0 : undefined}
          title={bubbleRoute ? "点击打开对应页面" : undefined}
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
            cursor: bubbleRoute ? "pointer" : undefined,
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
          ref={menuRef}
          data-pet-ui="menu"
          role="menu"
          aria-label="桌宠菜单"
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            left: menu.x,
            top: menu.y,
            minWidth: MENU_WIDTH,
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
            onClick={() =>
              chooseMenu(() => {
                setInputOpen(true);
                requestAnimationFrame(() => inputElRef.current?.focus());
              })
            }
          >
            说点什么
          </MenuItem>
          {capabilities.canScale && (
            <>
              <MenuItem onClick={() => chooseMenu(() => window.__heming_pet?.setScale({ dir: 1 }))}>
                放大一档
              </MenuItem>
              <MenuItem onClick={() => chooseMenu(() => window.__heming_pet?.setScale({ dir: -1 }))}>
                缩小一档
              </MenuItem>
            </>
          )}
          {canResetPosition && (
            <MenuItem
              onClick={() =>
                chooseMenu(() =>
                  (
                    window.__heming_pet as unknown as { resetPosition?: () => void }
                  )?.resetPosition?.(),
                )
              }
            >
              重置位置
            </MenuItem>
          )}
          {capabilities.canToggleClickThrough && (
            <MenuItem onClick={() => chooseMenu(toggleClickThrough)}>
              {`鼠标穿透（${
                menuClickThrough === true ? "已开" : menuClickThrough === false ? "已关" : "读取中"
              }）`}
            </MenuItem>
          )}
          {capabilities.hasBridge && (
            <>
              <MenuItem onClick={() => chooseMenu(() => window.__heming_pet?.openSettings())}>
                设置
              </MenuItem>
              <MenuItem onClick={() => chooseMenu(() => window.__heming_pet?.hide())}>隐藏</MenuItem>
            </>
          )}
        </div>
      )}

      {stage.status === "error" && (
        <div
          ref={errorRef}
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
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        width: "100%",
        minHeight: 28, // 触摸/鼠标都好点：低于 28px 会明显难按
        padding: "6px 8px",
        border: "none",
        borderRadius: 6,
        background: "transparent",
        textAlign: "left",
        fontSize: 12.5,
        lineHeight: 1.35,
        color: "#2f2f2f",
        cursor: "pointer",
        outline: "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "#f2f2f2";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
      onFocus={(e) => {
        e.currentTarget.style.background = "#f2f2f2";
      }}
      onBlur={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
