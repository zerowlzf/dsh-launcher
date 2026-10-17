' DSH Launcher - double-click entry (no console window)
' First run installs dependencies via npmmirror mirror; later runs start instantly.
Option Explicit

Dim fso, sh, dir, electron, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
electron = dir & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(electron) Then
    cmd = "cmd /c cd /d """ & dir & """ && set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ && npm install --registry=https://registry.npmmirror.com --no-audit --no-fund && node node_modules\electron\install.js"
    sh.Run cmd, 1, True
End If

If fso.FileExists(electron) Then
    ' Electron 宿主（WorkBuddy/VS Code 等集成终端）可能注入 ELECTRON_RUN_AS_NODE=1，
    ' 使 electron.exe 退化成纯 Node 而无法作为启动器运行；从本进程环境剥掉（Explorer
    ' 双击启动本就干净，此防护覆盖从终端运行 wscript/cscript 的场景）。
    On Error Resume Next
    sh.Environment("PROCESS").Remove "ELECTRON_RUN_AS_NODE"
    On Error GoTo 0
    sh.Run """" & electron & """ """ & dir & """", 0, False
Else
    MsgBox "Electron install failed. Run 'npm install' manually in " & dir & ".", 16, "DSH Launcher"
End If