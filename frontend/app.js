/* 剧本杀语音房 前端逻辑 */
'use strict';

const state = {
  uid: localStorage.getItem('sv_uid') || genUid(),
  name: localStorage.getItem('sv_name') || '',
  appId: localStorage.getItem('sv_appid') || '',
  provider: localStorage.getItem('sv_rtc_provider') || 'auto',   // 语音模式: auto/lan/agora/trtc
  trtcSdkAppId: localStorage.getItem('sv_trtc_sdkappid') || '',
  trtcSecret: localStorage.getItem('sv_trtc_secret') || '',
  roomId: '',
  ws: null,
  wsRetry: 0,
  room: null,        // 服务器下发的房间公开状态
  users: {},         // uid -> 用户对象（含自己私密字段）
  me: null,
  chatPub: [],
  chatPri: {},       // 会话key(uid|uid) -> [{from,name,text,time}]
  priNames: {},      // uid -> 对方昵称
  priTarget: null,
  tab: 'pub',
  priUnread: 0,
  myVote: null,
  roleShown: false,
  voteResultShown: false,
  gameTab: 'script',       // 剧本杀面板 Tab: script/clue/vote/host/log/bgm
  scriptLib: [],           // 示例剧本名列表
  voiceEffect: 'none',     // 变声: none/deep/clear/space
  // 语音（统一由 RTC 抽象层管理，见 frontend/rtc/adapter.js）
  rtc: { adapter: null },
  voiceBusy: false,
  timerTicker: null,
};

