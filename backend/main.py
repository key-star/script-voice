"""剧本杀语音房 后端服务

启动：
    uvicorn main:app --host 0.0.0.0 --port 8000
或直接：
    python main.py
"""
import os
import socket
import threading
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.websockets import WebSocketState

from game import GAME, MAX_SEATS
from rtc_token import get_rtc_token

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR.parent / 'frontend'
CERT_DIR = BASE_DIR.parent / 'certs'

UPLOAD_DIR = BASE_DIR / 'uploads'
BGM_ALLOWED_EXTS = {'.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.aac', '.flac', '.webm', '.opus'}
MAX_BGM_SIZE = 200 * 1024 * 1024        # 保护性上限（平台本身无限制，可调）
UPLOAD_DIR.mkdir(exist_ok=True)


def lan_ip():
    """探测本机局域网 IP（供手机访问 HTTPS 使用）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()

app = FastAPI(title='剧本杀语音房')

# 每个房间维护的 WebSocket 连接：room_id -> { uid: WebSocket }
room_conns = {}


def _delete_bgm_file(room):
    """删除房间关联的 BGM 文件（容错）。"""
    f = room.bgm.get('file', '') if room else ''
    if f:
        try:
            p = UPLOAD_DIR / os.path.basename(f)
            if p.exists():
                p.unlink()
        except Exception:
            pass


def _room_cleanup_loop():
    """后台清理：删除无人在线超过 TTL 的空房间（默认 5 小时）。"""
    while True:
        try:
            for room in GAME.cleanup_expired_rooms():
                room_conns.pop(room.id, None)
                _delete_bgm_file(room)
                print(f'[cleanup] 空房间已删除: {room.id}', flush=True)
        except Exception:
            pass
        time.sleep(60)


threading.Thread(target=_room_cleanup_loop, daemon=True).start()


# ---------------- 基础模型 ----------------
class CreateRoomReq(BaseModel):
    name: str
    host_uid: str
    host_name: str
    password: str = ''


class JoinRoomReq(BaseModel):
    password: str = ''


class ScriptReq(BaseModel):
    text: str


class TimerReq(BaseModel):
    seconds: int
    action: str = 'start'


class RtcTokenReq(BaseModel):
    provider: str = 'trtc'      # trtc / agora
    room_id: str = ''
    uid: str = ''


# ---------------- 静态文件 ----------------
app.mount('/static', StaticFiles(directory=str(FRONTEND_DIR)), name='static')


@app.get('/')
def index():
    return FileResponse(str(FRONTEND_DIR / 'index.html'))


@app.get('/certs/ca.crt')
def download_ca():
    """供手机/电脑浏览器直接下载 CA 证书。"""
    ca = CERT_DIR / 'ca.crt'
    if not ca.exists():
        raise HTTPException(404, '证书不存在，请先在电脑上运行 python make_cert.py')
    return FileResponse(str(ca), media_type='application/x-x509-ca-cert', filename='ca.crt')


@app.get('/guide')
def guide():
    """手机语音配置说明页（自动填入本机局域网 HTTPS 地址）。"""
    path = FRONTEND_DIR / 'guide.html'
    if not path.exists():
        raise HTTPException(404, 'guide.html 不存在')
    html = path.read_text(encoding='utf-8')
    ip = lan_ip()
    html = html.replace('__HTTPS_URL__', f'https://{ip}:8443')
    html = html.replace('__HTTP_URL__', f'http://{ip}:8000')
    html = html.replace('__LAN_IP__', ip)
    return HTMLResponse(html)


# ---------------- 房间 REST API ----------------
@app.post('/api/rooms')
def create_room(req: CreateRoomReq):
    if not req.name.strip():
        raise HTTPException(400, '房间名不能为空')
    room = GAME.create_room(req.name.strip(), req.host_uid, req.host_name, req.password)
    return {'room_id': room.id}


@app.get('/api/rooms')
def list_rooms():
    return {'rooms': GAME.list_rooms()}


@app.post('/api/rooms/{room_id}/join')
def join_room(room_id: str, req: JoinRoomReq):
    # 需要 uid/name，这里由前端先通过 /api/rooms/{id}/enter 进入
    raise HTTPException(400, '请通过 WebSocket 进入房间')


@app.get('/api/rooms/{room_id}')
def room_state(room_id: str, viewer: str = ''):
    room = GAME.get_room(room_id)
    if room is None:
        raise HTTPException(404, '房间不存在')
    return room.to_public(viewer)


# ---------------- RTC 令牌 ----------------
@app.post('/api/rtc/token')
def rtc_token(req: RtcTokenReq):
    """为指定 RTC 引擎签发令牌（TRTC userSig 现成可用，Agora 为骨架）。"""
    try:
        return get_rtc_token(req.provider, req.room_id, req.uid)
    except NotImplementedError as e:
        raise HTTPException(501, str(e))


# ---------------- 剧本库 ----------------
@app.get('/api/scripts')
def list_scripts():
    """列出剧本示例文件夹里的剧本（用于一键导入）。"""
    d = BASE_DIR.parent / '剧本示例'
    out = []
    if d.exists():
        for f in sorted(d.glob('*.txt')):
            out.append({'name': f.stem})
    return {'scripts': out}


@app.get('/api/scripts/{name}')
def get_script(name: str):
    d = BASE_DIR.parent / '剧本示例'
    for f in d.glob('*.txt'):
        if f.stem == name:
            return {'name': f.stem, 'content': f.read_text(encoding='utf-8', errors='replace')}
    raise HTTPException(404, '剧本不存在')


# ---------------- 背景音乐（BGM） ----------------
@app.post('/api/rooms/{room_id}/bgm')
async def upload_bgm(room_id: str, file: UploadFile = File(...), viewer: str = ''):
    """上传 BGM（仅 DM 可操作）。存储到 uploads/，返回可播放 URL。"""
    room = GAME.get_room(room_id)
    if room is None:
        raise HTTPException(404, '房间不存在')
    if not GAME._is_dm(room, viewer):
        raise HTTPException(403, '只有 DM（0 麦）可以上传 BGM')

    original = file.filename or ''
    ext = os.path.splitext(original)[1].lower()
    if ext not in BGM_ALLOWED_EXTS:
        raise HTTPException(400, f'不支持的文件格式「{ext or "未知"}」，支持: {" ".join(sorted(BGM_ALLOWED_EXTS))}')

    fname = f'{room_id}_{int(time.time() * 1000)}{ext}'
    dest = UPLOAD_DIR / fname
    size = 0
    try:
        with open(dest, 'wb') as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BGM_SIZE:
                    raise HTTPException(413, f'文件过大（上限 {MAX_BGM_SIZE // (1024 * 1024)}MB）')
                out.write(chunk)
    except HTTPException:
        try:
            dest.unlink(missing_ok=True)
        except Exception:
            pass
        raise
    if size == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, '文件为空')

    # 登记 BGM 并删除旧文件
    old = room.bgm.get('file', '')
    title = os.path.splitext(original)[0][:80]
    GAME.set_bgm_file(room, fname, title)
    if old and old != fname:
        try:
            p = UPLOAD_DIR / os.path.basename(old)
            if p.exists():
                p.unlink()
        except Exception:
            pass
    return {'url': f'/bgm/{fname}', 'title': title, 'filename': fname}


@app.get('/bgm/{filename}')
def get_bgm(filename: str):
    """播放 BGM 文件（仅允许上传目录内的文件，防目录穿越）。"""
    if os.path.basename(filename) != filename or not filename:
        raise HTTPException(400, '非法文件名')
    path = UPLOAD_DIR / filename
    if not path.exists():
        raise HTTPException(404, 'BGM 不存在')
    return FileResponse(str(path))


# ---------------- WebSocket ----------------
@app.websocket('/ws/{room_id}')
async def ws_endpoint(ws: WebSocket, room_id: str):
    await ws.accept()
    my_uid = None
    conns = room_conns.setdefault(room_id, {})
    try:
        while True:
            msg = await ws.receive_json()
            kind = msg.get('type')

            # 进入房间：建立身份
            if kind == 'enter':
                uid = msg.get('uid', '')
                name = msg.get('name', '').strip() or '玩家'
                password = msg.get('password', '')
                room = GAME.get_room(room_id)
                if room is None:
                    await ws.send_json({'type': 'error', 'msg': '房间不存在'})
                    continue
                room, err = GAME.join_room(room_id, uid, name, password)
                if room is None:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                my_uid = uid
                conns[uid] = ws
                was_offline = not room.users[uid].online
                room.users[uid].online = True
                await ws.send_json({
                    'type': 'entered',
                    'user': room.users[uid].to_private(),
                    'room': room.to_public(uid),
                })
                if was_offline:
                    await broadcast(room_id, {'type': 'notice', 'text': f'{name} 回到房间'})
                    GAME.log_event(room, f'{name} 回到房间')
                else:
                    await broadcast(room_id, {'type': 'notice', 'text': f'{name} 进入了房间'})
                await broadcast_state(room_id)
                continue

            if my_uid is None:
                await ws.send_json({'type': 'error', 'msg': '请先进入房间'})
                continue

            room = GAME.get_room(room_id)
            if room is None:
                await ws.send_json({'type': 'error', 'msg': '房间不存在'})
                continue
            user = room.users.get(my_uid)
            if user is None:
                await ws.send_json({'type': 'error', 'msg': '不在房间内'})
                continue

            # 公屏/私聊
            if kind == 'chat':
                text = (msg.get('text') or '').strip()
                if not text:
                    continue
                if len(text) > 500:
                    text = text[:500]
                if msg.get('to') == 'all':
                    chat = GAME.add_chat(room, my_uid, user.name, text)
                    await broadcast(room_id, {'type': 'chat', **chat})
                else:
                    to_uid = msg.get('to_uid', '')
                    if to_uid in room.users:
                        pkt = {
                            'type': 'chat', 'from': my_uid, 'name': user.name,
                            'text': text, 'to': 'private',
                            'to_uid': to_uid,
                            'to_name': room.users[to_uid].name,
                            'time': time.strftime('%H:%M:%S'),
                        }
                        await send_to(room_id, to_uid, pkt)
                        await send_to(room_id, my_uid, pkt)

            # 上麦/下麦
            elif kind == 'seat':
                seat = msg.get('seat', -1)
                if msg.get('leave'):
                    GAME.leave_seat(room, my_uid)
                else:
                    err = GAME.sit(room, my_uid, int(seat))
                    if err:
                        await ws.send_json({'type': 'error', 'msg': err})
                await broadcast_state(room_id)

            # WebRTC 信令转发（局域网直连语音）
            elif kind == 'rtc':
                to_uid = msg.get('to_uid', '')
                if to_uid in room.users:
                    await send_to(room_id, to_uid, {
                        'type': 'rtc',
                        'from': my_uid,
                        'payload': msg.get('payload', {}),
                    })

            # 静音/取消静音（本地音轨 + 状态广播）
            elif kind == 'mic':
                muted = bool(msg.get('muted', True))
                if not muted and user.host_muted:
                    await ws.send_json({'type': 'error', 'msg': 'DM 已将你闭麦，请等待 DM 解除'})
                    continue
                user.muted = muted
                await broadcast_state(room_id)

            # 房主操作
            elif kind == 'script':
                if room.seats[0] != my_uid:
                    await ws.send_json({'type': 'error', 'msg': '只有 DM 可以设置剧本'})
                    continue
                err = GAME.set_script(room, my_uid, msg.get('text', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                GAME.log_event(room, 'DM 更新了剧本')
                await broadcast(room_id, {'type': 'notice', 'text': 'DM 更新了剧本'})
                await broadcast_state(room_id)

            elif kind == 'assign_roles':
                if room.seats[0] != my_uid:
                    await ws.send_json({'type': 'error', 'msg': '只有 DM 可以分配角色'})
                    continue
                err = GAME.assign_roles(room, my_uid)
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                GAME.log_event(room, '角色已分配')
                await broadcast(room_id, {'type': 'notice', 'text': '角色已分配，请查看你的剧本'})
                await broadcast_private(room_id)

            elif kind == 'assign_mode':
                if room.seats[0] != my_uid:
                    await ws.send_json({'type': 'error', 'msg': '只有 DM 可以切换分配方式'})
                    continue
                err = GAME.set_assign_mode(room, my_uid, msg.get('mode', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                else:
                    names = {'auto': '自动分配', 'dm': 'DM 手动指定', 'self': '玩家自选'}
                    await broadcast(room_id, {'type': 'notice', 'text': f'角色分配方式切换为【{names.get(room.assign_mode, room.assign_mode)}】'})
                await broadcast_state(room_id)

            elif kind == 'reset_roles':
                if room.seats[0] != my_uid:
                    await ws.send_json({'type': 'error', 'msg': '只有 DM 可以重置角色'})
                    continue
                err = GAME.reset_roles(room, my_uid)
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                GAME.log_event(room, '角色已重置')
                await broadcast(room_id, {'type': 'notice', 'text': '角色已重置'})
                await broadcast_private(room_id)

            elif kind == 'dm_assign':
                if room.seats[0] != my_uid:
                    await ws.send_json({'type': 'error', 'msg': '只有 DM 可以指定角色'})
                    continue
                err = GAME.dm_assign_role(room, my_uid, msg.get('uid', ''), msg.get('role', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                else:
                    GAME.log_event(room, f'DM 指定了角色')
                await broadcast_state(room_id)

            elif kind == 'claim_role':
                err = GAME.self_claim_role(room, my_uid, msg.get('role', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                else:
                    GAME.log_event(room, f'{user.name} 选择了角色')
                    await broadcast(room_id, {'type': 'notice', 'text': f'{user.name} 选择了角色'})
                await broadcast_state(room_id)

            elif kind == 'bgm':
                err = GAME.bgm_ctrl(room, my_uid, msg.get('action', ''), msg)
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                await broadcast_state(room_id)

            elif kind == 'stage':
                if room.seats[0] != my_uid:
                    await ws.send_json({'type': 'error', 'msg': '只有 DM 可以切换阶段'})
                    continue
                err = GAME.set_stage(room, my_uid, msg.get('stage', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                await broadcast(room_id, {'type': 'notice', 'text': f"阶段切换为【{room.stage}】"})
                await broadcast_state(room_id)

            elif kind == 'timer':
                err = GAME.start_timer(room, max(1, int(msg.get('seconds', 60))), my_uid)
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                await broadcast_state(room_id)

            elif kind == 'stop_timer':
                GAME.stop_timer(room)
                await broadcast_state(room_id)

            elif kind == 'kick':
                if room.seats[0] != my_uid:
                    await ws.send_json({'type': 'error', 'msg': '只有 DM 可以踢人'})
                    continue
                target, err = GAME.kick(room, my_uid, msg.get('uid', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                victim_ws = conns.get(target.uid)
                if victim_ws:
                    try:
                        await victim_ws.send_json({'type': 'kicked', 'msg': '你已被 DM 移出房间'})
                    except Exception:
                        pass
                    try:
                        await victim_ws.close()
                    except Exception:
                        pass
                await broadcast(room_id, {'type': 'notice', 'text': f'{target.name} 被移出房间'})
                await broadcast_state(room_id)

            # DM 管理：公告 / 线索 / 控麦 / 轮次 / 发言 / 查看剧本
            elif kind == 'announcement':
                err = GAME.set_announcement(room, my_uid, msg.get('text', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                await broadcast_state(room_id)

            elif kind == 'add_clue':
                err = GAME.add_clue(room, my_uid, msg.get('text', ''), msg.get('visible_to', 'all'))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                await broadcast(room_id, {'type': 'notice', 'text': 'DM 发放了新的线索'})
                await broadcast_state(room_id)

            elif kind == 'host_mute':
                err = GAME.host_mute(room, my_uid, msg.get('uid', ''), msg.get('muted', True))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                await broadcast_state(room_id)

            elif kind == 'host_mute_all':
                err = GAME.host_mute_all(room, my_uid, msg.get('muted', True))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                await broadcast_state(room_id)

            elif kind == 'next_round':
                err = GAME.next_vote_round(room, my_uid)
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                await broadcast_state(room_id)

            elif kind == 'set_speaker':
                err = GAME.set_speaker(room, my_uid, msg.get('uid', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                await broadcast_state(room_id)

            elif kind == 'view_role':
                data, err = GAME.view_role_text(room, my_uid, msg.get('uid', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                    continue
                await ws.send_json({'type': 'role_view', 'data': data})

            # 投票
            elif kind == 'vote':
                err = GAME.cast_vote(room, my_uid, msg.get('uid', ''))
                if err:
                    await ws.send_json({'type': 'error', 'msg': err})
                GAME.log_event(room, f'{user.name} 投出了第 {room.vote_round} 轮的一票')
                await broadcast_state(room_id)

            # 公布投票结果（DM）
            elif kind == 'reveal_votes':
                if room.seats[0] != my_uid:
                    await ws.send_json({'type': 'error', 'msg': '只有 DM 可以公布结果'})
                    continue
                result = GAME.vote_result(room)
                await broadcast(room_id, {'type': 'vote_result', 'result': result})
                GAME.log_event(room, 'DM 公布了投票结果')
                await broadcast(room_id, {'type': 'notice', 'text': 'DM 公布了投票结果'})
                await broadcast_state(room_id)

            elif kind == 'ping':
                await ws.send_json({'type': 'pong', 'ts': time.time()})

            # 主动离开房间：释放麦位并移出房间（区别于意外断线的 mark_offline）
            elif kind == 'leave':
                if my_uid in room.users:
                    name = user.name
                    GAME.remove_user(room, my_uid)
                    await broadcast(room_id, {'type': 'notice', 'text': f'{name} 离开了房间'})
                    await broadcast_state(room_id)
                break

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if my_uid and my_uid in conns:
            del conns[my_uid]
            room = GAME.get_room(room_id)
            if room and my_uid in room.users:
                user = room.users[my_uid]
                name = user.name
                GAME.mark_offline(room, my_uid)
                await broadcast(room_id, {'type': 'notice', 'text': f'{name} 已离线'})
                await broadcast_state(room_id)


# ---------------- 推送工具 ----------------
async def send_to(room_id, uid, pkt):
    conns = room_conns.get(room_id, {})
    ws = conns.get(uid)
    if ws and ws.client_state == WebSocketState.CONNECTED:
        try:
            await ws.send_json(pkt)
        except Exception:
            pass


async def broadcast(room_id, pkt):
    conns = room_conns.get(room_id, {})
    for ws in list(conns.values()):
        if ws.client_state == WebSocketState.CONNECTED:
            try:
                await ws.send_json(pkt)
            except Exception:
                pass


async def broadcast_state(room_id):
    """广播完整房间状态（含各玩家座位/静音/角色名），并附带各自的私密剧本。"""
    room = GAME.get_room(room_id)
    if room is None:
        return
    conns = room_conns.get(room_id, {})
    for uid, ws in list(conns.items()):
        if ws.client_state == WebSocketState.CONNECTED:
            try:
                await ws.send_json({
                    'type': 'state',
                    'room': room.to_public(uid),
                    'users': {
                        u: room.users[u].to_private() if u == uid else room.users[u].to_public()
                        for u in room.users
                    },
                })
            except Exception:
                pass


async def broadcast_private(room_id):
    """分配角色后仅广播公开状态（角色名公开），私密内容走 to_private。"""
    await broadcast_state(room_id)


if __name__ == '__main__':
    import os
    import threading
    import uvicorn

    CERT_DIR = BASE_DIR.parent / 'certs'
    cert_file = CERT_DIR / 'server.crt'
    key_file = CERT_DIR / 'server.key'

    apps = [uvicorn.Config(app, host='0.0.0.0', port=8000)]
    print('HTTP 服务: http://localhost:8000')
    if cert_file.exists() and key_file.exists():
        apps.append(uvicorn.Config(
            app, host='0.0.0.0', port=8443,
            ssl_certfile=str(cert_file), ssl_keyfile=str(key_file),
        ))
        print('HTTPS 服务: https://localhost:8443 (局域网 https://<电脑IP>:8443)')
    else:
        print('未找到证书 (script_voice/certs/)，先运行: python make_cert.py 生成 HTTPS')

    servers = [uvicorn.Server(c) for c in apps]
    for s in servers:
        threading.Thread(target=s.run, daemon=True).start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print('服务已停止')
