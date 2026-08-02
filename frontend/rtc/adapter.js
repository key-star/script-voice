/* 剧本杀语音房 - RTC 抽象层
 *
 * 统一语音能力为「适配器（Adapter）」接口，业务层（app.js）只依赖本接口，
 * 不感知底层是 声网 Agora / 腾讯 TRTC / 局域网直连 WebRTC。
 *
 * 接口约定：
 *   connect(roomId, uid)  加入语音（房间号 + 用户ID）
 *   disconnect()          离开语音，释放所有资源
 *   setMuted(muted)       静音/恢复（true = 闭麦）
 *   setVoiceEffect(mode)  变声（仅支持的处理链可用，其余返回提示）
 *   handleSignal(msg)     处理来自服务器的信令转发（仅需要中转的适配器使用）
 *
 * 事件回调（构造时通过 opts 注入，由业务层提供）：
 *   onTrack(uid, stream)    远端音频流就绪
 *   onSpeaking(uid, on)     玩家发言状态变化
 *   onError(msg)            语音错误提示
 *   onStatus(text)          语音状态提示
 *
 * 新增一种 RTC 服务商只需：
 *   1. 新建 XxxAdapter extends RTCAdapter（实现上述接口）
 *   2. 在 createRTCAdapter 工厂注册一个 mode
 *   3. 在设置弹窗/存储中加入对应配置
 * 业务层无需任何改动。
 */
'use strict';

class RTCAdapter {
  constructor(opts) {
    this.mode = 'base';        // 子类覆盖：'lan' | 'agora' | 'trtc'
    this.label = 'BaseAdapter';
    this.joined = false;
    this.opts = opts || {};
  }

  async connect(roomId, uid) { throw new Error(this.label + ' 未实现 connect'); }

  async disconnect() { throw new Error(this.label + ' 未实现 disconnect'); }

  setMuted(muted) { /* 默认空实现，子类按需覆盖 */ }

  setVoiceEffect(mode) { this._emitError('变声仅支持「局域网直连」模式'); }

  handleSignal(msg) { /* 默认空实现，局域网信令中转用 */ }

  syncPeers(users) { /* 玩家列表变化时同步点对点连接，局域网模式覆盖 */ }

  _emitTrack(uid, stream) { if (this.opts.onTrack) this.opts.onTrack(uid, stream); }
  _emitSpeaking(uid, on) { if (this.opts.onSpeaking) this.opts.onSpeaking(uid, on); }
  _emitError(msg) { if (this.opts.onError) this.opts.onError(msg); }
  _emitStatus(text) { if (this.opts.onStatus) this.opts.onStatus(text); }
}

/**
 * 工厂：根据 mode 创建适配器。
 * opts 通用字段：{ signal: {send}, onTrack, onSpeaking, onError, onStatus }
 *   signal.send({to_uid, payload})  向指定用户转发信令（经服务器 WebSocket）
 */
function createRTCAdapter(mode, opts) {
  switch (mode) {
    case 'lan':   return new LanMeshAdapter(opts);
    case 'agora': return new AgoraAdapter(opts);
    case 'trtc':  return new TrtcAdapter(opts);
    default: throw new Error('未知语音模式: ' + mode);
  }
}