// ---------------- 工具 ----------------
function genUid() {
  return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
function toast(msg, color) {
  const t = document.createElement('div');
  t.className = 'msg sys';
  t.textContent = msg;
  const log = currentLog();
  if (log) { log.appendChild(t); log.scrollTop = log.scrollHeight; }
  console.log('[toast]', msg);
}
function currentLog() {
  return state.tab === 'pri' ? $('chat-pri') : $('chat-pub');
}
function api(url, opts) {
  return fetch(url, opts).then(r => {
    if (!r.ok) return r.json().then(j => Promise.reject(new Error(j.detail || r.statusText)));
    return r.json();
  });
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ---------------- 大厅 ----------------
async function refreshRooms() {
  try {
    const data = await api('/api/rooms');
    const box = $('room-list');
    box.innerHTML = '';
    if (!data.rooms.length) {
      box.innerHTML = '<div class="empty-tip">暂无房间，创建一个吧</div>';
      return;
    }
    data.rooms.forEach(r => {
      const card = document.createElement('div');
      card.className = 'room-card';
      const stageName = r.stage === 'lobby' ? '' : ` · ${r.stage_name}`;
      card.innerHTML = `
        <div>
          <div class="r-name">${esc(r.name)} ${r.has_password ? '🔒' : ''}</div>
          <div class="r-meta">${r.user_count}/${r.max_total} 人 · 🎙 ${r.seated_count}/21 麦 · 房主 ${esc(r.host_name)}${stageName}</div>
        </div>
        <button class="btn primary sm r-enter" data-id="${r.id}" data-name="${esc(r.name)}" data-pass="${r.has_password}">进入</button>`;
      box.appendChild(card);
    });
  } catch (e) { console.error(e); }
}

function requireName() {
  const name = $('login-name').value.trim();
  if (!name) { alert('请先输入昵称'); return null; }
  state.name = name;
  localStorage.setItem('sv_name', name);
  return name;
}

async function createRoom() {
  if (!requireName()) return;
  const name = $('create-name').value.trim();
  if (!name) { alert('请输入房间名'); return; }
  try {
    const data = await api('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, host_uid: state.uid, host_name: state.name, password: $('create-pass').value.trim() }),
    });
    enterRoom(data.room_id);
  } catch (e) { alert(e.message); }
}

function enterRoom(roomId, password) {
  state.roomId = roomId;
  $('login-screen').classList.add('hidden');
  $('room-screen').classList.remove('hidden');
  connectWs(password);
}

async function joinByNumber() {
  const val = $('join-id').value.trim();
  if (!/^\d{6}$/.test(val)) { alert('请输入 6 位数字房间号'); return; }
  if (!requireName()) return;
  try {
    const room = await api(`/api/rooms/${val}`);
    if (room.has_password) {
      const pwd = prompt('该房间需要密码：');
      if (pwd === null) return;
      enterRoom(val, pwd);
    } else {
      enterRoom(val, '');
    }
  } catch (e) { alert('房间不存在：' + e.message); }
}

// ---------------- WebSocket ----------------
function connectWs(password) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws/${state.roomId}`);
  state.ws.onopen = () => {
    state.wsRetry = 0;
    state.ws.send(JSON.stringify({
      type: 'enter', uid: state.uid, name: state.name, password: password || ''
    }));
  };
  state.ws.onmessage = ev => handleMsg(JSON.parse(ev.data));
  state.ws.onclose = () => {
    toast('连接断开，正在重连…');
    if (state.wsRetry < 20) {
      state.wsRetry++;
      setTimeout(() => connectWs(password), 1500);
    }
  };
  state.ws.onerror = () => { state.ws.close(); };
}

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'error': toast('⚠ ' + msg.msg); break;
    case 'entered': onEntered(msg); break;
    case 'state': applyState(msg); break;
    case 'chat': pushChat(msg); break;
    case 'notice': pushNotice(msg); break;
    case 'vote_result': showVoteResult(msg.result); break;
    case 'rtc': if (state.rtc.adapter) state.rtc.adapter.handleSignal(msg); break;
    case 'role_view': showRoleView(msg.data); break;
    case 'kicked': alert(msg.msg); try { state.ws.close(); } catch (e) {} location.reload(); break;
    case 'pong': break;
  }
}

function onEntered(msg) {
  state.me = msg.user;
  state.room = msg.room;
  state.users = {};
  state.users[msg.user.uid] = msg.user;
  $('room-name').textContent = msg.room.name;
  $('room-id').textContent = msg.room.id;
  if (state.room.viewer_is_dm) loadScriptLib();
  render();
  renderVoiceButton();
  // 进入房间即自动连接语音
  connectVoiceIfPossible();
}

async function loadScriptLib() {
  try {
    const data = await api('/api/scripts');
    state.scriptLib = (data.scripts || []).map(s => s.name);
    if (state.gameTab === 'script') render();
  } catch (e) { console.error(e); }
}

function applyState(msg) {
  state.room = msg.room;
  state.users = msg.users;
  state.me = msg.users[state.uid] || null;
  $('room-name').textContent = msg.room.name;
  $('room-id').textContent = msg.room.id;
  render();
  syncVoice();
  syncBgm();
  if (state.rtc.adapter) state.rtc.adapter.syncPeers(Object.values(state.users));
  maybeShowRole();
}

// ---------------- 渲染 ----------------
function render() {
  if (!state.room) return;
  // 房主 & 阶段
  $('room-host').textContent = state.room.host_name || '';
  const badge = $('stage-badge');
  badge.textContent = state.room.stage_name;
  badge.dataset.stage = state.room.stage;
  // 公告
  const ann = $('room-announcement');
  if (ann) {
    if (state.room.announcement) {
      ann.textContent = '📢 ' + state.room.announcement;
      ann.classList.remove('hidden');
    } else {
      ann.classList.add('hidden');
    }
  }
  // 计时器
  startTimerTicker();
  // 麦位
  renderSeats();
  // 剧本杀面板
  renderGamePanel();
  // 麦克风按钮
  renderMicButton();
  // 聊天用户提示（私聊目标）
  renderPriTarget();
}

function renderSeats() {
  const grid = $('seats-grid');
  grid.innerHTML = '';
  // 0 麦：DM 位，单独一行
  const host = Object.values(state.users).find(u => u.seat === 0);
  grid.appendChild(buildSeat(0, host, true));
  // 普通玩家麦位 1~20
  for (let i = 1; i <= 20; i++) {
    const user = Object.values(state.users).find(u => u.seat === i);
    grid.appendChild(buildSeat(i, user, false));
  }
  // 旁观者列表
  const obs = Object.values(state.users).filter(u => u.is_ob);
  if (obs.length || (state.me && state.me.is_ob)) {
    const obDiv = document.createElement('div');
    obDiv.className = 'ob-list';
    let head = `旁观者（${obs.length}）`;
    if (state.me && state.me.is_ob) head += ` · 点击麦位可上麦参与`;
    obDiv.innerHTML = `<div class="ob-head">${head}</div>
      <div class="ob-names">${obs.map(u => `<span class="ob-name">${esc(u.name)}</span>`).join('')}</div>`;
    grid.appendChild(obDiv);
  }
}

function buildSeat(seat, user, isHostSeat) {
  const div = document.createElement('div');
  const isSpeaker = !!(user && state.room && state.room.speaker_uid === user.uid);
  div.className = 'seat'
    + (user ? '' : ' empty')
    + (user && user.uid === state.uid ? ' me' : '')
    + (user && user.is_host ? ' host' : '')
    + (isHostSeat ? ' hostseat' : '')
    + (isSpeaker ? ' current-speaker' : '')
    + (user && !user.online ? ' offline' : '');
  div.dataset.seat = seat;
  if (user) {
    div.innerHTML = `
      <span class="seat-num">${isHostSeat ? 'DM' : seat}</span>
      <span class="muted-tag">${user.is_host ? '👑' : ''}${user.muted ? '🔇' : '🎙'}</span>
      <div class="avatar">${esc(user.name.slice(0, 1))}</div>
      <div class="s-name">${esc(user.name)}${user.is_host ? '(房主)' : ''}</div>
      <div class="s-state">${!user.online ? '离线' : (user.muted ? '闭麦' : '开麦')}</div>`;
  } else {
    div.innerHTML = `
      <span class="seat-num">${isHostSeat ? 'DM' : seat}</span>
      <div class="avatar">+</div>
      <div class="s-name">${isHostSeat ? 'DM 位' : '空位'}</div>
      <div class="s-state">${isHostSeat ? 'DM（0 麦）' : '上麦'}</div>`;
  }
  div.onclick = () => onSeatClick(seat, user);
  return div;
}

function onSeatClick(seat, user) {
  if (user && user.uid === state.uid) {
    wsSend({ type: 'seat', leave: true });
    return;
  }
  if (!user) {
    wsSend({ type: 'seat', seat });
    return;
  }
  // 点击其他玩家 -> 发起私聊
  startPrivate(user.uid, user.name);
}

// ---------------- 剧本杀面板 ----------------
function renderGamePanel() {
  const box = $('game-content');
  const room = state.room;
  const me = state.me;
  const isDm = room.viewer_is_dm;

  const tabs = [['script', '📖 剧本'], ['clue', '🔍 线索'], ['vote', '🗳 投票'], ['host', '🎛 DM'], ['log', '📜 日志'], ['bgm', '🎵 音乐']]
    .filter(([k]) => k !== 'host' || isDm);
  if (!tabs.some(t => t[0] === state.gameTab)) state.gameTab = 'script';

  let html = `<div class="game-tabs">${tabs.map(([k, n]) =>
    `<button class="tab ${state.gameTab === k ? 'active' : ''}" data-gtab="${k}">${n}</button>`).join('')}</div>`;
  html += `<div class="game-tab-body">`;
  if (state.gameTab === 'script') html += renderScriptTab(room, me, isDm);
  else if (state.gameTab === 'clue') html += renderClueTab(room, isDm);
  else if (state.gameTab === 'vote') html += renderVoteTab(room, me, isDm);
  else if (state.gameTab === 'host') html += renderHostTab(room);
  else if (state.gameTab === 'log') html += renderLogTab(room);
  else if (state.gameTab === 'bgm') html += renderBgmTab(room, isDm);
  html += `</div>`;

  let keepScript = null;
  const scriptInp = $('script-input');
  if (scriptInp && document.activeElement === scriptInp) keepScript = scriptInp.value;

  box.innerHTML = html;
  if (keepScript !== null) {
    const n = $('script-input');
    if (n) { n.value = keepScript; n.focus(); }
  }
  bindGameEvents();
}

function renderScriptTab(room, me, isDm) {
  let html = '';
  if (room.script) {
    const s = room.script;
    html += `<div class="game-card">
    <div class="g-title">${esc(s.title)}</div>
    <div class="g-intro">${esc(s.intro || '')}</div>
    <div class="g-roles">角色：${esc(s.role_names.join('、'))}</div>
    ${s.truth ? `<div class="g-roles" style="color:var(--warn)">真相：${esc(s.truth)}</div>` : ''}
    ${s.murderer ? `<div class="g-roles" style="color:var(--danger)">真凶：${esc(s.murderer)}</div>` : ''}
  </div>`;
  } else if (isDm) {
    html += `<h4>创建剧本</h4>
      <div class="import-row">
        <select id="script-import"><option value="">— 从示例库导入 —</option>${state.scriptLib.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select>
        <button class="btn sm" id="btn-load-script">加载</button>
      </div>
      <textarea id="script-input" placeholder="剧本格式示例：
剧本名: 迷雾庄园
简介: 一晚庄园聚会后，主人被发现死于书房……
角色: 王侦探
你是一名侦探，受邀前来调查……
任务: 找出真凶
角色: 李夫人
你是庄园的女主人，与主人感情不合……
真相: 凶手是李夫人，她因遗产纠纷杀人。
凶手: 李夫人
线索: 书房门口有一串脚印"></textarea>
      <div class="btn-row"><button class="btn primary" id="btn-save-script">保存剧本</button></div>
      <p class="tip">支持行：剧本名 / 简介 / 角色 / 任务 / 真相 / 凶手 / 线索（线索: 角色名|内容 仅该角色可见）</p>`;
  } else {
    html = `<div class="tip">等待 DM 创建剧本…</div>`;
  }

  if (isDm) {
    if (me && me.seat !== 0) html += `<div class="tip">⚙ 0 麦空置，你当前代理 DM 面板</div>`;
    html += `<h4>阶段控制</h4><div class="btn-row stage-btns">`;
    [['lobby','准备'],['reading','阅读'],['discussion','讨论'],['voting','投票'],['reveal','真相']].forEach(([st, name]) => {
      html += `<button class="btn ${room.stage === st ? 'active' : ''}" data-stage="${st}">${name}</button>`;
    });
    html += `</div>`;

    html += `<h4>角色分配</h4>
      <div class="btn-row assign-modes">
        <button class="btn ${room.assign_mode === 'auto' ? 'active' : ''}" data-mode="auto">自动分配</button>
        <button class="btn ${room.assign_mode === 'dm' ? 'active' : ''}" data-mode="dm">DM 指定</button>
        <button class="btn ${room.assign_mode === 'self' ? 'active' : ''}" data-mode="self">玩家自选</button>
      </div>`;
    if (room.assign_mode === 'auto') {
      if (!room.roles_assigned) {
        html += `<div class="btn-row"><button class="btn primary" id="btn-assign-roles">🎭 自动分配</button></div>`;
      } else {
        html += `<div class="tip" style="color:var(--ok)">✅ 角色已分配</div>`;
      }
      html += `<div class="btn-row"><button class="btn danger sm" id="btn-reset-roles">重置角色</button></div>`;
    } else if (room.assign_mode === 'dm') {
      if (!room.script) {
        html += `<div class="tip">先创建剧本后才能手动指定角色</div>`;
      } else {
        const roles = room.script.role_names;
        const players = Object.values(state.users).filter(u => u.online && u.seat >= 1 && u.seat <= 20);
        html += `<div class="dm-assign">`;
        if (!players.length) html += `<div class="tip">暂无上麦玩家（1-20 麦）</div>`;
        players.forEach(u => {
          html += `<div class="user-line dm-row">
            <span>${esc(u.name)}${u.is_host ? '👑' : ''}${u.role ? ` <small style="color:var(--ok)">${esc(u.role)}</small>` : ''}</span>
            <select data-dm-uid="${u.uid}">${roles.map(r => `<option value="${esc(r)}" ${u.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
            <button class="btn sm" data-dm-go="${u.uid}">指定</button>
          </div>`;
        });
        html += `</div>`;
        if (room.roles_assigned) html += `<div class="tip" style="color:var(--ok)">✅ 所有在线玩家已分配角色</div>`;
      }
      html += `<div class="btn-row"><button class="btn danger sm" id="btn-reset-roles">重置角色</button></div>`;
    } else {
      if (room.script) {
        html += `<div class="tip">玩家可在剧本面板点「选择角色」，先到先得</div>`;
        if (room.roles_assigned) html += `<div class="tip" style="color:var(--ok)">✅ 所有在线玩家已分配角色</div>`;
      } else {
        html += `<div class="tip">先创建剧本后才能进入玩家自选</div>`;
      }
      html += `<div class="btn-row"><button class="btn danger sm" id="btn-reset-roles">重置角色</button></div>`;
    }

    html += `<div class="timer-row">
      <input id="timer-input" type="number" value="300" min="10" step="10">
      <button class="btn" id="btn-timer">${room.timer.running ? '重新计时' : '⏱ 计时'}</button>
      ${room.timer.running ? `<button class="btn danger" id="btn-stop-timer">停止</button>` : ''}
    </div>`;
  }

  if (me && me.role) {
    html += `<h4>我的角色</h4><div class="my-role-box">🎭 <b>${esc(me.role)}</b>
      ${me.role_task ? `<div class="role-task">🎯 任务：${esc(me.role_task)}</div>` : ''}
      ${me.role_text ? `<button class="btn sm" id="btn-view-role" style="margin-top:6px">查看剧本</button>` : ''}
    </div>`;
  } else if (me && me.seat === 0) {
    html += `<div class="tip">🎙 你是 DM（0 麦），主持本局，不参与角色与投票</div>`;
  } else if (me && me.is_ob) {
    html += `<div class="tip">👁 你以旁观者身份观看本局，不参与游戏</div>`;
  } else if (room.stage !== 'lobby') {
    html += `<div class="tip">未分配角色</div>`;
  }
  if (me && me.seat !== 0 && room.assign_mode === 'self' && room.script && !room.roles_assigned && !me.role && !me.is_ob) {
    html += `<div class="btn-row"><button class="btn primary" id="btn-claim-role">🎭 选择角色</button></div>`;
  }
  if (me && me.seat !== 0 && room.assign_mode !== 'self' && room.script && !room.roles_assigned) {
    html += `<div class="tip">等待 DM 分配角色…</div>`;
  }
  return html;
}

