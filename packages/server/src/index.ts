import { createServer, type Server as HttpServer } from "node:http";
import { createApp, envFlagEnabled } from "./app.js";
import { resolveDbPath } from "./db.js";
import { createSqliteStore, type SqliteStore } from "./sqliteStore.js";
import { seedUsersFromEnv } from "./seed.js";
import { seedPreset } from "./preset.js";
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
  attachWs(server, store);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    store,
    port: actualPort,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          store.close();
          resolve();
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
  startServer(port, host).then((ctx) => {
    console.log(`heming server listening on http://${host}:${ctx.port}`);
    // 预设播种只在直跑入口做，startServer 内不播种——persistence/契约测试不被污染。
    // 无用户（未配 HEMING_SEED_USERS）时 seedPreset 返回 null，仅日志缺省不打。
    const preset = seedPreset(ctx.store);
    if (preset) console.log(`seed: preset group ${preset.groupId} ready`);
  });
}
