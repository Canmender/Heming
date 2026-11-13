; 和鸣 Windows 安装器外观与卸载行为（electron-builder nsis.include）
;
; 两类改动：
; - 外观层：侧栏/页头图由 installerSidebar.bmp / installerHeader.bmp 提供（见 scripts/make-installer-assets.py）；
;   这里补欢迎页（electron-builder 的 assisted 安装器默认没有欢迎页），
;   并把完成页/目录页的说明改成产品自己的话。
; - 行为层，只三处：
;   1) 安装中途取消要二次确认（assisted 默认点「取消」直接退出，半截文件留在目录里没人交代）；
;   2) 卸载时把「data 文件夹怎么办」交给用户选，默认保留；
;   3) 静默卸载（/S）不弹窗，默认保留 data；带 --delete-app-data 时才删。
;
; 为什么 data 要单独处理：打包版的用户数据根就是「<安装目录>/data」
; （见 packages/desktop/data-root.js），登录态、插件、知识库、记忆都在里面。
; 卸载器默认 RMDir /r $INSTDIR 会把它们一起删掉，且不可恢复。
;
; 注意：本文件在 electron-builder 模板的公共头部展开（早于 !include "MUI2.nsh"），
; 因此 MUI_* 的 !define 必须在模板插入页面宏之前生效——所以写成 include 而不是 post 脚本；
; 而自定义卸载页的函数体依赖 nsDialogs 宏，必须等到 MUI2 之后才展开，
; 所以放进 customUnWelcomePage 宏里（该宏在 assistedInstaller.nsh 中、MUI2 之后展开）。
;
; 刻意没做的事（试过或评估后放弃，记在这里免得下一轮再查一遍）：
; - 页头那行「和鸣 140.3.56」由 electron-builder 按 semver 写死，改它要 !undef MUI 宏，
;   而那发生在 MUI2.nsh 之后、我们够不到的位置；5 段版本号是产品自己的账，交给应用内的关于页。
; - 安装模式页（「为哪位用户安装」）的文案来自 multiUserUi.nsh 内置 LangString，
;   覆盖它需要重定义 MUI 的页面宏，收益不抵风险。

!define HEMING_DATA_DIR "data"

# 安装器的页面文案。MUI 的欢迎页对安装器/卸载器用的是同一组 define 名（MUI_WELCOMEPAGE_*），
# 所以两份脚本各写一遍、各在各自的分支里生效——之前写成 MUI_UNWELCOMEPAGE_* 是无效的，
# 实测卸载器欢迎页显示的是「安装 和鸣」的文案。
!ifndef BUILD_UNINSTALLER

!define MUI_WELCOMEPAGE_TITLE "安装 和鸣"
!define MUI_WELCOMEPAGE_TEXT "和鸣是一个本机优先的 AI 工作站：模型连接、工具与记忆都保存在这台设备上。$\r$\n$\r$\n下一步可以自选安装位置；以后卸载时可以自己决定要不要保留这些数据。"

!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "和鸣已经安装好。$\r$\n$\r$\n模型 Key、工具与记忆只保存在本机。"
!define MUI_FINISHPAGE_RUN_TEXT "运行 和鸣"

!define MUI_DIRECTORYPAGE_TEXT_TOP "选择安装位置。登录状态、插件与知识库等数据会存到这里的 data 文件夹。"

; 安装中途点「取消 / 关闭窗口」时的确认。文案说清楚会发生什么，而不是只问「确定吗」。
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "安装还没完成。现在退出的话，已经解到安装目录里的文件会留在那里，下次要重新运行安装程序才能补全。确定退出吗？"

!else

!define MUI_WELCOMEPAGE_TITLE "卸载 和鸣"
!define MUI_WELCOMEPAGE_TEXT "接下来会移除程序本体。$\r$\n$\r$\n你的数据（登录状态、插件、知识库、记忆）在安装目录下的 data 文件夹里，下一步会让你决定保留还是删除。"

; 卸载完成页同样是 MUI_FINISHPAGE_* 这组共享名字（MUI2 的 Finish.nsh 用 MUI_UNSET 复用）。
; 文案不能假装知道用户刚才勾没勾，只说明两种结果各自落在哪里。
!define MUI_FINISHPAGE_TITLE "卸载完成"
!define MUI_FINISHPAGE_TEXT "和鸣 已从这台电脑移除。$\r$\n$\r$\n如果刚才没有勾选「同时删除这个文件夹」，数据还在安装目录下的 data 文件夹里；勾了就一并清空了。"

!endif

; 卸载选项的状态："" / "0" = 保留，1 = 一并删除。默认保留（删数据不可恢复，宁可让用户显式勾选）。
; 只在卸载器脚本里声明：安装器里用不到，声明了会触发 NSIS 6001（变量未使用）而被当作错误。
!ifdef BUILD_UNINSTALLER
  Var hemingDeleteData
  Var hemingKeepDataCheckbox
  Var hemingKeepPath
  Var hemingDataMoved
