/**
 * 页签导航：只有会话与日程
 */

import { append, clear, el, h } from '../core/dom.js';
import { state } from '../core/state.js';
import { selectTab } from './shell.js';

const TABS = [
  ["chats", "会话"],
  ["agenda", "日程"],
];

export function renderTabs() {
  const node = el("tabs");
  if (!node) return;
  clear(node);
  if (state.phase !== "ready") {
    node.classList.add("hidden");
    return;
  }
  append(
    node,
    h(
      "div",
      { class: "segment-group" },
      TABS.map(([id, label]) =>
        h(
          "button",
          {
            class: "tab",
            type: "button",
            role: "tab",
            "aria-selected": String(state.tab === id),
            onclick: () => selectTab(id),
          },
          label,
        ),
      ),
    ),
  );
  node.classList.remove("hidden");
}
