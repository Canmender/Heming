import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import {
  CREDENTIALS_KEY,
  CREDENTIAL_VALUE_PREFIX,
  MAX_CREDENTIALS,
  credentialValueKey,
  getCredentialData,
  getCredentialType,
  readCredentialRecords,
  removeCredential,
  resetCredentialMemory,
  saveCredential,
  setCredentialStorage,
  useWorkflowCredentialsStore,
  type WorkflowCredentialType,
} from "./credentials.js";

const NOW = 1_700_000_000_000;

let mem: StorageLike;

beforeEach(() => {
  mem = createMemoryStorage();
  setCredentialStorage(mem);
  resetCredentialMemory();
  useWorkflowCredentialsStore.setState({ credentials: [] });
});

function saveBasic(name = "接口账号") {
  return saveCredential(
    {
      name,
      type: "httpBasic",
      data: { username: "alice", password: "secret-1" },
    },
    NOW,
  );
}

describe("凭据类型定义", () => {
  it("四种 HTTP 凭据都有字段定义，未知类型返回 undefined", () => {
    const types: WorkflowCredentialType[] = [
      "httpBasic",
      "httpHeader",
      "httpQueryAuth",
      "bearerToken",
    ];
    for (const type of types) {
      expect(getCredentialType(type)?.fields.length).toBeGreaterThan(0);
    }
    expect(getCredentialType("nope")).toBeUndefined();
  });
});

describe("saveCredential", () => {
  it("保存后元数据落普通键、值落 secureStorage 键，getData 能读回", async () => {
    const result = saveBasic();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const records = readCredentialRecords(mem);
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("接口账号");
    expect(records[0]?.type).toBe("httpBasic");
    expect(mem.getItem(CREDENTIALS_KEY)).toContain("接口账号");

    // 浏览器端没有桌面桥：值是明文 JSON（但键名独立，不混在元数据里）
    const rawValue = mem.getItem(credentialValueKey(result.id));
    expect(rawValue).toBeTruthy();
    expect(rawValue).not.toContain("__hemingEnc");
    expect(JSON.parse(rawValue ?? "{}")).toEqual({ username: "alice", password: "secret-1" });

    await expect(getCredentialData("httpBasic", result.id)).resolves.toEqual({
      username: "alice",
      password: "secret-1",
    });
  });

  it("类型不匹配时 getData 返回 null（防止把 A 类型的值喂给 B 类型节点）", async () => {
    const result = saveBasic();
    if (!result.ok) throw new Error(result.error);
    await expect(getCredentialData("bearerToken", result.id)).resolves.toBeNull();
    await expect(getCredentialData("httpBasic", "cred-missing")).resolves.toBeNull();
  });

  it("必填字段为空时给中文错误且不写入", () => {
    const result = saveCredential(
      { name: "缺密码", type: "httpBasic", data: { username: "alice", password: "  " } },
      NOW,
    );
    expect(result).toEqual({ ok: false, error: "请填写密码" });
    expect(readCredentialRecords(mem)).toHaveLength(0);
  });

  it("凭据名与类型也要校验", () => {
    expect(saveCredential({ name: " ", type: "httpBasic", data: {} }, NOW)).toEqual({
      ok: false,
      error: "请填写凭据名称",
    });
    const unknown = saveCredential({
      name: "怪类型",
      // 故意用非法类型走运行时校验分支（UI 不会传进来，但导入/手改数据可能）
      type: "httpDigest" as WorkflowCredentialType,
      data: {},
    }, NOW);
    expect(unknown).toEqual({ ok: false, error: "未知的凭据类型" });
  });

  it("同名凭据拒绝，改名后可以再存", () => {
    const first = saveBasic();
    expect(first.ok).toBe(true);
    const duplicated = saveBasic();
    expect(duplicated).toEqual({ ok: false, error: "已有同名凭据，请换一个名字" });
    expect(readCredentialRecords(mem)).toHaveLength(1);
  });

  it("更新已有凭据保留 id 与 createdAt，值被覆盖", async () => {
    const created = saveBasic();
    if (!created.ok) throw new Error(created.error);
    const createdRecord = readCredentialRecords(mem)[0];
    const updated = saveCredential(
      {
        id: created.id,
        name: "接口账号（新）",
        type: "httpBasic",
        data: { username: "bob", password: "secret-2" },
      },
      NOW + 10_000,
    );
    expect(updated).toEqual({ ok: true, id: created.id });
    const records = readCredentialRecords(mem);
    expect(records).toHaveLength(1);
    expect(records[0]?.createdAt).toBe(createdRecord?.createdAt);
    expect(records[0]?.updatedAt).toBe(NOW + 10_000);
    await expect(getCredentialData("httpBasic", created.id)).resolves.toEqual({
      username: "bob",
      password: "secret-2",
    });
  });

  it("更新不存在的凭据返回错误", () => {
    expect(
      saveCredential(
        { id: "cred-missing", name: "x", type: "bearerToken", data: { token: "t" } },
        NOW,
      ),
    ).toEqual({ ok: false, error: "凭据不存在（可能已被删除）" });
  });

  it("最多 30 条", () => {
    for (let index = 0; index < MAX_CREDENTIALS; index += 1) {
      const result = saveCredential(
        {
          name: `凭据 ${index}`,
          type: "bearerToken",
          data: { token: `token-${index}` },
        },
        NOW + index,
      );
      expect(result.ok).toBe(true);
    }
    const overflow = saveCredential(
      { name: "第 31 条", type: "bearerToken", data: { token: "t" } },
      NOW + 100,
    );
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.error).toContain("最多保存 30 条凭据");
  });

  it("字段白名单：多余键不会写进凭据值", async () => {
    const result = saveCredential(
      {
        name: "白名单",
        type: "httpHeader",
        data: { headerName: "X-Key", headerValue: "v", extra: "不该出现" },
      },
      NOW,
    );
    if (!result.ok) throw new Error(result.error);
    await expect(getCredentialData("httpHeader", result.id)).resolves.toEqual({
      headerName: "X-Key",
      headerValue: "v",
    });
    expect(mem.getItem(credentialValueKey(result.id))).not.toContain("extra");
  });
});

