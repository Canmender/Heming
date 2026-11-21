import { describe, expect, it } from "vitest";
import { evaluateExpression, formatNumber } from "./calc.js";

/** 取成功结果里的数值；失败直接抛，测试里不写 `as` 断言。 */
function value(expression: string): number {
  const outcome = evaluateExpression(expression);
  if (!outcome.ok) throw new Error(`${expression} 求值失败：${outcome.error}`);
  return outcome.value;
}

describe("evaluateExpression", () => {
  it("四则运算按优先级求值", () => {
    expect(value("1+2*3")).toBe(7);
    expect(value("(1+2)*3")).toBe(9);
    expect(value("10-4/2")).toBe(8);
    expect(value("7%3")).toBe(1);
  });

  it("支持乘方（右结合）、一元负号与科学计数法", () => {
    expect(value("2^3^2")).toBe(512);
    expect(value("-2^2")).toBe(-4);
    expect(value("1e3+1")).toBe(1001);
  });

  it("支持常用函数与常量，多个参数", () => {
    expect(value("sqrt(16)+abs(-2)")).toBe(6);
    expect(value("pow(2,10)")).toBe(1024);
    expect(value("min(3,1,2)")).toBe(1);
    expect(value("log(100)")).toBe(2);
    expect(value("round(pi)")).toBe(3);
  });

  it("中文全角符号与 ×÷ 也能算", () => {
    expect(value("（1+2）×3÷3")).toBe(3);
  });

  it("常用扩展函数：立方根/对数/三角/取整/双曲常数等（d.412.4.188）", () => {
    expect(value("cbrt(27)")).toBe(3);
    expect(value("log2(8)")).toBe(3);
    expect(value("hypot(3,4)")).toBe(5);
    expect(value("trunc(-2.9)")).toBe(-2);
    expect(value("sign(-7)")).toBe(-1);
    expect(value("clamp(15,0,10)")).toBe(10);
    expect(value("round(sin(pi/2))")).toBe(1); // sin(π/2)=1
    expect(value("round(cos(0))")).toBe(1);
    expect(value("round(atan(1)*4/pi)")).toBe(1); // atan(1)=π/4
    expect(value("round(atan2(1,1)*4/pi)")).toBe(1);
    expect(value("round(asin(1)*2/pi)")).toBe(1);
    expect(value("acos(1)")).toBe(0);
    expect(value("round(tan(pi/4))")).toBe(1);
  });

  it("阶乘 / gcd / lcm：含边界与非法输入的中文报错（d.412.4.188）", () => {
    expect(value("fact(5)")).toBe(120);
    expect(value("factorial(0)")).toBe(1);
    expect(value("fact(10)")).toBe(3628800);
    expect(value("gcd(12,18)")).toBe(6);
    expect(value("gcd(-24,18)")).toBe(6);
    expect(value("lcm(4,6)")).toBe(12);
    for (const [expression, expected] of [
      ["fact(-1)", "阶乘只接受非负整数"],
      ["fact(2.5)", "阶乘只接受非负整数"],
      ["fact(171)", "阶乘太大"],
    ] as const) {
      const outcome = evaluateExpression(expression);
      expect(outcome.ok, expression).toBe(false);
      if (!outcome.ok) expect(outcome.error, expression).toContain(expected);
    }
  });

  it("除零、未知函数、括号不闭合、空表达式都返回中文错误", () => {
    for (const [expression, expected] of [
      ["1/0", "除数为 0"],
      ["1%0", "除数为 0"],
      ["foo(1)", "不支持的函数"],
      ["(1+2", "括号没有闭合"],
      ["", "表达式为空"],
      ["1+", "不完整"],
      ["1 2", "多余内容"],
      ["1$2", "看不懂的字符"],
    ] as const) {
      const outcome = evaluateExpression(expression);
      expect(outcome.ok, expression).toBe(false);
      if (!outcome.ok) expect(outcome.error, expression).toContain(expected);
    }
  });

  it("结果不是有限数时报错而不是返回 Infinity", () => {
    const outcome = evaluateExpression("1e308*10");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("不是有限数");
  });

  it("成功的返回值带可读文本", () => {
    const outcome = evaluateExpression("(1280*0.85+36)/3");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.text).toBe("(1280*0.85+36)/3 = 374.666666667");
    }
  });
});

describe("formatNumber", () => {
  it("整数直出，小数最多保留 12 位有效数字", () => {
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(1 / 3)).toBe("0.333333333333");
  });
});
