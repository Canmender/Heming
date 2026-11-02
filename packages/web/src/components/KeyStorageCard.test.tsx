/**
 * 密钥存储状态卡（d.36 + P0-5b）：状态文案要能**点名**，不能只说「部分密钥」。
 *
 * P0-5b 起这张卡也会显示会话加密链 / 消息缓存 / 迁移备份键，
 * 所以这里专门钉「键名 → 中文名」的映射（含备份后缀）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { KeyStorageCard } from "./KeyStorageCard.js";
import {
  ENVELOPE_MARK,
  ENVELOPE_VERSION,
  PLAINTEXT_BACKUP_SUFFIX,
  UNDECRYPTABLE_BACKUP_SUFFIX,
  resetSecureStorageState,
  secureGetItem,
} from "../lib/secureStorage.js";

function installBridge(opts: { available?: boolean } = {}): void {
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
    available: opts.available !== false,
    encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
    decrypt: (data: string) =>
      data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
  };
}

function uninstallBridge(): void {
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
}

/** 卡片正文（区域内的全部文本，避免逐段 getByText 被换行拆开）。 */
function cardText(): string {
  return screen.getByRole("region", { name: "密钥存储" }).textContent ?? "";
}

beforeEach(() => {
  localStorage.clear();
  uninstallBridge();
  resetSecureStorageState();
});

afterEach(() => {
  cleanup();
  uninstallBridge();
  resetSecureStorageState();
});

describe("KeyStorageCard · 键名点名", () => {
  it("会话加密链与消息缓存有中文名（不甩原始键名）", () => {
    installBridge({ available: false }); // 读明文即记入「以明文保存」清单
    localStorage.setItem("heming.e2e.chains.c1", "{}");
    localStorage.setItem("heming.msgCache.c2", "[]");
    secureGetItem("heming.e2e.chains.c1");
    secureGetItem("heming.msgCache.c2");

    render(<KeyStorageCard />);

    const text = cardText();
    expect(text).toContain("会话加密链（会话 c1）");
    expect(text).toContain("消息缓存（会话 c2）");
    expect(text).not.toContain("heming.e2e.chains.c1"); // 原始键名只做兜底，不该出现
    // 覆盖范围说明要跟上 P0-5b，不能再说「尚未加密」
    expect(text).toContain("会话加密链与消息缓存");
    expect(text).not.toContain("尚未加密");
  });

  it("备份后缀可读：旧明文备份 / 无法解密的旧密文", () => {
    installBridge({ available: false });
    const plaintextBackup = "heming.e2e.chains.c1" + PLAINTEXT_BACKUP_SUFFIX;
    localStorage.setItem(plaintextBackup, "{}");
    secureGetItem(plaintextBackup);

    // 解不开的旧密文：有桥但密文是垃圾 ⇒ 进 undecryptableKeys
    installBridge();
    const undecryptable = "heming.msgCache.c2" + UNDECRYPTABLE_BACKUP_SUFFIX;
    localStorage.setItem(
      undecryptable,
      JSON.stringify({ [ENVELOPE_MARK]: ENVELOPE_VERSION, data: "garbage" }),
    );
    expect(secureGetItem(undecryptable)).toBeNull();

    render(<KeyStorageCard />);

    const text = cardText();
    expect(text).toContain("旧明文备份");
    expect(text).toContain("无法解密的旧密文");
    expect(text).toContain("会话加密链（会话 c1）");
    expect(text).toContain("消息缓存（会话 c2）");
  });

  it("不认识的键回退原始键名（宁可丑也不含糊）", () => {
    installBridge({ available: false });
    localStorage.setItem("heming.unknownKey.v1", "x");
    secureGetItem("heming.unknownKey.v1");

    render(<KeyStorageCard />);

    expect(cardText()).toContain("heming.unknownKey.v1");
  });
});
