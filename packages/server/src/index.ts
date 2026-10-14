import { createServer, type Server as HttpServer } from "node:http";
import { createApp, envFlagEnabled } from "./app.js";
import { createMemoryStore, type Store } from "./store.js";
import { seedUsersFromEnv } from "./seed.js";
import { attachWs } from "./ws.js";

export interface ServerContext {
  server: HttpServer;
  store: Store;
  port: number;
  close(): Promise<void>;
}

export async function startServer(port: number): Promise<ServerContext> {
  const store = createMemoryStore();
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
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    store,
    port: actualPort,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const isDirectRun = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isDirectRun) {
  const port = Number(process.env.PORT ?? 8787);
  startServer(port).then((ctx) => {
    console.log(`heming server listening on http://127.0.0.1:${ctx.port}`);
  });
}
