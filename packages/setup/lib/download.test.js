"use strict";
/**
 * 下载器的两个关键承诺：
 * 1. 断点续传真的只补缺的字节（服务器支持 Range 时发 206，把已有前缀接上）；
 * 2. 服务器不认 Range、直接回 200 时不能把文件拼坏——只能从头重写。
 *
 * 用本地 http 服务器跑，不联外网，也不 mock 掉 http 层：
 * 续传的坑几乎都在「Range 头 + 206/200 分支」上，mock 掉这层就测不到。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { downloadFile } = require("./download");

// 1.6KB 左右，够分两段续传，又不会让测试变慢
const PAYLOAD = Buffer.from("heming-installer-payload-".repeat(64));
const FULL_SHA = crypto.createHash("sha512").update(PAYLOAD).digest("base64");
const HALF = Math.floor(PAYLOAD.length / 2);

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** 支持 Range 的服务器；rangeSupported=false 时无论请求头都回 200 全量。 */
function payloadHandler(rangeSupported = true) {
  return (req, res) => {
    const match = /^bytes=(\d+)-/.exec(req.headers.range || "");
    if (rangeSupported && match) {
      const start = Number(match[1]);
      const chunk = PAYLOAD.subarray(start);
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Length": chunk.length,
        "Content-Range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
      res.end(chunk);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": PAYLOAD.length,
    });
    res.end(PAYLOAD);
  };
}

async function tempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "heming-download-"));
}

test("完整下载：落盘字节与 sha512 都与源一致", async () => {
  const { server, baseUrl } = await startServer(payloadHandler());
  const dir = await tempDir();
  try {
    const dest = path.join(dir, "inner-setup.exe");
    const result = await downloadFile(`${baseUrl}/inner-setup.exe`, dest, {
      expectedSize: PAYLOAD.length,
      resume: true,
    });

    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(result.sha512, FULL_SHA);
    assert.equal(result.total, PAYLOAD.length);
    assert.deepEqual(await fs.readFile(dest), PAYLOAD);
    // 成功后 .part 应该已经改名，不该留下半截文件
    await assert.rejects(fs.stat(`${dest}.part`), /ENOENT/);
  } finally {
    await stopServer(server);
  }
});

test("断点续传：已有 .part 时只补后半段，最终 sha512 仍按整文件算", async () => {
  const { server, baseUrl } = await startServer(payloadHandler(true));
  const dir = await tempDir();
  try {
    const dest = path.join(dir, "inner-setup.exe");
    const part = `${dest}.part`;
    await fs.writeFile(part, PAYLOAD.subarray(0, HALF));

    const result = await downloadFile(`${baseUrl}/inner-setup.exe`, dest, {
      expectedSize: PAYLOAD.length,
      resume: true,
    });

    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(result.sha512, FULL_SHA, "续传时哈希必须覆盖已有前缀 + 新补的字节");
    assert.deepEqual(await fs.readFile(dest), PAYLOAD);
  } finally {
    await stopServer(server);
  }
});

test("服务器不认 Range（回 200）时从头重写，不能把文件拼坏", async () => {
  const { server, baseUrl } = await startServer(payloadHandler(false));
  const dir = await tempDir();
  try {
    const dest = path.join(dir, "inner-setup.exe");
    await fs.writeFile(`${dest}.part`, PAYLOAD.subarray(0, HALF));

    const result = await downloadFile(`${baseUrl}/inner-setup.exe`, dest, {
      expectedSize: PAYLOAD.length,
      resume: true,
    });

    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(result.sha512, FULL_SHA);
    assert.deepEqual(await fs.readFile(dest), PAYLOAD);
  } finally {
    await stopServer(server);
  }
});

test("已满长度的 .part 当作无效断点：删掉重下，不发会拿到 416 的 Range（d.412 回归）", async () => {
  // 真实 HTTP 服务器对 bytes=<full>- 会回 416；这种「下载完没来得及改名」的崩溃现场
  // 旧代码把它当断点 → 416 → 三次重试全失败。修复后按 0 处理 → 删掉 .part 重下。
  const { server, baseUrl } = await startServer((req, res) => {
    const match = /^bytes=(\d+)-/.exec(req.headers.range || "");
    if (match && Number(match[1]) >= PAYLOAD.length) {
      res.writeHead(416, { "Content-Range": `bytes */${PAYLOAD.length}` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": PAYLOAD.length });
    res.end(PAYLOAD);
  });
  const dir = await tempDir();
  try {
    const dest = path.join(dir, "inner-setup.exe");
    await fs.writeFile(`${dest}.part`, PAYLOAD); // 完整但没改名
    const result = await downloadFile(`${baseUrl}/inner-setup.exe`, dest, {
      expectedSize: PAYLOAD.length,
      resume: true,
    });
    assert.equal(result.sha512, FULL_SHA);
    assert.deepEqual(await fs.readFile(dest), PAYLOAD);
  } finally {
    await stopServer(server);
  }
});

test("磁盘写满（ENOSPC）保留 no-space 错误码，不降级成 download-failed（d.412 回归）", async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Length": PAYLOAD.length });
    res.end(PAYLOAD);
  });
  const dir = await tempDir();
  const realCreateWriteStream = require("node:fs").createWriteStream;
  try {
    // stub createWriteStream 让它发出 ENOSPC，验证错误码不被包装吞掉
    require("node:fs").createWriteStream = () => {
      const { Writable } = require("node:stream");
      const stream = new Writable({ write(_c, _e, cb) { cb(); } });
      process.nextTick(() => stream.emit("error", Object.assign(new Error("no space"), { code: "ENOSPC" })));
      return stream;
    };
    const dest = path.join(dir, "inner-setup.exe");
    await assert.rejects(
      downloadFile(`${baseUrl}/inner-setup.exe`, dest, { expectedSize: PAYLOAD.length, resume: false }),
      (error) => error.code === "no-space",
    );
  } finally {
    require("node:fs").createWriteStream = realCreateWriteStream;
    await stopServer(server);
  }
});

test("下载失败时保留 .part，下一次尝试可以接着续", async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { "Content-Length": PAYLOAD.length });
    res.write(PAYLOAD.subarray(0, HALF));
    // 掐断连接：模拟服务器中途掉线
    setTimeout(() => res.destroy(), 10);
  });
  const dir = await tempDir();
  try {
    const dest = path.join(dir, "inner-setup.exe");
    await assert.rejects(
      downloadFile(`${baseUrl}/inner-setup.exe`, dest, {
        expectedSize: PAYLOAD.length,
        resume: true,
      }),
    );
    const partStats = await fs.stat(`${dest}.part`);
    assert.ok(partStats.size > 0, "半截文件要留着给下一次续传");
  } finally {
    await stopServer(server);
  }
});
