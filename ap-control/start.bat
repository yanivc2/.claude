@echo off
REM AP Control — one-click launcher for Windows.
REM Double-click this file to: pull the latest code, then start the server.
REM (Replaces the manual "git pull" + "npm start" steps.)

chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   AP Control - מושך עדכונים אחרונים...
echo ========================================
git pull

echo.
echo ========================================
echo   מפעיל את השרת... (לעצירה: Ctrl+C)
echo   בדפדפן: http://localhost:3000
echo ========================================
echo.
call npm start

REM If the server stops or fails to start, keep the window open so errors are readable.
echo.
echo ---- השרת נעצר. לחץ מקש כלשהו לסגירה. ----
pause >nul
