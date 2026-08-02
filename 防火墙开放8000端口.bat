@echo off
setlocal
chcp 65001 >nul
echo 正在添加 Windows 防火墙规则, 允许局域网设备访问 8000 端口...
echo (需要以管理员身份运行本脚本)
netsh advfirewall firewall delete rule name="script_voice_8000" >nul 2>&1
netsh advfirewall firewall add rule name="script_voice_8000" dir=in action=allow protocol=TCP localport=8000
echo 完成。若无报错, 手机即可通过 http://<电脑IP>:8000 访问。
pause