function renderClueTab(room, isDm) {
  let html = '';
  const clues = room.clues || [];
  if (isDm) {
    html += `<h4>发放线索</h4>
      <textarea id="clue-input" style="min-height:70px" placeholder="线索内容"></textarea>
      <div class="import-row">
        <select id="clue-visible"><option value="all">公开</option>${(room.script ? room.script.role_names : []).map(r => `<option value="${esc(r)}">仅 ${esc(r)}</option>`).join('')}</select>
        <button class="btn primary sm" id="btn-add-clue">发放</button>
      </div>`;
  }
  html += `<h4>线索（${clues.length}）</h4>`;
  if (!clues.length) html += `<div class="tip">暂无可见线索</div>`;
  clues.forEach(c => {
    html += `<div class="clue-card"><div class="clue-text">🔍 ${esc(c.text)}</div>
      <div class="clue-tag">${c.visible_to === 'all' ? '公开' : '仅 ' + esc(c.visible_to)}</div></div>`;
  });
  return html;
}

function renderVoteTab(room, me, isDm) {
  let html = `<h4>🗳 投票 · 第 ${room.vote_round} 轮</h4>`;
  if (room.stage === 'voting') {
    html += renderVoteUI(room, me);
  } else if (room.stage === 'reveal') {
    html += `<div class="tip" style="color:var(--ok)">真相已公布，可公布投票结果进行复盘判定</div>`;
  } else {
    html += `<div class="tip">尚未进入投票阶段（DM 切换到「投票」阶段后开始）</div>`;
  }
  if (isDm && room.stage === 'voting') {
    html += `<div class="btn-row"><button class="btn primary" id="btn-reveal-votes">公布结果</button>
      <button class="btn" id="btn-next-round">下一轮投票</button></div>`;
  }
  return html;
}

function renderVoteUI(room, me) {
  if (me && me.seat === 0) return `<div class="tip">🎙 你是 DM，不参与投票</div>`;
  if (me && me.is_ob) return `<div class="tip">旁观者不参与投票</div>`;
  if (me && me.voted_for) {
    const target = state.users[me.voted_for];
    return `<div class="tip">你已投票给 <b>${esc(target ? target.name : '')}</b>，等待其他玩家…</div>`;
  }
  const candidates = Object.values(state.users).filter(u => u.uid !== state.uid && u.online && u.seat >= 1 && u.seat <= 20);
  let html = `<div class="tip">请选择你怀疑的凶手</div><div class="vote-list">`;
  candidates.forEach(u => {
    html += `<div class="vote-item"><span>${esc(u.name)}${u.role ? ` <small style="color:var(--muted)">${esc(u.role)}</small>` : ''}</span>
      <button class="btn sm" data-vote="${u.uid}">投票</button></div>`;
  });
  html += `</div>`;
  return html;
}

