/* 剧本杀语音房 - 声网 Agora RTC 适配器
 *
 * 依赖：index.html 已引入 AgoraRTC（agora-rtc-sdk-ng），AppID 由业务层注入 opts.appId。
 * 云端音视频（可跨网络、21 人+），免费额度 10,000 分钟/月。
 */
'use strict';

class AgoraAdapter extends RTCAdapter {
  constructor(opts) {
    super(opts);
    this.mode = 'agora';
    this.label = '声网 Agora';
    this.appId = (opts && opts.appId) || '';
    this.uid = '';
    this.client = null;
    this.track = null;
    this._speaking = new Set();
  }

  async connect(roomId, uid) {
    if (typeof AgoraRTC === 'undefined') {
      throw new Error('声网 SDK 未加载（请检查网络）');
    }
    if (!this.appId) {
      throw new Error('未配置声网 AppID（请在设置中填写）');
    }
    this.uid = String(uid);
    try {
      const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
      this.client = client;
      client.enableAudioVolumeIndicator();
      client.on('volume-indicator', volumes => this._onVolumes(volumes));
      client.on('user-published', async (user, mediaType) => {
        await client.subscribe(user, mediaType);
        if (mediaType === 'audio' && user.audioTrack) {
          user.audioTrack.play();
          const raw = user.audioTrack.getMediaStreamTrack && user.audioTrack.getMediaStreamTrack();
          if (raw) this._emitTrack(String(user.uid), new MediaStream([raw]));
        }
      });
      client.on('user-unpublished', (user, mediaType) => {
        if (mediaType === 'audio') this._emitTrack(String(user.uid), null);
      });
      await client.join(this.appId, roomId, null, this.uid);
      this.track = await AgoraRTC.createMicrophoneAudioTrack();
      await client.setAudioProfile('speech_standard');
      await client.publish([this.track]);
      this.joined = true;
      this._emitStatus('云端语音已连接（声网）');
    } catch (e) {
      console.error('agora join failed', e);
      throw new Error('语音连接失败：' + (e.code || '') + ' ' + (e.message || e));
    }
  }

  async disconnect() {
    if (this.track) { try { await this.track.stop(); await this.track.close(); } catch (e) {} }
    if (this.client) { try { await this.client.leave(); } catch (e) {} }
    this._speaking.forEach(uid => this._emitSpeaking(uid, false));
    this._speaking = new Set();
    this.track = null;
    this.client = null;
    this.joined = false;
  }

  setMuted(muted) {
    if (this.track) {
      try { this.track.setEnabled(!muted); } catch (e) {}
    }
  }

  _onVolumes(volumes) {
    const active = new Set();
    volumes.forEach(v => {
      if (v.level > 0) active.add(String(v.uid));
    });
    active.forEach(u => { if (!this._speaking.has(u)) this._emitSpeaking(u, true); });
    this._speaking.forEach(u => { if (!active.has(u)) this._emitSpeaking(u, false); });
    this._speaking = active;
  }
}
