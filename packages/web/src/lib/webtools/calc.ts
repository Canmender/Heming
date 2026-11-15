/**
 * 计算器工具（内置只读工具 `calculator`，d.150.4.95.11）。
 *
 * 模型算数经常出错（多位数乘除、括号、百分比），给一个确定性的四则/函数求值器比让它「心算」可靠。
 * 这里只求值**表达式**，不执行任何代码：手写递归下降解析，函数表白名单，
 * 除零、溢出、非有限结果都返回中文错误，永不抛。
 */

export type CalcOutcome = { ok: true; value: number; text: string } | { ok: false; error: string };

const MAX_EXPRESSION_LENGTH = 400;
const MAX_DEPTH = 32;

/** 可用函数：名字 → 最少/最多参数个数 + 实现。 */
const FUNCTIONS: Record<string, { min: number; max: number; run: (args: number[]) => number }> = {
  sqrt: { min: 1, max: 1, run: ([x]) => Math.sqrt(x) },
  abs: { min: 1, max: 1, run: ([x]) => Math.abs(x) },
  round: { min: 1, max: 1, run: ([x]) => Math.round(x) },
  floor: { min: 1, max: 1, run: ([x]) => Math.floor(x) },
  ceil: { min: 1, max: 1, run: ([x]) => Math.ceil(x) },
  exp: { min: 1, max: 1, run: ([x]) => Math.exp(x) },
  ln: { min: 1, max: 1, run: ([x]) => Math.log(x) },
  log: { min: 1, max: 2, run: ([x, base]) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)) },
  pow: { min: 2, max: 2, run: ([x, y]) => x ** y },
  min: { min: 1, max: Number.MAX_SAFE_INTEGER, run: (args) => Math.min(...args) },
  max: { min: 1, max: Number.MAX_SAFE_INTEGER, run: (args) => Math.max(...args) },
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

interface Token {
  kind: "number" | "name" | "op" | "lparen" | "rparen" | "comma";
  text: string;
  value?: number;
}

class CalcError extends Error {}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[0-9.]/.test(input[end])) end += 1;
      // 科学计数法：1e3 / 2.5E-2（e 后面必须是数字，否则「e」是常量）
      if (end < input.length && /[eE]/.test(input[end])) {
        let probe = end + 1;
        if (probe < input.length && /[+-]/.test(input[probe])) probe += 1;
        if (probe < input.length && /[0-9]/.test(input[probe])) {
          end = probe;
          while (end < input.length && /[0-9]/.test(input[end])) end += 1;
        }
      }
      const raw = input.slice(index, end);
      if ((raw.match(/\./g) ?? []).length > 1) throw new CalcError(`数字格式不对：${raw}`);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new CalcError(`数字格式不对：${raw}`);
      tokens.push({ kind: "number", text: raw, value });
      index = end;
      continue;
    }
    if (/[a-zA-Z_]/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[a-zA-Z_0-9]/.test(input[end])) end += 1;
      tokens.push({ kind: "name", text: input.slice(index, end).toLowerCase() });
      index = end;
      continue;
    }
    if ("+-*/%^".includes(char)) {
      tokens.push({ kind: "op", text: char });
      index += 1;
      continue;
    }
    if (char === "(" || char === "（") {
      tokens.push({ kind: "lparen", text: "(" });
      index += 1;
      continue;
    }
    if (char === ")" || char === "）") {
      tokens.push({ kind: "rparen", text: ")" });
      index += 1;
      continue;
    }
    if (char === "," || char === "，") {
      tokens.push({ kind: "comma", text: "," });
      index += 1;
      continue;
    }
    if (char === "×" || char === "·") {
      tokens.push({ kind: "op", text: "*" });
      index += 1;
      continue;
    }
    if (char === "÷") {
      tokens.push({ kind: "op", text: "/" });
      index += 1;
      continue;
    }
    throw new CalcError(`看不懂的字符：${char}`);
  }
  return tokens;
}

