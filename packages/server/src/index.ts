import { createServer, type Server as HttpServer } from "node:http";
import { createApp } from "./app.js";
import { createMemoryStore, type Store } from "./store.js";
import { attachWs } from "./ws.js";

export interface ServerContext {
  server: HttpServer;
  store: Store;
  port: number;
  close(): Promise<void>;
}

export async function startServer(port: number): Promise<ServerContext> {
  const store = createMemoryStore();
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