describe("removeCredential", () => {
  it("删除元数据与值，重复删除返回 false", () => {
    const created = saveBasic();
    if (!created.ok) throw new Error(created.error);
    expect(mem.getItem(credentialValueKey(created.id))).toBeTruthy();
    expect(removeCredential(created.id)).toBe(true);
    expect(readCredentialRecords(mem)).toHaveLength(0);
    expect(mem.getItem(credentialValueKey(created.id))).toBeNull();
    expect(mem.getItem(CREDENTIALS_KEY)).toBe("[]");
    expect(removeCredential(created.id)).toBe(false);
  });
});

describe("内存兜底与读盘", () => {
  it("清掉内存缓存后仍能从存储读回值", async () => {
    const created = saveBasic();
    if (!created.ok) throw new Error(created.error);
    resetCredentialMemory();
    await expect(getCredentialData("httpBasic", created.id)).resolves.toEqual({
      username: "alice",
      password: "secret-1",
    });
  });

  it("读盘丢弃坏条目、按更新时间倒序", () => {
    mem.setItem(
      CREDENTIALS_KEY,
      JSON.stringify([
        { id: "c-1", name: "旧", type: "bearerToken", createdAt: NOW, updatedAt: NOW },
        { id: "c-2", name: "新", type: "bearerToken", createdAt: NOW, updatedAt: NOW + 10 },
        { id: "c-3", name: "坏类型", type: "nope" },
        { name: "缺 id" },
      ]),
    );
    expect(readCredentialRecords(mem).map((record) => record.id)).toEqual(["c-2", "c-1"]);
  });

  it("值的键前缀符合契约（便于存储水位按 heming.workflows. 统计）", () => {
    expect(CREDENTIAL_VALUE_PREFIX.startsWith("heming.workflows.credentials.v1")).toBe(true);
    expect(credentialValueKey("abc")).toBe(`${CREDENTIAL_VALUE_PREFIX}abc`);
  });
});

describe("credentials store", () => {
  it("save/remove 同步更新 zustand 列表", () => {
    const store = useWorkflowCredentialsStore.getState();
    const saved = store.save(
      { name: "store 凭据", type: "bearerToken", data: { token: "t" } },
      NOW,
    );
    expect(saved.ok).toBe(true);
    expect(useWorkflowCredentialsStore.getState().list()).toHaveLength(1);
    if (!saved.ok) return;
    expect(useWorkflowCredentialsStore.getState().remove(saved.id)).toBe(true);
    expect(useWorkflowCredentialsStore.getState().list()).toEqual([]);
  });
});
