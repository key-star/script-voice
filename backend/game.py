"""剧本杀语音房 - 内存态房间/麦位/游戏状态管理

所有状态保存在内存中，服务重启即清空，适合开发期使用。
后续可替换为 Redis/SQLite 持久化。
"""
import json
import random
import string
import threading
import time
from typing import Optional

MAX_SEATS = 20                          # 普通玩家麦位数（1~20）
TOTAL_SEATS = MAX_SEATS + 1              # 含 0 麦（DM/主持位）
MAX_TOTAL_DEFAULT = 50                  # 房间总人数上限（含 OB，固定值，DM 不可调节）
EMPTY_ROOM_TTL = 30 * 60                # 房间内无人在线达到该时长后自动删除（秒）
STAGES = {
    'lobby':    {'name': '准备中',   'index': 0},
    'reading':  {'name': '阅读剧本', 'index': 1},
    'discussion': {'name': '讨论',   'index': 2},
    'voting':   {'name': '投票',     'index': 3},
    'reveal':   {'name': '真相公布', 'index': 4},
}


class User:
    def __init__(self, uid, name, is_host=False):
        self.uid = uid
        self.name = name
        self.is_host = is_host
        self.seat = -1          # -1 表示不在麦上
        self.muted = True       # 默认闭麦：上麦后由玩家自行开麦（或被 DM 解除）
        self.online = True
        self.role = None        # 剧本角色名
        self.role_text = None   # 该玩家的剧本内容
        self.role_task = None   # 该角色的个人任务
        self.voted_for = None   # 投给了谁的 uid
        self.score = 0          # 复盘得分
        self.scored = False     # 本轮是否已计分
        self.host_muted = False # 房主强制闭麦标记
        self.is_ob = False      # 旁观者：不参与游戏（不上麦/无角色/不投票）

    def to_public(self):
        return {
            'uid': self.uid,
            'name': self.name,
            'is_host': self.is_host,
            'is_ob': self.is_ob,
            'seat': self.seat,
            'muted': self.muted,
            'online': self.online,
            'role': self.role,
            'has_voted': bool(self.voted_for),
            'score': self.score,
        }

    def to_private(self):
        d = self.to_public()
        d['role_text'] = self.role_text
        d['role_task'] = self.role_task
        d['voted_for'] = self.voted_for
        return d


