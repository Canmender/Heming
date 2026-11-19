import { describe, expect, it } from "vitest";
import {
  describeAuto,
  describeSync,
  labelOf,
  parseSyncStatus,
  syncAutoArgs,
  syncNowArgs,
  syncOffArgs,
  syncOnArgs,
} from "./magpieSync.js";

/** 云同步：把 `magpie webdav` 的输出读成「开着吗、连哪儿、上次怎么样」，并拼命令。 */

const OFF_WEBDAV = `WebDAV sync is off
magpie webdav on <address> keeps providers, settings, profiles, agents' models and the library the same on every computer (magpie webdav help)`;

const ON_WEBDAV = `WebDAV sync  https://dav.jianguoyun.com/dav/  me@example.com · password saved
  syncs providers with their API keys, settings, profiles, agents' models, library
 ✓ synced 3 minutes ago
  Syncs by itself every 15 minutes (magpie webdav auto changes it)`;

describe("parseSyncStatus", () => {
  it("没开的时候：认得出是哪一种云、也认得出没开", () => {
    const status = parseSyncStatus(OFF_WEBDAV);
    expect(status.on).toBe(false);
    expect(status.kind).toBe("webdav");
    expect(status.url).toBe("");
    expect(describeSync(status)).toBe("云同步没开：这台电脑的设置只在本地。");
  });

  it("开着的时候：地址、跟随说明、同步哪些、上次什么时候、多久一次都读出来", () => {
    const status = parseSyncStatus(ON_WEBDAV);
    expect(status.on).toBe(true);
    expect(status.kind).toBe("webdav");
    expect(status.url).toBe("https://dav.jianguoyun.com/dav/");
    expect(status.who).toEqual(["me@example.com", "password saved"]);
    expect(status.parts).toEqual([
      "providers with their API keys",
      "settings",
      "profiles",
      "agents' models",
      "library",
    ]);
    expect(status.last).toBe("上次同步 3 minutes ago");
    expect(status.auto).toBe(15);
    expect(describeSync(status)).toBe(
      "WebDAV → https://dav.jianguoyun.com/dav/：同步 providers with their API keys、settings、profiles、agents' models、library；上次同步 3 minutes ago。",
    );
  });

  it("失败与「还没同步过」各说各的：不把失败写成成功", () => {
    const failed = parseSyncStatus(`WebDAV sync  https://dav.example.com/dav/  me
  syncs settings, profiles
  couldn't sync: 401 Unauthorized
  Syncs only when asked: magpie webdav now syncs once`);
    expect(failed.error).toBe("401 Unauthorized");
    expect(failed.last).toBe("");
    expect(failed.auto).toBe(0);
    expect(describeSync(failed)).toContain("上次没成：401 Unauthorized");

    const never = parseSyncStatus(`WebDAV sync  https://dav.example.com/dav/
  not synced yet`);
    expect(never.last).toBe("还没同步过");
    expect(describeSync(never)).toContain("还没同步过");
  });

  it("S3 与 GitHub 的抬头也认：区域、path-style、令牌已存都跟着地址后面", () => {
    const s3 = parseSyncStatus(`S3 sync  s3://backups/magpie  AWS · ap-east-1 · path-style · access key AKIA · secret saved
  syncs providers without their API keys, settings`);
    expect(s3.kind).toBe("s3");
    expect(s3.url).toBe("s3://backups/magpie");
    expect(s3.who).toEqual(["AWS", "ap-east-1", "path-style", "access key AKIA", "secret saved"]);
    expect(labelOf(s3.kind)).toBe("S3 桶");

    const github = parseSyncStatus(`GitHub sync  github://me/heming-settings/main  main · token saved
  syncs settings`);
    expect(github.kind).toBe("github");
    expect(github.who).toEqual(["main", "token saved"]);
    expect(labelOf(github.kind)).toBe("GitHub 仓库");
  });
});

describe("命令拼装", () => {
  it("现在同步一次、关掉：都只有前半段，密码不用给", () => {
    expect(syncNowArgs("webdav")).toEqual(["webdav", "now"]);
    expect(syncOffArgs("s3")).toEqual(["s3", "off"]);
  });

  it("多久一次：只放内核认的那几档，别的一律不给发", () => {
    expect(syncAutoArgs("webdav", 15)).toEqual(["webdav", "auto", "15"]);
    expect(syncAutoArgs("github", "off")).toEqual(["github", "auto", "off"]);
    expect(syncAutoArgs("webdav", 7)).toBeNull();
  });

  it("开云同步：地址为空不发；给了账号就带上 user=", () => {
    expect(syncOnArgs("webdav", "  https://dav.example.com/dav/  ")).toEqual([
      "webdav",
      "on",
      "https://dav.example.com/dav/",
    ]);
    expect(syncOnArgs("webdav", "https://dav.example.com/dav/", "me@example.com")).toEqual([
      "webdav",
      "on",
      "https://dav.example.com/dav/",
      "user=me@example.com",
    ]);
    expect(syncOnArgs("webdav", "   ")).toBeNull();
  });

  it("自动同步的说法：没读到就不说，0 是只在手动时", () => {
    expect(describeAuto(null)).toBe("");
    expect(describeAuto(0)).toBe("只在点「现在同步一次」时");
    expect(describeAuto(30)).toBe("网关跑着时每 30 分钟");
  });
});
