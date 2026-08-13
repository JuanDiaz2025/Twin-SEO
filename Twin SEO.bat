@echo off
title Twin SEO
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Twin SEO needs Node.js, which is not installed on this PC.
  echo.
  echo   Opening the download page. Pick the "LTS" installer, click through
  echo   it, then double-click this file again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

echo.
echo   Starting Twin SEO. Your browser will open in a moment.
echo   Leave this window open while you use it; close it to stop.
echo.

node "app\server.js" --open
echo.
echo   Twin SEO has stopped.
pause
