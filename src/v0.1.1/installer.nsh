; ============================================================
; QClaw NSIS 自定义安装脚本
; 包含: OpenClaw tar 解压、安装性能打点、卸载清理
; ============================================================

; ----------------------------------------
; customHeader: 编译期声明全局变量
; 在 installer.nsi 头部执行，用于声明打点所需的变量
; ----------------------------------------
!macro customHeader
  ; 性能打点变量仅在安装器编译阶段声明（卸载器阶段不需要）
  !ifndef BUILD_UNINSTALLER
    Var /GLOBAL _perf_t0
    Var /GLOBAL _perf_t1
    Var /GLOBAL _perf_t2
    Var /GLOBAL _perf_t3
    Var /GLOBAL _perf_diff
    Var /GLOBAL _perf_total
    Var /GLOBAL _perf_log_handle
  !endif
!macroend

; ----------------------------------------
; 通用上报辅助宏（内部使用）
; 通过 PowerShell Invoke-WebRequest 发送 HTTP POST 请求，
; 上报格式与客户端 report/Action 完全一致（JSON → pcmgrmonitor）。
; 失败不影响安装/卸载流程（/norestart /WindowStyle Hidden）。
;
; 参数:
;   EVENT_CODE  - 事件类型（expo / click_new）
;   ACTION_TYPE - 安装动作类型（Install / Uninstall）
; ----------------------------------------
!macro _ReportEvent EVENT_CODE ACTION_TYPE
  Push $0
  ; 读取 channel.json 获取安装渠道（afterPack 钩子写入）
  ; 默认渠道为 5001（官网）
  Push $1
  StrCpy $1 "5001"
  IfFileExists "$INSTDIR\resources\channel.json" 0 +3
    nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "try { (Get-Content \"$INSTDIR\resources\channel.json\" -Raw | ConvertFrom-Json).channel } catch { Write-Output \"5001\" }"'
    Pop $1
  ; 上报单个事件
  ; 参数格式: page_id, action_type, channel, tdbank_imp_date, event_params
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "\
    try { \
      $$body = @{ \
        app_key = \"PC_Qclaw\"; \
        version = \"1.0.0\"; \
        guid = (Get-CimInstance Win32_ComputerSystemProduct).UUID; \
        event_code = \"${EVENT_CODE}\"; \
        params = @{ \
          page_id = \"Install_Page\"; \
          action_type = \"${ACTION_TYPE}\"; \
          channel = $$1; \
          tdbank_imp_date = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString(); \
          event_params = \"Qclaw_Win\" \
        } \
      } | ConvertTo-Json -Compress; \
      Invoke-WebRequest -Uri \"https://pcmgrmonitor.3g.qq.com/datareport\" -Method POST \
        -ContentType \"application/json\" -Body $$body -TimeoutSec 5 -UseBasicParsing | Out-Null \
    } catch { }"'
  Pop $0
  Pop $1
!macroend

; ----------------------------------------
; 曝光上报宏（expo）—— 页面展示时调用一次
; 参数:
;   ACTION_TYPE - Install / Uninstall
; ----------------------------------------
!macro _ReportExpo ACTION_TYPE
  !insertmacro _ReportEvent "expo" "${ACTION_TYPE}"
!macroend

; ----------------------------------------
; 点击上报宏（click_new）—— 用户每次点击操作时调用
; 参数:
;   ACTION_TYPE - Install / Uninstall
; ----------------------------------------
!macro _ReportClick ACTION_TYPE
  !insertmacro _ReportEvent "click_new" "${ACTION_TYPE}"
!macroend

; ----------------------------------------
; 卸载曝光上报宏
; 卸载页面展示时调用一次 expo 事件（action_type=Uninstall）
; 在卸载数据清理之前调用，确保 channel.json 还可读
; ----------------------------------------
!macro _UninstallExpo
  !insertmacro _ReportExpo "Uninstall"
!macroend

; ----------------------------------------
; 卸载点击上报宏
; 用户在卸载过程中每次点击操作时调用 click_new 事件
; ----------------------------------------
!macro _UninstallClick
  !insertmacro _ReportClick "Uninstall"
!macroend