function renderHostTab(room) {
  let html = `<h4>房间公告</h4>
    <div class="import-row">
      <input id="announcement-input" placeholder="房间公告（所有人可见）" value="${esc(room.announcement || '')}">
      <button class="btn sm" id="btn-set-announcement">发布</button>
    </div>`;
  html += `<h4>控麦</h4><div class="btn-row">
    <button class="btn" id="btn-mute-all">🔇 全体禁言</button>
    <button class="btn" id="btn-unmute-all">🎙 解除全体</button></div>`;
  html += `<h4>指定发言</h4>
    <div class="import-row">
      <select id="speaker-select"><option value="">— 指定当前发言玩家 —</option>${Object.values(state.users).map(u => `<option value="${u.uid}" ${room.speaker_uid === u.uid ? 'selected' : ''}>${esc(u.name)}${u.is_host ? '(房主)' : ''}</option>`).join('')}</select>
      <button class="btn sm" id="btn-set-speaker">指定</button>
    </div>`;
  html += `<h4>玩家管理</h4>`;
  Object.values(state.users).forEach(u => {
    if (u.uid === state.uid) return;
    html += `<div class="user-line">
      <div class="u-info"><span>${esc(u.name)}${u.is_host ? '👑' : ''}${u.is_ob ? `<span style="color:var(--muted);font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 4px">OB</span>` : ''}</span>${u.role ? `<span style="color:var(--accent-2);font-size:12px">${esc(u.role)}</span>` : ''}${!u.online ? `<span style="color:var(--muted);font-size:11px">离线</span>` : ''}</div>
      <div class="btn-row" style="margin:0">
        <button class="btn sm ${u.muted ? 'primary' : 'ghost'}" data-mute="${u.uid}" data-cur="${u.muted}">${u.muted ? '开麦' : '闭麦'}</button>
        ${u.role ? `<button class="btn sm" data-view-role="${u.uid}">剧本</button>` : ''}
        <button class="btn danger sm" data-kick="${u.uid}">踢出</button>
      </div></div>`;
  });
  return html;
}

function renderLogTab(room) {
  const log = room.log || [];
  if (!log.length) return `<div class="tip">暂无游戏日志</div>`;
  return `<div class="log-list">${log.map(l =>
    `<div class="log-line"><span class="log-time">${esc(l.time)}</span>${esc(l.text)}</div>`).join('')}</div>`;
}

function bindGameEvents() {
  document.querySelectorAll('[data-gtab]').forEach(b => {
    b.onclick = () => { state.gameTab = b.dataset.gtab; render(); };
  });

  const saveBtn = $('btn-save-script');
  if (saveBtn) saveBtn.onclick = () => wsSend({ type: 'script', text: $('script-input').value });

  const loadBtn = $('btn-load-script');
  if (loadBtn) loadBtn.onclick = async () => {
    const sel = $('script-import');
    if (!sel || !sel.value) { toast('请先选择剧本'); return; }
    try {
      const data = await api('/api/scripts/' + encodeURIComponent(sel.value));
      const inp = $('script-input');
      if (inp) inp.value = data.content;
    } catch (e) { toast(e.message); }
  };

  const assignBtn = $('btn-assign-roles');
  if (assignBtn) assignBtn.onclick = () => wsSend({ type: 'assign_roles' });

  document.querySelectorAll('[data-mode]').forEach(b => {
    b.onclick = () => wsSend({ type: 'assign_mode', mode: b.dataset.mode });
  });

  const resetBtn = $('btn-reset-roles');
  if (resetBtn) resetBtn.onclick = () => {
    if (confirm('确定重置所有角色？')) wsSend({ type: 'reset_roles' });
  };

  document.querySelectorAll('[data-dm-go]').forEach(b => {
    b.onclick = () => {
      const sel = document.querySelector(`select[data-dm-uid="${b.dataset.dmGo}"]`);
      if (!sel) return;
      wsSend({ type: 'dm_assign', uid: b.dataset.dmGo, role: sel.value });
    };
  });

  const claimBtn = $('btn-claim-role');
  if (claimBtn) claimBtn.onclick = showClaimModal;

  document.querySelectorAll('[data-stage]').forEach(b => {
    b.onclick = () => wsSend({ type: 'stage', stage: b.dataset.stage });
  });

  const tBtn = $('btn-timer');
  if (tBtn) tBtn.onclick = () => {
    const sec = parseInt($('timer-input').value || '60', 10);
    wsSend({ type: 'timer', seconds: Math.max(10, sec) });
  };
  const stBtn = $('btn-stop-timer');
  if (stBtn) stBtn.onclick = () => wsSend({ type: 'stop_timer' });

  const viewRole = $('btn-view-role');
  if (viewRole) viewRole.onclick = () => showRoleModal();

  document.querySelectorAll('[data-vote]').forEach(b => {
    b.onclick = () => wsSend({ type: 'vote', uid: b.dataset.vote });
  });

  const addClue = $('btn-add-clue');
  if (addClue) addClue.onclick = () => {
    const text = $('clue-input').value.trim();
    const vis = $('clue-visible').value;
    if (!text) { toast('请输入线索内容'); return; }
    wsSend({ type: 'add_clue', text, visible_to: vis });
    $('clue-input').value = '';
  };

  const reveal = $('btn-reveal-votes');
  if (reveal) reveal.onclick = () => wsSend({ type: 'reveal_votes' });
  const nextRound = $('btn-next-round');
  if (nextRound) nextRound.onclick = () => wsSend({ type: 'next_round' });

  const ann = $('btn-set-announcement');
  if (ann) ann.onclick = () => wsSend({ type: 'announcement', text: $('announcement-input').value });

  document.querySelectorAll('[data-mute]').forEach(b => {
    b.onclick = () => wsSend({ type: 'host_mute', uid: b.dataset.mute, muted: b.dataset.cur === 'false' });
  });
  const ma = $('btn-mute-all');
  if (ma) ma.onclick = () => wsSend({ type: 'host_mute_all', muted: true });
  const ua = $('btn-unmute-all');
  if (ua) ua.onclick = () => wsSend({ type: 'host_mute_all', muted: false });

  const sp = $('btn-set-speaker');
  if (sp) sp.onclick = () => wsSend({ type: 'set_speaker', uid: $('speaker-select').value });

  document.querySelectorAll('[data-view-role]').forEach(b => {
    b.onclick = () => wsSend({ type: 'view_role', uid: b.dataset.viewRole });
  });
  document.querySelectorAll('[data-kick]').forEach(b => {
    b.onclick = () => { if (confirm('确定将该玩家移出房间？')) wsSend({ type: 'kick', uid: b.dataset.kick }); };
  });

  bindBgmControls();
}

