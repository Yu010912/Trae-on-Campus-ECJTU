@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 昌衢 Changqu

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未检测到 Python。请先安装 Python 3.9 或更高版本，并勾选 Add Python to PATH。
  echo 下载地址：https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

echo 正在启动昌衢 Changqu...
echo 浏览器会自动打开；关闭本窗口即可停止服务。
echo.
start "昌衢 Changqu" cmd /k python start.py
