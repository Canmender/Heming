import { useEffect, useState } from "react";

import { ChevronIcon } from "../icons.js";
import type { ModelRow } from "../../lib/modelCatalog.js";
import {
  SEARCHER_OFF,
  SEARCH_EFFORTS,
  SEARCH_FIRST_OPTIONS,
  describeSearchRoute,
  searcherChoices,
  type SearchFirst,
  type SearchRoute,
} from "../../lib/magpieSearch.js";
import { settingArgs } from "../../lib/modelSettings.js";

/**
 * 网页搜索交给谁、先问谁、想多深（`settings` 的 searcher / searchFirst / searcherEffort）。
 *
 * 与「看图与画图模型」同一套做法：选中就保存，清空就 reset（`settings set` 不收空值）。
 */
export function SearchProviderSettings({
  rows,
  route,
  cliReady,
  onRun,
}: {
  /** 网关现在给出的模型；用来挑「用哪家搜网」。 */
  rows: ModelRow[];
  /** 现在设着的三项。 */
  route: SearchRoute;
  cliReady: boolean;
  onRun: (title: string, args: string[]) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [searcherDraft, setSearcherDraft] = useState(route.searcher);
  const [firstDraft, setFirstDraft] = useState<SearchFirst>(route.first);
  const [effortDraft, setEffortDraft] = useState(route.effort);

  useEffect(() => setSearcherDraft(route.searcher), [route.searcher]);
  useEffect(() => setFirstDraft(route.first), [route.first]);
  useEffect(() => setEffortDraft(route.effort), [route.effort]);

  const choices = searcherChoices(rows, searcherDraft);
  const save = async (title: string, args: string[]) => {
    if (busy) return;
    setBusy(true);
    try {
      await onRun(title, args);
    } finally {
      setBusy(false);
    }
  };

  const firstHint = SEARCH_FIRST_OPTIONS.find((option) => option.value === firstDraft)?.hint ?? "";

  return (
    <details className="ui-disclosure mt-2">
      <summary className="cursor-pointer text-ui-md font-semibold">
        <ChevronIcon width={14} height={14} className="ui-disclosure-chevron" />
        网页搜索用谁（可选）
      </summary>
      <p className="ui-caption mt-1">
        模型自己搜不了网、你的来源和搜索 API 又都能搜时，这里决定先问谁；也可以直接点名一个会搜网的模型。
        下面「现在：…」是按你已经设好的值拼的，不是内核现算的。
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <label className="grid gap-1">
            <span className="ui-caption">搜网用谁</span>
            <select
              className="ui-input"
              aria-label="搜网用谁"
              value={searcherDraft}
              disabled={!cliReady || busy}
              onChange={(event) => {
                setSearcherDraft(event.target.value);
                void save("保存搜网模型", settingArgs("searcher", event.target.value));
              }}
            >
              <option value="">和鸣自己挑一个会搜网的模型</option>
              <option value={SEARCHER_OFF}>不叫模型去搜，只走搜索 API</option>
              {choices.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name && row.name !== row.id ? `${row.name}（${row.id}）` : row.id}
                </option>
              ))}
            </select>
          </label>
          <p className="ui-caption">挑一个真的会搜网的模型；挑错了它只会白回一句「我搜不到」。</p>
        </div>

        <div className="grid gap-1">
          <label className="grid gap-1">
            <span className="ui-caption">先问谁</span>
            <select
              className="ui-input"
              aria-label="先问谁"
              value={firstDraft}
              disabled={!cliReady || busy}
              onChange={(event) => {
                const next = event.target.value as SearchFirst;
                setFirstDraft(next);
                void save("保存搜索先后", settingArgs("searchFirst", next));
              }}
            >
              {SEARCH_FIRST_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p className="ui-caption">{firstHint}</p>
        </div>

        <div className="grid gap-1">
          <label className="grid gap-1">
            <span className="ui-caption">搜索时想多深</span>
            <select
              className="ui-input"
              aria-label="搜索时想多深"
              value={effortDraft}
              disabled={!cliReady || busy}
              onChange={(event) => {
                setEffortDraft(event.target.value);
                void save("保存搜索思考档", settingArgs("searcherEffort", event.target.value));
              }}
            >
              <option value="">用它自己的默认</option>
              {SEARCH_EFFORTS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <p className="ui-caption">档位越高搜得越细，也越慢越贵；不确定就留「用它自己的默认」。</p>
        </div>
      </div>
      <p className="ui-caption mt-2">
        现在：{describeSearchRoute({ searcher: searcherDraft, effort: effortDraft, first: firstDraft })}
      </p>
    </details>
  );
}
