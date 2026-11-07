; 和鸣 Windows 安装器外观（electron-builder nsis.include）
;
; 只改「文案 + 品牌图」两层，不动安装行为：
; - 侧栏/页头图由 installerSidebar.bmp / installerHeader.bmp 提供（见 scripts/make-installer-assets.py）；
; - 这里补欢迎页与卸载欢迎页（electron-builder 的 assisted 安装器默认没有欢迎页），
;   并把完成页/目录页的说明改成产品自己的话。
;
; 注意：本文件在 electron-builder 模板的公共头部展开，MUI_* 的 !define 必须在
; 模板插入 MUI_PAGE_WELCOME / MUI_PAGE_FINISH 之前生效——所以写成 include 而不是 post 脚本。

!define MUI_WELCOMEPAGE_TITLE "安装 和鸣"
!define MUI_WELCOMEPAGE_TEXT "和鸣是一个本机优先的 AI 工作站：模型连接、工具与记忆都保存在这台设备上。$\r$\n$\r$\n下一步可以自选安装位置；卸载时不会删除你的本机数据。"

!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "和鸣已经安装好。$\r$\n$\r$\n模型 Key、工具与记忆只保存在本机。"
!define MUI_FINISHPAGE_RUN_TEXT "运行 和鸣"

!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置。数据与设置始终保存在本机，卸载时不会被删除。"

!define MUI_UNWELCOMEPAGE_TITLE "卸载 和鸣"
!define MUI_UNWELCOMEPAGE_TEXT "卸载只会移除程序，本机数据与设置会保留。"

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
