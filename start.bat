@echo off
setlocal enabledelayedexpansion

echo VRChat Camera Bridge Launcher
echo =============================
echo.
echo This will start both services. Keep these windows open while using the application.
echo.
pause

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if FFmpeg is installed
where ffmpeg >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: FFmpeg not found. Please install FFmpeg from https://ffmpeg.org/download.html
    echo Or run: choco install ffmpeg
    pause
    exit /b 1
)

echo Starting Spout Bridge (will open in new window)...
start "Spout Bridge" node spout-bridge.js

timeout /t 2 /nobreak

echo Starting Main Server (will open in new window)...
start "VRChat Camera Bridge" node server.js

echo.
echo =============================
echo Services started!
echo Open browser to: http://localhost:3000
echo.
echo Press any key to close this window...
pause
