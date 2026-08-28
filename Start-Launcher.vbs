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
    sh.Run """" & electron & """ """ & dir & """", 0, False
Else
    MsgBox "Electron install failed. Run 'npm install' manually in " & dir & ".", 16, "DSH Launcher"
End If