function maybeShowRole() {
  const room = state.room, me = state.me;
  if (!room || !me || !me.role || !me.role_text) return;
  if ((room.stage === 'reading' || room.stage === 'discussion') && !state.roleShown) {
    state.roleShown = true;
    showRoleModal();
  }
}

function showRoleModal() {
  $('role-modal-title').textContent = `🎭 ${state.me.role} · 我的剧本`;
  let html = `<div class="role-content">${esc(state.me.role_text || '（本角色无文字剧本）')}`;
  if (state.me.role_task) html += `<p style="color:var(--warn);margin-top:10px">🎯 任务：${esc(state.me.role_task)}</p>`;
  html += `</div>`;
  $('role-modal-content').innerHTML = html;
  $('role-modal').classList.remove('hidden');
}

function showClaimModal() {
  const room = state.room;
  if (!room || !room.script) return;
  const claimed = new Set(Object.values(state.users).map(u => u.role).filter(Boolean));
  const available = room.script.role_names.filter(r => !claimed.has(r));
  let html = '';
  if (!available.length) {
    html = `<div class="tip">角色已被选完</div>`;
  } else {
    html = `<div class="tip">以下角色可选（先到先得）</div>`;
    available.forEach(r => {
      html += `<div class="claim-item"><span>${esc(r)}</span>
        <button class="btn sm primary" data-claim="${esc(r)}">选择</button></div>`;
    });
  }
  $('claim-modal-content').innerHTML = html;
  $('claim-modal').classList.remove('hidden');
  document.querySelectorAll('[data-claim]').forEach(b => {
    b.onclick = () => {
      wsSend({ type: 'claim_role', role: b.dataset.claim });
      $('claim-modal').classList.add('hidden');
    };
  });
}

function showVoteResult(result) {
  const box = $('vote-modal-content');
  let html = '';
  if (result.murderer_role) {
    html += `<div class="tip" style="color:var(--danger)">真凶角色：<b>${esc(result.murderer_role)}</b></div>`;
  }
  html += `<h4>票数统计</h4>`;
  if (!result.tally.length) html += '<div class="tip">无人投票</div>';
  result.tally.forEach((r, i) => {
    html += `<div class="vote-result-line"><span>${i + 1}. ${esc(r.name)}</span><b>${r.count} 票</b></div>`;
  });
  html += `<h4>判定 / 得分</h4>`;
  (result.verdict || []).forEach(v => {
    html += `<div class="vote-result-line">
      <span>${esc(v.name)}${v.voted_name ? ` → ${esc(v.voted_name)}` : ' · 未投票'}${v.correct ? ' ✅' : ''}</span>
      <b style="color:${v.correct ? 'var(--ok)' : 'var(--muted)'}">${v.score}分</b></div>`;
  });
  box.innerHTML = html;
  $('vote-modal').classList.remove('hidden');
}

function showRoleView(data) {
  $('role-modal-title').textContent = `📖 ${data.name} · ${data.role || '未分配角色'}`;
  let html = `<div class="role-content">${esc(data.role_text || '（无文字剧本）')}`;
  if (data.role_task) html += `<p style="color:var(--warn);margin-top:10px">🎯 任务：${esc(data.role_task)}</p>`;
  html += `</div>`;
  $('role-modal-content').innerHTML = html;
  $('role-modal').classList.remove('hidden');
}

// ---------------- 计时器 ----------------
function startTimerTicker() {
  if (state.timerTicker) return;
  state.timerTicker = setInterval(() => {
    const t = state.room && state.room.timer;
    if (t && t.running && t.end_at) {
      const left = Math.max(0, Math.round(t.end_at - Date.now() / 1000));
      $('timer-display').textContent = '⏱ ' + fmtTime(left);
    } else {
      $('timer-display').textContent = '⏱ 00:00';
    }
  }, 500);
}

// ---------------- 麦克风 / 麦位状态 ----------------
function renderMicButton() {
  const me = state.me;
  const btn = $('btn-mic');
  if (!me) return;
  const onSeat = me.seat >= 0;
  if (onSeat) {
    btn.textContent = me.muted ? '🎤 开麦' : '🔇 闭麦';
    btn.classList.toggle('primary', me.muted);
  } else {
    btn.textContent = '🎤 未上麦';
    btn.classList.remove('primary');
  }
}

function toggleMic() {
  const me = state.me;
  if (!me || me.seat < 0) { toast('请先上麦'); return; }
  const muted = !me.muted;
  wsSend({ type: 'mic', muted });
  state.me.muted = muted;
  renderMicButton();
  syncVoice();
}

function renderVoiceButton() {
  const btn = $('btn-set-voice');
  const st = $('voice-status');
  const joined = !!(state.rtc.adapter && state.rtc.adapter.joined);
  if (joined) {
    btn.textContent = '🔇 断开语音';
    st.textContent = '已连接语音';
    st.classList.add('on');
  } else {
    btn.textContent = (state.appId || state.trtcSdkAppId) ? '🔊 连接语音' : '🔊 连接语音(局域网)';
    st.textContent = '未连接语音';
    st.classList.remove('on');
  }
}

function renderPriTarget() {
  const me = state.me;
  const chatBox = $('chat-pri');
  if (state.tab === 'pri' && state.priTarget) {
    const u = state.users[state.priTarget] || { name: '未知' };
    chatBox.dataset.placeholder = `私聊 ${u.name}`;
    $('chat-input').placeholder = `私聊 ${u.name}：按 Enter 发送`;
  } else if (state.tab === 'pri') {
    $('chat-input').placeholder = '未选择对象，消息将发到公屏';
  } else if (state.tab === 'pub') {
    $('chat-input').placeholder = '按 Enter 发送消息';
  }
}

// ---------------- 聊天 ----------------
function convKey(a, b) {
  return [a, b].sort().join('|');
}

function pushChat(msg) {
  if (msg.to === 'private') {
    const other = msg.from === state.uid ? msg.to_uid || '' : msg.from;
    if (!other) return;
    const key = convKey(state.uid, other);
    if (!state.chatPri[key]) state.chatPri[key] = [];
    state.chatPri[key].push(msg);
    if (state.priNames) state.priNames[other] = msg.from === state.uid ? msg.to_name || msg.name : msg.name;
    renderChat('pri');
    if (state.tab !== 'pri' && msg.from !== state.uid) {
      state.priUnread++;
      $('pri-badge').textContent = state.priUnread;
      $('pri-badge').classList.remove('hidden');
    }
    return;
  }
  state.chatPub.push(msg);
  if (state.chatPub.length > 200) state.chatPub = state.chatPub.slice(-150);
  renderChat('pub');
}

function pushNotice(msg) {
  const n = { type: 'notice', text: msg.text, time: msg.time };
  state.chatPub.push(n);
  if (state.chatPub.length > 200) state.chatPub = state.chatPub.slice(-150);
  renderChat('pub');
}

