"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseLatestYml,
  pickWindowsInstaller,
  resolveDownloadUrl,
  versionFromInstallerName,
  decodeFileName,
} = require("./feed");

const SAMPLE = `\uFEFFversion: 135.3.54
files:
  - url: 和鸣 Setup d.135.3.54.7.exe
    sha512: 9xYzAbCdEf==
    size: 361236480
  - url: 和鸣 Setup d.135.3.54.7.exe.blockmap
    sha512: 0oPqRsTuVw==
    size: 380000
path: 和鸣 Setup d.135.3.54.7.exe
sha512: 9xYzAbCdEf==
size: 361236480
releaseDate: '2026-11-10T09:12:00.000Z'
`;

test("parseLatestYml 读取 version / files / path", () => {
  const feed = parseLatestYml(SAMPLE);
  assert.equal(feed.version, "135.3.54");
  assert.equal(feed.files.length, 2);
  assert.equal(feed.files[0].url, "和鸣 Setup d.135.3.54.7.exe");
  assert.equal(feed.files[0].sha512, "9xYzAbCdEf==");
  assert.equal(feed.files[0].size, 361236480);
  assert.equal(feed.path, "和鸣 Setup d.135.3.54.7.exe");
  assert.equal(feed.sha512, "9xYzAbCdEf==");
});

test("parseLatestYml 对空文本与坏结构返回空壳而不抛异常", () => {
  const empty = parseLatestYml("");
  assert.deepEqual(empty, { version: null, files: [], path: null, sha512: null, size: null });

  const noise = parseLatestYml("这不是 yaml\n::: :\n");
  assert.equal(noise.version, null);
  assert.equal(noise.files.length, 0);
});

test("只有顶层 path 的老服务端也能用 path 兜底成 files", () => {
  const feed = parseLatestYml("version: 1.2.3\npath: 和鸣 Setup d.1.2.3.4.exe\nsha512: abc\nsize: 12\n");
  assert.equal(feed.files.length, 1);
  assert.equal(feed.files[0].url, "和鸣 Setup d.1.2.3.4.exe");
  assert.equal(feed.files[0].size, 12);
});

test("pickWindowsInstaller 跳过 blockmap，优先 .exe", () => {
  const feed = parseLatestYml(SAMPLE);
  const file = pickWindowsInstaller(feed);
  assert.equal(file.url, "和鸣 Setup d.135.3.54.7.exe");
  assert.equal(file.size, 361236480);
});

test("pickWindowsInstaller 没有 .exe 时退回 path", () => {
  const file = pickWindowsInstaller({ files: [{ url: "x.dmg", sha512: null, size: null }], path: "x.exe", sha512: "s", size: 7 });
  assert.equal(file.url, "x.exe");
  assert.equal(file.sha512, "s");
});

test("pickWindowsInstaller 什么也没有时返回 null", () => {
  assert.equal(pickWindowsInstaller(null), null);
  assert.equal(pickWindowsInstaller({ files: [], path: null }), null);
});

test("resolveDownloadUrl 给没有结尾斜杠的 base 补斜杠", () => {
  assert.equal(
    resolveDownloadUrl("http://47.92.39.184/updates", "和鸣%20Setup%20d.135.3.54.7.exe"),
    "http://47.92.39.184/updates/%E5%92%8C%E9%B8%A3%20Setup%20d.135.3.54.7.exe",
  );
  assert.equal(resolveDownloadUrl("http://host/updates/", "a.exe"), "http://host/updates/a.exe");
  assert.equal(resolveDownloadUrl("http://host/updates", "http://cdn/a.exe"), "http://cdn/a.exe");
});

test("versionFromInstallerName 取出 5 段版本", () => {
  assert.equal(versionFromInstallerName("和鸣 Setup d.135.3.54.7.exe"), "d.135.3.54.7");
  assert.equal(versionFromInstallerName("heming-setup-d.140.0.1.0-dev.3.exe"), "d.140.0.1.0-dev.3");
  assert.equal(versionFromInstallerName("random.exe"), null);
});

test("decodeFileName 解码 URL 文件名并去掉查询串", () => {
  assert.equal(decodeFileName("http://host/a/%E5%92%8C%E9%B8%A3%20Setup.exe?x=1"), "和鸣 Setup.exe");
  assert.equal(decodeFileName("http://host/plain.exe"), "plain.exe");
});
