@echo off
echo ========================================
echo   Pluely Development Server
echo ========================================
echo.

:: Kill any existing processes
echo Cleaning up old processes...
taskkill /F /IM "pluely.exe" 2>nul
taskkill /F /IM "cargo.exe" 2>nul
npx kill-port 1420 2>nul

:: Small delay to let processes fully terminate
timeout /t 1 /nobreak >nul

echo Starting Pluely...
echo (Press Ctrl+C to stop, then type Y to confirm)
echo.

cd /d "%~dp0"
npm run tauri dev

:: Cleanup after exit
echo.
echo Cleaning up...
npx kill-port 1420 2>nul
