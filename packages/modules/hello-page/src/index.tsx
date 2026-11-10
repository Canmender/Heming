/**
 * 模块包最小样例：验证「不打包 React、共享宿主 JSX 运行时」这条链路。
 * 真实模块（幕僚/自动化/…）按同一契约导出 pages / background / homeCards / settings。
 */

export const manifest = { id: "hello-page", version: "0.0.1" };

export function HelloPage() {
  return (
    <div className="p-4 text-[13px]">
      <div className="ui-section-title">Hello 模块包</div>
      <p className="mt-1 ui-caption">
        这段 UI 来自 <code className="rounded-sm bg-[var(--subtle-3)] px-1">packages/modules/hello-page</code>
        ，构建后由宿主从 entry.js 动态加载。
      </p>
    </div>
  );
}

export const pages = { hello: HelloPage };
