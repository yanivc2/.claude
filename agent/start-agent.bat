@echo off
cd /d "%~dp0"
title AP Control - bank agent
rem npm is npm.cmd: without "call" this batch never resumes, and the window would just vanish.
call npm start
pause
