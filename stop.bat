@echo off
echo ========================================
echo   Stopping Pluely
echo ========================================
echo.

echo Killing Pluely processes...
taskkill /F /IM "pluely.exe" 2>nul && echo   - Killed pluely.exe || echo   - pluely.exe not running

echo Killing Cargo/Rust processes...
taskkill /F /IM "cargo.exe" 2>nul && echo   - Killed cargo.exe || echo   - cargo.exe not running

echo Killing Node processes on port 1420...
npx kill-port 1420 2>nul && echo   - Killed port 1420 || echo   - Port 1420 not in use

echo.
echo Done! All Pluely processes should be stopped.
pause