/** 递归下降求值：expr → term → unary → power → primary。 */
class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.expression();
    if (this.index < this.tokens.length) {
      throw new CalcError(`表达式有多余内容：${this.tokens[this.index].text}`);
    }
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private takeOp(ops: string): boolean {
    const token = this.peek();
    if (token && token.kind === "op" && ops.includes(token.text)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expression(): number {
    let value = this.term();
    for (;;) {
      const token = this.peek();
      if (!token || token.kind !== "op" || (token.text !== "+" && token.text !== "-")) return value;
      this.index += 1;
      const right = this.term();
      value = token.text === "+" ? value + right : value - right;
    }
  }

  private term(): number {
    let value = this.unary();
    for (;;) {
      const token = this.peek();
      if (!token || token.kind !== "op" || !"*/%".includes(token.text)) return value;
      this.index += 1;
      const right = this.unary();
      if (token.text === "*") value *= right;
      else if (token.text === "/") {
        if (right === 0) throw new CalcError("除数为 0");
        value /= right;
      } else {
        if (right === 0) throw new CalcError("取余的除数为 0");
        value %= right;
      }
    }
  }

  private unary(): number {
    const token = this.peek();
    if (token && token.kind === "op" && (token.text === "+" || token.text === "-")) {
      this.index += 1;
      const value = this.unary();
      return token.text === "-" ? -value : value;
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    const token = this.peek();
    if (token && token.kind === "op" && token.text === "^") {
      this.index += 1;
      const exponent = this.unary(); // 右结合
      return base ** exponent;
    }
    return base;
  }

  private primary(): number {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) throw new CalcError("表达式嵌套太深");
    try {
      const token = this.peek();
      if (!token) throw new CalcError("表达式不完整");
      if (token.kind === "number") {
        this.index += 1;
        return token.value ?? 0;
      }
      if (token.kind === "lparen") {
        this.index += 1;
        const value = this.expression();
        const close = this.peek();
        if (!close || close.kind !== "rparen") throw new CalcError("括号没有闭合");
        this.index += 1;
        return value;
      }
      if (token.kind === "name") {
        this.index += 1;
        const name = token.text;
        const next = this.peek();
        if (next && next.kind === "lparen") {
          this.index += 1;
          const args: number[] = [];
          if (this.peek()?.kind !== "rparen") {
            args.push(this.expression());
            while (this.peek()?.kind === "comma") {
              this.index += 1;
              args.push(this.expression());
            }
          }
          const close = this.peek();
          if (!close || close.kind !== "rparen") throw new CalcError(`函数 ${name}( ) 括号没有闭合`);
          this.index += 1;
          const fn = FUNCTIONS[name];
          if (!fn) throw new CalcError(`不支持的函数：${name}（可用 sqrt/abs/round/floor/ceil/exp/ln/log/pow/min/max）`);
          if (args.length < fn.min || args.length > fn.max) {
            throw new CalcError(`函数 ${name} 的参数个数不对（收到 ${args.length} 个）`);
          }
          return fn.run(args);
        }
        const constant = CONSTANTS[name];
        if (constant === undefined) throw new CalcError(`不认识的常量或函数：${name}`);
        return constant;
      }
      throw new CalcError(`这里需要一个数字，收到「${token.text}」`);
    } finally {
      this.depth -= 1;
    }
  }
}

/** 把数值格式化成给人看的字符串：整数直出，小数保留最多 12 位有效数字。 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rounded = Number(value.toPrecision(12));
  return String(rounded);
}

/** 求值一个算术表达式（四则/取余/乘方 + 常用函数），永不抛。 */
export function evaluateExpression(expression: string): CalcOutcome {
  const input = collapseSpaces(expression);
  if (!input) return { ok: false, error: "表达式为空" };
  if (input.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, error: `表达式太长（上限 ${MAX_EXPRESSION_LENGTH} 个字符）` };
  }
  try {
    const tokens = tokenize(input);
    if (!tokens.length) return { ok: false, error: "表达式为空" };
    const value = new Parser(tokens).parse();
    if (!Number.isFinite(value)) return { ok: false, error: "结果不是有限数（可能溢出或除以 0）" };
    return { ok: true, value, text: `${input} = ${formatNumber(value)}` };
  } catch (error) {
    if (error instanceof CalcError) return { ok: false, error: error.message };
    return { ok: false, error: `计算失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function collapseSpaces(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}
