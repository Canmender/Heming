/** 网页搜索交给谁、先问谁、想多深（内核 `settings` 的 searcher / searcherEffort / searchFirst）。
 *
 * 内核注释（`vendor/magpie-core/internal/settings/settings.go:519-541`）：
 * - `searcher` 指定「用哪家来搜网」；`off` 表示只走配置好的搜索 API，不叫模型去搜。
 * - `searcherEffort` 是搜索模型搜索时的思考档，取 `catalog.EffortRank` 里的一级，空等于用它自己的默认。
 * - `searchFirst` 是「一个自己搜不了网、但来源和搜索 API 都能搜」时先问谁：
 *   `model`（先问来源自己的搜索）或 `api`（先问搜索 API），空等于和鸣自己决定。
 */

/** `searchFirst` 的三个取值：空＝和鸣自己决定。 */
export type SearchFirst = "" | "model" | "api";

export const SEARCH_FIRST_OPTIONS: { value: SearchFirst; label: string; hint: string }[] = [
  { value: "", label: "和鸣自己决定", hint: "默认：谁合适就问谁" },
  { value: "model", label: "先问来源自己的搜索", hint: "来源声称自己能搜时，先让它搜" },
  { value: "api", label: "先问搜索 API", hint: "先问配好的搜索服务，问不到再让来源搜" },
];

/** `searcher` 的特殊值：不叫模型搜，只走搜索 API。 */
export const SEARCHER_OFF = "off";

/** 内核认的思考档，从弱到强（`vendor/magpie-core/internal/catalog/catalog.go:2290`）。 */
export const SEARCH_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type SearchRoute = {
  /** 用哪家搜网：模型 id、`off`，空＝和鸣自己挑。 */
  searcher: string;
  /** 搜索时的思考档，空＝用它自己的默认。 */
  effort: string;
  /** 先问谁：空 / `model` / `api`。 */
  first: SearchFirst;
};

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/** 从 `settings list --json` 那份表里读出这三项；缺了就是没设置过。 */
export function parseSearchRoute(values: Map<string, unknown>): SearchRoute {
  const first = text(values.get("searchFirst"));
  return {
    searcher: text(values.get("searcher")),
    effort: text(values.get("searcherEffort")),
    first: first === "model" || first === "api" ? first : "",
  };
}

/** 一句话说清现在是怎么搜的。 */
export function describeSearchRoute(route: SearchRoute): string {
  const who =
    route.searcher === ""
      ? "和鸣自己挑一个会搜网的模型"
      : route.searcher === SEARCHER_OFF
        ? "不叫模型去搜，只走搜索 API"
        : `用 ${route.searcher} 搜网`;
  const first =
    route.first === "model"
      ? "先问来源自己的搜索"
      : route.first === "api"
        ? "先问搜索 API"
        : "先问谁由和鸣决定";
  const effort = route.effort === "" ? "思考档按它自己的默认" : `搜索时按 ${route.effort} 档思考`;
  return `${who}；${first}；${effort}。`;
}

/** 下拉里能选的模型：现在设的那个可能已经不在目录里，留着它，免得一打开就被悄悄改掉。 */
export function searcherChoices(
  models: { id: string; name?: string }[],
  current: string,
): { id: string; name?: string }[] {
  if (current === "" || current === SEARCHER_OFF) return models;
  if (models.some((row) => row.id === current)) return models;
  return [{ id: current }, ...models];
}
