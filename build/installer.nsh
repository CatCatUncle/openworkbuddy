; 安装向导的补充脚本：electron-builder 会自动带上 build/installer.nsh（只给安装版，免安装版不用），配置里不用写。
;
; 不许装进数据文件夹。数据根是 ~/OpenWorkBuddy（设了 OPENWORKBUDDY_HOME 就是它，见 src/platform/paths.js），
; 账号、会话、工作区和成果全在里面；而升级、卸载时会把整个安装目录 RMDir /r。
; 装进去当时看不出问题，下次升级才连数据一起删光。最容易撞上的两种选法：
;   · 选了 C:\Users\<名字>：向导会在路径后面自动补一层 OpenWorkBuddy，正好补成数据文件夹
;   · 设了 OPENWORKBUDDY_HOME=D:\OpenWorkBuddy（docs/安装与启动.md 排障表里就这么教），又选了 D:\
; 选到这些位置时「下一步」是灰的，目录页上方写着为什么。
; 只管向导里手选这一步；静默安装（/S /D=…）不经过目录页，由下命令的人自己负责。

!ifndef BUILD_UNINSTALLER
  Var owbDirNote
  Var owbDir
  Var owbTmp
  Var owbLen
  Var owbPos

  !macro customInit
    ; 简体；繁体（1028 台湾、3076 香港）读简体也没问题
    ${If} $LANGUAGE == 2052
    ${OrIf} $LANGUAGE == 1028
    ${OrIf} $LANGUAGE == 3076
      StrCpy $owbDirNote "OpenWorkBuddy 数据文件夹（存工作区和成果）不能当安装位置，选中时「下一步」会变灰。"
    ${Else}
      StrCpy $owbDirNote "The OpenWorkBuddy data folder (workspace and files) can't be the install location. Next stays disabled while it's selected."
    ${EndIf}
  !macroend

  !define MUI_DIRECTORYPAGE_TEXT_TOP "$owbDirNote"

  ; 目录页每改一个字就调一次；Abort = 「下一步」变灰
  Function .onVerifyInstDir
    ; 先算出真正会装到哪：路径里没有 OpenWorkBuddy（不分大小写）就补一层，
    ; 跟 assistedInstaller.nsh 的 instFilesPre 一个算法，不然这里放行的和实际装的不是一个地方
    StrCpy $owbDir $INSTDIR
    StrLen $owbLen "${APP_FILENAME}"
    StrCpy $owbPos 0
    owbScan:
      StrCpy $owbTmp $INSTDIR $owbLen $owbPos
      StrCmp $owbTmp "${APP_FILENAME}" owbFinal
      StrCmp $owbTmp "" owbAppend
      IntOp $owbPos $owbPos + 1
      Goto owbScan
    owbAppend:
      StrCpy $owbTmp $INSTDIR 1 -1
      StrCmp $owbTmp "\" 0 +3
        StrCpy $owbDir "$INSTDIR${APP_FILENAME}"
        Goto owbFinal
      StrCpy $owbDir "$INSTDIR\${APP_FILENAME}"
    owbFinal:

    ; 1) 就是数据根（默认那个，或 OPENWORKBUDDY_HOME 指的那个）
    StrCmp $owbDir "$PROFILE\OpenWorkBuddy" owbBad
    ReadEnvStr $owbTmp OPENWORKBUDDY_HOME
    StrCmp $owbTmp "" owbNoEnv
    StrCmp $owbDir $owbTmp owbBad
    ; 2) 数据根在它底下（比如路径里本来就带着 OpenWorkBuddy 的用户目录本身）
    StrLen $owbLen "$owbDir\"
    StrCpy $owbTmp $owbTmp $owbLen
    StrCmp $owbTmp "$owbDir\" owbBad
    owbNoEnv:
    StrLen $owbLen "$owbDir\"
    StrCpy $owbTmp "$PROFILE\OpenWorkBuddy" $owbLen
    StrCmp $owbTmp "$owbDir\" owbBad
    ; 3) 里面已经是一份数据（搬过家、拷过来的）：安装目录里不会有这三样
    IfFileExists "$owbDir\config.json" owbBad
    IfFileExists "$owbDir\workspace\*.*" owbBad
    IfFileExists "$owbDir\data\*.*" owbBad
    Return
    owbBad:
      Abort
  FunctionEnd
!endif
