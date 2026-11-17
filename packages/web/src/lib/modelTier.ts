/**
 * 「速度档」是 magpie 的 `model tier` 命令：参考源码有，但随桌面端发布的
 * 内核（magpie 0.1.3246）还不认识它。裸 `magpie model` 会打整段 usage，
 * 支持时里面会有一行 `magpie model tier <provider/model> …`，用它判断要不要
 * 在编辑器里摆这个选择框——摆一个保存必报错的控件比不摆更糟。
 */
export function supportsModelTier(usage: string): boolean {
  return /magpie\s+model\s+tier\b/.test(usage);
}
