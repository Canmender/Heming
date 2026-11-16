/**
 * 本机命令执行的上限（d.164）。
 *
 * 这些数字都不是「随便取一个安全值」，而是三条约束的交点：
 * - 一轮对话最多 12 个工具轮（`MAX_TOOL_ROUNDS`），命令一跑十分钟就把轮次预算全吃掉；
 * - 模型能写出的命令长度有实际边界，2000 字符足够写完一条构建/测试/查找命令，
 *   再长通常是它把整份脚本糊进 `-e` 里，那应该写文件再执行；
 * - 命令输出会整段进上下文，20KB 已经能撑爆一次小模型的窗口，超出的部分必须截断
 *   并**明确告诉模型「被截断了」**，否则它会以为命令没输出。
 */

/** 模型侧单条命令的最大字符数。 */
export const SHELL_MAX_COMMAND_CHARS = 2000;

/** 默认超时：30 秒。 */
export const SHELL_DEFAULT_TIMEOUT_MS = 30_000;

/** 超时上限：2 分钟。超过就请用户自己跑，或拆成更小的命令。 */
export const SHELL_MAX_TIMEOUT_MS = 120_000;

/** 回灌给模型的输出上限（stdout + stderr 合计）。 */
export const SHELL_MAX_OUTPUT_CHARS = 20_000;

/** 主进程侧的硬上限：超过这个量直接拒绝，不把它读进内存。 */
export const SHELL_MAX_CAPTURE_BYTES = 512 * 1024;
