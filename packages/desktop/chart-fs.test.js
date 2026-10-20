/**
 * 图表导出桥的安全测试。
 *
 * 这个桥把网页（不可信输入）传来的文件名写到本机磁盘，
 * 所以路径穿越防护必须有测试兜着——它一旦破了就是任意文件写。
 */

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

// chart-fs 依赖 electron 的 shell（只在 open 时用），这里不测 open，
// 故用 stub 顶掉 electron 模块，避免测试环境里 require 失败。
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "electron") return require.resolve("./__electron-stub.js");
  return origResolve.call(this, request, ...rest);
};

const { safeFileName, resolveTarget, chartsRoot } = require("./chart-fs.js");

Module._resolveFilename = origResolve;

test("文件名清洗：只保留安全字符", () => {
  assert.strictEqual(safeFileName("季度收入-F1.html"), "季度收入-F1.html");
  assert.strictEqual(safeFileName("a/b:c*d.html"), "b-c-d.html"); // 先取最后一段再清洗
  assert.strictEqual(safeFileName("  报表  2026 .html"), "报表-2026-.html");
});

test("文件名清洗：路径分隔符被剥离（不产生子目录）", () => {
  assert.strictEqual(safeFileName("../../etc/passwd.html"), "passwd.html");
  assert.strictEqual(safeFileName("..\\..\\windows\\system32.html"), "system32.html"); // 同理取最后一段
  assert.strictEqual(safeFileName("a/b/c/d.html"), "d.html");
});

test("文件名清洗：空与纯符号返回 null", () => {
  assert.strictEqual(safeFileName(""), null);
  assert.strictEqual(safeFileName("   "), null);
  assert.strictEqual(safeFileName("..."), null);
  assert.strictEqual(safeFileName(".."), null);
});

test("resolveTarget：只接受 .html", () => {
  assert.strictEqual(resolveTarget("a.html") !== null, true);
  assert.strictEqual(resolveTarget("a.txt"), null);
  assert.strictEqual(resolveTarget("a.exe"), null);
  assert.strictEqual(resolveTarget("noext"), null);
});

test("resolveTarget：拒绝目录穿越", () => {
  // 清洗后已不含分隔符，这里再确认最终路径仍在根目录内
  const evil = ["../../evil.html", "..\\..\\evil.html", "/etc/evil.html", "C:/evil.html"];
  for (const name of evil) {
    const target = resolveTarget(name);
    if (target) {
      const root = path.resolve(chartsRoot());
      const full = path.resolve(target.full);
      assert.ok(
        full.startsWith(root + path.sep),
        `${name} 逃出了 charts 根目录：${full}`,
      );
    }
  }
});

test("resolveTarget：落盘路径恒在 ~/Heming/charts 内", () => {
  const target = resolveTarget("季度-F1.html");
  assert.ok(target);
  assert.strictEqual(target.name, "季度-F1.html");
  assert.ok(target.full.startsWith(path.resolve(chartsRoot())));
  assert.strictEqual(path.dirname(target.full), path.resolve(chartsRoot()));
});

test("chartsRoot 固定在用户目录的 Heming/charts 下", () => {
  assert.strictEqual(
    chartsRoot(),
    path.join(os.homedir(), "Heming", "charts"),
  );
});

test("resolveTarget：长文件名被截断到 80 字符内且保住 .html 后缀", () => {
  // 回归：截断若把后缀切掉，resolveTarget 会因「不以 .html 结尾」拒收，
  // 表现为导出静默失败（界面只说「导出失败」，看不出是文件名太长）。
  const target = resolveTarget(`${"x".repeat(300)}.html`);
  assert.ok(target);
  assert.ok(target.name.length <= 80);
  assert.ok(target.name.endsWith(".html"), `后缀被截掉了：${target.name}`);
});
