import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { DomesticCard } from "./DomesticCard.js";
import { DOMESTIC_AGENTS } from "../../lib/magpieDomestic.js";
import type { AgentQuota } from "../../lib/agentQuota.js";

/** 国内端卡片（d.284）：右侧说下一步，标题行说「这份免费额度还剩多少」。 */

const workbuddy = DOMESTIC_AGENTS[0]!;

function quota(patch: Partial<AgentQuota> = {}): AgentQuota {
  return { accounts: 1, label: "剩 70%", tone: "ok", detail: "腾讯号：本月 剩 70%", ...patch };
}

describe("国内端卡片", () => {
  it("还没接入也还没登录时，右侧只说「接入」，不贴额度", () => {
    render(<DomesticCard item={workbuddy} signedIn={0} busy={false} onPress={() => {}} />);
    expect(screen.getByText("接入")).toBeInTheDocument();
    expect(screen.queryByText("剩 70%")).not.toBeInTheDocument();
  });

  it("登录之后把最紧的额度写在标题行，颜色跟着余量走", () => {
    const { container } = render(
      <DomesticCard item={workbuddy} signedIn={1} quota={quota({ label: "剩 8%", tone: "danger" })} busy={false} onPress={() => {}} />,
    );
    const chip = container.querySelector(".ui-chip.bg-danger-soft");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe("剩 8%");
    expect(chip?.getAttribute("title")).toContain("腾讯号");
  });

  it("点数窗口的文案原样搬上来（剩 7,000 点）", () => {
    render(
      <DomesticCard item={workbuddy} signedIn={1} quota={quota({ label: "剩 7,000 点", tone: "ok" })} busy={false} onPress={() => {}} />,
    );
    expect(screen.getByText("剩 7,000 点")).toBeInTheDocument();
  });

  it("登录全都失效时，右侧改成「重新登录」，并贴「登录已失效」", () => {
    render(<DomesticCard item={workbuddy} signedIn={2} lapsed={2} busy={false} onPress={() => {}} />);
    expect(screen.getByText("重新登录")).toBeInTheDocument();
    expect(screen.getByText("登录已失效")).toBeInTheDocument();
  });

  it("只有一部分账号失效时，仍说「已登录」，不喊整张卡失效", () => {
    render(<DomesticCard item={workbuddy} signedIn={2} lapsed={1} busy={false} onPress={() => {}} />);
    expect(screen.getByText("已登录 2 个")).toBeInTheDocument();
    expect(screen.queryByText("登录已失效")).not.toBeInTheDocument();
  });

  it("点一下就走 onPress：接入与登录是同一次点击里的事", () => {
    const onPress = vi.fn();
    render(<DomesticCard item={workbuddy} signedIn={0} busy={false} onPress={onPress} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onPress).toHaveBeenCalledWith(workbuddy);
  });
});
