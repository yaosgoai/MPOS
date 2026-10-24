@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Local test server: http://localhost:8080/  (admin PIN 1234)
start "" http://localhost:8080/
node tests\e2e\harness.js
pause
