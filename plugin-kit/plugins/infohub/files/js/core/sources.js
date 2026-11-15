/**
 * 采集来源识别（仅内部使用：不渲染来源清单与路径，界面上保持静默）
 */

import { state } from './state.js';

export function sourceDetected(status, source) {
  const config = (status && status.config) || {};
  if (source === "wechat") {
    const c = config.wechat || {};
    return Boolean(c.detected || c.db_dir || c.dbDir);
  }
  const c = config.qq || {};
  return Boolean(c.detected || c.nt_db || c.ntDb || c.export_dir || c.exportDir || c.export_detected || c.exportDetected);
}

export function detectedSources() {
  const status = state.status;
  if (!status) return [];
  const sources = [];
  if (sourceDetected(status, "qq")) sources.push("qq");
  if (sourceDetected(status, "wechat")) sources.push("wechat");
  return sources;
}
