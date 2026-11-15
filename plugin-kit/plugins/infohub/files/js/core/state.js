/**
 * 页面全局状态（唯一可变源）
 */

import { CONV_PAGE } from './constants.js';

export const state = {
  phase: "connecting", // connecting | ready | error
  errorText: "",
  errorHint: "",
  status: null,
  agenda: null,
  tab: "chats",
  busy: { agenda: false, rebuild: false, sync: false, status: false },
  syncNote: "",
  sync: { full: false, archive: false },
  chat: {
    keyword: "",
    convLimit: CONV_PAGE,
    items: [],
    total: 0,
    dbMissing: false,
    loading: false,
    seq: 0,
    selected: null,
    messages: [],
    hasMore: false,
    msgLoading: false,
    msgSeq: 0,
    messagesLoaded: false,
  },
  /* AI 日程识别：身份提示词、范围、来源、模型与可编辑结果（结果只存插件私有目录，不写回日程库） */
  ai: {
    loaded: false,
    profile: "",
    allowSend: false,
    days: 14,
    sources: { qq: true, wechat: true },
    gateway: null,
    models: [],
    model: "",
    error: "",
    note: "",
    running: false,
    stage: "",
    done: 0,
    total: 0,
    items: [],
    savedAt: 0,
    seq: 0,
    controller: null,
    prefTimer: 0,
    itemsTimer: 0,
  },
  autoTried: false,
};
