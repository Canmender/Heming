/**
 * 内核输出的人话化（d.285）。
 *
 * 为什么要做：模型能力由随包的「和鸣模型内核」提供，用户不该在页面上再看见另一套
 * 产品名。内核自己的报错与命令回显里会带着那个名字——`magpie ...`、`magpie-core ...`、
 * `@magpie-community/opencode-xxx-auth` 这种包名——统一在这里换成和鸣自己的说法。
 *
 * 只影响**展示**：真实命令、参数、包名一个字节都不改，页面上照抄出去仍然有效的前提是
 * 我们只改人读的那部分；涉及包名时换成「接入组件「xxx」」，不让用户去 npm 上找一个
 * 名字已经被我们改掉的包。
 */

/** 页面上对随包内核的称呼：与 `magpieHost.ts` / `magpieClient.ts` 的报错用同一个词。 */
const ENGINE_NAME = "模型服务";

/**
 * 把内核输出里的外部产品名换成和鸣自己的说法，并把最常撞见的两句英文拒绝翻成中文。
 *
 * 其余英文原样保留：用户排查时往往要照着那行字去搜或贴给别人，改写反而帮倒忙。
 */
export function engineText(text: string): string {
  if (!text) return text;
  return (
    text
      // 包名先处理，否则会被下面的单词替换拆成「@和鸣模型内核-community/...」。
      .replace(/@magpie-community\/opencode-([a-z0-9-]+)-auth/gi, "接入组件「$1」")
      // 不带插件时 `accounts add <国内端>` 的真实回应，留着英文用户也解不开。
      .replace(
        /magpie can't sign in to (\S+) accounts?/gi,
        `${ENGINE_NAME}不能直接登录 $1 的账号：先装上它的接入组件`,
      )
      // `accounts checkin` 在没有可签到账号时的回应。
      .replace(/no ([^.\n]+) account is signed in/gi, "还没有登录任何 $1 账号")
      // 名字本身：二进制名先换，避免 `magpie-core` 只剩半截。
      .replace(/\bmagpie-core\b/gi, ENGINE_NAME)
      .replace(/\bmagpie\b/gi, ENGINE_NAME)
  );
}
