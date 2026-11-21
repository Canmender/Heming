import { createServer, type Server as HttpServer } from "node:http";
import { createApp, envFlagEnabled } from "./app.js";
import { resolveDbPath } from "./db.js";
import { createSqliteStore, type SqliteStore } from "./sqliteStore.js";
import { seedUsersFromEnv } from "./seed.js";
import { attachWs } from "./ws.js";

export interface ServerContext {
  server: HttpServer;
  store: SqliteStore;
  port: number;
  close(): Promise<void>;
}

/**
 * 监听地址：默认 127.0.0.1（本地安全默认不变），容器内经 HOST=0.0.0.0 暴露给同 compose 网的 nginx。
 * HOST 空串/全空白视为未设置。
 */
export function resolveHost(): string {
  return process.env.HOST?.trim() || "127.0.0.1";
}

export async function startServer(
  port: number,
  host: string = resolveHost(),
  dbPath: string = resolveDbPath(),
): Promise<ServerContext> {
  const store = createSqliteStore(dbPath);
  // 播种在开始监听前完成，避免出现"已可登录但账号未就绪"的窗口。
  seedUsersFromEnv(store, process.env.HEMING_SEED_USERS);
  // d.54：预设群删除后，系统助手（和小鸣）仍要幂等登记到名册，否则新库无法开对话。
  store.ensureSystemAgents();
  if (
    !envFlagEnabled(process.env.HEMING_ALLOW_REGISTER) &&
    !process.env.HEMING_SEED_USERS?.trim()
  ) {
    console.warn(
      "[heming] registration is disabled and HEMING_SEED_USERS is unset — no account will be able to login",
    );
  }
  const app = createApp(store);
  const server = createServer(app);
  // 持有 wss：关服时必须先关它——否则 (1) ws.ts 里的广播订阅只在 wss 的 "close"
  // 事件退订，从不 close 就永久泄漏（热重启/测试反复 start 会堆积指向旧 store 的监听器）；
  // (2) 活动 WS 连接会吊住 http server.close()，ctx.close() 永远不 resolve。
  const wss = attachWs(server, store);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    store,
    port: actualPort,
    close: () =>
      new Promise((resolve, reject) => {
        // 先终止所有 WS 客户端再关 wss：ws 的 noServer 模式下 wss.close() 只等现有客户端
        // 自己断开才会发 "close"（从而触发 ws.ts 的退订）。逐个 terminate() 让这一步即时完成，
        // 不再吊住随后的 http server.close()。terminate 走的是底层 socket 强关，客户端
        // 会收到异常关闭——关服阶段这是可接受的（正常关闭请用客户端主动 close）。
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          server.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            store.close();
            resolve();
          });
        });
      }),
  };
}

// 编译产物（node dist/index.js）与 tsx 直跑（tsx src/index.ts）均以本文件为入口，
// argv[1] 以 index.js / index.ts 结尾即视为直跑；被 vitest 等导入时 argv[1] 不匹配。
const isDirectRun = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isDirectRun) {
  const port = Number(process.env.PORT ?? 8787);
  const host = resolveHost();
  startServer(port, host).then(
    (ctx) => {
      console.log(`heming server listening on http://${host}:${ctx.port}`);
    },
    (error: unknown) => {
      // 启动失败要给出清晰错误并置失败退出码，而不是留一个未处理的 Promise 拒绝
      // 让进程用原始 ERR_UNHANDLED_REJECTION 堆栈崩掉（d.412 回归）。
      console.error(`[heming] 服务启动失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
