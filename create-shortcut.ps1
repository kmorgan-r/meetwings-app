$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\Meetwings.lnk")
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$env:USERPROFILE\meetwings\run-dev.ps1`""
$Shortcut.WorkingDirectory = "$env:USERPROFILE\meetwings"
$Shortcut.Description = "Launch Meetwings"
$Shortcut.Save()
Write-Host "Shortcut created on Desktop!"