class Room:
    def __init__(self, room_id, name, host_uid, host_name, password=''):
        self.id = room_id
        self.name = name
        self.password = password
        self.host_uid = host_uid
        self.created_at = time.time()
        self.users = {}
        self.seats = [None] * TOTAL_SEATS          # 0 麦为 DM 位，1~MAX_SEATS 为玩家麦位
        self.script = None                       # {'title','intro','roles':[{name,text,task}], 'truth','murderer','clues'}
        self.stage = 'lobby'
        self.votes = {}                          # voter_uid -> target_uid
        self.vote_round = 0                      # 投票轮次
        self.clues = []                          # [{id,text,visible_to:'all'|角色名}]
        self.announcement = ''                   # 房间公告
        self.speaker_uid = None                  # 当前发言玩家
        self.log = []                            # 游戏日志 [{time,text}]
        self.timer = {'running': False, 'left': 0, 'total': 0, 'end_at': 0}
        self.chat = []                           # 公屏消息，最多保留 200 条
        self.lock = threading.RLock()
        self.roles_assigned = False
        self.assign_mode = 'auto'         # 角色分配方式: auto 自动 / dm DM手动指定 / self 玩家自选
        self.empty_since = None          # 房间内无人在线的时间戳，用于空房自动回收
        self.bgm = {                     # 房间背景音乐（服务器托管 + 客户端同步播放）
            'url': '', 'title': '', 'file': '',   # file 为服务端文件名，不下发给客户端
            'playing': False, 'position': 0.0, 'ts': 0.0,
            'volume': 1.0, 'loop': False,
        }
        self.departed = {}               # 已离开玩家：uid -> {name, role, role_text, role_task, voted_for, score}，游戏记录随房间保留

    def _visible_clues(self, viewer_uid):
        if viewer_uid == self.host_uid:
            return [dict(c) for c in self.clues]
        viewer_role = ''
        if viewer_uid in self.users:
            viewer_role = self.users[viewer_uid].role or ''
        out = []
        for c in self.clues:
            if c['visible_to'] == 'all' or c['visible_to'] == viewer_role:
                out.append(dict(c))
        return out

    def to_public(self, viewer_uid):
        with self.lock:
            host_name = ''
            if self.host_uid in self.users:
                host_name = self.users[self.host_uid].name
            return {
                'id': self.id,
                'name': self.name,
                'has_password': bool(self.password),
                'host_uid': self.host_uid,
                'host_name': host_name,
                'user_count': len(self.users),
                'max_seats': MAX_SEATS,
                'max_total': MAX_TOTAL_DEFAULT,
                'stage': self.stage,
                'stage_name': STAGES[self.stage]['name'],
                'roles_assigned': self.roles_assigned,
                'assign_mode': self.assign_mode,
                'announcement': self.announcement,
                'speaker_uid': self.speaker_uid,
                'vote_round': self.vote_round,
                'votes_open': self.stage == 'voting',
                'clues': self._visible_clues(viewer_uid),
                'log': list(self.log[-50:]),
                'script': None if self.script is None else {
                    'title': self.script['title'],
                    'intro': self.script['intro'],
                    'truth': self.script['truth'] if self.stage == 'reveal' else None,
                    'murderer': self.script['murderer'] if self.stage == 'reveal' else '',
                    'role_names': [r['name'] for r in self.script['roles']],
                    'roles': [{'name': r['name'], 'task': r['task']} for r in self.script['roles']],
                },
                'timer': self.timer,
                'bgm': {k: self.bgm[k] for k in ('url', 'title', 'playing', 'position', 'ts', 'volume', 'loop')},
                'viewer_is_host': viewer_uid == self.host_uid,
                'viewer_is_dm': viewer_uid == self.seats[0] or (self.seats[0] is None and viewer_uid == self.host_uid),
            }


