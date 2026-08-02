@echo off
setlocal
cd /d "%~dp0backend"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000 :8443" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
)
ping -n 2 127.0.0.1 >nul

if not exist "..\certs\server.crt" (
    echo 首次运行，正在生成 HTTPS 证书...
    python make_cert.py
)

echo ==============================================
echo   剧本杀语音房  启动器
echo ==============================================
echo.
echo   本机访问:   http://localhost:8000  (电脑可直接语音)
echo   HTTPS:      https://localhost:8443
echo   局域网访问: https://192.168.0.119:8443
echo   (局域网 IP 请用 ipconfig 查看实际值)
echo.
echo   语音默认用「局域网直连」，无需 AppID。
echo   手机开麦需安装并信任 certs\ca.crt，且用 https 访问。
echo ==============================================
echo.
python main.py
pause