function renderChat(tab) {
  const log = tab === 'pri' ? $('chat-pri') : $('chat-pub');
  if (tab === 'pub') {
    log.innerHTML = state.chatPub.map(m => {
      if (m.type === 'notice') return `<div class="msg notice">${esc(m.text)}</div>`;
      return `<div class="msg ${m.from === state.uid ? 'me' : ''}"><span class="m-name">${esc(m.name)}</span>${esc(m.text)}<span class="m-time">${esc(m.time || '')}</span></div>`;
    }).join('');
  } else {
    const meName = state.me ? state.me.name : '';
    if (!state.priTarget) {
      const rows = [];
      Object.values(state.chatPri || {}).forEach(list => list.forEach(m => {
        rows.push(m);
      }));
      rows.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      log.innerHTML = rows.map(m => {
        const name = m.from === state.uid ? `${meName}→${m.to_name || m.name}` : ((state.priNames && state.priNames[m.from]) || m.name);
        return `<div class="msg ${m.from === state.uid ? 'me' : ''}"><span class="m-name">${esc(name)}</span>${esc(m.text)}<span class="m-time">${esc(m.time || '')}</span></div>`;
      }).join('') || '<div class="tip">点击麦位上其他玩家的头像，即可发起私聊。</div>';
      return;
    }
    const key = convKey(state.uid, state.priTarget);
    const list = state.chatPri[key] || [];
    log.innerHTML = list.map(m => {
      const name = m.from === state.uid ? meName : (state.priNames && state.priNames[m.from]) || m.name;
      return `<div class="msg ${m.from === state.uid ? 'me' : ''}"><span class="m-name">${esc(name)}</span>${esc(m.text)}<span class="m-time">${esc(m.time || '')}</span></div>`;
    }).join('');
  }
  log.scrollTop = log.scrollHeight;
}

function startPrivate(uid, name) {
  state.priTarget = uid;
  if (!state.priNames) state.priNames = {};
  state.priNames[uid] = name;
  if (state.tab !== 'pri') switchTab('pri');
  $('chat-input').placeholder = `私聊 ${name}：按 Enter 发送`;
  renderChat('pri');
  renderPriTarget();
}

function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  if (state.tab === 'pri' && state.priTarget) {
    wsSend({ type: 'chat', to: 'private', to_uid: state.priTarget, text });
  } else {
    wsSend({ type: 'chat', to: 'all', text });
  }
  input.value = '';
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.chat-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('chat-pub').classList.toggle('hidden', tab !== 'pub');
  $('chat-pri').classList.toggle('hidden', tab !== 'pri');
  if (tab === 'pri') {
    state.priUnread = 0;
    $('pri-badge').classList.add('hidden');
  }
  renderChat(tab);
  renderPriTarget();
}

// ---------------- 语音（RTC 抽象层统一管理，模式：auto/lan/agora/trtc） ----------------
async function connectVoiceIfPossible() {
  const r = await ensureVoice();
  if (!r.ok) toast(r.msg);
  renderVoiceButton();
}

// 根据配置解析实际语音模式（auto 时自动选择已配置的云端引擎）
function resolveRTCProvider() {
  if (state.provider !== 'auto') return state.provider;
  if (state.appId) return 'agora';
  if (state.trtcSdkAppId && state.trtcSecret) return 'trtc';
  return 'lan';
}

// 从后端签发 TRTC userSig（待接入），失败返回空字符串
async function fetchRtcToken(provider) {
  if (!state.roomId) return '';
  try {
    const data = await api('/api/rtc/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, room_id: state.roomId, uid: state.uid }),
    });
    return data.token || '';
  } catch (e) {
    console.error('fetch rtc token failed', e);
    return '';
  }
}

// 获取（必要时重建）当前模式的 RTC 适配器
async function ensureRTCAdapter() {
  const mode = resolveRTCProvider();
  if (state.rtc.adapter && state.rtc.adapter.mode === mode) return state.rtc.adapter;
  if (state.rtc.adapter) {
    await state.rtc.adapter.disconnect();
    state.rtc.adapter = null;
  }
  const base = {
    signal: { send: pkt => wsSend({ type: 'rtc', to_uid: pkt.to_uid, payload: pkt.payload }) },
    onTrack: attachRemoteStream,
    onSpeaking: setSeatSpeaking,
    onError: msg => toast('⚠ ' + msg),
    onStatus: msg => toast(msg),
  };
  let opts = base;
  if (mode === 'agora') opts = Object.assign({ appId: state.appId }, base);
  else if (mode === 'trtc') opts = Object.assign({ sdkAppId: state.trtcSdkAppId, userSig: await fetchRtcToken('trtc') }, base);
  state.rtc.adapter = createRTCAdapter(mode, opts);
  return state.rtc.adapter;
}

async function ensureVoice() {
  if (state.voiceBusy) return { ok: false, msg: '正在连接语音…' };
  const adapter = await ensureRTCAdapter();
  if (adapter.joined) return { ok: true };
  state.voiceBusy = true;
  try {
    await adapter.connect(state.roomId, state.uid);
    syncVoice();
    adapter.syncPeers(Object.values(state.users));
    if (adapter.mode === 'lan' && adapter.localStream) setupSpeakerDetect(state.uid, adapter.localStream);
    toast('🔊 ' + adapter.label + ' 语音已连接');
    return { ok: true };
  } catch (e) {
    console.error('voice connect failed', e);
    return { ok: false, msg: e.message || '语音连接失败' };
  } finally {
    state.voiceBusy = false;
  }
}

function attachRemoteStream(uid, stream) {
  if (!stream) {
    const el = document.getElementById('audio-' + uid);
    if (el) { el.srcObject = null; el.remove(); }
    setSeatSpeaking(uid, false);
    return;
  }
  let el = document.getElementById('audio-' + uid);
  if (!el) {
    el = document.createElement('audio');
    el.id = 'audio-' + uid;
    el.autoplay = true;
    document.body.appendChild(el);
  }
  el.srcObject = stream;
  setupSpeakerDetect(uid, stream);
}

