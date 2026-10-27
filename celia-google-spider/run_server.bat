@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo شغّل install_windows.bat أولًا لإنشاء بيئة .venv.
  exit /b 1
)
".venv\Scripts\python.exe" -m celia_spider.server