; ----------------------------------------
; customInit: 安装初始化阶段
; 执行时机: .onInit 末尾 (UAC 提权后、安装界面显示前)
; 记录 t0 + 注册表初始化 + 上报安装开始事件
; ----------------------------------------
!macro customInit
  Push $0

  ; === 性能打点: 记录 t0 (安装开始) ===
  System::Call 'kernel32::GetTickCount() i .s'
  Pop $_perf_t0

  ; === 业务逻辑: 保存用户数据目录路径到注册表（卸载时使用）===
  ; 优先读新键 com.tencent.qclaw，兼容读取旧键 com.tencent.qmclaw
  ReadRegStr $0 HKCU "Software\com.tencent.qclaw" "User_Data_Directory"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\com.tencent.qmclaw" "User_Data_Directory"
  ${EndIf}
  ${If} $0 == ""
    StrCpy $0 "$APPDATA\${PRODUCT_NAME}"
  ${EndIf}
  ; 统一写回新键，完成历史键名迁移
  WriteRegStr HKCU "Software\com.tencent.qclaw" "User_Data_Directory" "$0"

  ; === 上报安装页面曝光（expo，一次） ===
  !insertmacro _ReportExpo "Install"
  ; === 上报安装开始点击事件（click_new） ===
  !insertmacro _ReportClick "Install"

  Pop $0
!macroend

; ----------------------------------------
; customFiles_x64: 7z 包已提取到临时目录，即将开始解压
; 执行时机: extractAppPackage.nsh 中 x64_app_files 之后、decompress 之前
; 记录 t1
; ----------------------------------------
!macro customFiles_x64
  ; === 性能打点: 记录 t1 (解压前) ===
  System::Call 'kernel32::GetTickCount() i .s'
  Pop $_perf_t1
!macroend

; ----------------------------------------
; customInstall: 所有文件安装完成后
; 执行时机: installSection.nsh 末尾 (文件解压/复制/注册表/快捷方式全部完成后)
; 解压 OpenClaw tar 归档，记录性能打点
; ----------------------------------------
!macro customInstall
  ; === 性能打点: 记录 t2 (NSIS 文件安装完成，tar 解压前) ===
  System::Call 'kernel32::GetTickCount() i .s'
  Pop $_perf_t2

  ; === OpenClaw tar 解压 ===
  ; 构建时 pack-openclaw-tar.cjs 将 openclaw/ 打成单个 tar 归档
  ; 这里通过 QClaw.exe (ELECTRON_RUN_AS_NODE 模式) 执行解压脚本还原散文件目录
  DetailPrint "Extracting OpenClaw resources..."

  ; 设置 ELECTRON_RUN_AS_NODE 环境变量，使 QClaw.exe 以纯 Node.js 模式运行
  System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "1") i'

  nsExec::ExecToLog '"$INSTDIR\QClaw.exe" "$INSTDIR\resources\scripts\unpack-openclaw.cjs" "$INSTDIR"'
  Pop $0

  ; 清除环境变量，避免影响后续进程
  System::Call 'kernel32::SetEnvironmentVariableW(w "ELECTRON_RUN_AS_NODE", w "") i'

  ${If} $0 != "0"
    DetailPrint "CRITICAL: OpenClaw extraction failed (exit code: $0)"
    MessageBox MB_OK|MB_ICONSTOP "安装失败：OpenClaw 资源解压出错。$\n请重新安装或联系支持。"
    Abort
  ${EndIf}

  ; === 性能打点: 记录 t3 (tar 解压完成) ===
  System::Call 'kernel32::GetTickCount() i .s'
  Pop $_perf_t3

  ; 计算总耗时 (t0 到 t3)
  IntOp $_perf_total $_perf_t3 - $_perf_t0

  ; 写入性能日志到安装目录
  FileOpen $_perf_log_handle "$INSTDIR\install-perf.log" w
  ${If} $_perf_log_handle != ""
    FileWrite $_perf_log_handle "========================================$\r$\n"
    FileWrite $_perf_log_handle "QClaw Installer Performance Log$\r$\n"
    FileWrite $_perf_log_handle "Version: ${VERSION}$\r$\n"
    FileWrite $_perf_log_handle "InstDir: $INSTDIR$\r$\n"
    FileWrite $_perf_log_handle "========================================$\r$\n"
    FileWrite $_perf_log_handle "$\r$\n"

    ; 阶段 1: 初始化 + 旧版卸载 + 7z 提取到临时目录
    IntOp $_perf_diff $_perf_t1 - $_perf_t0
    FileWrite $_perf_log_handle "[T0 -> T1] Init + Uninstall old + Extract 7z to temp:  $_perf_diff ms$\r$\n"

    ; 阶段 2: 7z 解压 + 文件复制到安装目录 + 注册表 + 快捷方式
    IntOp $_perf_diff $_perf_t2 - $_perf_t1
    FileWrite $_perf_log_handle "[T1 -> T2] Decompress + Copy + Registry + Shortcuts:   $_perf_diff ms$\r$\n"

    ; 阶段 3: OpenClaw tar 解压
    IntOp $_perf_diff $_perf_t3 - $_perf_t2
    FileWrite $_perf_log_handle "[T2 -> T3] OpenClaw tar extraction:                    $_perf_diff ms$\r$\n"

    FileWrite $_perf_log_handle "$\r$\n"
    FileWrite $_perf_log_handle "Total install time: $_perf_total ms$\r$\n"
    FileWrite $_perf_log_handle "========================================$\r$\n"

    FileClose $_perf_log_handle
  ${EndIf}

  ; 同时输出到安装界面的详情日志
  IntOp $_perf_diff $_perf_t1 - $_perf_t0
  DetailPrint "Install perf: phase1(init+uninstall+extract)=$_perf_diff ms"
  IntOp $_perf_diff $_perf_t2 - $_perf_t1
  DetailPrint "Install perf: phase2(decompress+copy+registry)=$_perf_diff ms"
  IntOp $_perf_diff $_perf_t3 - $_perf_t2
  DetailPrint "Install perf: phase3(openclaw-tar-extract)=$_perf_diff ms"
  DetailPrint "Install perf: total=$_perf_total ms"

  ; === 上报安装完成点击事件（click_new） ===
  !insertmacro _ReportClick "Install"
