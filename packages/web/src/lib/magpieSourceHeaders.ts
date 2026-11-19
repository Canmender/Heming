/**
 * 自定义请求头：把「一行一个」的输入翻译成 `provider set` 的那几对参数。
 *
 * 内核那边（`vendor/magpie-core/internal/cli/providers_cli.go` 的 applyPairs）认的是
 * `header.X-Foo=bar`：同名（不分大小写）先删再写，**值为空就只删**。页面上原来只有一对
 * 「名称 + 值」两个输入框，想加第二个头得清空重填——这里改成一块文本框，一行一个，
 * 顺带把「值留空」当成删掉这个头。
 *
 * 只做翻译，不碰 CLI：拼出来的每一对原样交给 `["provider","set",id,…]`。
 */

/** 请求头名的合法字符（RFC 7230 的 token），其余一律当看不懂。 */
const NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** 一条里可能出现的分隔符：半角冒号、全角冒号、等号。 */
const SEP = /[:：=]/;

export interface HeaderLines {
  /** 拼好的 `header.<名>=<值>`；值为空表示「删掉这个头」。 */
  pairs: string[];
  /** 看不懂的那几行原文（缺分隔符、名字里带空格等）。 */
  rejected: string[];
}

/**
 * 把多行文本拆成请求头参数对。
 *
 * - 一行一个，也认分号（半角 / 全角）隔开；
 * - 分隔符取第一个出现的，值里可以再有冒号（如 `Authorization: Bearer a:b`）；
 * - 同一个名字重复出现只留最后一个——内核本来也是先删再写，留着前面的只是噪音；
 * - 名字非法或缺分隔符的行进 `rejected`，其余照发（发得出去的先发）。
 */
export function parseHeaderLines(text: string): HeaderLines {
  const pairs: string[] = [];
  const rejected: string[] = [];
  const seen = new Map<string, number>();

  for (const raw of text.split(/\r?\n|;|；/)) {
    const line = raw.trim();
    if (!line) continue;

    const matched = SEP.exec(line);
    if (!matched) {
      rejected.push(line);
      continue;
    }
    const name = line.slice(0, matched.index).trim();
    const value = line.slice(matched.index + 1).trim();
    if (!NAME.test(name)) {
      rejected.push(line);
      continue;
    }

    const key = name.toLowerCase();
    const pair = `header.${name}=${value}`;
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, pairs.length);
      pairs.push(pair);
      continue;
    }
    // 重复名：原位替换，位置不动（保留先出现的次序，值取最后一次）。
    pairs[previous] = pair;
  }

  return { pairs, rejected };
}

/** 只取参数对，给不想多拿一个对象的调用方用。 */
export function headerPairs(text: string): string[] {
  return parseHeaderLines(text).pairs;
}