function setupSpeakerDetect(uid, stream) {
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const isSelf = uid === state.uid;
    const tick = () => {
      const a = state.rtc.adapter;
      if (!a || a.mode !== 'lan' || !a.localStream || (!isSelf && !a.peers[uid])) {
        ctx.close().catch(() => {});
        return;
      }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      setSeatSpeaking(uid, Math.sqrt(sum / data.length) > 0.06);
      requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { console.error('speaker detect', e); }
}

function setSeatSpeaking(uid, on) {
  document.querySelectorAll('.seat').forEach(el => {
    const user = Object.values(state.users).find(u => u.seat === parseInt(el.dataset.seat, 10));
    if (user && user.uid === uid) el.classList.toggle('speaking', on && !user.muted);
  });
}

async function leaveVoice() {
  if (!state.rtc.adapter) return;
  await state.rtc.adapter.disconnect();
  state.rtc.adapter = null;
  renderVoiceButton();
}

function syncVoice() {
  const me = state.me;
  const canSpeak = !!(me && me.seat >= 0 && !me.muted);
  if (state.rtc.adapter) state.rtc.adapter.setMuted(!canSpeak);
}

// ---------------- 变声（仅局域网直连模式支持） ----------------
function applyVoiceEffect(mode) {
  state.voiceEffect = mode;
  const a = state.rtc.adapter;
  if (a && a.joined) {
    a.setVoiceEffect(mode);
  } else if (mode !== 'none') {
    toast('变声仅支持「局域网直连」模式，且需先连接语音');
    const ve = $('voice-effect');
    if (ve) ve.value = 'none';
    state.voiceEffect = 'none';
  }
}

// ---------------- 背景音乐（BGM） ----------------
function bgmAudio() { return $('bgm-audio'); }

function bgmPos(bgm) {
  if (!bgm) return 0;
  let p = bgm.position || 0;
  if (bgm.playing && bgm.ts) p += (Date.now() / 1000) - bgm.ts;
  return Math.max(0, p);
}

function renderBgmTab(room, isDm) {
  const bgm = room.bgm || {};
  const hasTrack = !!bgm.url;
  const ctl = hasTrack ? '' : ' disabled';
  let html = `<div class="bgm-tab"><div class="bgm-head">🎵 <span class="bgm-title">${hasTrack ? esc(bgm.title || '背景音乐') : (isDm ? '未上传背景音乐' : 'DM 尚未上传背景音乐')}</span></div>`;
  if (isDm) {
    html += `<div class="bgm-row">
      <input type="file" id="bgm-file" accept=".mp3,.wav,.ogg,.m4a,.mp4,.aac,.flac,.webm,.opus,audio/*" hidden>
      <button class="btn sm primary" id="btn-bgm-upload">⬆ 上传</button>
      <button class="btn sm" id="btn-bgm-play"${ctl}>${bgm.playing ? '⏸ 暂停' : '▶ 播放'}</button>
      <button class="btn sm" id="btn-bgm-stop"${ctl}>⏹ 停止</button>
      <button class="btn sm ${bgm.loop ? 'active' : ''}" id="btn-bgm-loop"${ctl}>🔁 循环</button>
    </div>`;
  }
  html += `<div class="bgm-row bgm-progress">
    <input type="range" id="bgm-seek" min="0" max="1000" step="1" value="0" ${isDm && hasTrack ? '' : 'disabled'}>
    <span class="bgm-time" id="bgm-time"></span>
  </div>`;
  if (isDm) {
    html += `<div class="bgm-row bgm-vol">
      <span>🔉</span><input type="range" id="bgm-vol-global" min="0" max="100" step="1" value="${Math.round((bgm.volume || 1) * 100)}">
      <span class="bgm-vol-note">房内全局音量</span>
    </div>`;
  } else {
    const localVol = Math.round(((state.bgmLocalVol != null ? state.bgmLocalVol : (bgm.volume || 1)) || 1) * 100);
    html += `<div class="bgm-row bgm-vol">
      <span>🔉</span><input type="range" id="bgm-vol-local" min="0" max="100" step="1" value="${localVol}">
      <span class="bgm-vol-note">仅调自己的音量</span>
    </div>`;
  }
  html += `</div>`;
  return html;
}

// 进度条与时间显示：优先用 <audio> 的真实播放状态，未加载时退回服务端记录。
function updateBgmProgress() {
  const a = bgmAudio();
  const seek = $('bgm-seek');
  if (!a || !seek || !state.room) return;
  const bgm = state.room.bgm || {};
  const d = a.duration;
  const hasDur = isFinite(d) && d > 0;
  let dur = hasDur ? d : 0;
  let cur;
  if (hasDur) {
    cur = (a.ended && !a.loop) ? dur : a.currentTime;
  } else {
    cur = bgmPos(bgm);
  }
  if (!isFinite(cur) || cur < 0) cur = 0;
  const pct = dur > 0 ? Math.min(100, Math.max(0, (cur / dur) * 100)) : 0;
  seek.value = Math.round(pct * 10);
  const t = $('bgm-time');
  if (t) t.textContent = fmtTime(cur) + ' / ' + fmtTime(dur);
}

function bindBgmControls() {
  const a = bgmAudio();
  const up = $('btn-bgm-upload');
  if (up) up.onclick = () => { const f = $('bgm-file'); if (f) f.click(); };
  const fi = $('bgm-file');
  if (fi) fi.onchange = () => { if (fi.files && fi.files[0]) uploadBgm(fi.files[0]); fi.value = ''; };

  const play = $('btn-bgm-play');
  if (play) play.onclick = () => {
    const b = state.room.bgm;
    if (!b || !b.url) { toast('请先上传 BGM'); return; }
    let cur = (a && isFinite(a.currentTime) ? a.currentTime : 0) || 0;
    if (b.playing) {
      wsSend({ type: 'bgm', action: 'pause', position: cur });
    } else {
      if (a && a.ended) cur = 0;   // 播放结束后再次播放从开头开始
      wsSend({ type: 'bgm', action: 'play', position: cur });
    }
  };
  const stop = $('btn-bgm-stop');
  if (stop) stop.onclick = () => wsSend({ type: 'bgm', action: 'stop' });
  const loop = $('btn-bgm-loop');
  if (loop) loop.onclick = () => wsSend({ type: 'bgm', action: 'loop', loop: !state.room.bgm.loop });

  const vol = $('bgm-vol-global');
  if (vol) vol.oninput = () => wsSend({ type: 'bgm', action: 'volume', volume: parseInt(vol.value, 10) / 100 });
  const volL = $('bgm-vol-local');
  if (volL) volL.oninput = () => { state.bgmLocalVol = parseInt(volL.value, 10) / 100; applyBgmVolume(); };

  const seek = $('bgm-seek');
  if (seek && !seek.disabled) {
    seek.oninput = () => {
      const d = a.duration;
      if (isFinite(d) && d > 0) {
        const pos = d * (parseInt(seek.value, 10) / 1000);
        try { a.currentTime = pos; } catch (e) {}
        wsSend({ type: 'bgm', action: 'seek', position: pos });
      }
    };
  }
  updateBgmProgress();
}

function uploadBgm(file) {
  const fd = new FormData();
  fd.append('file', file);
  toast('上传中…');
  fetch(`/api/rooms/${state.room.id}/bgm?viewer=${encodeURIComponent(state.uid)}`, { method: 'POST', body: fd })
    .then(r => r.json().then(d => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok) { toast(d.detail || '上传失败'); return; }
      wsSend({ type: 'bgm', action: 'load', url: d.url, title: d.title });
      toast('BGM 上传成功');
    })
    .catch(() => toast('上传失败'));
}

