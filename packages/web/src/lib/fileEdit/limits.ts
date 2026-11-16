/**
 * 文件编辑原语的上限（单一来源，解析、干跑、写盘三层都从这里取）。
 *
 * 为什么集中在一处：这些数字会同时出现在给模型的文案、设置区说明与测试断言里，
 * 各写一份必然漂移——某天把单文件放宽到 2MB，设置区还写着 1MB，用户就会以为工具坏了。
 *
 * 取值依据（产品决策，规格 §14 第 2 问已定）：
 * - 单文件 2 MB：知识库笔记远小于此，代码文件（含大段注释/字典）也很少超过；
 * - 单次补丁 4 MB：一次改 20 个 200KB 文件刚好到顶，再大就该拆；
 * - 20 个文件：一次改超过 20 个文件，用户已经无法在确认卡上逐一看清；
 * - 单 hunk 200 行：再大说明模型在整段重写，应该拆或多个 hunk（这正是补丁要避免的）。
 */

/** 单文件上限（字节，UTF-8）。 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * 单张图片上限（字节；与主进程 `MAX_IMAGE_BYTES` 同值，改一处必须改两处）。
 *
 * 为什么比文本大：截图/设计稿动辄 1–3MB，卡 2MB 会让最常见的一类图片读不了；
 * 为什么不能更大：工具返回的图片是**另起一条 user 消息**进上下文的，base64 之后再涨约
 * 1/3，5MB 的原图约等于 6.7MB 文本，已经吃掉不小模型窗口的一大块。
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 单次补丁总量上限（字节，UTF-8，按补丁文本本身计）。 */
export const MAX_PATCH_BYTES = 4 * 1024 * 1024;

/** 单次调用最多改多少个文件。 */
export const MAX_FILES_PER_PATCH = 20;

/** 单个 hunk 最多多少行（上下文 + 新增 + 删除）。 */
export const MAX_HUNK_LINES = 200;

/**
 * 判定二进制/非法 UTF-8 时检查的前缀长度。
 *
 * 只看前 8KB：足够覆盖所有常见二进制魔数与 UTF-8 前缀；
 * 扫全文件会让「打开一个 2MB 的日志」也变得很慢。
 */
export const SNIFF_BYTES = 8 * 1024;

/** `file_read` 单次返回的最大行数（防止把整个大文件塞进上下文）。 */
export const READ_MAX_LINES = 400;

/** `file_read` 单次返回的最大字符数（与工具结果 8000 字符封顶同量级，留余量）。 */
export const READ_MAX_CHARS = 20_000;

/**
 * `file_glob` 单次最多返回多少条路径（与主进程 `MAX_GLOB_RESULTS` 一致）。
 *
 * 为什么 200：一条路径平均 ~40 字符，200 条约 8KB，已经是单条工具结果的合理上限；
 * 再多模型也不会逐个读，只会挑前几条——不如让它自己用更窄的 pattern 再查一次。
 */
export const GLOB_MAX_RESULTS = 200;

/** `file_grep` 单次最多返回多少条命中（与主进程 `MAX_GREP_MATCHES` 一致）。 */
export const GREP_MAX_MATCHES = 200;

/** 单行命中文本的展示上限（与主进程 `MAX_GREP_LINE_CHARS` 一致）。 */
export const GREP_MAX_LINE_CHARS = 2000;

/**
 * `file_edit` 的 old_string 长度上限。
 *
 * 精确串替换要求模型把「要改的原文」原样抄一遍，抄得越长越容易抄错（多一个空格就匹配不上），
 * 也越贵；超过这个长度应该用 file_patch 的 `@@` 锚点或先 file_read 缩小范围。
 */
export const EDIT_MAX_OLD_CHARS = 8_000;

/** `file_edit` 的 new_string 长度上限（整份替换走 file_write，不必挤在这里）。 */
export const EDIT_MAX_NEW_CHARS = 100_000;