class GameServer:
    def __init__(self):
        self.rooms = {}
        self.lock = threading.RLock()

    # ---------------- 房间 ----------------
    def _gen_room_id(self):
        """生成全局唯一的 6 位数字房间号（TT 风格）。"""
        while True:
            rid = ''.join(random.choices(string.digits, k=6))
            if rid not in self.rooms:
                return rid

    def create_room(self, name, host_uid, host_name, password=''):
        with self.lock:
            room = Room(self._gen_room_id(), name, host_uid, host_name, password)
            user = User(host_uid, host_name, is_host=True)
            user.seat = 0
            room.users[host_uid] = user
            room.seats[0] = host_uid
            self.rooms[room.id] = room
            return room

    def _move_to_seat_zero(self, room, uid):
        """让房主固定坐 0 麦（DM 位）。"""
        user = room.users.get(uid)
        if user is None or user.seat == 0:
            return
        if room.seats[0] is not None:
            other = room.seats[0]
            room.seats[0] = None
            if other in room.users:
                room.users[other].seat = -1
        if user.seat >= 0:
            room.seats[user.seat] = None
        user.seat = 0
        room.seats[0] = uid
        # 坐 0 麦 = DM：原玩家记录存入 departed，清除角色/投票（投票留在 room.votes）
        self._save_departed(room, user)
        user.role = None
        user.role_text = None
        user.role_task = None
        user.voted_for = None

    def get_room(self, room_id):
        with self.lock:
            return self.rooms.get(room_id)

    def list_rooms(self):
        with self.lock:
            out = []
            for r in self.rooms.values():
                out.append({
                    'id': r.id, 'name': r.name,
                    'user_count': len(r.users), 'max_seats': MAX_SEATS, 'max_total': MAX_TOTAL_DEFAULT,
                    'seated_count': sum(1 for suid in r.seats if suid),
                    'has_password': bool(r.password),
                    'host_name': r.users[r.host_uid].name if r.host_uid in r.users else '',
                    'stage': r.stage, 'stage_name': STAGES[r.stage]['name'],
                })
            return out

    def remove_room(self, room_id):
        with self.lock:
            return self.rooms.pop(room_id, None)

    def cleanup_expired_rooms(self):
        """删除「无人在线超过 EMPTY_ROOM_TTL」的空房间。返回被删除的 Room 对象列表。"""
        with self.lock:
            now = time.time()
            expired = [r for r in self.rooms.values()
                       if r.empty_since is not None and now - r.empty_since >= EMPTY_ROOM_TTL]
            for r in expired:
                self.rooms.pop(r.id, None)
            return expired

    def join_room(self, room_id, uid, name, password=''):
        with self.lock:
            room = self.get_room(room_id)
            if room is None:
                return None, '房间不存在'
            if room.password and room.password != password:
                return None, '房间密码错误'
            if uid not in room.users and len(room.users) >= MAX_TOTAL_DEFAULT:
                return None, f'房间人数已满（上限 {MAX_TOTAL_DEFAULT} 人）'
            if uid in room.users:
                user = room.users[uid]
                user.name = name
                room.empty_since = None
                # online 状态由 WS 层负责（用于区分“回归”与“新进入”）
                return room, ''
            user = User(uid, name)
            if uid != room.host_uid:
                user.is_ob = True   # 除房主外，进入房间默认旁观者，上麦后转为玩家
            # 回归玩家：恢复其游戏记录（角色/投票/得分），保持本局记录完整
            self._restore_departed(room, user)
            room.users[uid] = user
            room.empty_since = None
            return room, ''

    def _is_player(self, room, uid):
        """正式玩家：上麦（1~MAX_SEATS）且在线的用户。DM（0 麦）与 OB 不算。"""
        user = room.users.get(uid)
        return bool(user and user.online and 1 <= user.seat <= MAX_SEATS)

    def _is_dm(self, room, uid):
        """DM = 当前坐在 0 麦的用户；0 麦空置时控制权兜底归房主。"""
        if not uid:
            return False
        if room.seats[0] == uid:
            return True
        return room.seats[0] is None and uid == room.host_uid

    def _refresh_empty_since(self, room):
        """有人在在线则清空时间戳；全员离线则记录离线起始时间。"""
        if any(u.online for u in room.users.values()):
            room.empty_since = None
        elif room.empty_since is None:
            room.empty_since = time.time()

    def _save_departed(self, room, user):
        """把玩家的游戏记录快照保存下来（角色/投票/得分随房间保留）。
        仅在有记录可存、且该用户尚未有快照时写入，避免覆盖已有记录。"""
        if user.uid in room.departed:
            return
        if not (user.role or user.voted_for or user.score):
            return
        room.departed[user.uid] = {
            'name': user.name,
            'role': user.role, 'role_text': user.role_text, 'role_task': user.role_task,
            'voted_for': user.voted_for, 'score': user.score,
        }

    def _restore_departed(self, room, user):
        """回归玩家 / 从 DM 位回到玩家麦位时，恢复其游戏记录快照。"""
        rec = room.departed.pop(user.uid, None)
        if rec:
            user.role = rec.get('role')
            user.role_text = rec.get('role_text')
            user.role_task = rec.get('role_task')
            user.voted_for = rec.get('voted_for')
            user.score = rec.get('score', 0)

    def remove_user(self, room, uid):
        with self.lock:
            user = room.users.pop(uid, None)
            if user and user.seat >= 0:
                room.seats[user.seat] = None
            if user:
                self._save_departed(room, user)
            # 投票记录保留（room.votes 不弹出）
            if uid == room.host_uid:
                # 房主离开：优先移交给当前 DM（0 麦），否则麦上第一人，并坐 0 麦
                new_host = None
                if room.seats[0] and room.seats[0] in room.users:
                    new_host = room.seats[0]
                if new_host is None:
                    for suid in room.seats:
                        if suid and suid in room.users:
                            new_host = suid
                            break
                if new_host is None:
                    for suid in list(room.users.keys()):
                        new_host = suid
                        break
                if new_host is not None:
                    room.users[new_host].is_host = True
                    room.host_uid = new_host
                    self._move_to_seat_zero(room, new_host)
            self._refresh_empty_since(room)

    def mark_offline(self, room, uid):
        """玩家断线：保留房间与麦位并标记离线；房主离线则移交给在线玩家。"""
        with self.lock:
            user = room.users.get(uid)
            if user is None:
                return
            user.online = False
            if uid == room.host_uid:
                new_host = None
                if room.seats[0] and room.seats[0] in room.users and room.users[room.seats[0]].online:
                    new_host = room.seats[0]
                if new_host is None:
                    for suid in room.seats:
                        if suid and suid in room.users and room.users[suid].online:
                            new_host = suid
                            break
                if new_host is None:
                    for suid in list(room.users.keys()):
                        if room.users[suid].online:
                            new_host = suid
                            break
                if new_host is not None:
                    room.users[new_host].is_host = True
                    room.host_uid = new_host
                    self._move_to_seat_zero(room, new_host)
            self._refresh_empty_since(room)

    # ---------------- 麦位 ----------------
    def sit(self, room, uid, seat):
        with self.lock:
            if seat < 0 or seat >= TOTAL_SEATS:
                return '麦位不存在'
            user = room.users.get(uid)
            if user is None:
                return '用户不在房间'
            if room.seats[seat] is not None and not (
                seat == 0 and not room.users[room.seats[seat]].online
            ):
                return '该麦位已被占用'
            if room.seats[seat] is not None:
                # 接管离线 DM 的 0 麦
                room.users[room.seats[seat]].seat = -1
            if user.seat >= 0:
                room.seats[user.seat] = None
            room.seats[seat] = uid
            user.seat = seat
            user.is_ob = False    # 上麦即转为正式玩家
            # 上麦后保持闭麦，由玩家自行开麦（不改动 user.muted）
            if seat == 0:
                # 坐 0 麦即担任 DM：不参与角色与投票；原玩家记录存入 departed
                self._save_departed(room, user)
                user.role = None
                user.role_text = None
                user.role_task = None
                user.voted_for = None
            elif uid in room.departed:
                # 从 DM 位回到玩家麦位：恢复其原游戏记录
                self._restore_departed(room, user)
            self._sync_roles_assigned(room)
            return ''

    def leave_seat(self, room, uid):
        with self.lock:
            user = room.users.get(uid)
            if user and user.seat >= 0:
                room.seats[user.seat] = None
                user.seat = -1
                user.muted = True
                if uid != room.host_uid:
                    # 下麦回到旁观者；角色与投票等游戏记录保留，重新上麦可继续参与
                    user.is_ob = True
                else:
                    # 房主下麦：不转为 OB；游戏记录同样保留
                    user.is_ob = False
                self._sync_roles_assigned(room)
            return ''

    def kick(self, room, dm_uid, target_uid):
        """踢出房间：直接移出用户。返回 (被踢用户, 错误信息)。"""
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return None, '只有 DM（0 麦）可以操作'
            target = room.users.get(target_uid)
            if target is None:
                return None, '用户不存在'
            if target_uid == room.host_uid:
                return None, '不能操作房主'
            if target_uid == dm_uid:
                return None, '不能踢自己'
            self._save_departed(room, target)
            room.users.pop(target_uid, None)
            if target.seat >= 0:
                room.seats[target.seat] = None
            # 投票记录保留（room.votes 不弹出）
            self.log_event(room, f'{target.name} 被移出房间')
            self._refresh_empty_since(room)
            return target, ''

    def set_bgm_file(self, room, filename, title):
        """上传成功后登记 BGM 文件（替换旧文件由调用方负责删除）。"""
        with self.lock:
            room.bgm.update({
                'url': f'/bgm/{filename}', 'title': title or '',
                'file': filename, 'playing': False, 'position': 0.0, 'ts': 0.0,
            })
            return ''

    def bgm_ctrl(self, room, dm_uid, action, data=None):
        """DM 控制 BGM：load 载入 / play 播放 / pause 暂停 / stop 停止 / seek 跳转 / loop 循环 / volume 音量。"""
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return '只有 DM（0 麦）可以操作'
            data = data or {}
            b = room.bgm
            if action == 'load':
                url = data.get('url', '')
                if not url:
                    return 'BGM 不存在'
                b.update({'url': url, 'title': data.get('title', b.get('title', '')) or '',
                          'playing': False, 'position': 0.0, 'ts': 0.0})
            elif action == 'play':
                b['position'] = float(data.get('position', b.get('position', 0) or 0) or 0)
                b['playing'] = True
                b['ts'] = time.time()
            elif action == 'pause':
                b['playing'] = False
                b['position'] = float(data.get('position', b.get('position', 0) or 0) or 0)
                b['ts'] = 0.0
            elif action == 'stop':
                b['playing'] = False
                b['position'] = 0.0
                b['ts'] = 0.0
            elif action == 'seek':
                b['position'] = float(data.get('position', 0) or 0)
                if b.get('playing'):
                    b['ts'] = time.time()   # 播放中跳转：重置基准时间，避免偏移叠加
            elif action == 'loop':
                b['loop'] = bool(data.get('loop'))
            elif action == 'volume':
                v = float(data.get('volume', 1.0) or 1.0)
                b['volume'] = min(1.0, max(0.0, v))
            else:
                return '未知操作'
            return ''

    # ---------------- 剧本 ----------------
    def parse_script(self, text):
        """解析剧本文本，支持：
        剧本名: xxx
        简介: xxx
        角色: 名字
        角色的剧本内容（多行，直到下一个 角色/任务/真相/凶手/线索/剧本名/简介 行）
        任务: 该角色的个人任务（可选）
        凶手: 角色名（真凶，复盘时判定）
        线索: 内容                 -> 公开线索
        线索: 角色名|内容          -> 仅该角色可见的线索
        真相: 真相内容
        """
        roles = []
        clues = []
        title = ''
        intro = ''
        truth = ''
        murderer = ''
        cur_role = None
        for raw in text.splitlines():
            line = raw.rstrip()
            if not line.strip():
                continue
            s = line.strip()
            if s.startswith('剧本名:'):
                title = s[len('剧本名:'):].strip()
            elif s.startswith('简介:'):
                intro = s[len('简介:'):].strip()
            elif s.startswith('真相:'):
                truth = s[len('真相:'):].strip()
                cur_role = None
            elif s.startswith('凶手:'):
                murderer = s[len('凶手:'):].strip()
                cur_role = None
            elif s.startswith('线索:'):
                txt = s[len('线索:'):].strip()
                visible = 'all'
                if '|' in txt:
                    rname, ctext = txt.split('|', 1)
                    rname, ctext = rname.strip(), ctext.strip()
                    if rname and rname != '公开':
                        visible = rname
                    txt = ctext
                if txt:
                    clues.append({'text': txt, 'visible_to': visible})
                cur_role = None
            elif s.startswith('角色:'):
                name = s[len('角色:'):].strip()
                if name:
                    cur_role = {'name': name, 'text': '', 'task': ''}
                    roles.append(cur_role)
            elif s.startswith('任务:') and cur_role is not None:
                cur_role['task'] = s[len('任务:'):].strip()
            elif cur_role is not None:
                cur_role['text'] += s + '\n'
            else:
                continue
        if not title:
            title = '未命名剧本'
        for r in roles:
            r['text'] = r['text'].strip()
        return {'title': title, 'intro': intro, 'roles': roles, 'truth': truth,
                'murderer': murderer, 'clues': clues}

    def set_script(self, room, actor_uid, text):
        with self.lock:
            if not self._is_dm(room, actor_uid):
                return '只有 DM（0 麦）可以操作'
            script = self.parse_script(text)
            if not script['roles']:
                return '剧本格式有误：至少需要一个「角色: 名字」'
            room.script = script
            room.roles_assigned = False
            room.votes = {}
            room.departed = {}
            room.vote_round = 0
            room.clues = [dict(c, id='c' + str(i + 1)) for i, c in enumerate(script['clues'])]
            room.stage = 'lobby'
            for u in room.users.values():
                u.role = None
                u.role_text = None
                u.role_task = None
                u.voted_for = None
                u.score = 0
            return ''

    def assign_roles(self, room, actor_uid):
        """随机给玩家分配剧本角色"""
        with self.lock:
            if not self._is_dm(room, actor_uid):
                return '只有 DM（0 麦）可以操作'
            if room.script is None:
                return '请先创建剧本'
            roles = list(room.script['roles'])
            random.shuffle(roles)
            players = [u for u in room.users.values() if 1 <= u.seat <= MAX_SEATS and u.online]
            # 角色多于玩家时截断；玩家多于角色时循环补位
            for i, u in enumerate(players):
                if not roles:
                    break
                role = roles[i % len(roles)]
                u.role = role['name']
                u.role_text = role['text']
                u.role_task = role['task'] or None
            room.roles_assigned = True
            return ''

    def set_assign_mode(self, room, actor_uid, mode):
        """切换角色分配方式：auto 自动 / dm DM手动指定 / self 玩家自选。"""
        with self.lock:
            if not self._is_dm(room, actor_uid):
                return '只有 DM（0 麦）可以操作'
            if mode not in ('auto', 'dm', 'self'):
                return '分配方式不存在'
            room.assign_mode = mode
            return ''

    def reset_roles(self, room, actor_uid):
        """清空所有玩家的角色，恢复未分配状态。"""
        with self.lock:
            if not self._is_dm(room, actor_uid):
                return '只有 DM（0 麦）可以操作'
            for u in room.users.values():
                u.role = None
                u.role_text = None
                u.role_task = None
                u.voted_for = None
            room.votes = {}
            room.departed = {}
            room.roles_assigned = False
            return ''

    def _role_by_name(self, room, role_name):
        return next((r for r in room.script['roles'] if r['name'] == role_name), None)

    def _available_roles(self, room):
        """玩家自选模式下，剩余可选的剧本角色（去掉已被他人占用的）。"""
        claimed = {u.role for u in room.users.values() if u.role}
        return [r['name'] for r in room.script['roles'] if r['name'] not in claimed]

    def _sync_roles_assigned(self, room):
        """所有上麦玩家（1~MAX_SEATS）都有角色时，视为分配完成。"""
        players = [u for u in room.users.values() if 1 <= u.seat <= MAX_SEATS and u.online]
        room.roles_assigned = bool(players) and all(u.role is not None for u in players)

    def dm_assign_role(self, room, dm_uid, target_uid, role_name):
        """DM 手动给指定玩家分配角色。"""
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return '只有 DM（0 麦）可以操作'
            if room.script is None:
                return '请先创建剧本'
            role = self._role_by_name(room, role_name)
            if role is None:
                return '角色不存在'
            user = room.users.get(target_uid)
            if user is None:
                return '用户不在房间'
            if not self._is_player(room, target_uid):
                return '只有上麦玩家（1-20 麦）能获得角色'
            user.role = role['name']
            user.role_text = role['text']
            user.role_task = role['task'] or None
            self._sync_roles_assigned(room)
            return ''

    def self_claim_role(self, room, uid, role_name):
        """玩家自己选择角色（先到先得，角色不重复）。"""
        with self.lock:
            if room.assign_mode != 'self':
                return '当前不是玩家自选模式'
            if room.script is None:
                return '请先创建剧本'
            user = room.users.get(uid)
            if user is None:
                return '用户不在房间'
            if not self._is_player(room, uid):
                return '请先上麦（1-20 麦）再选择角色'
            if user.role:
                return '你已选择了角色'
            if role_name not in self._available_roles(room):
                return '该角色已被选走'
            role = self._role_by_name(room, role_name)
            user.role = role['name']
            user.role_text = role['text']
            user.role_task = role['task'] or None
            self._sync_roles_assigned(room)
            return ''

    # ---------------- 阶段 / 投票 / 计时 ----------------
    def set_stage(self, room, actor_uid, stage):
        with self.lock:
            if not self._is_dm(room, actor_uid):
                return '只有 DM（0 麦）可以操作'
            if stage not in STAGES:
                return '阶段不存在'
            room.stage = stage
            if stage == 'voting':
                room.votes = {}
                room.vote_round += 1
                for u in room.users.values():
                    u.voted_for = None
                    u.scored = False
                self.log_event(room, f'进入投票（第 {room.vote_round} 轮）')
            if stage == 'lobby':
                room.votes = {}
                self.stop_timer(room)
            return ''

    def cast_vote(self, room, voter_uid, target_uid):
        with self.lock:
            if room.stage != 'voting':
                return '当前不在投票阶段'
            if voter_uid not in room.users or target_uid not in room.users:
                return '用户不存在'
            if not self._is_player(room, voter_uid):
                return '只有上麦玩家（1-20 麦）能投票'
            room.votes[voter_uid] = target_uid
            room.users[voter_uid].voted_for = target_uid
            return ''

    def vote_result(self, room):
        with self.lock:
            def uname(uid):
                u = room.users.get(uid)
                if u:
                    return u.name
                rec = room.departed.get(uid)
                return rec['name'] if rec else '?'

            tally = {}
            for _, t in room.votes.items():
                tally[t] = tally.get(t, 0) + 1
            ranked = sorted(tally.items(), key=lambda kv: -kv[1])
            tally_out = [{'uid': uid, 'name': uname(uid), 'count': count}
                         for uid, count in ranked]
            mur_role = (room.script or {}).get('murderer', '')
            murderer_uid = None
            for u in room.users.values():
                if u.role == mur_role:
                    murderer_uid = u.uid
                    break
            if murderer_uid is None:
                for uid, rec in room.departed.items():
                    if rec.get('role') == mur_role:
                        murderer_uid = uid
                        break

            def vname(uid):
                if not uid:
                    return None
                u = room.users.get(uid)
                if u:
                    return u.name
                rec = room.departed.get(uid)
                return rec['name'] if rec else None

            verdict = []
            # 当前在房玩家
            for u in room.users.values():
                if not u.online:
                    continue
                correct = bool(murderer_uid and u.voted_for and u.voted_for == murderer_uid)
                if correct and not u.scored and room.stage == 'reveal':
                    u.score += 1
                    u.scored = True
                verdict.append({
                    'uid': u.uid, 'name': u.name, 'role': u.role,
                    'voted_uid': u.voted_for,
                    'voted_name': vname(u.voted_for),
                    'correct': correct,
                    'score': u.score,
                })
            # 已离开玩家（游戏记录随房间保留，参与复盘判定；仍在房内者以在房状态为准）
            for uid, rec in room.departed.items():
                if uid in room.users:
                    continue
                voted = rec.get('voted_for')
                correct = bool(murderer_uid and voted and voted == murderer_uid)
                verdict.append({
                    'uid': uid, 'name': rec['name'], 'role': rec.get('role'),
                    'voted_uid': voted,
                    'voted_name': vname(voted),
                    'correct': correct,
                    'score': rec.get('score', 0),
                })
            return {'tally': tally_out, 'murderer_uid': murderer_uid,
                    'murderer_role': mur_role, 'verdict': verdict}

    def start_timer(self, room, seconds, dm_uid):
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return '只有 DM（0 麦）可以设置计时器'
            room.timer = {'running': True, 'left': seconds, 'total': seconds, 'end_at': time.time() + seconds}
            return ''

    def stop_timer(self, room):
        room.timer = {'running': False, 'left': 0, 'total': 0, 'end_at': 0}

    # ---------------- 主持管理（公告/线索/控麦/轮次/发言） ----------------
    def log_event(self, room, text):
        room.log.append({'time': time.strftime('%H:%M:%S'), 'text': text})
        if len(room.log) > 200:
            room.log = room.log[-150:]

    def set_announcement(self, room, dm_uid, text):
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return '只有 DM（0 麦）可以操作'
            room.announcement = (text or '').strip()[:200]
            self.log_event(room, 'DM 更新了公告')
            return ''

    def add_clue(self, room, dm_uid, text, visible_to='all'):
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return '只有 DM（0 麦）可以发放线索'
            text = (text or '').strip()
            if not text:
                return '线索内容不能为空'
            cid = 'c' + str(int(time.time() * 1000))[-6:]
            room.clues.append({'id': cid, 'text': text[:300], 'visible_to': visible_to or 'all'})
            who = '公开' if visible_to in ('', 'all') else '角色「' + visible_to + '」'
            self.log_event(room, f'DM 发放线索（{who}）')
            return ''

    def host_mute(self, room, dm_uid, target_uid, muted):
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return '只有 DM（0 麦）可以控麦'
            if target_uid == dm_uid:
                return '不能操作自己'
            u = room.users.get(target_uid)
            if u is None:
                return '用户不存在'
            u.muted = bool(muted)
            u.host_muted = bool(muted)
            return ''

    def host_mute_all(self, room, dm_uid, muted):
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return '只有 DM（0 麦）可以控麦'
            for uid, u in room.users.items():
                if uid != dm_uid:
                    u.muted = bool(muted)
                    u.host_muted = bool(muted)
            self.log_event(room, 'DM 全体' + ('禁言' if muted else '解除禁言'))
            return ''

    def next_vote_round(self, room, dm_uid):
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return '只有 DM（0 麦）可以操作'
            if room.stage != 'voting':
                return '仅投票阶段可开启新一轮'
            room.votes = {}
            room.vote_round += 1
            for u in room.users.values():
                u.voted_for = None
                u.scored = False
            self.log_event(room, f'开始第 {room.vote_round} 轮投票')
            return ''

    def set_speaker(self, room, dm_uid, uid):
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return '只有 DM（0 麦）可以指定发言'
            room.speaker_uid = uid if (uid and uid in room.users) else None
            return ''

    def view_role_text(self, room, dm_uid, target_uid):
        """DM 查看指定玩家的剧本内容"""
        with self.lock:
            if not self._is_dm(room, dm_uid):
                return None, '只有 DM（0 麦）可以查看'
            u = room.users.get(target_uid)
            if u is None:
                return None, '用户不存在'
            return {'uid': u.uid, 'name': u.name, 'role': u.role, 'role_text': u.role_text,
                    'role_task': u.role_task}, ''

    def tick_timers(self):
        """每秒由后台线程调用，推进倒计时"""
        with self.lock:
            now = time.time()
            for room in self.rooms.values():
                t = room.timer
                if t['running'] and t['end_at']:
                    t['left'] = max(0, int(t['end_at'] - now))
                    if t['left'] == 0:
                        t['running'] = False

    # ---------------- 聊天 ----------------
    def add_chat(self, room, sender_uid, sender_name, text):
        with self.lock:
            if len(room.chat) >= 200:
                room.chat = room.chat[-150:]
            msg = {
                'type': 'chat',
                'from': sender_uid,
                'name': sender_name,
                'text': text,
                'time': time.strftime('%H:%M:%S'),
            }
            room.chat.append(msg)
            return msg


# 全局单例
GAME = GameServer()

# 后台倒计时线程
def _tick_loop():
    while True:
        try:
            with GAME.lock:
                GAME.tick_timers()
        except Exception:
            pass
        time.sleep(1)


ticker = threading.Thread(target=_tick_loop, daemon=True)
ticker.start()
