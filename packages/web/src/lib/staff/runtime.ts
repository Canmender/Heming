import { isInfohubAvailable } from "../infohub/client.js";
import { useInfohubStore } from "../infohub/store.js";
import { useTaskStore } from "../tasks/store.js";
import {
  collectFacts,
  filterFactsBySources,
  type StaffFacts,
  type StaffSettings,
} from "./model.js";

/**
 * 幕僚采集接线（d.48）：唯一的「从各 store 取事实」入口。
 *
 * 议程只在桌面端且用户已连接 InfoHub 时读取——这里**绝不**调用 connect/start，
 * 拉起 Python 必须由用户自己点「连接」。
 */

export function liveFacts(settings: StaffSettings, now: number = Date.now()): StaffFacts {
  const hub = useInfohubStore.getState();
  const agenda = isInfohubAvailable() && hub.running ? (hub.agenda?.items ?? []) : [];
  const tasks = useTaskStore.getState().tasks;
  return filterFactsBySources(collectFacts({ agenda, tasks }, now), settings);
}

/** 已连接时刷新议程；返回是否真的发起了刷新（未连接返回 false）。 */
export async function refreshAgendaIfRunning(): Promise<boolean> {
  if (!isInfohubAvailable()) return false;
  const hub = useInfohubStore.getState();
  if (!hub.running) return false;
  await hub.loadAgenda();
  return true;
}
