/**
 * 工作流引擎 · Web 编辑器（原生 JS，经典脚本，无构建）。
 *
 * 为什么一个文件：本插件要求「双击启动即用」，不能引入打包器；app.js 只依赖浏览器
 * 标准 API 与服务端 §4.5 REST，页面逻辑按「状态 → 渲染」组织，便于直接读懂与调试。
 *
 * 结构：
 *   1. WFAppUtils：纯函数与 API 客户端（挂 globalThis，供 src/ui/app.test.ts 在 Node 里测）；
 *   2. 状态与 API 实例；
 *   3. DOM 小工具（h/toast/modal/confirm）；
 *   4. 四个 Tab 的视图（工作流列表/编辑器/执行记录/凭据/设置）；
 *   5. 启动（健康检查、加载数据、绑定 Tab 与全局快捷键）。
 *
 * 画布由 canvas.js 提供 `window.WFCanvas`（另一个实现者负责），本文件只接线：
 * 画布回调改草稿，草稿变化再 setWorkflow 回去；运行状态用 setRunState 显示。
 */
(function () {
  "use strict";

  // =========================================================================
  // 1. 纯函数与 API 客户端（可测试，导出到 globalThis.WFAppUtils）
  // =========================================================================

  var NODE_GROUP_LABELS = {
    trigger: "触发器",
    action: "操作",
    transform: "数据处理",
    flow: "流程控制",
    ai: "智能",
    output: "输出",
  };

  var NODE_GROUP_ORDER = ["trigger", "action", "transform", "flow", "ai", "output"];

  /** 凭据类型：服务端 src/server/credentials.ts 的四类（前端内置，因为 REST 没有类型接口）。 */
  var CREDENTIAL_TYPES = [
    {
      type: "httpBasic",
      label: "HTTP 基本认证",
      description: "用户名 + 密码，放进 Authorization: Basic。",
      fields: [
        { name: "username", label: "用户名", secret: false, required: true },
        { name: "password", label: "密码", secret: true, required: true },
      ],
    },
    {
      type: "httpHeader",
      label: "请求头",
      description: "自定义请求头，例如 X-API-Key。",
      fields: [
        { name: "name", label: "请求头名", secret: false, required: true, placeholder: "X-API-Key" },
        { name: "value", label: "请求头值", secret: true, required: true },
      ],
    },
    {
      type: "httpQueryAuth",
      label: "查询参数",
      description: "把凭据拼进 URL 查询串，例如 ?api_key=…。",
      fields: [
        { name: "name", label: "参数名", secret: false, required: true, placeholder: "api_key" },
        { name: "value", label: "参数值", secret: true, required: true },
      ],
    },
    {
      type: "bearerToken",
      label: "Bearer Token",
      description: "放进 Authorization: Bearer <token>。",
      fields: [{ name: "token", label: "Token", secret: true, required: true }],
    },
  ];

  var STATUS_LABELS = {
    new: "新建",
    running: "运行中",
    success: "成功",
    error: "失败",
    canceled: "已取消",
    waiting: "等待中",
  };

  var STATUS_TONES = {
    new: "badge",
    running: "badge badge-run",
    success: "badge badge-ok",
    error: "badge badge-error",
    canceled: "badge",
    waiting: "badge badge-warn",
  };

  var MODE_LABELS = {
    manual: "手动",
    trigger: "定时",
    retry: "重试",
    subworkflow: "子流程",
    error: "错误处理",
    partial: "部分执行",
  };

  var ON_ERROR_OPTIONS = [
    { value: "stopWorkflow", label: "停止工作流（默认）" },
    { value: "continueRegularOutput", label: "继续，按正常输出透传" },
    { value: "continueErrorOutput", label: "继续，错误项走错误输出" },
  ];

  var EXPRESSION_VARIABLES = [
    { label: "当前字段", value: '{{ $json.field }}' },
    { label: "全部 items 数量", value: "{{ $items.length }}" },
    { label: "上游节点", value: '{{ $node["节点名"].json.field }}' },
    { label: "现在", value: '{{ $now.format("yyyy-MM-dd HH:mm:ss") }}' },
    { label: "今天", value: '{{ $today.format("yyyy-MM-dd") }}' },
    { label: "工作流名", value: "{{ $workflow.name }}" },
    { label: "全局变量", value: "{{ $vars.变量名 }}" },
  ];

  function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /** epoch 毫秒 → 本地「YYYY-MM-DD HH:mm:ss」。 */
  function formatTime(at) {
    if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return "—";
    var date = new Date(at);
    return (
      date.getFullYear() +
      "-" +
      pad2(date.getMonth() + 1) +
      "-" +
      pad2(date.getDate()) +
      " " +
      pad2(date.getHours()) +
      ":" +
      pad2(date.getMinutes()) +
      ":" +
      pad2(date.getSeconds())
    );
  }

  function formatDuration(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "不到 1 毫秒";
    if (ms < 1000) return Math.round(ms) + " 毫秒";
    var seconds = ms / 1000;
    if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)) + " 秒";
    var minutes = Math.floor(seconds / 60);
    var rest = Math.round(seconds % 60);
    return rest > 0 ? minutes + " 分 " + rest + " 秒" : minutes + " 分";
  }

  function formatBytes(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] || status || "未知";
  }

  function statusTone(status) {
    return STATUS_TONES[status] || "badge";
  }

  function modeLabel(mode) {
    return MODE_LABELS[mode] || mode || "未知";
  }

  function executionStatusFinished(status) {
    return status === "success" || status === "error" || status === "canceled";
  }

  /** 搜索过滤：名称/说明/标签/节点名都算，大小写不敏感。 */
  function filterWorkflows(workflows, keyword) {
    var text = String(keyword || "").trim().toLowerCase();
    if (!text) return workflows.slice();
    return workflows.filter(function (workflow) {
      var haystack = [
        workflow.name || "",
        workflow.description || "",
        (workflow.tags || []).join(" "),
        (workflow.nodeNames || []).join(" "),
      ]
        .join("\n")
        .toLowerCase();
      return haystack.indexOf(text) >= 0;
    });
  }

  /** 列表摘要的「节点/触发器」文案（服务端摘要字段直接给数）。 */
  function workflowCounts(summary) {
    var nodeCount = typeof summary.nodeCount === "number" ? summary.nodeCount : 0;
    var triggerCount = typeof summary.triggerCount === "number" ? summary.triggerCount : 0;
    var text = nodeCount + " 个节点";
    if (triggerCount > 0) text += " · " + triggerCount + " 个触发器";
    return text;
  }

  // ---------------- 节点参数与表单模型 ----------------

  /** displayOptions.show 有一个条件不满足就不显示（与引擎/旧前端同口径）。 */
  function isPropertyVisible(property, parameters) {
    var show = property.displayOptions && property.displayOptions.show;
    if (!show) return true;
    var params = parameters || {};
    for (var key in show) {
      if (!Object.prototype.hasOwnProperty.call(show, key)) continue;
      var allowed = show[key] || [];
      var current = params[key];
      var matched = false;
      for (var i = 0; i < allowed.length; i += 1) {
        if (String(allowed[i]) === String(current)) {
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }
    return true;
  }

  function isRequiredEmpty(value) {
    return value === undefined || value === null || value === "";
  }

  /**
   * 把节点描述与当前参数变成「可渲染字段模型」。
   * 纯函数：不碰 DOM，测试直接断言可见性/必填错误/取值。
   */
  function buildParameterFields(description, parameters) {
    var params = parameters || {};
    var properties = (description && description.properties) || [];
    var fields = [];
    for (var i = 0; i < properties.length; i += 1) {
      var property = properties[i];
      if (!isPropertyVisible(property, params)) continue;
      var value = params[property.name];
      if (property.default !== undefined && value === undefined) value = cloneJson(property.default);
      fields.push({
        name: property.name,
        displayName: property.displayName,
        type: property.type,
        description: property.description || "",
        placeholder: property.placeholder || "",
        options: property.options || [],
        rows: property.rows || (property.type === "code" ? 8 : 4),
        required: property.required === true,
        expression: property.expression !== false,
        value: value,
        error:
          property.required === true && property.type !== "notice" && isRequiredEmpty(value)
            ? "请填写" + property.displayName
            : "",
      });
    }
    return fields;
  }

  /** 必填校验：键是参数名，值是中文错误。 */
  function parameterErrors(description, parameters) {
    var errors = {};
    var fields = buildParameterFields(description, parameters);
    for (var i = 0; i < fields.length; i += 1) {
      if (fields[i].error) errors[fields[i].name] = fields[i].error;
    }
    return errors;
  }

  /** JSON 文本校验：空值合法；含表达式时跳过（表达式运行时才知道结果）。 */
  function validateJsonText(text) {
    if (typeof text !== "string" || text.trim() === "") return "";
    if (text.indexOf("{{") >= 0) return "";
    try {
      JSON.parse(text);
      return "";
    } catch (error) {
      return "JSON 格式有误：" + (error && error.message ? error.message : "无法解析");
    }
  }

  function parseJsonSafe(text) {
    if (typeof text !== "string" || text.trim() === "") return { ok: true, value: undefined, error: "" };
    try {
      return { ok: true, value: JSON.parse(text), error: "" };
    } catch (error) {
      return { ok: false, value: undefined, error: error && error.message ? error.message : "无法解析" };
    }
  }

  // ---------------- 表达式提示 ----------------

  function hasExpression(value) {
    return typeof value === "string" && /\{\{[\s\S]+?\}\}/.test(value);
  }

  function extractExpressions(value) {
    var found = [];
    if (typeof value !== "string") return found;
    var pattern = /\{\{([\s\S]+?)\}\}/g;
    var match;
    while ((match = pattern.exec(value)) !== null) {
      var body = (match[1] || "").trim();
      if (body && found.indexOf(body) < 0) found.push(body);
      if (found.length >= 6) break;
    }
    return found;
  }

  function isSingleExpression(value) {
    if (typeof value !== "string") return false;
    var trimmed = value.trim();
    if (trimmed.indexOf("{{") !== 0 || trimmed.lastIndexOf("}}") !== trimmed.length - 2) return false;
    return trimmed.slice(2, -2).indexOf("}}") < 0;
  }

  /** 表达式少了右括号：提示用户补全，而不是运行到一半才报语法错。 */
  function hasUnclosedExpression(value) {
    if (typeof value !== "string") return false;
    var opens = (value.match(/\{\{/g) || []).length;
    var closes = (value.match(/\}\}/g) || []).length;
    return opens > closes;
  }

  // ---------------- 节点与调色板 ----------------

  function uniqueNodeName(nodes, base) {
    var trimmed = String(base || "节点").trim() || "节点";
    var used = {};
    for (var i = 0; i < nodes.length; i += 1) used[nodes[i].name] = true;
    if (!used[trimmed]) return trimmed;
    var n = 2;
    while (n < 1000) {
      var candidate = trimmed + " " + n;
      if (!used[candidate]) return candidate;
      n += 1;
    }
    return trimmed + " " + Date.now();
  }

  function defaultParametersOf(description) {
    var parameters = {};
    var properties = (description && description.properties) || [];
    for (var i = 0; i < properties.length; i += 1) {
      if (properties[i].default !== undefined) {
        parameters[properties[i].name] = cloneJson(properties[i].default);
      }
    }
    return parameters;
  }

  function randomId(prefix) {
    var tail;
    if (typeof crypto !== "undefined" && crypto && typeof crypto.randomUUID === "function") {
      tail = crypto.randomUUID().slice(0, 8);
    } else {
      tail = Math.random().toString(36).slice(2, 10);
    }
    return prefix + "-" + Date.now().toString(36) + "-" + tail;
  }

  /** 按节点描述创建一个新节点（默认参数、唯一名字、画布坐标）。 */
  function createNodeFromType(description, workflow, position) {
    var nodes = (workflow && workflow.nodes) || [];
    return {
      id: randomId("node"),
      name: uniqueNodeName(nodes, description.defaultName || description.displayName || description.type),
      type: description.type,
      position: { x: position && position.x ? position.x : 200, y: position && position.y ? position.y : 180 },
      parameters: defaultParametersOf(description),
    };
  }

  function findNodeType(nodeTypes, type) {
    for (var i = 0; i < nodeTypes.length; i += 1) {
      if (nodeTypes[i].type === type) return nodeTypes[i];
    }
    return null;
  }

  /** 调色板分组：固定顺序，未知分组归到「操作」。 */
  function groupNodeTypes(nodeTypes) {
    var groups = {};
    for (var i = 0; i < nodeTypes.length; i += 1) {
      var type = nodeTypes[i];
      var group = NODE_GROUP_LABELS[type.group] ? type.group : "action";
      if (!groups[group]) groups[group] = [];
      groups[group].push(type);
    }
    var result = [];
    for (var g = 0; g < NODE_GROUP_ORDER.length; g += 1) {
      var key = NODE_GROUP_ORDER[g];
      if (groups[key] && groups[key].length > 0) {
        result.push({ group: key, label: NODE_GROUP_LABELS[key], types: groups[key] });
      }
    }
    return result;
  }

  // ---------------- 执行数据 ----------------

  function latestRunOf(execution, nodeId) {
    if (!execution || !execution.runData) return null;
    var runs = execution.runData[nodeId];
    if (!Array.isArray(runs) || runs.length === 0) return null;
    return runs[runs.length - 1];
  }

  /** 引擎事件/REST 没有「当前节点」，只能从 runData 推：跑完的最新生效。 */
  function buildRunState(execution) {
    var map = {};
    if (!execution || !execution.runData) return map;
    for (var nodeId in execution.runData) {
      if (!Object.prototype.hasOwnProperty.call(execution.runData, nodeId)) continue;
      var latest = latestRunOf(execution, nodeId);
      if (!latest) continue;
      var state = "success";
      if (latest.status === "error") state = "error";
      else if (latest.status === "waiting") state = "running";
      map[nodeId] = { state: state, itemCount: latest.itemsTotal || 0 };
    }
    return map;
  }

  function flattenOutputs(run) {
    var items = [];
    if (!run || !run.data || !Array.isArray(run.data.main)) return items;
    for (var i = 0; i < run.data.main.length; i += 1) {
      var list = run.data.main[i];
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j += 1) items.push(list[j]);
    }
    return items;
  }

  function collectNodeOutputItems(execution, nodeId) {
    return flattenOutputs(latestRunOf(execution, nodeId));
  }

  /** 某一次节点运行的输入：按 run.source 找上游节点最近一次输出（调试够用）。 */
  function collectRunInputItems(execution, run) {
    var items = [];
    if (!run || !Array.isArray(run.source)) return items;
    for (var i = 0; i < run.source.length; i += 1) {
      var source = run.source[i];
      if (!source || !source.previousNode) continue;
      var upstream = latestRunOf(execution, source.previousNode);
      items = items.concat(flattenOutputs(upstream));
    }
    return items;
  }

  /** 节点最近一次运行的输入。 */
  function collectNodeInputItems(execution, nodeId) {
    return collectRunInputItems(execution, latestRunOf(execution, nodeId));
  }

  /** 执行详情里「逐节点」的展示模型（节点名来自工作流，找不到时退回 id）。 */
  function executionNodeSummaries(execution, workflow) {
    var nodes = (workflow && workflow.nodes) || [];
    var byId = {};
    for (var i = 0; i < nodes.length; i += 1) byId[nodes[i].id] = nodes[i];
    var summaries = [];
    if (!execution || !execution.runData) return summaries;
    for (var nodeId in execution.runData) {
      if (!Object.prototype.hasOwnProperty.call(execution.runData, nodeId)) continue;
      var runs = execution.runData[nodeId] || [];
      var node = byId[nodeId];
      summaries.push({
        nodeId: nodeId,
        name: node ? node.name : nodeId,
        type: node ? node.type : "未知类型",
        runs: runs,
      });
    }
    return summaries;
  }

  // ---------------- 凭据与设置 ----------------

  function credentialTypeSpec(type) {
    for (var i = 0; i < CREDENTIAL_TYPES.length; i += 1) {
      if (CREDENTIAL_TYPES[i].type === type) return CREDENTIAL_TYPES[i];
    }
    return null;
  }

  function credentialTypeLabel(type) {
    var spec = credentialTypeSpec(type);
    return spec ? spec.label : type;
  }

  /** 新建凭据表单模型：字段 + 必填/密文标记。 */
  function buildCredentialFields(type) {
    var spec = credentialTypeSpec(type);
    if (!spec) return [];
    return spec.fields.map(function (field) {
      return {
        name: field.name,
        label: field.label,
        secret: field.secret === true,
        required: field.required === true,
        placeholder: field.placeholder || "",
      };
    });
  }

  /** 校验凭据表单；返回中文错误或空串。 */
  function validateCredentialForm(fields, values) {
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      var value = values[field.name];
      if (field.required && (value === undefined || value === null || String(value).trim() === "")) {
        return "请填写" + field.label;
      }
    }
    return "";
  }

  function parseVarsText(text) {
    var parsed = parseJsonSafe(text);
    if (!parsed.ok) return { ok: false, error: "全局变量必须是合法 JSON：" + parsed.error, value: {} };
    if (parsed.value === undefined || parsed.value === null) return { ok: true, error: "", value: {} };
    if (!isPlainObject(parsed.value)) return { ok: false, error: "全局变量必须是一个 JSON 对象", value: {} };
    return { ok: true, error: "", value: parsed.value };
  }

  /** 设置表单 → PUT /api/settings 的载荷：空 apiKey 表示「保持不变」。 */
  function buildSettingsPayload(form, previous) {
    var payload = { vars: form.vars || {} };
    var baseUrl = String(form.baseUrl || "").trim();
    var model = String(form.model || "").trim();
    var apiKey = String(form.apiKey || "").trim();
    var hasLlm = baseUrl || model || apiKey || (previous && previous.configured);
    if (hasLlm) {
      var llm = { baseUrl: baseUrl, model: model };
      if (apiKey || (previous && previous.configured && !apiKey)) {
        // 留空的 apiKey 不传，服务端保留旧值（契约：PUT 的 llm.apiKey 可选）
        if (apiKey) llm.apiKey = apiKey;
      }
      payload.llm = llm;
    }
    return payload;
  }

  // ---------------- 预览与历史 ----------------

  /** JSON 预览文本；超过 maxChars 截断并明确告诉用户。 */
  function truncateJson(value, maxChars) {
    var limit = typeof maxChars === "number" ? maxChars : 20000;
    var text;
    try {
      text = JSON.stringify(value, null, 2);
    } catch (error) {
      text = String(value);
    }
    if (text === undefined) text = "undefined";
    if (text.length <= limit) return { text: text, truncated: false };
    return {
      text: text.slice(0, limit) + "\n…（已截断，共 " + text.length + " 字符）",
      truncated: true,
    };
  }

  /** 撤销/重做栈：editor 用它，测试也直接测行为。 */
  function createHistory(initial, clone) {
    var copy = clone || cloneJson;
    var past = [];
    var future = [];
    var current = copy(initial);
    return {
      get: function () {
        return current;
      },
      push: function (next) {
        past.push(copy(current));
        if (past.length > 50) past.shift();
        current = copy(next);
        future = [];
      },
      undo: function () {
        if (past.length === 0) return false;
        future.unshift(copy(current));
        current = past.pop();
        return true;
      },
      redo: function () {
        if (future.length === 0) return false;
        past.push(copy(current));
        current = future.shift();
        return true;
      },
      canUndo: function () {
        return past.length > 0;
      },
      canRedo: function () {
        return future.length > 0;
      },
    };
  }

  // ---------------- API 客户端 ----------------

  function buildQueryString(query) {
    if (!query) return "";
    var parts = [];
    for (var key in query) {
      if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
      var value = query[key];
      if (value === undefined || value === null || value === "") continue;
      parts.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(value)));
    }
    return parts.length > 0 ? "?" + parts.join("&") : "";
  }

  /**
   * REST 客户端。fetchImpl 注入是为了在 Node 测试里 mock；
   * 错误统一抛 Error（中文），UI 只需 toast(error.message)。
   */
  function createApi(fetchImpl, baseUrl) {
    var base = baseUrl || "";
    var doFetch = fetchImpl;

    function request(path, options) {
      var opts = options || {};
      var method = opts.method || "GET";
      var init = { method: method, headers: {} };
      if (opts.body !== undefined) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
      var url = base + path + buildQueryString(opts.query);
      return Promise.resolve()
        .then(function () {
          return doFetch(url, init);
        })
        .then(function (response) {
          var readText =
            response && typeof response.text === "function"
              ? response.text()
              : Promise.resolve("");
          return readText.then(function (text) {
            var payload = null;
            if (text) {
              try {
                payload = JSON.parse(text);
              } catch (error) {
                payload = text;
              }
            }
            if (!response || response.ok === false) {
              var status = response && response.status ? response.status : 0;
              var message =
                payload && typeof payload === "object" && payload.error
                  ? String(payload.error)
                  : "请求失败（HTTP " + status + "）";
              var failure = new Error(message);
              failure.status = status;
              failure.payload = payload;
              throw failure;
            }
            if (payload && typeof payload === "object" && payload.ok === false) {
              throw new Error(payload.error ? String(payload.error) : "请求失败");
            }
            return payload;
          });
        });
    }

    function idPath(id) {
      return "/api/workflows/" + encodeURIComponent(id);
    }

    return {
      request: request,
      health: function () {
        return request("/api/health");
      },
      nodeTypes: function () {
        return request("/api/node-types");
      },
      templates: function () {
        return request("/api/templates");
      },
      listWorkflows: function () {
        return request("/api/workflows");
      },
      getWorkflow: function (id) {
        return request(idPath(id));
      },
      createWorkflow: function (input) {
        return request("/api/workflows", { method: "POST", body: input || {} });
      },
      saveWorkflow: function (id, workflow) {
        return request(idPath(id), { method: "PUT", body: workflow });
      },
      deleteWorkflow: function (id) {
        return request(idPath(id), { method: "DELETE" });
      },
      setActive: function (id, active) {
        return request(idPath(id) + "/active", { method: "POST", body: { active: !!active } });
      },
      duplicateWorkflow: function (id) {
        return request(idPath(id) + "/duplicate", { method: "POST" });
      },
      exportWorkflow: function (id) {
        return request(idPath(id) + "/export");
      },
      importWorkflow: function (json) {
        return request("/api/workflows/import", { method: "POST", body: { json: json } });
      },
      runWorkflow: function (id, options) {
        return request(idPath(id) + "/run", {
          method: "POST",
          body: options || {},
        });
      },
      stopWorkflow: function (id) {
        return request(idPath(id) + "/stop", { method: "POST" });
      },
      listExecutions: function (query) {
        return request("/api/executions", { query: query || {} });
      },
      getExecution: function (id) {
        return request("/api/executions/" + encodeURIComponent(id));
      },
      deleteExecution: function (id) {
        return request("/api/executions/" + encodeURIComponent(id), { method: "DELETE" });
      },
      retryExecution: function (id) {
        return request("/api/executions/" + encodeURIComponent(id) + "/retry", { method: "POST" });
      },
      listCredentials: function () {
        return request("/api/credentials");
      },
      createCredential: function (input) {
        return request("/api/credentials", { method: "POST", body: input });
      },
      updateCredential: function (id, patch) {
        return request("/api/credentials/" + encodeURIComponent(id), { method: "PUT", body: patch });
      },
      deleteCredential: function (id) {
        return request("/api/credentials/" + encodeURIComponent(id), { method: "DELETE" });
      },
      getSettings: function () {
        return request("/api/settings");
      },
      saveSettings: function (patch) {
        return request("/api/settings", { method: "PUT", body: patch });
      },
    };
  }

  var WFAppUtils = {
    NODE_GROUP_LABELS: NODE_GROUP_LABELS,
    NODE_GROUP_ORDER: NODE_GROUP_ORDER,
    CREDENTIAL_TYPES: CREDENTIAL_TYPES,
    STATUS_LABELS: STATUS_LABELS,
    MODE_LABELS: MODE_LABELS,
    ON_ERROR_OPTIONS: ON_ERROR_OPTIONS,
    EXPRESSION_VARIABLES: EXPRESSION_VARIABLES,
    createApi: createApi,
    isPlainObject: isPlainObject,
    cloneJson: cloneJson,
    formatTime: formatTime,
    formatDuration: formatDuration,
    formatBytes: formatBytes,
    statusLabel: statusLabel,
    statusTone: statusTone,
    modeLabel: modeLabel,
    executionStatusFinished: executionStatusFinished,
    filterWorkflows: filterWorkflows,
    workflowCounts: workflowCounts,
    isPropertyVisible: isPropertyVisible,
    buildParameterFields: buildParameterFields,
    parameterErrors: parameterErrors,
    validateJsonText: validateJsonText,
    parseJsonSafe: parseJsonSafe,
    hasExpression: hasExpression,
    extractExpressions: extractExpressions,
    isSingleExpression: isSingleExpression,
    hasUnclosedExpression: hasUnclosedExpression,
    uniqueNodeName: uniqueNodeName,
    defaultParametersOf: defaultParametersOf,
    createNodeFromType: createNodeFromType,
    findNodeType: findNodeType,
    groupNodeTypes: groupNodeTypes,
    latestRunOf: latestRunOf,
    buildRunState: buildRunState,
    collectNodeOutputItems: collectNodeOutputItems,
    collectRunInputItems: collectRunInputItems,
    collectNodeInputItems: collectNodeInputItems,
    executionNodeSummaries: executionNodeSummaries,
    credentialTypeSpec: credentialTypeSpec,
    credentialTypeLabel: credentialTypeLabel,
    buildCredentialFields: buildCredentialFields,
    validateCredentialForm: validateCredentialForm,
    parseVarsText: parseVarsText,
    buildSettingsPayload: buildSettingsPayload,
    truncateJson: truncateJson,
    createHistory: createHistory,
  };

  // Node 测试只取工具函数：没有 document 就不启动 UI。
  globalThis.WFAppUtils = WFAppUtils;
  if (typeof document === "undefined") return;

  // =========================================================================
  // 2. 状态
  // =========================================================================

  var state = {
    tab: "workflows",
    health: null,
    workflows: [],
    templates: [],
    nodeTypes: [],
    executions: [],
    executionDetail: null,
    executionWorkflow: null,
    selectedExecutionId: null,
    credentials: [],
    settings: null,
    workflowSearch: "",
    listError: "",
    edit: null,
    listHost: null,
    detailHost: null,
    loading: false,
  };

  var dom = {
    app: null,
    modalRoot: null,
    toastRoot: null,
    healthBadge: null,
  };

  var api = null;
  var modalStack = [];
  var currentToastTimer = null;

  // =========================================================================
  // 3. DOM 小工具
  // =========================================================================

  function h(tag, attrs) {
    var element = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        var value = attrs[key];
        if (value === undefined || value === null || value === false) continue;
        if (key === "class") element.className = value;
        else if (key === "text") element.textContent = String(value);
        else if (key === "dataset") {
          for (var dataKey in value) element.dataset[dataKey] = String(value[dataKey]);
        } else if (key === "style" && typeof value === "object") {
          for (var styleKey in value) element.style[styleKey] = value[styleKey];
        } else if (key.indexOf("on") === 0 && typeof value === "function") {
          element.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (
          key === "value" ||
          key === "checked" ||
          key === "disabled" ||
          key === "title" ||
          key === "placeholder" ||
          key === "type" ||
          key === "rows" ||
          key === "min" ||
          key === "max" ||
          key === "step" ||
          key === "readOnly" ||
          key === "name" ||
          key === "id" ||
          key === "htmlFor"
        ) {
          try {
            element[key] = value;
          } catch (error) {
            element.setAttribute(key, String(value));
          }
        } else {
          element.setAttribute(key, value === true ? "" : String(value));
        }
      }
    }
    var children = Array.prototype.slice.call(arguments, 2);
    appendChildren(element, children);
    return element;
  }

  function appendChildren(parent, children) {
    for (var i = 0; i < children.length; i += 1) {
      var child = children[i];
      if (child === undefined || child === null || child === false) continue;
      if (Array.isArray(child)) {
        appendChildren(parent, child);
      } else if (child instanceof Node) {
        parent.appendChild(child);
      } else {
        parent.appendChild(document.createTextNode(String(child)));
      }
    }
  }

  function clear(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function button(label, className, onClick, disabled) {
    return h(
      "button",
      {
        type: "button",
        class: className || "btn",
        disabled: disabled === true,
        onclick: onClick,
      },
      label,
    );
  }

  function toast(message, isError) {
    if (!dom.toastRoot) return;
    var node = h("div", { class: isError ? "toast error" : "toast", role: "status" }, message);
    dom.toastRoot.appendChild(node);
    if (currentToastTimer) clearTimeout(currentToastTimer);
    var timer = setTimeout(function () {
      node.remove();
    }, isError ? 6000 : 3500);
    currentToastTimer = timer;
  }

  function openModal(options) {
    var opts = options || {};
    var overlay = h("div", { class: "modal-overlay" });
    var modal = h("div", {
      class: opts.wide ? "modal wide" : "modal",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": opts.title || "对话框",
    });
    var head = h(
      "div",
      { class: "modal-head" },
      h("h2", { class: "modal-title", text: opts.title || "" }),
      h("button", {
        type: "button",
        class: "close-btn",
        "aria-label": "关闭",
        text: "×",
      }),
    );
    var body = h("div", { class: "modal-body" });
    var foot = h("div", { class: "modal-foot" });
    var handle = {
      close: close,
      modal: modal,
      body: body,
      footer: foot,
      overlay: overlay,
    };
    function close() {
      var index = modalStack.indexOf(handle);
      if (index >= 0) modalStack.splice(index, 1);
      overlay.remove();
      if (typeof opts.onClose === "function") opts.onClose();
    }
    head.lastChild.addEventListener("click", close);
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close();
    });
    modal.appendChild(head);
    modal.appendChild(body);
    modal.appendChild(foot);
    overlay.appendChild(modal);
    modalStack.push(handle);
    dom.modalRoot.appendChild(overlay);
    setTimeout(function () {
      var focusable = modal.querySelector("input, select, textarea, button");
      if (focusable) focusable.focus();
    }, 0);
    return handle;
  }

  function confirmDialog(options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(value);
      }
      var modal = openModal({
        title: opts.title || "确认",
        onClose: function () {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        },
      });
      modal.body.appendChild(
        h("p", { text: opts.message || "确定执行这个操作吗？", style: { margin: "0" } }),
      );
      modal.footer.appendChild(
        button("取消", "btn", function () {
          finish(false);
        }),
      );
      modal.footer.appendChild(
        button(opts.confirmText || "确认", opts.danger ? "btn btn-danger" : "btn btn-primary", function () {
          finish(true);
        }),
      );
    });
  }

  function closeTopModal() {
    if (modalStack.length === 0) return false;
    modalStack[modalStack.length - 1].close();
    return true;
  }

  // =========================================================================
  // 4. 工作流列表
  // =========================================================================

  function setTab(tab) {
    state.tab = tab;
    if (state.edit && tab !== "workflows") {
      stopEditorPolling();
      state.edit = null;
    }
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i += 1) {
      tabs[i].setAttribute("aria-selected", tabs[i].dataset.tab === tab ? "true" : "false");
    }
    render();
    if (tab === "executions") void loadExecutions();
    else if (tab === "credentials") void loadCredentials();
    else if (tab === "settings") void loadSettings();
  }

  function render() {
    if (!dom.app) return;
    clear(dom.app);
    dom.app.classList.toggle("wide", Boolean(state.edit));
    if (state.edit) {
      renderEditor(dom.app);
      return;
    }
    if (state.tab === "workflows") renderWorkflowList(dom.app);
    else if (state.tab === "executions") renderExecutions(dom.app);
    else if (state.tab === "credentials") renderCredentials(dom.app);
    else renderSettings(dom.app);
  }

  function renderWorkflowList(root) {
    var toolbar = h("div", { class: "toolbar" });
    var searchInput = h("input", {
      class: "input",
      type: "search",
      placeholder: "搜索名称、说明或标签",
      "aria-label": "搜索工作流",
      value: state.workflowSearch,
      oninput: function (event) {
        state.workflowSearch = event.target.value;
        renderCards(cardsHost);
      },
    });
    toolbar.appendChild(h("div", { class: "search" }, searchInput));
    toolbar.appendChild(
      button("新建工作流", "btn btn-primary", function () {
        openTemplateModal();
      }),
    );
    toolbar.appendChild(
      button("导入", "btn", function () {
        openImportModal();
      }),
    );
    toolbar.appendChild(
      button("刷新", "btn btn-ghost", function () {
        void loadWorkflows();
      }),
    );
    root.appendChild(toolbar);

    if (state.listError) {
      root.appendChild(h("div", { class: "alert alert-error", text: state.listError }));
    }

    var cardsHost = h("div");
    root.appendChild(cardsHost);
    renderCards(cardsHost);
  }

  function renderCards(host) {
    clear(host);
    if (state.loading && state.workflows.length === 0) {
      host.appendChild(h("div", { class: "empty", text: "正在加载工作流…" }));
      return;
    }
    if (state.workflows.length === 0) {
      host.appendChild(
        h(
          "div",
          { class: "empty" },
          h("p", { class: "empty-title", text: "还没有工作流" }),
          h("p", {
            class: "empty-desc",
            text: "从空白画布开始，或选一个起手模板：手动/定时触发、HTTP 请求、代码与分支都能直接拖。",
          }),
          button("新建工作流", "btn btn-primary", function () {
            openTemplateModal();
          }),
        ),
      );
      return;
    }
    var filtered = filterWorkflows(state.workflows, state.workflowSearch);
    if (filtered.length === 0) {
      host.appendChild(
        h(
          "div",
          { class: "empty" },
          h("p", { class: "empty-title", text: "没有匹配的工作流" }),
          h("p", { class: "empty-desc", text: "换个关键词试试，或清空搜索。" }),
        ),
      );
      return;
    }
    var grid = h("div", { class: "workflow-grid" });
    for (var i = 0; i < filtered.length; i += 1) {
      grid.appendChild(renderWorkflowCard(filtered[i]));
    }
    host.appendChild(grid);
  }

  function renderWorkflowCard(summary) {
    var card = h("div", { class: "card workflow-card" });
    var head = h("div", { class: "workflow-card-head" });
    var titleWrap = h("div", { class: "grow" });
    titleWrap.appendChild(
      h("button", {
        type: "button",
        class: "workflow-name",
        text: summary.name || "未命名工作流",
        title: summary.name || "",
        onclick: function () {
          void openEditor(summary.id);
        },
      }),
    );
    titleWrap.appendChild(
      h("div", { class: "workflow-meta" }, h("span", { text: workflowCounts(summary) })),
    );
    head.appendChild(titleWrap);

    var activeSwitch = h("button", {
      type: "button",
      class: "switch",
      role: "switch",
      "aria-checked": summary.active ? "true" : "false",
      "aria-label": "启用工作流 " + (summary.name || ""),
      onclick: function () {
        var next = !summary.active;
        api.setActive(summary.id, next).then(
          function () {
            summary.active = next;
            activeSwitch.setAttribute("aria-checked", next ? "true" : "false");
            toast(next ? "已启用；定时触发会在后台执行。" : "已停用。");
            void loadWorkflows();
          },
          function (error) {
            toast(error.message, true);
          },
        );
      },
    });
    head.appendChild(activeSwitch);
    card.appendChild(head);

    var meta = h("div", { class: "workflow-meta" });
    meta.appendChild(h("span", { text: "更新于 " + formatTime(summary.updatedAt) }));
    if (summary.lastRunAt) meta.appendChild(h("span", { text: "上次运行 " + formatTime(summary.lastRunAt) }));
    if (summary.lastStatus) {
      meta.appendChild(
        h("span", { class: statusTone(summary.lastStatus), text: statusLabel(summary.lastStatus) }),
      );
    } else {
      meta.appendChild(h("span", { class: "badge", text: "尚未运行" }));
    }
    if (summary.active) {
      meta.appendChild(h("span", { class: "caption", text: "已启用（定时触发）" }));
    }
    card.appendChild(meta);

    var actions = h("div", { class: "workflow-actions" });
    actions.appendChild(
      button("编辑", "btn btn-sm", function () {
        void openEditor(summary.id);
      }),
    );
    actions.appendChild(
      button("复制", "btn btn-sm", function () {
        api.duplicateWorkflow(summary.id).then(
          function (workflow) {
            toast("已复制为「" + workflow.name + "」");
            void loadWorkflows();
          },
          function (error) {
            toast(error.message, true);
          },
        );
      }),
    );
    actions.appendChild(
      button("导出", "btn btn-sm", function () {
        api.exportWorkflow(summary.id).then(
          function (exported) {
            openExportModal(summary.name, exported);
          },
          function (error) {
            toast(error.message, true);
          },
        );
      }),
    );
    actions.appendChild(
      button("删除", "btn btn-sm btn-danger", function () {
        confirmDialog({
          title: "删除工作流",
          message:
            "确定删除工作流「" +
            (summary.name || "") +
            "」吗？它的执行记录也会一并删除，且无法恢复。建议先导出备份。",
          confirmText: "删除",
          danger: true,
        }).then(function (confirmed) {
          if (!confirmed) return;
          api.deleteWorkflow(summary.id).then(
            function () {
              toast("已删除");
              void loadWorkflows();
            },
            function (error) {
              toast(error.message, true);
            },
          );
        });
      }),
    );
    card.appendChild(actions);
    return card;
  }

  function openTemplateModal() {
    var modal = openModal({ title: "新建工作流" });
    modal.body.appendChild(
      h(
        "button",
        {
          type: "button",
          class: "template-item",
          onclick: function () {
            modal.close();
            void createWorkflow({});
          },
        },
        h("span", { class: "template-name", text: "空白工作流" }),
        h("span", { class: "caption", text: "从空画布开始，自己拖节点、连线。" }),
      ),
    );
    if (state.templates.length === 0) {
      modal.body.appendChild(h("p", { class: "caption", text: "正在加载模板…" }));
      api.templates().then(function (templates) {
        state.templates = Array.isArray(templates) ? templates : [];
        modal.body.querySelector("p.caption") &&
          modal.body.querySelector("p.caption").remove();
        appendTemplates(modal);
      });
    } else {
      appendTemplates(modal);
    }
    modal.footer.appendChild(
      button("取消", "btn", function () {
        modal.close();
      }),
    );
  }

  function appendTemplates(modal) {
    if (!state.templates.length) return;
    modal.body.appendChild(h("p", { class: "palette-group-title", text: "起手模板" }));
    var list = h("div", { class: "template-list" });
    for (var i = 0; i < state.templates.length; i += 1) {
      var template = state.templates[i];
      list.appendChild(
        h(
          "button",
          {
            type: "button",
            class: "template-item",
            onclick: (function (item) {
              return function () {
                modal.close();
                void createWorkflow({ fromTemplateId: item.id });
              };
            })(template),
          },
          h("span", { class: "template-name", text: template.name }),
          h("span", { class: "caption", text: template.description || "" }),
        ),
      );
    }
    modal.body.appendChild(list);
  }

  function openImportModal() {
    var modal = openModal({ title: "导入工作流", wide: true });
    var parsedJson = null;
    var textarea = h("textarea", {
      class: "textarea",
      rows: 12,
      placeholder: "粘贴本插件或 n8n 导出的工作流 JSON",
      "aria-label": "工作流 JSON",
    });
    var fileInput = h("input", {
      type: "file",
      accept: ".json,application/json",
      onchange: function (event) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;
        file.text().then(function (text) {
          textarea.value = text;
          parsedJson = null;
        });
      },
    });
    var notice = h("div");
    modal.body.appendChild(h("p", { class: "caption", text: "支持本插件导出的 JSON 和 n8n 工作流 JSON；不认识的节点类型会被跳过并列出。" }));
    modal.body.appendChild(fileInput);
    modal.body.appendChild(h("div", { style: { height: "10px" } }));
    modal.body.appendChild(textarea);
    modal.body.appendChild(notice);
    modal.footer.appendChild(
      button("取消", "btn", function () {
        modal.close();
      }),
    );
    modal.footer.appendChild(
      button(
        "导入",
        "btn btn-primary",
        function () {
          var text = textarea.value.trim();
          if (!text) {
            toast("请先粘贴 JSON 或选择文件", true);
            return;
          }
          var parsed = parseJsonSafe(text);
          if (!parsed.ok) {
            toast("不是合法的 JSON：" + parsed.error, true);
            return;
          }
          parsedJson = parsed.value;
          api.importWorkflow(parsedJson).then(
            function (result) {
              clear(notice);
              if (result && result.warnings && result.warnings.length > 0) {
                notice.appendChild(
                  h(
                    "div",
                    { class: "alert alert-warn" },
                    h("div", { text: "已导入，但跳过了部分内容：" }),
                    h("ul", { style: { margin: "4px 0 0", paddingLeft: "18px" } }, (result.warnings || []).map(function (warning) {
                      return h("li", { text: warning });
                    })),
                  ),
                );
              }
              toast("已导入「" + (result.workflow ? result.workflow.name : "工作流") + "」");
              modal.close();
              void loadWorkflows();
            },
            function (error) {
              toast(error.message, true);
            },
          );
        },
        false,
      ),
    );
  }

  function openExportModal(name, exported) {
    var modal = openModal({ title: "导出工作流： " + (name || ""), wide: true });
    var preview = truncateJson(exported, 200000);
    var textarea = h("textarea", {
      class: "textarea",
      rows: 16,
      readOnly: true,
      "aria-label": "导出的工作流 JSON",
    });
    textarea.value = preview.text;
    modal.body.appendChild(
      h("p", {
        class: "caption",
        text: "导出的是类 n8n 的 JSON（连接按节点名）。凭据只带 id 引用，不含密码/令牌。",
      }),
    );
    modal.body.appendChild(textarea);
    modal.footer.appendChild(
      button("复制 JSON", "btn", function () {
        copyText(preview.text).then(function (ok) {
          toast(ok ? "已复制" : "复制失败，请手动选择文本", !ok);
        });
      }),
    );
    modal.footer.appendChild(
      button("下载 JSON", "btn btn-primary", function () {
        downloadJson((name || "工作流") + ".json", preview.text);
      }),
    );
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return false;
        },
      );
    }
    return Promise.resolve(false);
  }

  function downloadJson(filename, text) {
    try {
      var blob = new Blob([text], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename.replace(/[\\/:*?"<>|]/g, "_");
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (error) {
      toast("下载失败：" + error.message, true);
    }
  }

  // =========================================================================
  // 5. 编辑器
  // =========================================================================

  async function openEditor(workflowId) {
    try {
      stopEditorPolling();
      await ensureNodeTypes();
      var workflow = await api.getWorkflow(workflowId);
      state.edit = {
        workflow: workflow,
        baseline: cloneJson(workflow),
        selectedIds: [],
        openNodeId: null,
        past: [],
        future: [],
        execution: null,
        executionId: null,
        running: false,
        pollTimer: null,
        canvas: null,
        refs: null,
        saving: false,
      };
      render();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function closeEditor() {
    var edit = state.edit;
    if (!edit) return;
    if (isDirty()) {
      confirmDialog({
        title: "离开编辑器",
        message: "有未保存的修改，返回后这些修改会丢失。要先保存吗？",
        confirmText: "放弃修改并返回",
        danger: true,
      }).then(function (confirmed) {
        if (!confirmed) return;
        cleanupEditor();
        render();
      });
      return;
    }
    cleanupEditor();
    render();
  }

  function stopEditorPolling() {
    if (state.edit && state.edit.pollTimer) {
      clearInterval(state.edit.pollTimer);
      state.edit.pollTimer = null;
    }
  }

  function cleanupEditor() {
    stopEditorPolling();
    // 画布实例在 window 上挂了空格/方向键监听：换视图/重新打开编辑器前必须 destroy，
    // 否则监听器会随打开次数累积（表现为空格被处理多次、内存慢慢涨）。
    if (state.edit && state.edit.canvas && typeof state.edit.canvas.destroy === "function") {
      try {
        state.edit.canvas.destroy();
      } catch (error) {
        /* 画布清理失败不影响离开编辑器 */
      }
    }
    state.edit = null;
    void loadWorkflows();
  }

  function isDirty() {
    if (!state.edit) return false;
    return JSON.stringify(state.edit.workflow) !== JSON.stringify(state.edit.baseline);
  }

  function renderEditor(root) {
    var edit = state.edit;
    var wrap = h("div", { class: "editor" });
    var toolbar = h("div", { class: "editor-toolbar" });

    var nameInput = h("input", {
      class: "input",
      "aria-label": "工作流名称",
      value: edit.workflow.name || "",
      oninput: function (event) {
        edit.workflow.name = event.target.value;
        updateDirtyIndicator();
      },
    });
    toolbar.appendChild(button("返回", "btn btn-ghost", closeEditor));
    toolbar.appendChild(nameInput);
    var dirtyBadge = h("span", { class: "badge badge-warn hidden", text: "未保存" });
    toolbar.appendChild(dirtyBadge);
    toolbar.appendChild(h("span", { class: "toolbar-sep" }));

    var saveButton = button("保存", "btn btn-primary", function () {
      void saveEditor();
    });
    toolbar.appendChild(saveButton);
    var runButton = button("运行", "btn", function () {
      void runWorkflow();
    });
    toolbar.appendChild(runButton);
    var stopButton = button("停止", "btn", function () {
      void stopWorkflow();
    });
    stopButton.disabled = true;
    toolbar.appendChild(stopButton);
    var undoButton = button("撤销", "btn btn-ghost", function () {
      undo();
    });
    undoButton.disabled = true;
    toolbar.appendChild(undoButton);
    var redoButton = button("重做", "btn btn-ghost", function () {
      redo();
    });
    redoButton.disabled = true;
    toolbar.appendChild(redoButton);
    toolbar.appendChild(
      button("模板", "btn btn-ghost", function () {
        openTemplateModal();
      }),
    );
    toolbar.appendChild(
      button("导出", "btn btn-ghost", function () {
        api.exportWorkflow(edit.workflow.id).then(
          function (exported) {
            openExportModal(edit.workflow.name, exported);
          },
          function (error) {
            toast(error.message, true);
          },
        );
      }),
    );
    toolbar.appendChild(
      button("导入", "btn btn-ghost", function () {
        openImportModal();
      }),
    );
    toolbar.appendChild(h("span", { class: "toolbar-sep" }));
    toolbar.appendChild(
      button("缩小", "btn btn-sm btn-ghost", function () {
        if (edit.canvas) edit.canvas.zoomBy(0.85);
      }),
    );
    toolbar.appendChild(
      button("适配", "btn btn-sm btn-ghost", function () {
        if (edit.canvas) edit.canvas.fit();
      }),
    );
    toolbar.appendChild(
      button("放大", "btn btn-sm btn-ghost", function () {
        if (edit.canvas) edit.canvas.zoomBy(1.15);
      }),
    );

    var activeWrap = h("span", { class: "row", style: { marginLeft: "auto" } });
    activeWrap.appendChild(h("span", { class: "caption", text: "启用" }));
    var activeSwitch = h("button", {
      type: "button",
      class: "switch",
      role: "switch",
      "aria-checked": edit.workflow.active ? "true" : "false",
      "aria-label": "启用工作流",
      onclick: function () {
        var next = !edit.workflow.active;
        api.setActive(edit.workflow.id, next).then(
          function (result) {
            edit.workflow.active = next;
            if (result && result.workflow) edit.workflow.active = result.workflow.active === true;
            activeSwitch.setAttribute("aria-checked", edit.workflow.active ? "true" : "false");
            toast(next ? "已启用；定时触发会在后台执行。" : "已停用。");
          },
          function (error) {
            toast(error.message, true);
          },
        );
      },
    });
    activeWrap.appendChild(activeSwitch);
    toolbar.appendChild(activeWrap);

    var body = h("div", { class: "editor-body" });
    var canvasHost = h("div", { class: "canvas-host" });
    var panelHost = h("div", { class: "node-panel" });
    body.appendChild(canvasHost);
    body.appendChild(panelHost);
    wrap.appendChild(toolbar);
    wrap.appendChild(body);
    root.appendChild(wrap);

    edit.refs = {
      nameInput: nameInput,
      dirtyBadge: dirtyBadge,
      saveButton: saveButton,
      runButton: runButton,
      stopButton: stopButton,
      undoButton: undoButton,
      redoButton: redoButton,
      canvasHost: canvasHost,
      panelHost: panelHost,
    };

    mountCanvas(canvasHost);
    renderNodePanel();
    updateDirtyIndicator();
    updateHistoryButtons();
    updateRunningButtons();
  }

  function mountCanvas(host) {
    var edit = state.edit;
    if (!edit) return;
    if (edit.canvas && typeof edit.canvas.destroy === "function") {
      try {
        edit.canvas.destroy();
      } catch (error) {
        /* 旧实例清理失败不影响重新挂载 */
      }
      edit.canvas = null;
    }
    if (typeof window.WFCanvas === "undefined" || !window.WFCanvas || typeof window.WFCanvas.mount !== "function") {
      host.appendChild(
        h("div", { class: "canvas-fallback", text: "画布组件未加载（canvas.js 缺失）。刷新页面或检查 /static/canvas.js 是否可访问。" }),
      );
      return;
    }
    try {
      edit.canvas = window.WFCanvas.mount(host, {
        onSelect: function (ids) {
          edit.selectedIds = Array.isArray(ids) ? ids.slice() : [];
        },
        onMoveNodes: function (moves) {
          pushHistory();
          for (var i = 0; i < moves.length; i += 1) {
            var move = moves[i];
            var node = findNode(move.id);
            if (node) node.position = { x: move.position.x, y: move.position.y };
          }
          afterDraftChange();
        },
        onConnect: function (connection) {
          if (!connection || connection.sourceId === connection.targetId) return;
          pushHistory();
          addConnection(edit.workflow, connection);
          afterDraftChange();
        },
        onRequestDelete: function (ids) {
          pushHistory();
          for (var i = 0; i < ids.length; i += 1) removeNode(edit.workflow, ids[i]);
          edit.selectedIds = [];
          edit.openNodeId = null;
          afterDraftChange();
          renderNodePanel();
        },
        onOpenNode: function (nodeId) {
          edit.openNodeId = nodeId;
          renderNodePanel();
        },
        onRequestAddNode: function (position) {
          openNodePicker({ x: position.x, y: position.y });
        },
      });
      edit.canvas.setWorkflow(edit.workflow);
      edit.canvas.setSelected([]);
      edit.canvas.setRunState({});
    } catch (error) {
      host.appendChild(h("div", { class: "canvas-fallback", text: "画布初始化失败：" + error.message }));
    }
  }

  function findNode(nodeId) {
    if (!state.edit || !state.edit.workflow) return null;
    var nodes = state.edit.workflow.nodes || [];
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].id === nodeId) return nodes[i];
    }
    return null;
  }

  function addConnection(workflow, connection) {
    var sourceId = connection.sourceId;
    var targetId = connection.targetId;
    var outputIndex = connection.sourceOutput || 0;
    var inputIndex = connection.targetInput || 0;
    if (!workflow.connections) workflow.connections = {};
    var ports = workflow.connections[sourceId];
    if (!ports) {
      ports = { main: [] };
      workflow.connections[sourceId] = ports;
    }
    while (ports.main.length <= outputIndex) ports.main.push([]);
    var list = ports.main[outputIndex];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i] && list[i].node === targetId && list[i].index === inputIndex) return;
    }
    list.push({ node: targetId, type: "main", index: inputIndex });
  }

  function removeNode(workflow, nodeId) {
    workflow.nodes = (workflow.nodes || []).filter(function (node) {
      return node.id !== nodeId;
    });
    if (workflow.connections) {
      delete workflow.connections[nodeId];
      for (var sourceId in workflow.connections) {
        if (!Object.prototype.hasOwnProperty.call(workflow.connections, sourceId)) continue;
        var ports = workflow.connections[sourceId];
        if (!ports || !Array.isArray(ports.main)) continue;
        for (var i = 0; i < ports.main.length; i += 1) {
          ports.main[i] = (ports.main[i] || []).filter(function (target) {
            return target && target.node !== nodeId;
          });
        }
      }
    }
    if (state.edit) {
      state.edit.selectedIds = state.edit.selectedIds.filter(function (id) {
        return id !== nodeId;
      });
      if (state.edit.openNodeId === nodeId) state.edit.openNodeId = null;
    }
  }

  function pushHistory() {
    var edit = state.edit;
    if (!edit) return;
    edit.past.push(cloneJson(edit.workflow));
    if (edit.past.length > 50) edit.past.shift();
    edit.future = [];
  }

  function undo() {
    var edit = state.edit;
    if (!edit || edit.past.length === 0) return;
    edit.future.unshift(cloneJson(edit.workflow));
    edit.workflow = edit.past.pop();
    afterDraftChange();
    updateHistoryButtons();
  }

  function redo() {
    var edit = state.edit;
    if (!edit || edit.future.length === 0) return;
    edit.past.push(cloneJson(edit.workflow));
    edit.workflow = edit.future.shift();
    afterDraftChange();
    updateHistoryButtons();
  }

  function afterDraftChange() {
    var edit = state.edit;
    if (!edit) return;
    if (edit.canvas) {
      edit.canvas.setWorkflow(edit.workflow);
      edit.canvas.setSelected(edit.selectedIds);
    }
    updateDirtyIndicator();
    updateHistoryButtons();
    if (edit.refs) {
      edit.refs.nameInput.value = edit.workflow.name || "";
    }
  }

  function updateDirtyIndicator() {
    var edit = state.edit;
    if (!edit || !edit.refs) return;
    var dirty = isDirty();
    edit.refs.dirtyBadge.classList.toggle("hidden", !dirty);
    edit.refs.saveButton.disabled = edit.saving === true;
  }

  function updateHistoryButtons() {
    var edit = state.edit;
    if (!edit || !edit.refs) return;
    edit.refs.undoButton.disabled = edit.past.length === 0;
    edit.refs.redoButton.disabled = edit.future.length === 0;
  }

  function updateRunningButtons() {
    var edit = state.edit;
    if (!edit || !edit.refs) return;
    edit.refs.runButton.disabled = edit.running;
    edit.refs.runButton.textContent = edit.running ? "运行中…" : "运行";
    edit.refs.stopButton.disabled = !edit.running;
  }

  async function saveEditor() {
    var edit = state.edit;
    if (!edit) return;
    edit.saving = true;
    updateDirtyIndicator();
    try {
      var result = await api.saveWorkflow(edit.workflow.id, edit.workflow);
      var workflow = result && result.workflow ? result.workflow : edit.workflow;
      edit.workflow = cloneJson(workflow);
      edit.baseline = cloneJson(workflow);
      var issues = (result && result.issues) || [];
      var errors = issues.filter(function (issue) {
        return issue && issue.level === "error";
      });
      if (errors.length > 0) {
        toast("已保存，但有问题：" + errors.map(function (issue) {
          return issue.message;
        }).join("；"), true);
      } else {
        toast("已保存");
      }
      afterDraftChange();
      void loadWorkflows();
    } catch (error) {
      toast(error.message, true);
    } finally {
      edit.saving = false;
      updateDirtyIndicator();
    }
  }

  async function ensureNodeTypes() {
    if (state.nodeTypes.length > 0) return;
    var types = await api.nodeTypes();
    state.nodeTypes = Array.isArray(types) ? types : [];
  }

  function nodeDescriptionOf(nodes, type) {
    for (var i = 0; i < nodes.length; i += 1) {
      if (nodes[i].type === type) return nodes[i];
    }
    return null;
  }

  function openNodePicker(position) {
    var pickerState = { query: "" };
    var modal = openModal({ title: "添加节点", wide: true });
    var searchInput = h("input", {
      class: "input",
      type: "search",
      placeholder: "搜索节点名称或说明",
      "aria-label": "搜索节点",
      oninput: function (event) {
        pickerState.query = event.target.value;
        renderPalette();
      },
      onkeydown: function (event) {
        if (event.key === "Enter") {
          var first = modal.body.querySelector(".palette-item");
          if (first) first.click();
        }
      },
    });
    modal.body.appendChild(searchInput);
    var paletteHost = h("div");
    modal.body.appendChild(paletteHost);
    var pendingPosition = position || { x: 240, y: 200 };

    function renderPalette() {
      clear(paletteHost);
      var keyword = String(pickerState.query || "").trim().toLowerCase();
      var types = state.nodeTypes.filter(function (type) {
        if (!keyword) return true;
        return (
          (type.displayName || "").toLowerCase().indexOf(keyword) >= 0 ||
          (type.type || "").toLowerCase().indexOf(keyword) >= 0 ||
          (type.description || "").toLowerCase().indexOf(keyword) >= 0
        );
      });
      var groups = groupNodeTypes(types);
      if (groups.length === 0) {
        paletteHost.appendChild(h("p", { class: "caption", text: "没有匹配的节点。" }));
        return;
      }
      for (var i = 0; i < groups.length; i += 1) {
        paletteHost.appendChild(h("p", { class: "palette-group-title", text: groups[i].label }));
        var grid = h("div", { class: "palette-grid" });
        for (var j = 0; j < groups[i].types.length; j += 1) {
          var description = groups[i].types[j];
          grid.appendChild(
            h(
              "button",
              {
                type: "button",
                class: "palette-item",
                onclick: (function (item) {
                  return function () {
                    addNodeFromDescription(item);
                    modal.close();
                  };
                })(description),
              },
              h("span", { class: "palette-item-name", text: description.displayName }),
              h("span", { class: "caption", text: description.description || "" }),
            ),
          );
        }
        paletteHost.appendChild(grid);
      }
    }

    function addNodeFromDescription(description) {
      var edit = state.edit;
      if (!edit) return;
      pushHistory();
      var node = createNodeFromType(description, edit.workflow, pendingPosition);
      edit.workflow.nodes = (edit.workflow.nodes || []).concat([node]);
      edit.openNodeId = node.id;
      afterDraftChange();
      renderNodePanel();
    }

    renderPalette();
    modal.footer.appendChild(
      button("取消", "btn", function () {
        modal.close();
      }),
    );
  }

  function renderNodePanel() {
    var edit = state.edit;
    if (!edit || !edit.refs) return;
    var host = edit.refs.panelHost;
    clear(host);
    var node = edit.openNodeId ? findNode(edit.openNodeId) : null;
    if (!node) {
      host.appendChild(
        h(
          "div",
          { class: "empty", style: { padding: "28px 16px" } },
          h("p", { class: "empty-title", text: "未选择节点" }),
          h("p", { class: "empty-desc", text: "双击画布空白处，或拖动节点后点击节点，在这里编辑参数。" }),
        ),
      );
      return;
    }
    var description = nodeDescriptionOf(state.nodeTypes, node.type);

    // 头部
    var head = h("div", { class: "node-panel-head" });
    var headText = h("div", { class: "grow" });
    var nameFieldId = "node-name-" + node.id;
    var nameInput = h("input", {
      class: "input",
      id: nameFieldId,
      value: node.name,
      "aria-label": "节点名称",
      oninput: function (event) {
        var next = event.target.value;
        renameNodeSafely(node, next);
        afterDraftChange();
      },
    });
    headText.appendChild(nameInput);
    headText.appendChild(
      h("div", {
        class: "caption",
        text: (description ? description.displayName : node.type) + " · " + node.type,
      }),
    );
    head.appendChild(headText);
    head.appendChild(
      button("×", "close-btn", function () {
        edit.openNodeId = null;
        renderNodePanel();
      }),
    );
    host.appendChild(head);

    // 内容
    var body = h("div", { class: "node-panel-body" });
    if (!description) {
      body.appendChild(
        h("div", { class: "alert alert-warn", text: "未知节点类型「" + node.type + "」，无法编辑参数。" }),
      );
    } else {
      body.appendChild(renderParameterSection(node, description, nameFieldId));
      body.appendChild(renderNodeSettingsSection(node));
      body.appendChild(renderNodeDataSection(node, nameFieldId));
    }
    host.appendChild(body);

    var foot = h("div", { class: "node-panel-foot" });
    var runNodeButton = button("执行此节点", "btn btn-primary btn-sm", function () {
      void runSingleNode(node.id);
    });
    runNodeButton.disabled = edit.running === true;
    foot.appendChild(runNodeButton);
    var latest = latestRunOf(edit.execution, node.id);
    foot.appendChild(
      h("span", {
        class: "caption",
        text: latest ? "最近一次：" + (latest.status === "error" ? "失败" : "成功") : "尚未运行",
      }),
    );
    host.appendChild(foot);
  }

  function renameNodeSafely(node, requested) {
    var edit = state.edit;
    if (!edit) return;
    var trimmed = String(requested || "").trim();
    if (!trimmed) return;
    var others = (edit.workflow.nodes || []).filter(function (item) {
      return item.id !== node.id;
    });
    node.name = uniqueNodeName(others, trimmed);
  }

  function section(title) {
    var sectionNode = h("div", { class: "node-section" });
    sectionNode.appendChild(h("h3", { class: "node-section-title", text: title }));
    return sectionNode;
  }

  function renderParameterSection(node, description, nameFieldId) {
    var wrapper = section("参数");
    var fields = buildParameterFields(description, node.parameters || {});
    if (fields.length === 0) {
      wrapper.appendChild(h("p", { class: "caption", text: "这个节点没有可调参数。" }));
      return wrapper;
    }
    for (var i = 0; i < fields.length; i += 1) {
      wrapper.appendChild(renderParameterField(node, fields[i], nameFieldId));
    }
    return wrapper;
  }

  function renderParameterField(node, field, nameFieldId) {
    var fieldId = nameFieldId + "-param-" + field.name;
    var container = h("div", { class: "field", dataset: { field: field.name } });
    if (field.type === "notice") {
      container.appendChild(h("div", { class: "alert", text: field.description || field.displayName }));
      return container;
    }
    var label = h("label", { class: "field-label", htmlFor: fieldId });
    label.appendChild(document.createTextNode(field.displayName));
    if (field.required) {
      label.appendChild(h("span", { class: "required", text: "*", "aria-hidden": "true" }));
    }
    container.appendChild(label);

    function update(value) {
      var parameters = node.parameters || {};
      if (value === undefined) delete parameters[field.name];
      else parameters[field.name] = value;
      node.parameters = parameters;
      afterDraftChange();
      // displayOptions 可能依赖这个字段：重渲染面板并恢复焦点到同一控件
      rerenderPanelWithFocus(field.name, fieldId);
    }

    if (field.type === "boolean") {
      var checkbox = h("input", {
        type: "checkbox",
        id: fieldId,
        checked: field.value === true,
        onchange: function (event) {
          update(event.target.checked);
        },
      });
      var row = h("div", { class: "checkbox-row" });
      row.appendChild(checkbox);
      row.appendChild(h("span", { text: field.description || "启用" }));
      container.appendChild(row);
      return container;
    }

    if (field.type === "options") {
      var select = h("select", {
        class: "select",
        id: fieldId,
        value: field.value === undefined || field.value === null ? "" : String(field.value),
        onchange: function (event) {
          var raw = event.target.value;
          var chosen = null;
          for (var i = 0; i < field.options.length; i += 1) {
            if (String(field.options[i].value) === raw) {
              chosen = field.options[i];
              break;
            }
          }
          update(chosen ? chosen.value : raw);
        },
      });
      select.appendChild(h("option", { value: "", text: "请选择" }));
      for (var oi = 0; oi < field.options.length; oi += 1) {
        var option = field.options[oi];
        select.appendChild(
          h("option", { value: String(option.value), text: option.name, title: option.description || "" }),
        );
      }
      container.appendChild(select);
      if (field.description) container.appendChild(h("p", { class: "field-hint", text: field.description }));
      appendFieldError(container, field);
      return container;
    }

    if (field.type === "multiOptions") {
      var selected = Array.isArray(field.value) ? field.value.map(String) : [];
      var group = h("div", { class: "row wrap" });
      for (var mi = 0; mi < field.options.length; mi += 1) {
        (function (option) {
          var optionValue = String(option.value);
          var id = fieldId + "-" + mi;
          var checkbox = h("input", {
            type: "checkbox",
            id: id,
            checked: selected.indexOf(optionValue) >= 0,
            onchange: function () {
              var next = [];
              for (var k = 0; k < field.options.length; k += 1) {
                var candidate = field.options[k];
                var input = container.querySelector("#" + cssEscape(fieldId + "-" + k));
                if (input && input.checked) next.push(candidate.value);
              }
              update(next);
            },
          });
          var row = h("label", { class: "checkbox-row", htmlFor: id });
          row.appendChild(checkbox);
          row.appendChild(h("span", { text: option.name }));
          group.appendChild(row);
        })(field.options[mi]);
      }
      container.appendChild(group);
      if (field.description) container.appendChild(h("p", { class: "field-hint", text: field.description }));
      return container;
    }

    if (field.type === "number") {
      var numberValue = field.value === undefined || field.value === null ? "" : String(field.value);
      container.appendChild(
        h("input", {
          class: "input",
          type: "number",
          id: fieldId,
          value: numberValue,
          placeholder: field.placeholder,
          oninput: function (event) {
            var raw = event.target.value;
            if (raw === "") {
              update(undefined);
              return;
            }
            var parsed = Number(raw);
            update(Number.isFinite(parsed) ? parsed : raw);
          },
        }),
      );
      if (field.description) container.appendChild(h("p", { class: "field-hint", text: field.description }));
      appendFieldError(container, field);
      return container;
    }

    if (field.type === "dateTime") {
      var dateValue = field.value === undefined || field.value === null ? "" : String(field.value);
      container.appendChild(
        h("input", {
          class: "input",
          type: "datetime-local",
          id: fieldId,
          value: dateValue,
          oninput: function (event) {
            update(event.target.value);
          },
        }),
      );
      if (field.description) container.appendChild(h("p", { class: "field-hint", text: field.description }));
      appendFieldError(container, field);
      return container;
    }

    var isMultiline = field.type === "multiline" || field.type === "json" || field.type === "code";
    var valueText =
      field.value === undefined || field.value === null
        ? ""
        : typeof field.value === "string"
          ? field.value
          : JSON.stringify(field.value, null, 2);
    var input;
    if (isMultiline) {
      input = h("textarea", {
        class: "textarea mono",
        id: fieldId,
        rows: field.rows,
        placeholder: field.placeholder,
        oninput: function (event) {
          update(event.target.value);
        },
      });
      input.value = valueText;
    } else {
      input = h("input", {
        class: "input mono",
        type: "text",
        id: fieldId,
        value: valueText,
        placeholder: field.placeholder,
        oninput: function (event) {
          update(event.target.value);
        },
      });
    }
    container.appendChild(input);

    if (field.expression && (field.type === "string" || field.type === "multiline" || field.type === "json" || field.type === "code")) {
      var chips = h("div", { class: "expr-chips" });
      var expressions = extractExpressions(valueText);
      for (var ei = 0; ei < expressions.length; ei += 1) {
        chips.appendChild(h("span", { class: "expr-chip", text: "{{ " + expressions[ei] + " }}", title: "表达式" }));
      }
      container.appendChild(chips);
      if (hasUnclosedExpression(valueText)) {
        container.appendChild(h("p", { class: "field-error", text: "表达式少了右括号 }}，请补全。" }));
      }
      if (isSingleExpression(valueText)) {
        container.appendChild(h("p", { class: "field-hint", text: "整段是一个表达式：结果保留原始类型（数字/数组/对象）。" }));
      }
      var tools = h("div", { class: "expr-tools" });
      var variablesButton = button("插入变量", "btn btn-sm btn-ghost", function (event) {
        event.preventDefault();
        openVariableMenu(input, field.name, valueText);
      });
      tools.appendChild(variablesButton);
      container.appendChild(tools);
      if (field.type === "json") {
        var jsonError = validateJsonText(valueText);
        if (jsonError) container.appendChild(h("p", { class: "field-error", text: jsonError }));
      }
    }
    if (field.description) container.appendChild(h("p", { class: "field-hint", text: field.description }));
    appendFieldError(container, field);
    return container;
  }

  function appendFieldError(container, field) {
    if (!field.error) return;
    container.appendChild(h("p", { class: "field-error", role: "alert", text: field.error }));
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && CSS && typeof CSS.escape === "function") return CSS.escape(value);
    return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  }

  function openVariableMenu(input, fieldName, currentValue) {
    var modal = openModal({ title: "插入变量" });
    var list = h("div", { class: "template-list" });
    for (var i = 0; i < EXPRESSION_VARIABLES.length; i += 1) {
      (function (variable) {
        list.appendChild(
          h(
            "button",
            {
              type: "button",
              class: "template-item",
              onclick: function () {
                var start = typeof input.selectionStart === "number" ? input.selectionStart : currentValue.length;
                var end = typeof input.selectionEnd === "number" ? input.selectionEnd : currentValue.length;
                input.value = currentValue.slice(0, start) + variable.value + currentValue.slice(end);
                var edit = state.edit;
                if (edit && edit.openNodeId) {
                  var node = findNode(edit.openNodeId);
                  if (node) {
                    node.parameters = node.parameters || {};
                    node.parameters[fieldName] = input.value;
                    afterDraftChange();
                  }
                }
                modal.close();
                renderNodePanel();
              },
            },
            h("span", { class: "template-name", text: variable.label }),
            h("span", { class: "caption mono", text: variable.value }),
          ),
        );
      })(EXPRESSION_VARIABLES[i]);
    }
    modal.body.appendChild(list);
    modal.footer.appendChild(
      button("取消", "btn", function () {
        modal.close();
      }),
    );
  }

  function rerenderPanelWithFocus(fieldName, fieldId) {
    var active = document.activeElement;
    var selectionStart = null;
    if (active && typeof active.selectionStart === "number") selectionStart = active.selectionStart;
    renderNodePanel();
    var edit = state.edit;
    if (!edit || !edit.refs) return;
    var target = edit.refs.panelHost.querySelector('[data-field="' + cssEscape(fieldName) + '"]');
    if (!target) return;
    var control = target.querySelector("#" + cssEscape(fieldId)) || target.querySelector("input, select, textarea");
    if (!control) return;
    try {
      control.focus();
      if (selectionStart !== null && typeof control.setSelectionRange === "function") {
        control.setSelectionRange(selectionStart, selectionStart);
      }
    } catch (error) {
      /* 控件类型不支持 setSelectionRange（select/checkbox），忽略 */
    }
  }

  function renderNodeSettingsSection(node) {
    var wrapper = section("节点设置");
    var row = h("div", { class: "checkbox-row" });
    var disabled = h("input", {
      type: "checkbox",
      id: "node-disabled-" + node.id,
      checked: node.disabled === true,
      onchange: function (event) {
        node.disabled = event.target.checked;
        afterDraftChange();
      },
    });
    row.appendChild(disabled);
    row.appendChild(h("label", { htmlFor: "node-disabled-" + node.id, text: "禁用（运行时跳过本节点）" }));
    wrapper.appendChild(row);

    var retryRow = h("div", { class: "checkbox-row" });
    var retry = h("input", {
      type: "checkbox",
      id: "node-retry-" + node.id,
      checked: node.retryOnFail === true,
      onchange: function (event) {
        node.retryOnFail = event.target.checked;
        afterDraftChange();
        renderNodePanel();
      },
    });
    retryRow.appendChild(retry);
    retryRow.appendChild(h("label", { htmlFor: "node-retry-" + node.id, text: "失败时重试" }));
    wrapper.appendChild(retryRow);

    if (node.retryOnFail) {
      var grid = h("div", { class: "form-grid" });
      var triesField = h("div", { class: "field" });
      triesField.appendChild(h("label", { class: "field-label", text: "最多尝试（2–5）" }));
      triesField.appendChild(
        h("input", {
          class: "input",
          type: "number",
          min: 2,
          max: 5,
          value: String(node.maxTries || 3),
          oninput: function (event) {
            node.maxTries = Math.min(5, Math.max(2, Number(event.target.value) || 3));
            afterDraftChange();
          },
        }),
      );
      grid.appendChild(triesField);
      var waitField = h("div", { class: "field" });
      waitField.appendChild(h("label", { class: "field-label", text: "间隔（毫秒，0–5000）" }));
      waitField.appendChild(
        h("input", {
          class: "input",
          type: "number",
          min: 0,
          max: 5000,
          step: 100,
          value: String(node.waitBetweenTries === undefined ? 1000 : node.waitBetweenTries),
          oninput: function (event) {
            node.waitBetweenTries = Math.min(5000, Math.max(0, Number(event.target.value) || 0));
            afterDraftChange();
          },
        }),
      );
      grid.appendChild(waitField);
      wrapper.appendChild(grid);
    }

    var onErrorField = h("div", { class: "field" });
    onErrorField.appendChild(h("label", { class: "field-label", text: "失败处理" }));
    var onErrorSelect = h("select", {
      class: "select",
      value: node.onError || "stopWorkflow",
      onchange: function (event) {
        node.onError = event.target.value;
        afterDraftChange();
      },
    });
    for (var i = 0; i < ON_ERROR_OPTIONS.length; i += 1) {
      onErrorSelect.appendChild(
        h("option", { value: ON_ERROR_OPTIONS[i].value, text: ON_ERROR_OPTIONS[i].label }),
      );
    }
    onErrorField.appendChild(onErrorSelect);
    wrapper.appendChild(onErrorField);

    var onceRow = h("div", { class: "checkbox-row" });
    var once = h("input", {
      type: "checkbox",
      id: "node-once-" + node.id,
      checked: node.executeOnce === true,
      onchange: function (event) {
        node.executeOnce = event.target.checked;
        afterDraftChange();
      },
    });
    onceRow.appendChild(once);
    onceRow.appendChild(h("label", { htmlFor: "node-once-" + node.id, text: "只运行一次（全部输入一次交给节点）" }));
    wrapper.appendChild(onceRow);

    var notesField = h("div", { class: "field" });
    notesField.appendChild(h("label", { class: "field-label", text: "备注" }));
    var notes = h("textarea", {
      class: "textarea",
      rows: 2,
      value: node.notes || "",
      oninput: function (event) {
        node.notes = event.target.value;
        afterDraftChange();
      },
    });
    notes.value = node.notes || "";
    notesField.appendChild(notes);
    wrapper.appendChild(notesField);
    return wrapper;
  }

  function renderNodeDataSection(node, nameFieldId) {
    var edit = state.edit;
    var wrapper = section("输入 / 输出数据");
    var view = edit.nodeDataView === "input" ? "input" : "output";
    var pills = h("div", { class: "tab-pills", role: "group", "aria-label": "输入或输出" });
    var inputItems = collectNodeInputItems(edit.execution, node.id);
    var outputItems = collectNodeOutputItems(edit.execution, node.id);
    pills.appendChild(
      h("button", {
        type: "button",
        class: "pill",
        "aria-pressed": view === "input" ? "true" : "false",
        text: "输入（" + inputItems.length + "）",
        onclick: function () {
          edit.nodeDataView = "input";
          renderNodePanel();
        },
      }),
    );
    pills.appendChild(
      h("button", {
        type: "button",
        class: "pill",
        "aria-pressed": view === "output" ? "true" : "false",
        text: "输出（" + outputItems.length + "）",
        onclick: function () {
          edit.nodeDataView = "output";
          renderNodePanel();
        },
      }),
    );
    wrapper.appendChild(pills);
    if (!edit.execution) {
      wrapper.appendChild(
        h("p", {
          class: "caption",
          text: "还没有运行记录。运行一次工作流后，这里会显示该节点的输入与输出。",
        }),
      );
      return wrapper;
    }
    var data = view === "input" ? inputItems : outputItems;
    var preview = truncateJson(data, 20000);
    var box = h("div", { class: "preview-box" });
    box.appendChild(h("pre", { text: preview.text }));
    wrapper.appendChild(box);
    if (preview.truncated) {
      wrapper.appendChild(h("p", { class: "caption", text: "数据较大，预览已截断；执行记录里保留裁剪后的数据。" }));
    }
    return wrapper;
  }

  // ---------------- 运行与轮询 ----------------

  async function runWorkflow() {
    var edit = state.edit;
    if (!edit || edit.running) return;
    try {
      var result = await api.runWorkflow(edit.workflow.id, {});
      edit.running = true;
      edit.executionId = result.executionId;
      edit.execution = null;
      updateRunningButtons();
      toast("已开始运行");
      startPolling(result.executionId);
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function runSingleNode(nodeId) {
    var edit = state.edit;
    if (!edit || edit.running) return;
    try {
      var inputItems = collectNodeInputItems(edit.execution, nodeId);
      var result = await api.runWorkflow(edit.workflow.id, {
        startNodeId: nodeId,
        inputData: inputItems,
      });
      edit.running = true;
      edit.executionId = result.executionId;
      updateRunningButtons();
      renderNodePanel();
      toast("已从该节点开始运行");
      startPolling(result.executionId);
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function stopWorkflow() {
    var edit = state.edit;
    if (!edit) return;
    try {
      await api.stopWorkflow(edit.workflow.id);
      toast("已请求停止");
    } catch (error) {
      toast(error.message, true);
    }
  }

  function startPolling(executionId) {
    var edit = state.edit;
    if (!edit) return;
    if (edit.pollTimer) clearInterval(edit.pollTimer);
    var tick = async function () {
      var current = state.edit;
      if (!current || current.executionId !== executionId) return;
      try {
        var execution = await api.getExecution(executionId);
        current = state.edit;
        if (!current || current.executionId !== executionId) return;
        current.execution = execution;
        if (current.canvas) current.canvas.setRunState(buildRunState(execution));
        if (executionStatusFinished(execution.status)) {
          current.running = false;
          current.executionId = null;
          clearInterval(current.pollTimer);
          current.pollTimer = null;
          updateRunningButtons();
          updateDirtyIndicator();
          renderNodePanel();
          if (execution.status === "error") {
            toast("运行失败：" + (execution.error && execution.error.message ? execution.error.message : "未知错误"), true);
          } else if (execution.status === "canceled") {
            toast("已停止");
          } else {
            toast("运行完成，用时 " + formatDuration(execution.durationMs));
          }
          void loadWorkflows();
        }
      } catch (error) {
        var editNow = state.edit;
        if (editNow) {
          editNow.running = false;
          editNow.executionId = null;
          if (editNow.pollTimer) clearInterval(editNow.pollTimer);
          editNow.pollTimer = null;
          updateRunningButtons();
        }
        toast("查询执行状态失败：" + error.message, true);
      }
    };
    edit.pollTimer = setInterval(tick, 700);
    void tick();
  }

  // =========================================================================
  // 6. 执行记录
  // =========================================================================

  async function loadExecutions() {
    try {
      var executions = await api.listExecutions({ limit: 60 });
      state.executions = Array.isArray(executions) ? executions : [];
      if (state.tab === "executions" && !state.edit) render();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function renderExecutions(root) {
    var toolbar = h("div", { class: "toolbar" });
    toolbar.appendChild(h("h2", { class: "section-title", text: "执行记录", style: { margin: "0" } }));
    toolbar.appendChild(
      button("刷新", "btn btn-ghost", function () {
        void loadExecutions();
      }),
    );
    if (state.executions.length > 0) {
      toolbar.appendChild(
        button(
          "清空全部",
          "btn btn-danger btn-sm",
          function () {
            confirmDialog({
              title: "清空执行记录",
              message: "将删除全部 " + state.executions.length + " 条执行记录（只在本机，工作流不受影响）。",
              confirmText: "清空",
              danger: true,
            }).then(function (confirmed) {
              if (!confirmed) return;
              var ids = state.executions.map(function (execution) {
                return execution.id;
              });
              Promise.all(
                ids.map(function (id) {
                  return api.deleteExecution(id).catch(function () {
                    return null;
                  });
                }),
              ).then(function () {
                toast("已清空执行记录");
                state.selectedExecutionId = null;
                state.executionDetail = null;
                void loadExecutions();
              });
            });
          },
        ),
      );
    }
    root.appendChild(toolbar);

    if (state.executions.length === 0) {
      root.appendChild(
        h(
          "div",
          { class: "empty" },
          h("p", { class: "empty-title", text: "还没有执行记录" }),
          h("p", { class: "empty-desc", text: "手动运行、定时触发或子流程都会在这里留一条记录（只存本机）。" }),
        ),
      );
      return;
    }

    var layout = h("div", { class: "exec-layout" });
    var listHost = h("div", { class: "exec-list card" });
    var detailHost = h("div", { class: "exec-detail" });
    state.listHost = listHost;
    state.detailHost = detailHost;
    layout.appendChild(listHost);
    layout.appendChild(detailHost);
    root.appendChild(layout);
    renderExecutionList();
    renderExecutionDetail();
  }

  function renderExecutionList() {
    var host = state.listHost;
    if (!host) return;
    clear(host);
    for (var i = 0; i < state.executions.length; i += 1) {
      (function (execution) {
        var item = h("button", {
          type: "button",
          class: "exec-item",
          "aria-current": state.selectedExecutionId === execution.id ? "true" : "false",
          onclick: function () {
            void selectExecution(execution.id);
          },
        });
        var head = h("div", { class: "row-between" });
        head.appendChild(h("span", { class: "truncate", style: { fontWeight: "600" }, text: execution.workflowName }));
        head.appendChild(
          h("span", { class: statusTone(execution.status), text: statusLabel(execution.status) }),
        );
        item.appendChild(head);
        item.appendChild(
          h("div", {
            class: "caption",
            text: modeLabel(execution.mode) + " · " + formatTime(execution.startedAt) + " · " + formatDuration(execution.durationMs),
          }),
        );
        host.appendChild(item);
      })(state.executions[i]);
    }
  }

  async function selectExecution(executionId) {
    state.selectedExecutionId = executionId;
    renderExecutionList();
    try {
      var execution = await api.getExecution(executionId);
      state.executionDetail = execution;
      state.executionWorkflow = null;
      try {
        state.executionWorkflow = await api.getWorkflow(execution.workflowId);
      } catch (error) {
        state.executionWorkflow = null;
      }
      renderExecutionDetail();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function renderExecutionDetail() {
    var host = state.detailHost;
    if (!host) return;
    clear(host);
    var execution = state.executionDetail;
    if (!execution || execution.id !== state.selectedExecutionId) {
      host.appendChild(
        h(
          "div",
          { class: "empty card" },
          h("p", { class: "empty-title", text: "选择左边的一条记录" }),
          h("p", { class: "empty-desc", text: "可以查看每个节点的输入输出、错误与耗时。" }),
        ),
      );
      return;
    }
    var card = h("div", { class: "card", style: { padding: "14px" } });
    var head = h("div", { class: "row-between wrap", style: { alignItems: "flex-start" } });
    var info = h("div", { class: "grow" });
    info.appendChild(h("h3", { class: "section-title", style: { margin: "0" }, text: execution.workflowName }));
    info.appendChild(
      h("div", {
        class: "caption",
        text:
          statusLabel(execution.status) +
          " · " +
          modeLabel(execution.mode) +
          " · " +
          formatDuration(execution.durationMs) +
          " · " +
          formatTime(execution.startedAt) +
          (execution.parentExecutionId ? " · 父执行 " + execution.parentExecutionId : ""),
      }),
    );
    head.appendChild(info);
    var actions = h("div", { class: "row" });
    actions.appendChild(
      button("重跑", "btn btn-sm btn-primary", function () {
        api.retryExecution(execution.id).then(
          function () {
            toast("已重新启动执行");
            void loadExecutions();
          },
          function (error) {
            toast(error.message, true);
          },
        );
      }),
    );
    actions.appendChild(
      button("删除", "btn btn-sm btn-danger", function () {
        confirmDialog({
          title: "删除执行记录",
          message: "删除后无法恢复，工作流本身不受影响。",
          confirmText: "删除",
          danger: true,
        }).then(function (confirmed) {
          if (!confirmed) return;
          api.deleteExecution(execution.id).then(
            function () {
              toast("已删除");
              state.selectedExecutionId = null;
              state.executionDetail = null;
              void loadExecutions();
              renderExecutionDetail();
            },
            function (error) {
              toast(error.message, true);
            },
          );
        });
      }),
    );
    head.appendChild(actions);
    card.appendChild(head);

    if (execution.dataTruncated) {
      card.appendChild(
        h("p", {
          class: "caption",
          text: "部分节点数据因体积上限未保存（单条超过 64KB 或整条记录超过 1MB 时会截断，状态、耗时与错误仍保留）。",
        }),
      );
    }
    if (execution.error) {
      card.appendChild(
        h(
          "div",
          { class: "alert alert-error", style: { marginTop: "10px" } },
          h("strong", { text: execution.error.message || "执行失败" }),
          execution.error.nodeName ? h("div", { class: "caption", text: "出错节点：" + execution.error.nodeName }) : null,
        ),
      );
    }

    var triggerData = execution.triggerData || [];
    card.appendChild(renderPreviewBlock("触发数据（" + triggerData.length + " 条）", triggerData, "这次执行没有触发数据。"));

    var summaries = executionNodeSummaries(execution, state.executionWorkflow);
    if (summaries.length === 0) {
      card.appendChild(h("p", { class: "caption", text: "没有节点运行记录（可能一开始就失败了）。" }));
    }
    for (var i = 0; i < summaries.length; i += 1) {
      card.appendChild(renderExecutionNode(summaries[i], execution));
    }
    host.appendChild(card);
  }

  function renderPreviewBlock(title, data, emptyText) {
    var block = h("div", { style: { marginTop: "10px" } });
    block.appendChild(h("div", { class: "section-title", style: { margin: "0 0 4px" }, text: title }));
    if (!data || (Array.isArray(data) && data.length === 0)) {
      block.appendChild(h("p", { class: "caption", text: emptyText || "没有数据。" }));
      return block;
    }
    var preview = truncateJson(data, 12000);
    var box = h("div", { class: "preview-box" });
    box.appendChild(h("pre", { text: preview.text }));
    block.appendChild(box);
    if (preview.truncated) {
      block.appendChild(h("p", { class: "caption", text: "数据较大，预览已截断。" }));
    }
    return block;
  }

  function renderExecutionNode(summary, execution) {
    var container = h("div", { class: "exec-node" });
    var head = h("div", { class: "exec-node-head" });
    head.appendChild(h("span", { class: "grow", text: summary.name + "（" + summary.type + "）" }));
    var latest = summary.runs[summary.runs.length - 1];
    if (latest) {
      head.appendChild(
        h("span", {
          class: latest.status === "error" ? "badge badge-error" : latest.status === "waiting" ? "badge badge-warn" : "badge badge-ok",
          text: latest.status === "error" ? "失败" : latest.status === "waiting" ? "等待" : "成功",
        }),
      );
      head.appendChild(h("span", { class: "caption", text: formatDuration(latest.executionTime) }));
      head.appendChild(h("span", { class: "caption", text: (latest.itemsTotal || 0) + " 条数据" }));
    }
    container.appendChild(head);

    var body = h("div", { class: "exec-node-body" });
    for (var i = 0; i < summary.runs.length; i += 1) {
      (function (run, index) {
        var runBlock = h("div", { style: { borderBottom: "1px solid var(--line-soft)", paddingBottom: "8px" } });
        runBlock.appendChild(
          h("div", {
            class: "caption",
            text: "第 " + (run.executionIndex + 1) + " 次运行 · " + formatDuration(run.executionTime) + " · " + (run.itemsTotal || 0) + " 条数据",
          }),
        );
        if (run.error) {
          runBlock.appendChild(
            h("div", { class: "alert alert-error" }, h("div", { text: run.error.message }), run.error.description ? h("div", { class: "caption", text: run.error.description }) : null),
          );
        }
        var input = collectRunInputItems(execution, run);
        runBlock.appendChild(renderPreviewBlock("输入", input, "没有上游输入（可能是触发节点）。"));
        runBlock.appendChild(
          renderPreviewBlock("输出", flattenOutputs(run), "这次运行没有输出，或工作流设置成不保存执行数据。"),
        );
        body.appendChild(runBlock);
      })(summary.runs[i], i);
    }
    container.appendChild(body);
    return container;
  }


  // =========================================================================
  // 7. 凭据
  // =========================================================================

  async function loadCredentials() {
    try {
      var credentials = await api.listCredentials();
      state.credentials = Array.isArray(credentials) ? credentials : [];
      if (state.tab === "credentials" && !state.edit) render();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function renderCredentials(root) {
    var toolbar = h("div", { class: "toolbar" });
    toolbar.appendChild(h("h2", { class: "section-title", text: "凭据", style: { margin: "0" } }));
    toolbar.appendChild(
      button("新建凭据", "btn btn-primary", function () {
        openCredentialModal(null);
      }),
    );
    toolbar.appendChild(
      button("刷新", "btn btn-ghost", function () {
        void loadCredentials();
      }),
    );
    root.appendChild(toolbar);
    root.appendChild(
      h("p", {
        class: "caption",
        style: { marginBottom: "12px" },
        text: "凭据只保存在本机：值由服务端 AES-256-GCM 加密后落盘，接口不会回传明文。导出工作流时只带凭据 id。",
      }),
    );

    if (state.credentials.length === 0) {
      root.appendChild(
        h(
          "div",
          { class: "empty" },
          h("p", { class: "empty-title", text: "还没有凭据" }),
          h("p", { class: "empty-desc", text: "需要认证的 HTTP 请求可以在这里保存账号、请求头或令牌；值不会离开本机。" }),
          button("新建凭据", "btn btn-primary", function () {
            openCredentialModal(null);
          }),
        ),
      );
      return;
    }

    var grid = h("div", { class: "credential-grid" });
    for (var i = 0; i < state.credentials.length; i += 1) {
      grid.appendChild(renderCredentialCard(state.credentials[i]));
    }
    root.appendChild(grid);
  }

  function renderCredentialCard(meta) {
    var card = h("div", { class: "card list-row" });
    var info = h("div", { class: "grow" });
    info.appendChild(h("div", { style: { fontWeight: "600" }, text: meta.name }));
    info.appendChild(
      h("div", {
        class: "caption",
        text: credentialTypeLabel(meta.type) + " · 更新于 " + formatTime(meta.updatedAt),
      }),
    );
    card.appendChild(info);
    var actions = h("div", { class: "row" });
    actions.appendChild(
      button("编辑", "btn btn-sm", function () {
        openCredentialModal(meta);
      }),
    );
    actions.appendChild(
      button("删除", "btn btn-sm btn-danger", function () {
        confirmDialog({
          title: "删除凭据",
          message: "确定删除凭据「" + meta.name + "」吗？使用它的节点会拿不到认证信息。",
          confirmText: "删除",
          danger: true,
        }).then(function (confirmed) {
          if (!confirmed) return;
          api.deleteCredential(meta.id).then(
            function () {
              toast("已删除凭据");
              void loadCredentials();
            },
            function (error) {
              toast(error.message, true);
            },
          );
        });
      }),
    );
    card.appendChild(actions);
    return card;
  }

  function openCredentialModal(meta) {
    var isEdit = Boolean(meta);
    var type = meta ? meta.type : CREDENTIAL_TYPES[0].type;
    var values = {};
    var modal = openModal({ title: isEdit ? "编辑凭据" : "新建凭据" });
    var nameInput = h("input", {
      class: "input",
      id: "credential-name",
      value: meta ? meta.name : "",
      placeholder: "例如：示例接口（测试环境）",
    });
    var nameField = h("div", { class: "field" });
    nameField.appendChild(h("label", { class: "field-label", htmlFor: "credential-name", text: "名称" }));
    nameField.appendChild(nameInput);
    modal.body.appendChild(nameField);

    var typeField = h("div", { class: "field" });
    typeField.appendChild(h("label", { class: "field-label", htmlFor: "credential-type", text: "类型" }));
    var typeSelect = h("select", {
      class: "select",
      id: "credential-type",
      disabled: isEdit,
      onchange: function (event) {
        type = event.target.value;
        renderFields();
      },
    });
    for (var i = 0; i < CREDENTIAL_TYPES.length; i += 1) {
      typeSelect.appendChild(h("option", { value: CREDENTIAL_TYPES[i].type, text: CREDENTIAL_TYPES[i].label }));
    }
    typeSelect.value = type;
    typeField.appendChild(typeSelect);
    modal.body.appendChild(typeField);

    var fieldsHost = h("div");
    modal.body.appendChild(fieldsHost);
    var hint = h("p", { class: "caption", text: "" });
    modal.body.appendChild(hint);

    function renderFields() {
      clear(fieldsHost);
      var fields = buildCredentialFields(type);
      hint.textContent = isEdit
        ? "接口不会回显已保存的密码/令牌：只改名称可以全部留空；要改值请把该类型的必填字段都填上。"
        : "";
      for (var j = 0; j < fields.length; j += 1) {
        (function (field) {
          var fieldId = "credential-field-" + field.name;
          var wrapper = h("div", { class: "field" });
          var label = h("label", { class: "field-label", htmlFor: fieldId });
          label.appendChild(document.createTextNode(field.label));
          if (field.required) label.appendChild(h("span", { class: "required", text: "*" }));
          wrapper.appendChild(label);
          var input = h("input", {
            class: "input",
            type: field.secret ? "password" : "text",
            id: fieldId,
            placeholder: field.placeholder,
            autocomplete: "off",
            oninput: function (event) {
              values[field.name] = event.target.value;
            },
          });
          wrapper.appendChild(input);
          fieldsHost.appendChild(wrapper);
        })(fields[j]);
      }
    }
    renderFields();

    modal.footer.appendChild(
      button("取消", "btn", function () {
        modal.close();
      }),
    );
    modal.footer.appendChild(
      button(isEdit ? "保存" : "创建", "btn btn-primary", function () {
        var name = String(nameInput.value || "").trim();
        if (!name) {
          toast("请填写凭据名称", true);
          return;
        }
        var fields = buildCredentialFields(type);
        var payloadData = {};
        var filledCount = 0;
        for (var k = 0; k < fields.length; k += 1) {
          var field = fields[k];
          var value = values[field.name];
          if (value === undefined || String(value).trim() === "") continue;
          payloadData[field.name] = value;
          filledCount += 1;
        }
        if (isEdit) {
          // 全部留空 = 只改名称：不传 data，服务端沿用已保存的密钥值。
          var patch = filledCount === 0 ? { name: name } : { name: name, data: payloadData };
          if (filledCount > 0) {
            var editValidation = validateCredentialForm(fields, values);
            if (editValidation) {
              toast(editValidation, true);
              return;
            }
          }
          api.updateCredential(meta.id, patch).then(
            function () {
              toast("已保存凭据");
              modal.close();
              void loadCredentials();
            },
            function (error) {
              toast(error.message, true);
            },
          );
          return;
        }
        var validationError = validateCredentialForm(fields, values);
        if (validationError) {
          toast(validationError, true);
          return;
        }
        api.createCredential({ name: name, type: type, data: payloadData }).then(
          function () {
            toast("已创建凭据");
            modal.close();
            void loadCredentials();
          },
          function (error) {
            toast(error.message, true);
          },
        );
      }),
    );
  }

  // =========================================================================
  // 8. 设置
  // =========================================================================

  async function loadSettings() {
    try {
      state.settings = await api.getSettings();
      if (state.tab === "settings" && !state.edit) render();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function renderSettings(root) {
    var settings = state.settings || { vars: {}, llm: { configured: false } };
    var llm = settings.llm || { configured: false };
    var grid = h("div", { class: "settings-grid" });

    var varsCard = h("div", { class: "card", style: { padding: "14px" } });
    varsCard.appendChild(h("h2", { class: "section-title", text: "全局变量" }));
    varsCard.appendChild(
      h("p", { class: "caption", text: "表达式里用 {{ $vars.名字 }} 读取；只在本机保存。" }),
    );
    var varsTextarea = h("textarea", { class: "textarea mono", rows: 10, "aria-label": "全局变量 JSON" });
    varsTextarea.value = JSON.stringify(settings.vars || {}, null, 2);
    varsCard.appendChild(varsTextarea);
    var varsNotice = h("div");
    varsCard.appendChild(varsNotice);
    varsCard.appendChild(
      button("保存变量", "btn btn-primary", function () {
        var parsed = parseVarsText(varsTextarea.value);
        clear(varsNotice);
        if (!parsed.ok) {
          varsNotice.appendChild(h("div", { class: "alert alert-error", text: parsed.error }));
          return;
        }
        api.saveSettings({ vars: parsed.value }).then(
          function (next) {
            state.settings = next;
            toast("已保存全局变量");
            render();
          },
          function (error) {
            toast(error.message, true);
          },
        );
      }),
    );
    grid.appendChild(varsCard);

    var llmCard = h("div", { class: "card", style: { padding: "14px" } });
    llmCard.appendChild(h("h2", { class: "section-title", text: "模型连接" }));
    llmCard.appendChild(
      h("p", {
        class: "caption",
        text: "OpenAI 兼容接口（POST /chat/completions），供大模型节点使用。API Key 只写不读。",
      }),
    );
    var llmForm = h("div", { class: "form-grid" });
    var baseField = h("div", { class: "field full" });
    baseField.appendChild(h("label", { class: "field-label", text: "Base URL" }));
    var baseInput = h("input", { class: "input", value: llm.baseUrl || "", placeholder: "https://api.example.com/v1" });
    baseField.appendChild(baseInput);
    llmForm.appendChild(baseField);
    var modelField = h("div", { class: "field" });
    modelField.appendChild(h("label", { class: "field-label", text: "模型" }));
    var modelInput = h("input", { class: "input", value: llm.model || "", placeholder: "例如 gpt-4o-mini" });
    modelField.appendChild(modelInput);
    llmForm.appendChild(modelField);
    var keyField = h("div", { class: "field" });
    keyField.appendChild(h("label", { class: "field-label", text: "API Key" }));
    var keyInput = h("input", {
      class: "input",
      type: "password",
      autocomplete: "off",
      placeholder: llm.configured ? "已配置，留空保持不变" : "sk-…",
    });
    keyField.appendChild(keyInput);
    llmForm.appendChild(keyField);
    llmCard.appendChild(llmForm);
    llmCard.appendChild(
      h("p", {
        class: "caption",
        text: llm.configured ? "当前状态：已配置" : "当前状态：未配置（大模型节点会给出中文错误）",
      }),
    );
    llmCard.appendChild(
      button("保存模型连接", "btn btn-primary", function () {
        var payload = buildSettingsPayload(
          {
            vars: settings.vars || {},
            baseUrl: baseInput.value,
            model: modelInput.value,
            apiKey: keyInput.value,
          },
          { configured: llm.configured === true },
        );
        var llmPayload;
        if (!baseInput.value.trim() && !modelInput.value.trim() && !keyInput.value.trim()) {
          llmPayload = llm.configured ? { llm: null } : {};
        } else {
          llmPayload = payload.llm ? { llm: payload.llm } : {};
        }
        api.saveSettings(llmPayload).then(
          function (next) {
            state.settings = next;
            toast("已保存模型连接");
            render();
          },
          function (error) {
            toast(error.message, true);
          },
        );
      }),
    );
    grid.appendChild(llmCard);
    root.appendChild(grid);
  }

  // =========================================================================
  // 9. 加载与启动
  // =========================================================================

  async function loadWorkflows() {
    state.loading = true;
    try {
      var workflows = await api.listWorkflows();
      state.workflows = Array.isArray(workflows) ? workflows : [];
      state.listError = "";
    } catch (error) {
      state.listError = "加载工作流失败：" + error.message;
    } finally {
      state.loading = false;
      if (state.tab === "workflows" && !state.edit) render();
    }
  }

  async function createWorkflow(input) {
    if (state.edit && isDirty()) {
      var confirmed = await confirmDialog({
        title: "新建工作流会离开当前编辑器",
        message: "当前工作流有未保存的修改，新建后这些修改会丢失。",
        confirmText: "放弃修改并新建",
        danger: true,
      });
      if (!confirmed) return;
      stopEditorPolling();
    }
    try {
      var workflow = await api.createWorkflow(input);
      toast("已创建「" + workflow.name + "」");
      await loadWorkflows();
      await openEditor(workflow.id);
    } catch (error) {
      toast(error.message, true);
    }
  }

  function bindGlobalEvents() {
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (closeTopModal()) {
          event.preventDefault();
          return;
        }
        if (state.edit) {
          if (state.edit.openNodeId) {
            state.edit.openNodeId = null;
            renderNodePanel();
            event.preventDefault();
          }
        }
        return;
      }
      var mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      var key = String(event.key || "").toLowerCase();
      if (key === "s" && state.edit) {
        event.preventDefault();
        void saveEditor();
      } else if (key === "enter" && state.edit) {
        event.preventDefault();
        void runWorkflow();
      }
    });
  }

  function bindTabs() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i += 1) {
      (function (tab) {
        tab.addEventListener("click", function () {
          if (state.edit && isDirty()) {
            confirmDialog({
              title: "离开编辑器",
              message: "有未保存的修改，切换页面会丢失这些修改。",
              confirmText: "放弃修改并切换",
              danger: true,
            }).then(function (confirmed) {
              if (!confirmed) return;
              stopEditorPolling();
              state.edit = null;
              setTab(tab.dataset.tab);
            });
            return;
          }
          if (state.edit) {
            stopEditorPolling();
            state.edit = null;
          }
          setTab(tab.dataset.tab);
        });
      })(tabs[i]);
    }
  }

  async function boot() {
    dom.app = document.getElementById("app");
    dom.modalRoot = document.getElementById("modal-root");
    dom.toastRoot = document.getElementById("toast-root");
    dom.healthBadge = document.getElementById("health-badge");
    api = createApi(function (url, init) {
      return window.fetch(url, init);
    });

    bindTabs();
    bindGlobalEvents();
    render();

    try {
      var health = await api.health();
      if (dom.healthBadge) {
        dom.healthBadge.textContent = "服务已连接 · " + (health && health.version ? "v" + health.version : "");
      }
    } catch (error) {
      if (dom.healthBadge) dom.healthBadge.textContent = "服务未连接";
    }

    await Promise.all([
      loadWorkflows(),
      api.templates().then(
        function (templates) {
          state.templates = Array.isArray(templates) ? templates : [];
        },
        function () {
          state.templates = [];
        },
      ),
      api.nodeTypes().then(
        function (types) {
          state.nodeTypes = Array.isArray(types) ? types : [];
        },
        function () {
          state.nodeTypes = [];
        },
      ),
    ]);
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      void boot();
    });
  } else {
    void boot();
  }
})();
