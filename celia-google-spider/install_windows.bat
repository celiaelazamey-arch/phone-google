@echo off
setlocal
cd /d "%~dp0"

echo [Celia Google Spider] إنشاء بيئة Python وتثبيت الحزم...
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 -m venv .venv
) else (
  python -m venv .venv
)
if not exist ".venv\Scripts\python.exe" (
  echo فشل إنشاء .venv — تأكد من تثبيت Python 3.11 أو أحدث.
  exit /b 1
)

".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 exit /b 1
".venv\Scripts\python.exe" -m pip install -e .
if errorlevel 1 exit /b 1

echo.
echo اكتمل التثبيت. الخطوات التالية:
echo   1) ضع credentials.json من Google Cloud بجوار هذا الملف.
echo   2) .venv\Scripts\python.exe -m celia_spider.auth
echo   3) .venv\Scripts\python.exe -m celia_spider.check --live
echo   4) شغّل run_server.bat ثم اربطه بعميل MCP يدعم stdio.
exit /b 0
