/**
 * 设置区 · 桌宠卡：打扰强度三档必须「真的可选、真的落盘、真的对应不同行为」。
 *
 * 行为本身在 petEvent（reducePetEvent）与 PetWindow 的用例里钉死；
 * 这里钉住设置项：默认「正常」、三档可切换、写进 heming.pet.presence.v1、提示文案随档变化。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PetSettingsCard } from "./PetSettingsCard.js";
import { PET_PRESENCE_KEY, loadPetPresencePrefs } from "../lib/petEvent.js";
import { useChatStore } from "../store/chat.js";

function installPetBridge(): void {
  (window as unknown as { __heming_pet?: unknown }).__heming_pet = {
    state: async () => ({ visible: true, scale: 1, clickThrough: true, bounds: { x: 0, y: 0, width: 1, height: 1 } }),
    show: vi.fn(),
    hide: vi.fn(),
    setScale: vi.fn(),
    setClickThrough: vi.fn(),
    reload: vi.fn(),
    openSettings: vi.fn(),
    emit: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  };
}

beforeEach(() => {
  localStorage.clear();
  installPetBridge();
  // 名册加载走网络，本卡不关心：直接给一个已加载的空名册。
  useChatStore.setState({ agentsRoster: [], loadAgentsRoster: async () => {} });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __heming_pet?: unknown }).__heming_pet;
});

describe("PetSettingsCard · 打扰强度", () => {
  it("默认「正常」；三档都在，且能切换并落盘", () => {
    render(<PetSettingsCard />);

    const group = screen.getByRole("group", { name: "打扰强度" });
    const normal = screen.getByRole("button", { name: "正常" });
    expect(normal).toHaveAttribute("aria-pressed", "true");
    expect(loadPetPresencePrefs().intensity).toBe("normal");

    for (const label of ["安静", "正常", "积极"]) {
      expect(
        Array.from(group.querySelectorAll("button")).some((b) => b.textContent === label),
      ).toBe(true);
    }

    fireEvent.click(screen.getByRole("button", { name: "安静" }));
    expect(screen.getByRole("button", { name: "安静" })).toHaveAttribute("aria-pressed", "true");
    expect(loadPetPresencePrefs().intensity).toBe("quiet");
    expect(localStorage.getItem(PET_PRESENCE_KEY)).toContain("quiet");
    expect(document.body.textContent).toContain("只换姿态，不冒泡");

    fireEvent.click(screen.getByRole("button", { name: "积极" }));
    expect(loadPetPresencePrefs().intensity).toBe("eager");
    expect(document.body.textContent).toContain("姿态 + 气泡 + 轻微动作");
  });

  it("三档的提示文案各不相同（不是同一个下拉框换标签）", () => {
    render(<PetSettingsCard />);
    const hints: string[] = [];
    for (const label of ["安静", "正常", "积极"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      hints.push(document.body.textContent ?? "");
    }
    expect(hints[0]).toContain("只换姿态，不冒泡");
    expect(hints[1]).toContain("冒泡 4 秒后收回");
    expect(hints[2]).toContain("姿态 + 气泡 + 轻微动作");
  });
});