!macroend

; ----------------------------------------
; customUnInit: 卸载初始化
; 执行时机: 卸载程序 un.onInit 末尾
; 上报卸载事件，询问用户是否删除数据，执行清理
; ----------------------------------------
!macro customUnInit
  ; === 上报卸载页面曝光（expo，一次，在数据清理之前确保 channel.json 可读） ===
  !insertmacro _UninstallExpo

  Push $0

  ; === 上报卸载确认弹窗点击事件（click_new） ===
  !insertmacro _UninstallClick

  ; 静默卸载时跳过确认与数据清理，避免阻塞
  IfSilent SkipCleanup 0
  MessageBox MB_ICONQUESTION|MB_YESNO "是否删除用户数据和配置？$\n$\n这包括：$\n• 用户配置文件$\n• 本地存储数据$\n• 聊天记录$\n• OpenClaw 运行时数据 (~/.qclaw) 等" IDNO SkipCleanup

  ; 获取应用用户数据目录（优先新键，兼容旧键）
  ReadRegStr $0 HKCU "Software\com.tencent.qclaw" "User_Data_Directory"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\com.tencent.qmclaw" "User_Data_Directory"
  ${EndIf}
  ${If} $0 != ""
    ; 删除用户数据目录（配置文件、聊天记录等）
    RMDir /r /REBOOTOK "$0"
  ${EndIf}

  ; 清理当前版本默认用户数据目录（QClaw）
  RMDir /r /REBOOTOK "$APPDATA\${PRODUCT_NAME}"
  RMDir /r /REBOOTOK "$LOCALAPPDATA\${PRODUCT_NAME}"

  ; 兼容旧版本默认用户数据目录（com.tencent.qmclaw）
  RMDir /r /REBOOTOK "$APPDATA\com.tencent.qmclaw"
  RMDir /r /REBOOTOK "$LOCALAPPDATA\com.tencent.qmclaw"

  ; 删除 OpenClaw 运行时数据目录（~/.qclaw）
  RMDir /r /REBOOTOK "$PROFILE\.qclaw"

  ; 删除注册表键值（清理新旧键名）
  DeleteRegKey HKCU "Software\com.tencent.qclaw"
  DeleteRegKey HKCU "Software\com.tencent.qmclaw"

  ; 删除快捷方式
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall ${PRODUCT_NAME}.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"

  SkipCleanup:

  Pop $0
!macroend

; ----------------------------------------
; customAbort: 用户取消安装
; 执行时机: 用户点击取消按钮或关闭安装窗口
; 上报安装取消事件
; ----------------------------------------
!macro customAbort
  ; === 上报安装取消点击事件（click_new） ===
  !insertmacro _ReportClick "Install"
!macroend
