@echo off
echo ========================================
echo   Stopping Meetwings
echo ========================================
echo.

echo Killing Meetwings processes...
taskkill /F /IM "meetwings.exe" 2>nul && echo   - Killed meetwings.exe || echo   - meetwings.exe not running

echo Killing Cargo/Rust processes...
taskkill /F /IM "cargo.exe" 2>nul && echo   - Killed cargo.exe || echo   - cargo.exe not running

echo Killing Node processes on port 1420...
npx kill-port 1420 2>nul && echo   - Killed port 1420 || echo   - Port 1420 not in use

echo.
echo Done! All Meetwings processes should be stopped.
pause
