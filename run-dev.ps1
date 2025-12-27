$env:Path = $env:Path + ";C:\Users\kmorg\.cargo\bin"
Set-Location "C:\Users\kmorg\pluely"
Write-Host "Cargo version:" -ForegroundColor Green
cargo --version
Write-Host "Starting Tauri dev..." -ForegroundColor Green
npm run tauri dev
