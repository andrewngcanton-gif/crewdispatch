Unicode True
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

!ifndef VERSION
  !error "VERSION must be defined"
!endif
!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR must be defined"
!endif
!ifndef OUTPUT_FILE
  !define OUTPUT_FILE "CrewDispatch-Setup-${VERSION}.exe"
!endif

!define PRODUCT_NAME "CrewDispatch"
!define PRODUCT_PUBLISHER "CrewDispatch"
!define PRODUCT_WEB_SITE "https://github.com/andrewngcanton-gif/crewdispatch"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CrewDispatch"
!define PRODUCT_KEY "Software\CrewDispatch"

Name "${PRODUCT_NAME} ${VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\CrewDispatch"
InstallDirRegKey HKCU "${PRODUCT_KEY}" "InstallLocation"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
BrandingText "CrewDispatch"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

Var NodeExe
Var RemoveData
Var RemoveDataCheckbox

Function .onInit
  SearchPath $NodeExe "node.exe"
  ${If} $NodeExe == ""
    MessageBox MB_ICONSTOP|MB_OK "CrewDispatch requires Node.js 22 or newer. Install Node.js, then run this setup again."
    Abort
  ${EndIf}
  nsExec::ExecToStack '"$NodeExe" -e "process.exit(parseInt(process.versions.node,10)>=22?0:1)"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "CrewDispatch requires Node.js 22 or newer. Current Node.js did not pass the version check."
    Abort
  ${EndIf}
FunctionEnd

Section "CrewDispatch" SEC_MAIN
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${PAYLOAD_DIR}/*"

  StrCpy $0 "install"
  IfFileExists "$INSTDIR\.jobquay-install.json" 0 +2
    StrCpy $0 "upgrade"

  nsExec::ExecToStack '"$NodeExe" "$PLUGINSDIR\payload\dist\cli\install-cli.js" $0 --target "$INSTDIR"'
  Pop $1
  Pop $2
  ${If} $1 != 0
    MessageBox MB_ICONSTOP|MB_OK "CrewDispatch setup failed.$\r$\n$\r$\n$2"
    Abort
  ${EndIf}

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\CrewDispatch"
  CreateShortCut "$SMPROGRAMS\CrewDispatch\CrewDispatch Dashboard.lnk" "$INSTDIR\bin\crewdispatch.cmd" "web"
  CreateShortCut "$SMPROGRAMS\CrewDispatch\Uninstall CrewDispatch.lnk" "$INSTDIR\Uninstall.exe"

  WriteRegStr HKCU "${PRODUCT_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${PRODUCT_KEY}" "NodePath" "$NodeExe"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "CrewDispatch"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Function un.RemoveDataPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 30u "CrewDispatch program files and unmodified Codex/Claude integration will be removed. Node.js, Command Code and WorkBuddy AI are never removed."
  Pop $1
  ${NSD_CreateCheckbox} 0 42u 100% 24u "Also remove all CrewDispatch jobs, logs, settings and history"
  Pop $RemoveDataCheckbox
  ${NSD_Uncheck} $RemoveDataCheckbox
  nsDialogs::Show
FunctionEnd

Function un.RemoveDataPageLeave
  ${NSD_GetState} $RemoveDataCheckbox $RemoveData
FunctionEnd

!insertmacro MUI_UNPAGE_WELCOME
UninstPage custom un.RemoveDataPage un.RemoveDataPageLeave
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

Section "Uninstall"
  SetShellVarContext current
  ReadRegStr $NodeExe HKCU "${PRODUCT_KEY}" "NodePath"
  ${If} $NodeExe == ""
    SearchPath $NodeExe "node.exe"
  ${EndIf}
  ${If} $NodeExe == ""
    MessageBox MB_ICONSTOP|MB_OK "Node.js could not be found. Reinstall Node.js 22+ before running the CrewDispatch uninstaller."
    Abort
  ${EndIf}

  StrCpy $0 ""
  ${If} $RemoveData == ${BST_CHECKED}
    StrCpy $0 " --purge-data"
  ${EndIf}
  nsExec::ExecToStack '"$NodeExe" "$INSTDIR\dist\cli\install-cli.js" complete-uninstall --target "$INSTDIR"$0'
  Pop $1
  Pop $2
  ${If} $1 != 0
    MessageBox MB_ICONSTOP|MB_OK "CrewDispatch uninstall could not complete.$\r$\n$\r$\n$2"
    Abort
  ${EndIf}
  IfSilent +2
    MessageBox MB_ICONINFORMATION|MB_OK "CrewDispatch managed uninstall report:$\r$\n$\r$\n$2"

  Delete "$SMPROGRAMS\CrewDispatch\CrewDispatch Dashboard.lnk"
  Delete "$SMPROGRAMS\CrewDispatch\Uninstall CrewDispatch.lnk"
  RMDir "$SMPROGRAMS\CrewDispatch"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${PRODUCT_KEY}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
