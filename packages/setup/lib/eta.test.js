"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { EtaEstimator } = require("./eta");

test("样本不足或时间跨度太短时不给速度", () => {
  let now = 0;
  const eta = new EtaEstimator({ now: () => now });
  assert.equal(eta.rate(), null);
  eta.sample(0);
  assert.equal(eta.rate(), null);
  now = 200;
  eta.sample(200);
  // 跨度 200ms < minSpanMs(500)
  assert.equal(eta.rate(), null);
});

test("窗口首尾差值算速度，并给出剩余秒数", () => {
  let now = 0;
  const eta = new EtaEstimator({ now: () => now });
  eta.sample(0);
  now = 1000;
  eta.sample(1024 * 1024);
  assert.equal(Math.round(eta.rate()), 1024 * 1024);
  assert.equal(Math.round(eta.remaining(2 * 1024 * 1024)), 1);
});

test("剩余时间为 0 或无效总量时返回 null / 0", () => {
  let now = 0;
  const eta = new EtaEstimator({ now: () => now });
  eta.sample(0);
  now = 1000;
  eta.sample(1000);
  assert.equal(eta.remaining(500), 0);
  assert.equal(eta.remaining(null), null);
  assert.equal(eta.remaining(0), null);
});

test("窗口只保留最后 window 个样本", () => {
  let now = 0;
  const eta = new EtaEstimator({ window: 3, now: () => now });
  for (let i = 0; i < 5; i += 1) {
    now = i * 600;
    eta.sample(i * 100);
  }
  assert.equal(eta.samples.length, 3);
  // 首尾是第 3、5 个样本：200 -> 400 字节，1200ms
  assert.equal(Math.round(eta.rate()), Math.round((200 / 1200) * 1000));
});

test("reset 清空样本；非法样本被忽略", () => {
  let now = 0;
  const eta = new EtaEstimator({ now: () => now });
  eta.sample(10);
  eta.sample(-1);
  eta.sample(Number.NaN);
  assert.equal(eta.samples.length, 1);
  eta.reset();
  assert.equal(eta.samples.length, 0);
  assert.equal(eta.rate(), null);
});
