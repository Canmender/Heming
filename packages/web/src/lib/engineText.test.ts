import { describe, expect, it } from "vitest";
import { engineText } from "./engineText.js";

/** 内核输出的人话化（d.285）：页面上不再出现外部引擎名。 */

describe("engineText", () => {
  it("空串与普通中文原样返回", () => {
    expect(engineText("")).toBe("");
    expect(engineText("已签到 +100 点")).toBe("已签到 +100 点");
  });

  it("二进制名换成和鸣自己的说法", () => {
    expect(engineText("magpie-core provider add deepseek sk-x")).toBe("模型服务 provider add deepseek sk-x");
    expect(engineText("magpie-core.exe 已退出")).toBe("模型服务.exe 已退出");
  });

  it("产品名（含大写）也换掉", () => {
    expect(engineText("magpie accounts --json")).toBe("模型服务 accounts --json");
    expect(engineText("Magpie 目录为空")).toBe("模型服务 目录为空");
  });

  it("包名换成「接入组件」，不把用户引向一个改了名的 npm 包", () => {
    expect(engineText("npm couldn't install @magpie-community/opencode-workbuddy-auth: 404")).toBe(
      "npm couldn't install 接入组件「workbuddy」: 404",
    );
  });

  it("不带接入组件时内核拒绝登录的那句翻成中文", () => {
    expect(engineText("magpie can't sign in to workbuddy accounts")).toBe(
      "模型服务不能直接登录 workbuddy 的账号：先装上它的接入组件",
    );
  });

  it("没有可签到账号的那句翻成中文，厂商名保留原样", () => {
    expect(engineText("no WorkBuddy (China), Trae CN, MiniMax Code or Qoder account is signed in")).toBe(
      "还没有登录任何 WorkBuddy (China), Trae CN, MiniMax Code or Qoder 账号",
    );
  });

  it("处理完的结果里不再有那个名字（大小写都算）", () => {
    const mixed = [
      "magpie-core accounts --json",
      "magpie can't sign in to qoder accounts",
      "npm couldn't install @magpie-community/opencode-qoder-auth: EACCES",
      "Magpie 网关没有就绪",
    ].join("\n");
    expect(engineText(mixed)).not.toMatch(/magpie/i);
  });
});
