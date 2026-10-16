import { useState } from "react";
import { useAuthStore } from "../store/auth.js";
import { UserIcon } from "./icons.js";
import { LlmSettingsCard } from "./LlmSettingsCard.js";

/**
 * 头像文件上限：449_000 字节 → base64 data URL 约 598_700 字符，
 * 低于服务端 UpdateProfileBodySchema.avatar 上限（600_000 字符）；
 * 若取 450_000 字节，base64 后恰为 600_000 字符再加 data: 前缀必超边界，
 * 449_000 留出安全窗（评审遗留修正）。
 */
const MAX_AVATAR_BYTES = 449_000;

/** 设置区 · 个人资料：头像（data URL）与昵称，保存走 PUT /api/me。 */
export function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const updateProfile = useAuthStore((s) => s.updateProfile);

  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [avatar, setAvatar] = useState<string | undefined>(user?.avatar);
  const [fileError, setFileError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setSaved(false); // 选文件视为编辑，复位「已保存」（与昵称 onChange 行为一致）
    setFileError(null);
    if (!file.type.startsWith("image/")) {
      setFileError("请选择图片文件");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setFileError("头像不能超过约 449KB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatar(String(reader.result));
    reader.onerror = () => setFileError("读取图片失败，请重试");
    reader.readAsDataURL(file);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setError(null);
    setSaving(true);
    try {
      await updateProfile(displayName, avatar);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-[17px] font-extrabold">设置区</h1>
      <section className="mt-3 max-w-[520px] rounded-xl border border-line bg-white p-4 shadow-card">
        <div className="text-[12px] font-bold text-[#777]">个人资料</div>

        <div className="mt-3 flex items-center gap-4">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#f0f0f0] text-[#777]">
            {avatar ? (
              <img
                src={avatar}
                alt="当前头像"
                className="h-full w-full object-cover"
              />
            ) : (
              <UserIcon width={22} height={22} />
            )}
          </span>
          <label className="inline-flex cursor-pointer items-center rounded-lg border border-line px-3 py-1.5 text-[12px] shadow-card transition-colors duration-150 hover:bg-[#fafafa]">
            上传头像
            <input
              type="file"
              accept="image/*"
              aria-label="上传头像"
              className="sr-only"
              onChange={onPickFile}
            />
          </label>
          {fileError && <span className="text-[12px] text-red-600">{fileError}</span>}
        </div>

        <form onSubmit={save} className="mt-4 flex flex-col gap-3">
          <label className="text-[12px] text-muted">
            昵称
            <input
              value={displayName}
              maxLength={64}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setSaved(false);
              }}
              className="mt-1 block w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-[#bbb]"
            />
          </label>
          {error && <div className="text-[12px] text-red-600">{error}</div>}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-ink px-4 py-1.5 text-sm font-bold text-white disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {saved && (
              <span role="status" className="text-[12px] text-muted">
                已保存
              </span>
            )}
          </div>
        </form>
      </section>

      <LlmSettingsCard />
    </div>
  );
}
