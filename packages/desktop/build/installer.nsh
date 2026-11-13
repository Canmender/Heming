; 和鸣 Windows 安装器外观（electron-builder nsis.include）
;
; 只改「文案 + 品牌图」两层，不动安装行为：
; - 侧栏/页头图由 installerSidebar.bmp / installerHeader.bmp 提供（见 scripts/make-installer-assets.py）；
; - 这里补欢迎页（electron-builder 的 assisted 安装器默认没有欢迎页），
;   并把完成页/目录页的说明改成产品自己的话；
; - 中途取消要二次确认：assisted 安装器默认点「取消」直接退出，
;   装到一半的目录就那么留着，用户不知道发生了什么。
;
; 注意：本文件在 electron-builder 模板的公共头部展开，MUI_* 的 !define 必须在
; 模板插入 MUI_PAGE_WELCOME / MUI_PAGE_FINISH 之前生效——所以写成 include 而不是 post 脚本。
;
; 刻意没做的事（试过或评估后放弃，记在这里免得下一轮再查一遍）：
; - 页头那行「和鸣 140.3.56」由 electron-builder 按 semver 写死，改它要 !undef MUI 宏，
;   而那发生在 MUI2.nsh 之后、我们够不到的位置；5 段版本号是产品自己的账，交给应用内的关于页。
; - 安装模式页（「为哪位用户安装」）的文案来自 multiUserUi.nsh 内置 LangString，
;   覆盖它需要重定义 MUI 的页面宏，收益不抵风险。

!define MUI_WELCOMEPAGE_TITLE "安装 和鸣"
!define MUI_WELCOMEPAGE_TEXT "和鸣是一个本机优先的 AI 工作站：模型连接、工具与记忆都保存在这台设备上。$\r$\n$\r$\n下一步可以自选安装位置。卸载时会把安装目录下的 data 文件夹一并删除，请先备份需要保留的内容。"

!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "和鸣已经安装好。$\r$\n$\r$\n模型 Key、工具与记忆只保存在本机。"
!define MUI_FINISHPAGE_RUN_TEXT "运行 和鸣"

!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置。登录状态、插件与知识库等数据会存到这里的 data 文件夹，卸载时一并删除。"

!define MUI_UNWELCOMEPAGE_TITLE "卸载 和鸣"
!define MUI_UNWELCOMEPAGE_TEXT "卸载会删除程序与安装目录下的 data 文件夹（登录状态、插件、知识库）。请先备份要保留的数据。"

; 安装中途点「取消 / 关闭窗口」时的确认。文案说清楚会发生什么，而不是只问「确定吗」。
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "安装还没完成。现在退出的话，已经解到安装目录里的文件会留在那里，下次要重新运行安装程序才能补全。确定退出吗？"

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
!macroend