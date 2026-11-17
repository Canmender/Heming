import { useEffect, useState } from "react";
import { Button } from "../ui/Button.js";
import { TextField } from "../ui/Field.js";
import { ChevronIcon } from "../icons.js";
import { canTestModel, type ModelRow } from "../../lib/modelCatalog.js";
import { IMAGE_SETTING_LABEL, settingArgs } from "../../lib/modelSettings.js";

/**
 * 「看图 / 画图模型」——原版 magpie Settings › Models 的 Images 一段。
 *
 * magpie 自己会说清楚这两项：能看图的模型替看不了图的模型描述图片，画图模型接下
 * `generate_image`。这里只摆这两项，值走 `magpie settings get|set|reset`。
 */
export function ImageModelSettings({
  rows,
  drawers,
  vision,
  visionEffort,
  imageGen,
  cliReady,
  onRun,
}: {
  rows: ModelRow[];
  /** 网关单独列出的画图模型（`kind: image`）；空 = 没有来源能画图，退回手填。 */
  drawers: { id: string; name: string }[];
  vision: string;
  /** 看图模型的思考档（`settings get visionEffort`）；空 = 用它自己的默认。 */
  visionEffort: string;
  imageGen: string;
  cliReady: boolean;
  onRun: (title: string, args: string[]) => Promise<boolean>;
}) {
  const [visionDraft, setVisionDraft] = useState(vision);
  const [effortDraft, setEffortDraft] = useState(visionEffort);
  const [drawDraft, setDrawDraft] = useState(imageGen);
  const [busy, setBusy] = useState(false);

  // 打开页面时先读到的是空值，`settings get` 回来后再把草稿对齐到现在的设置。
  useEffect(() => {
    setVisionDraft(vision);
  }, [vision]);
  useEffect(() => {
    setEffortDraft(visionEffort);
  }, [visionEffort]);
  useEffect(() => {
    setDrawDraft(imageGen);
  }, [imageGen]);

  const visionModels = rows.filter((row) => row.vision && canTestModel(row.id));
  // 现在指定的模型可能已经不在目录里：保留一个选项，不然一打开就被悄悄改掉。
  // 「off」是单独的一项，不从这里补。
  const naming = visionDraft !== "" && visionDraft !== "off";
  const visionOptions =
    visionModels.some((row) => row.id === visionDraft) || !naming
      ? visionModels
      : [{ id: visionDraft } as ModelRow, ...visionModels];
  // 思考档的选项来自所选取图模型自己的档位；现在设的值不在里面时也留一项，免得被悄悄改掉。
  const visionRow = visionModels.find((row) => row.id === visionDraft);
  const effortLevels = visionRow?.efforts ?? [];
  const effortOptions =
    effortDraft === "" || effortLevels.includes(effortDraft)
      ? effortLevels
      : [effortDraft, ...effortLevels];
  // 现在指定的画图模型也可能已经不在目录里：同样补一个选项，免得打开就被改掉。
  const drawerOptions =
    drawers.length === 0
      ? []
      : drawers.some((drawer) => drawer.id === drawDraft) || !drawDraft
        ? drawers
        : [{ id: drawDraft, name: "" }, ...drawers];

  const save = async (key: "vision" | "visionEffort" | "imageGen", value: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await onRun(`保存${IMAGE_SETTING_LABEL[key].title}`, settingArgs(key, value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="ui-disclosure ui-card p-4">
      <summary className="flex cursor-pointer items-center gap-1.5 ui-section-title">
        看图与画图模型
        <ChevronIcon width={12} height={12} className="ui-disclosure-chevron" />
      </summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <label className="grid gap-1">
            <span className="ui-caption">{IMAGE_SETTING_LABEL.vision.title}</span>
            <select
              className="ui-input"
              aria-label="看图模型"
              value={visionDraft}
              disabled={!cliReady || busy}
              onChange={(event) => {
                setVisionDraft(event.target.value);
                void save("vision", event.target.value);
              }}
            >
              <option value="">不指定（自动挑一个能看图的模型）</option>
              <option value="off">关掉（带图片的请求直接拒绝）</option>
              {visionOptions.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name && row.name !== row.id ? `${row.name}（${row.id}）` : row.id}
                </option>
              ))}
            </select>
          </label>
          <p className="ui-caption">{IMAGE_SETTING_LABEL.vision.hint}</p>
          <label className="grid gap-1">
            <span className="ui-caption">{IMAGE_SETTING_LABEL.visionEffort.title}</span>
            <select
              className="ui-input"
              aria-label="看图模型的思考档"
              value={effortDraft}
              disabled={!cliReady || busy}
              onChange={(event) => {
                setEffortDraft(event.target.value);
                void save("visionEffort", event.target.value);
              }}
            >
              <option value="">用它自己的默认</option>
              {effortOptions.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <p className="ui-caption">{IMAGE_SETTING_LABEL.visionEffort.hint}</p>
        </div>

        <div className="grid gap-1">
          {drawerOptions.length > 0 ? (
            <>
              <label className="grid gap-1">
                <span className="ui-caption">{IMAGE_SETTING_LABEL.imageGen.title}</span>
                <select
                  className="ui-input"
                  aria-label="画图模型"
                  value={drawDraft}
                  disabled={!cliReady || busy}
                  onChange={(event) => {
                    setDrawDraft(event.target.value);
                    void save("imageGen", event.target.value);
                  }}
                >
                  <option value="">不指定（关掉画图）</option>
                  {drawerOptions.map((drawer) => (
                    <option key={drawer.id} value={drawer.id}>
                      {drawer.name && drawer.name !== drawer.id ? `${drawer.name}（${drawer.id}）` : drawer.id}
                    </option>
                  ))}
                </select>
              </label>
              <p className="ui-caption">{IMAGE_SETTING_LABEL.imageGen.hint}</p>
            </>
          ) : (
            <>
              <TextField
                label={IMAGE_SETTING_LABEL.imageGen.title}
                placeholder="provider/model"
                hint={`${IMAGE_SETTING_LABEL.imageGen.hint} 网关现在没列出能画图的模型，可以手填。`}
                value={drawDraft}
                disabled={!cliReady || busy}
                onChange={(event) => setDrawDraft(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  disabled={!cliReady || busy || drawDraft.trim() === imageGen}
                  onClick={() => void save("imageGen", drawDraft)}
                >
                  保存画图模型
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!cliReady || busy || imageGen === ""}
                  onClick={() => {
                    setDrawDraft("");
                    void save("imageGen", "");
                  }}
                >
                  关掉
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </details>
  );
}