!endif

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME

  ; 只在卸载器里展开。
  !ifdef BUILD_UNINSTALLER
    UninstPage custom un.hemingKeepDataShow un.hemingKeepDataLeave

    Function un.hemingKeepDataShow
      !insertmacro MUI_HEADER_TEXT "数据怎么处理" "安装目录下的 data 文件夹"

      ; 静默卸载不会走到这里，默认值由 customUnInit 落定；这里兜一次底。
      ${If} $hemingDeleteData == ""
        StrCpy $hemingDeleteData "0"
      ${EndIf}

      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0 0 100% 26u "和鸣的登录状态、插件、知识库与记忆都保存在："
      Pop $0

      ${NSD_CreateLabel} 0 26u 100% 22u "$INSTDIR\${HEMING_DATA_DIR}"
      Pop $0

      ${NSD_CreateCheckbox} 0 60u 100% 22u "同时删除这个文件夹（登录状态、插件、知识库一并清空）"
      Pop $hemingKeepDataCheckbox
      ${NSD_SetState} $hemingKeepDataCheckbox ${BST_UNCHECKED}

      ${NSD_CreateLabel} 0 90u 100% 46u "不勾选（默认）：data 留在原处，以后重新安装到同一个目录可以接着用，换目录或重装系统前记得先备份。$\r$\n勾选：全部删除，无法恢复。"
      Pop $0

      nsDialogs::Show
    FunctionEnd

    Function un.hemingKeepDataLeave
      ${NSD_GetState} $hemingKeepDataCheckbox $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $hemingDeleteData "1"
      ${Else}
        StrCpy $hemingDeleteData "0"
      ${EndIf}
    FunctionEnd
  !endif
!macroend

; 卸载器的默认数据处理方式：静默卸载（/S）不弹窗，默认保留；
; 显式带 --delete-app-data 时才删（与 electron-builder 自己的删除 AppData 约定一致）。
!macro customUnInit
  StrCpy $hemingDeleteData "0"
  ${GetParameters} $R0
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    StrCpy $hemingDeleteData "1"
  ${EndIf}
!macroend

; 替换 electron-builder 的默认「RMDir /r $INSTDIR」：
; 先把 data 挪到 $PLUGINSDIR，删完程序文件再按用户选择放回或丢弃（更新场景沿用原子搬移逻辑）。
!macro customRemoveFiles
  ; 暂存目录必须和 $INSTDIR 同卷：$PLUGINSDIR 在 %TEMP%（可能另一块盘），跨卷 Rename 会直接失败，
  ; 失败后 data 会被后面的 RMDir /r 一并删掉——这正是第一次实跑踩到的坑。
  ${GetParent} "$INSTDIR" $hemingKeepPath
  StrCpy $hemingKeepPath "$hemingKeepPath\heming-keep-data"

  StrCpy $hemingDataMoved "0"
  ${If} ${FileExists} "$INSTDIR\${HEMING_DATA_DIR}\*.*"
    RMDir /r "$hemingKeepPath"
    CreateDirectory "$hemingKeepPath"
    ClearErrors
    Rename "$INSTDIR\${HEMING_DATA_DIR}" "$hemingKeepPath\${HEMING_DATA_DIR}"
    ${IfNot} ${Errors}
      StrCpy $hemingDataMoved "1"
      DetailPrint "已暂存 $INSTDIR\${HEMING_DATA_DIR}，等待处理。"
    ${Else}
      DetailPrint "无法暂存 ${HEMING_DATA_DIR}（跨卷或被占用），本次会随程序目录一起删除。"
    ${EndIf}
  ${EndIf}

  ${If} ${isUpdated}
    CreateDirectory "$PLUGINSDIR\old-install"

    Push ""
    Call un.atomicRMDir
    Pop $R0

    ${If} $R0 != 0
      DetailPrint "File is busy, aborting: $R0"

      Push ""
      Call un.restoreFiles
      Pop $R0

      Abort `Can't rename "$INSTDIR" to "$PLUGINSDIR\old-install".`
    ${EndIf}
  ${EndIf}

  SetOutPath $TEMP
  RMDir /r $INSTDIR

  ${If} $hemingDataMoved == "1"
    ${If} $hemingDeleteData == "1"
      RMDir /r "$hemingKeepPath"
      DetailPrint "按选择删除 ${HEMING_DATA_DIR}。"
    ${Else}
      CreateDirectory "$INSTDIR"
      Rename "$hemingKeepPath\${HEMING_DATA_DIR}" "$INSTDIR\${HEMING_DATA_DIR}"
      RMDir "$hemingKeepPath"
      DetailPrint "已保留数据：$INSTDIR\${HEMING_DATA_DIR}"
    ${EndIf}
  ${EndIf}
!macroend