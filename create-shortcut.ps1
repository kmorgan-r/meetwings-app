$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\Pluely.lnk")
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$env:USERPROFILE\pluely\run-dev.ps1`""
$Shortcut.WorkingDirectory = "$env:USERPROFILE\pluely"
$Shortcut.Description = "Launch Pluely"
$Shortcut.Save()
Write-Host "Shortcut created on Desktop!"
