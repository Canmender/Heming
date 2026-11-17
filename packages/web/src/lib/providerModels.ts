/**
 * 来源的模型清单：`provider show <id>` 里那一段
 *
 *   models     2 exposed of 2 from api.deepseek.com · fetched Nov 13
 *              deepseek/deepseek-flash  DeepSeek-V4.1-Flash
 *              deepseek/deepseek-v4-pro  DeepSeek-V4-Pro
 *
 * 只认 `models` 键那一行之后的更深缩进行，别把后面的 `keys`/`balance`
 * 之类当成模型。magpie 的增删是 `provider models <id> +id|-id|all|best|none`。
 */

export interface ProviderModel {
  id: string;
  name: string;
}

export interface ProviderModelsBlock {
  models: ProviderModel[];
  /** `models` 那一行右边的说明，例如 `2 exposed of 2 from api.deepseek.com · fetched Nov 13`。 */
  note: string;
}

const MODELS_KEY = /^(\s{2,})models\s+(.*)$/;

export function parseProviderModels(showText: string): ProviderModelsBlock {
  const lines = showText.replace(/\r/g, "").split("\n");
  const index = lines.findIndex((line) => MODELS_KEY.test(line));
  if (index < 0) return { models: [], note: "" };
  const match = MODELS_KEY.exec(lines[index] ?? "");
  const baseIndent = (match?.[1] ?? "  ").length;
  const note = (match?.[2] ?? "").trim();
  const models: ProviderModel[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    const parts = line.trim().split(/\s{2,}/);
    const id = (parts[0] ?? "").trim();
    if (!id) continue;
    models.push({ id, name: (parts[1] ?? "").trim() });
  }
  return { models, note };
}

/** `provider models <id> +model`：只加不减。 */
export function addProviderModelArgs(provider: string, model: string): string[] {
  return ["provider", "models", provider, `+${model.trim()}`];
}

/** `provider models <id> -model`：只减不加。 */
export function removeProviderModelArgs(provider: string, model: string): string[] {
  return ["provider", "models", provider, `-${model.trim()}`];
}

export type ProviderModelsChoice = "all" | "best" | "none";

export const PROVIDER_MODELS_CHOICE_LABEL: Record<ProviderModelsChoice, string> = {
  all: "全部",
  best: "每个系列只要最新",
  none: "暂时不下发模型",
};

export const PROVIDER_MODELS_CHOICE_HINT: Record<ProviderModelsChoice, string> = {
  all: "回到厂商目录里的全部模型",
  best: "每个系列只留下最新的一个",
  none: "来源保留，但任何智能体都看不到它的模型",
};

export function providerModelsChoiceArgs(
  provider: string,
  choice: ProviderModelsChoice,
): string[] {
  return ["provider", "models", provider, choice];
}

/** `provider refresh <id>`：重新问厂商要一次模型目录。 */
export function refreshProviderModelsArgs(provider: string): string[] {
  return ["provider", "refresh", provider];
}

export function providerModelLabel(model: ProviderModel): string {
  return model.name || model.id;
}
