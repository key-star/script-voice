/* 剧本杀语音房 - 局域网直连 RTC 适配器（默认模式，无需任何 AppID / 云端服务）
 *
 * 同一局域网 / Wi-Fi 下，浏览器间通过 WebRTC 点对点（全互联 mesh）传音。
 * 信令（offer/answer/ice-candidate）经服务器 WebSocket 中转，见 opts.signal。
 *
 * 注意：mesh 模式每人需与其余 N-1 人各建一条连接，21 人时连接数偏多，
 * 仅适合内网测试；公网多人请切换到 Agora / TRTC 等云端适配器。
 */
'use strict';

class LanMeshAdapter extends RTCAdapter {
  constructor(opts) {
    super(opts);
    this.mode = 'lan';
    this.label = '局域网直连';
    this.uid = '';
    this.localStream = null;
    this.audioProc = null;       // 变声处理链
    this.voiceEffect = 'none';
    this.peers = {};             // uid -> RTCPeerConnection
    this.pendingSignal = [];     // joined 前到达的信令缓冲
  }

  async connect(roomId, uid) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前环境不支持麦克风（需 HTTPS）');
    }
    this.uid = uid;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.joined = true;
      if (this.voiceEffect !== 'none') this.setupLanVoiceChain();
      // 连接期间到达的信令补处理
      this.pendingSignal.splice(0).forEach(m => this.processSignal(m));
      this.syncPeers(this.lastUsers || []);
      this._emitStatus('局域网直连语音已连接');
    } catch (e) {
      throw new Error(this._micErrText(e));
    }
  }

  _micErrText(e) {
    if (e && e.name === 'NotAllowedError') return '麦克风权限被拒绝';
    if (e && e.name === 'NotFoundError') return '未检测到麦克风设备';
    if (e && e.name === 'NotReadableError') return '麦克风被其他程序占用';
    return '无法访问麦克风（非本机访问需要 HTTPS）';
  }

  async disconnect() {
    Object.keys(this.peers).forEach(uid => this._teardownPeer(uid));
    if (this.audioProc) { try { this.audioProc.ctx.close(); } catch (e) {} this.audioProc = null; }
    if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
    this.localStream = null;
    this.peers = {};
    this.pendingSignal = [];
    this.joined = false;
  }

  setMuted(muted) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    }
  }

  setVoiceEffect(mode) {
    this.voiceEffect = mode;
    if (!this.localStream) {
      this._emitError('变声需要先连接语音（仅局域网直连模式支持）');
      return;
    }
    this.setupLanVoiceChain();
  }

  // ---- 麦位/玩家列表变化时同步点对点连接 ----
  syncPeers(users) {
    this.lastUsers = users || [];
    if (!this.joined) return;
    const want = new Set(
      (users || [])
        .filter(u => u && u.uid !== this.uid)
        .map(u => u.uid)
    );
    Object.keys(this.peers).forEach(uid => {
      const pc = this.peers[uid];
      if (!want.has(uid) || (pc && (pc.iceConnectionState === 'failed' || pc.connectionState === 'closed'))) {
        this._teardownPeer(uid);
      }
    });
    want.forEach(uid => {
      if (!this.peers[uid]) {
        this._createPeer(uid);
        if (this.uid < uid) this._sendOffer(uid);
      }
    });
  }

  // ---- 服务器转发信令入口 ----
  handleSignal(msg) {
    if (!this.joined) {
      this.pendingSignal.push(msg);
      return;
    }
    this.processSignal(msg);
  }

  processSignal(msg) {
    const uid = msg.from;
    const payload = msg.payload || {};
    if (payload.candidate) {
      const pc = this.peers[uid];
      if (!pc) return;
      if (pc.remoteDescription) pc.addIceCandidate(payload.candidate).catch(() => {});
      else (pc._pendingIce || (pc._pendingIce = [])).push(payload.candidate);
      return;
    }
    if (payload.type === 'offer') {
      let pc = this.peers[uid];
      if (!pc) pc = this._createPeer(uid);
      pc.setRemoteDescription(payload.sdp).then(() => {
        (pc._pendingIce || []).splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
        return pc.createAnswer();
      }).then(answer => pc.setLocalDescription(answer)).then(() => {
        this._sendSignal(uid, { type: 'answer', sdp: pc.localDescription });
      }).catch(e => console.error('lan answer failed', e));
      return;
    }
    if (payload.type === 'answer') {
      const pc = this.peers[uid];
      if (!pc) return;
      pc.setRemoteDescription(payload.sdp).then(() => {
        (pc._pendingIce || []).splice(0).forEach(c => pc.addIceCandidate(c).catch(() => {}));
      }).catch(e => console.error('lan set remote desc failed', e));
    }
  }

  _sendSignal(toUid, payload) {
    if (this.opts.signal) this.opts.signal.send({ to_uid: toUid, payload });
  }

  _createPeer(uid) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });
    this.peers[uid] = pc;
    const sendStream = (this.audioProc && this.audioProc.stream) || this.localStream;
    if (sendStream) sendStream.getTracks().forEach(t => pc.addTrack(t, sendStream));
    pc.onicecandidate = e => {
      if (e.candidate) this._sendSignal(uid, { candidate: e.candidate });
    };
    pc.ontrack = e => {
      this._emitTrack(uid, e.streams[0]);
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.log('mesh peer', uid, pc.iceConnectionState);
      }
    };
    return pc;
  }

  _teardownPeer(uid) {
    const pc = this.peers[uid];
    if (!pc) return;
    delete this.peers[uid];
    try { pc.close(); } catch (e) {}
    this._emitTrack(uid, null);
  }

  _sendOffer(uid) {
    const pc = this.peers[uid];
    if (!pc) return;
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => this._sendSignal(uid, { type: 'offer', sdp: pc.localDescription }))
      .catch(e => console.error('lan offer failed', e));
  }

  // ---- 变声处理链（Web Audio 管线，替换本地音轨） ----
  setupLanVoiceChain() {
    const ls = this.localStream;
    if (!ls) return;
    if (!this.audioProc) {
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(ls);
      const low = ctx.createBiquadFilter();
      const high = ctx.createBiquadFilter();
      const delay = ctx.createDelay(0.5);
      const fb = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      src.connect(low); low.connect(high);
      high.connect(dry); dry.connect(dest);
      high.connect(delay); delay.connect(fb); fb.connect(delay);
      delay.connect(wet); wet.connect(dest);
      dry.gain.value = 1; wet.gain.value = 0; fb.gain.value = 0.35;
      this.audioProc = { ctx, low, high, delay, fb, dry, wet, dest, stream: dest.stream };
    }
    const g = this.audioProc;
    const mode = this.voiceEffect || 'none';
    if (mode === 'deep') {
      g.low.type = 'lowshelf'; g.low.frequency.value = 200; g.low.gain.value = 6;
      g.high.type = 'highshelf'; g.high.frequency.value = 1200; g.high.gain.value = -6;
      g.dry.gain.value = 1; g.wet.gain.value = 0;
    } else if (mode === 'clear') {
      g.low.type = 'lowshelf'; g.low.frequency.value = 400; g.low.gain.value = -6;
      g.high.type = 'highshelf'; g.high.frequency.value = 2000; g.high.gain.value = 6;
      g.dry.gain.value = 1; g.wet.gain.value = 0;
    } else if (mode === 'space') {
      g.low.type = 'lowshelf'; g.low.frequency.value = 150; g.low.gain.value = -3;
      g.high.type = 'highshelf'; g.high.frequency.value = 1000; g.high.gain.value = -3;
      g.dry.gain.value = 0.6; g.wet.gain.value = 0.8;
    } else {
      g.low.type = 'lowshelf'; g.low.gain.value = 0;
      g.high.type = 'highshelf'; g.high.gain.value = 0;
      g.dry.gain.value = 1; g.wet.gain.value = 0;
    }
    const procTrack = g.dest.stream.getAudioTracks()[0];
    Object.values(this.peers).forEach(pc => {
      const sender = pc.getSenders && pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender && procTrack) sender.replaceTrack(procTrack).catch(() => {});
    });
  }
}
