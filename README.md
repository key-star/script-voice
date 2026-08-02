---
sdk: docker
app_port: 7860
---

# 剧本杀语音房 (script_voice)

多人在线剧本杀语音房：语音上麦（DM + 20 玩家 + 旁观者）、角色分配/自选、线索、投票、BGM、聊天。

- 后端：FastAPI + WebSocket（房间/角色/投票/阶段为进程内存态，重启即清空）
- 前端：原生 JS（`frontend/`）
- 语音：局域网直连（WebRTC mesh）或声网 Agora（跨网，需 AppID）

## 运行

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 7860
```

> 平台约定了 7860 端口；必须**单 worker** 运行（多 worker 会各自持有房间状态）。
> HTTPS 由创空间平台提供，本地无需证书。