function syncBgm() {
  const a = bgmAudio();
  if (!a || !state.room || !state.room.bgm) return;
  const bgm = state.room.bgm;
  const sig = bgm.url + '|' + bgm.playing + '|' + bgm.position + '|' + bgm.ts + '|' + bgm.loop;
  if (sig === state._bgmSig) { applyBgmVolume(); updateBgmProgress(); return; }
  state._bgmSig = sig;
  applyBgmVolume();
  if (!bgm.url) {
    a.pause();
    a.removeAttribute('src');
    a.load();
    updateBgmProgress();
    return;
  }
  const freshSrc = a.getAttribute('src') !== bgm.url;
  if (freshSrc) { a.src = bgm.url; a.load(); }
  a.loop = !!bgm.loop;
  if (bgm.playing) {
    const off = Math.max(0, bgm.position + (Date.now() / 1000 - bgm.ts));
    const seekPlay = () => {
      try { a.currentTime = off; } catch (e) {}
      const p = a.play();
      if (p && p.catch) p.catch(() => {});
      updateBgmProgress();
    };
    if (freshSrc || a.readyState < 1) { a.onloadedmetadata = seekPlay; a.oncanplay = seekPlay; }
    else seekPlay();
  } else {
    a.pause();
    try { a.currentTime = bgm.position; } catch (e) {}
    updateBgmProgress();
  }
}

function applyBgmVolume() {
  const a = bgmAudio();
  if (!a) return;
  const vol = state.bgmLocalVol != null ? state.bgmLocalVol : (state.room && state.room.bgm ? state.room.bgm.volume : 1);
  a.volume = Math.min(1, Math.max(0, vol));
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return m + ':' + String(sec).padStart(2, '0');
}

// ---------------- 弹窗 / 设置 ----------------
function openSettings() {
  $('voice-provider').value = state.provider;
  $('appid-input').value = state.appId;
  $('trtc-sdkappid-input').value = state.trtcSdkAppId;
  $('trtc-secret-input').value = state.trtcSecret;
  $('settings-modal').classList.remove('hidden');
}
function closeSettings() {
  state.provider = $('voice-provider').value;
  state.appId = $('appid-input').value.trim();
  state.trtcSdkAppId = $('trtc-sdkappid-input').value.trim();
  state.trtcSecret = $('trtc-secret-input').value.trim();
  localStorage.setItem('sv_rtc_provider', state.provider);
  localStorage.setItem('sv_appid', state.appId);
  localStorage.setItem('sv_trtc_sdkappid', state.trtcSdkAppId);
  localStorage.setItem('sv_trtc_secret', state.trtcSecret);
  $('settings-modal').classList.add('hidden');
  // 模式/配置变化：断开并重新连接语音
  if (state.roomId && state.rtc.adapter) {
    leaveVoice().then(() => connectVoiceIfPossible());
  }
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('btn-refresh-rooms').onclick = refreshRooms;
  $('btn-create-room').onclick = createRoom;
  $('btn-join-room').onclick = joinByNumber;
  $('join-id').addEventListener('keydown', e => { if (e.key === 'Enter') joinByNumber(); });
  $('btn-settings').onclick = openSettings;
  $('btn-save-appid').onclick = closeSettings;
  $('btn-close-settings').onclick = closeSettings;
  $('appid-input').addEventListener('keydown', e => { if (e.key === 'Enter') closeSettings(); });

  $('btn-leave-room').onclick = () => {
    state.wsRetry = 99;   // 立即锁死重连，防止服务端断开后自动重连重新进房
    const doLeave = () => {
      if (state.ws) state.ws.close();
      if (state.rtc.adapter) leaveVoice();
      $('room-screen').classList.add('hidden');
      $('login-screen').classList.remove('hidden');
      refreshRooms();
    };
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try { state.ws.send(JSON.stringify({ type: 'leave' })); } catch (e) {}
      setTimeout(doLeave, 300);
    } else {
      doLeave();
    }
  };

  $('room-list').addEventListener('click', e => {
    const btn = e.target.closest('.r-enter');
    if (!btn) return;
    if (!requireName()) return;
    if (btn.dataset.pass === 'true') {
      const pwd = prompt('该房间需要密码：');
      if (pwd === null) return;
      enterRoom(btn.dataset.id, pwd);
    } else {
      enterRoom(btn.dataset.id, '');
    }
  });

  $('btn-mic').onclick = toggleMic;
  const bgmAudioEl = bgmAudio();
  if (bgmAudioEl) {
    // 播放结束（未循环）：停在结尾，进度条保持最右端，并通知服务端
    bgmAudioEl.addEventListener('ended', () => {
      if (state.room && state.room.viewer_is_dm) {
        const d = bgmAudioEl.duration;
        wsSend({ type: 'bgm', action: 'pause', position: isFinite(d) && d > 0 ? d : 0 });
      }
      updateBgmProgress();
    });
    // 实时刷新进度条：播放/暂停/跳转/结束等事件都更新
    ['timeupdate', 'loadedmetadata', 'play', 'pause', 'seeked', 'canplay'].forEach(ev =>
      bgmAudioEl.addEventListener(ev, updateBgmProgress));
  }
  $('btn-set-voice').onclick = async () => {
    if (state.rtc.adapter && state.rtc.adapter.joined) { await leaveVoice(); }
    else { const r = await ensureVoice(); if (!r.ok) toast(r.msg); renderVoiceButton(); }
  };

  const ve = $('voice-effect');
  if (ve) {
    ve.value = state.voiceEffect || 'none';
    ve.onchange = () => applyVoiceEffect(ve.value);
  }

  $('btn-chat').onclick = sendChat;
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  document.querySelectorAll('.chat-tabs .tab').forEach(b => {
    b.onclick = () => switchTab(b.dataset.tab);
  });

  $('btn-close-role').onclick = () => $('role-modal').classList.add('hidden');
  $('btn-close-vote').onclick = () => $('vote-modal').classList.add('hidden');
  $('btn-close-claim').onclick = () => $('claim-modal').classList.add('hidden');
}

// 弹窗打开时锁住页面滚动（老 iOS 不支持 overscroll-behavior 的兜底）
function setupScrollLock() {
  const modals = ['settings-modal', 'role-modal', 'claim-modal', 'vote-modal']
    .map(id => document.getElementById(id)).filter(Boolean);
  if (!modals.length) return;
  const apply = () => {
    const anyOpen = modals.some(m => !m.classList.contains('hidden'));
    if (anyOpen) {
      const bar = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      document.body.style.paddingRight = bar > 0 ? bar + 'px' : '';
    } else {
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    }
  };
  modals.forEach(m => {
    new MutationObserver(apply).observe(m, { attributes: true, attributeFilter: ['class'] });
  });
}

// ---------------- 启动 ----------------
function init() {
  bindEvents();
  setupScrollLock();
  $('login-name').value = state.name;
  refreshRooms();
}
init();

// 调试钩子（供自动化测试/排查使用）
window.__sv = {
  state,
  adapter: () => state.rtc.adapter ? { mode: state.rtc.adapter.mode, joined: state.rtc.adapter.joined } : null,
  peers: () => {
    const a = state.rtc.adapter;
    if (!a || !a.peers) return [];
    return Object.keys(a.peers).map(uid => ({
      uid,
      conn: a.peers[uid].iceConnectionState,
      sig: a.peers[uid].signalingState,
    }));
  },
};
