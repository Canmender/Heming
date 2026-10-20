# 网页抓取（Scrapling）

和鸣通过 [Scrapling](https://github.com/D4Vinci/Scrapling) 的 MCP 服务器获得网页抓取能力。

许可：BSD 3-Clause（可商用）。

## 怎么用

直接跟智能体说「帮我抓一下 xxx 网页」就行。它会自己选工具：

| 场景 | 工具 |
|---|---|
| 普通网页、API、不需要 JS | `make_request` |
| SPA、需要前端渲染、被 Cloudflare 拦 | `browser_fetch_once` |
| 连续抓多个页面、保持登录态 | `browser_open` → `browser_fetch` → `close_session` |

已默认登记为预置服务「网页抓取（Scrapling）」，首次启动即自动连接并发现工具。

## 16 个工具分三层

### 第一层 · 只读观察（默认自动启用）

`make_request`、`browser_fetch_once`、`browser_fetch`、`browser_extract`、
`browser_screenshot`、`browser_network_requests`、`browser_network_request`、`list_sessions`

只读取网页内容，不改本机任何状态，也不在目标站点产生副作用。

### 第二层 · 会开浏览器或写文件（需手动启用）

`browser_open`、`open_request_session`、`close_session`、
`browser_save_state`、`browser_load_state`

会话会常驻占资源（用完必须 `close_session`）；状态文件会写到本机磁盘。

### 第三层 · 可操作页面与执行代码（需手动启用）

`browser_actions`、`browser_evaluate`

能在目标站点上点击、填表、提交表单、执行任意 JavaScript——
会产生真实副作用（登录、下单、发消息）。

**这三层要手动开的原因**：MCP 工具默认一律不启用（可能有副作用）。
完全让用户手点又谈不上「默认接入」，所以折中是：预置服务登记好、
工具发现后把**只读那一批**自动打开，写操作仍需逐个确认。

在接口区勾选即可开启。

## 前置依赖

- **HTTP 工具**（`make_request` 等）：无需浏览器，开箱即用。
- **浏览器工具**（`browser_*`）：需先装浏览器依赖。

  ```bash
  uvx --from "scrapling[ai,fetchers]" scrapling install
  ```

  本机已装（`D:\Python314` 环境，浏览器落在 uv 的缓存里）。

## 命令与参数

stdio 传输，启动命令：

```
uvx --from scrapling[ai] scrapling mcp
```

`--from` **必须带 `[ai]` extra**——`mcp` 子命令装在 ai extra 里，
少了它 uvx 会报「no such command」。

也支持 HTTP 传输（`scrapling mcp --http --port 8000`），
但和鸣用的是 stdio，不需要。

## 已知限制

- **仅桌面端可用**：stdio 会拉起本机进程，浏览器里只能看到配置连不上。
- **首次拉包慢**：`uvx` 首次要下载 scrapling 及其依赖（64 个包，约 5 秒），
  之后是秒级。应用启动时的自动连接失败也不影响——发送消息前有懒预检会补连。
- **会话不会自动清理**：`browser_open` / `open_request_session` 创建的会话
  会一直开着直到显式 `close_session`。忘了关会持续占浏览器与内存。
- **反爬不等于无条件绕过**：实际效果还取决于目标站点防护强度、IP 信誉、
  代理质量、地区限制、账号状态与行为模式。失败就换工具或如实说明。
- **网络历史只记已完成的请求**：4xx/5xx 会被记录，失败与未完成的请求不会；
  二进制响应体与未知 Content-Type 不会保存正文（仍保留元数据与响应头）。
- **Anthropic provider 不支持工具调用**（既有设计），
  所以绑 Anthropic 的智能体用不了任何 MCP 工具。

## 提示注入防护

`main_content_only=true`（默认）会清理页面里可能被用于 Prompt Injection 的隐藏内容：
`display:none`、`visibility:hidden`、透明度 0、尺寸 0、`aria-hidden="true"`、
`<template>`、`<slot hidden>`、HTML 注释、零宽字符。

但**仍要把网页内容当数据看**——内置技能「网页抓取」里也写了这一条。
清理是兜底，不是保证。

## 合规

抓取前遵守 `robots.txt`、站点服务条款、访问频率限制、版权与隐私法规。
不要抓取超出授权的个人数据或商业数据。
