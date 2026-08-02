/* 剧本杀语音房 - 腾讯云 TRTC RTC 适配器（骨架桩，待接入 SDK）
 *
 * 接入步骤（TODO）：
 *   1. 在 index.html 引入 TRTC Web SDK：
 *        <script src="https://web.sdk.qcloud.com/trtc/webrtc/v5/trtc.js"></script>
 *      （版本以腾讯云官方文档为准：https://cloud.tencent.com/document/product/647）
 *   2. 在 connect() 中按 TRTC v5 API 实现：
 *        const app = TRTC.createApp({ sdkAppId, userId: uid, userSig });
 *        const client = app.getClient();
 *        await client.join({ roomId });
 *        const stream = TRTC.createStream({ audio: true, video: false, userId: uid });
 *        await stream.initialize(); await client.publish(stream);
 *        client.on('stream-added', e => client.subscribe(e.stream).then(s => s.play()));
 *   3. userSig 由后端签发（backend/rtc_token.py + POST /api/rtc/token），
 *      需要 sdkAppId + secretKey。
 *   4. setMuted()：stream.muteAudio()/unmuteAudio()。
 *   5. 说话检测：TRTC 的 volume 事件（client.on('volume-change')），
 *      在回调中调用 this._emitSpeaking(uid, on) 驱动麦位高亮。
 *
 * 骨架阶段 connect() 会抛出明确提示，业务层（app.js）无需改动即可对接。
 */
'use strict';

class TrtcAdapter extends RTCAdapter {
  constructor(opts) {
    super(opts);
    this.mode = 'trtc';
    this.label = '腾讯 TRTC';
    this.sdkAppId = (opts && opts.sdkAppId) || '';
    this.userSig = (opts && opts.userSig) || '';
    this.uid = '';
    this.app = null;
  }

  async connect(roomId, uid) {
    this.uid = String(uid);
    if (!this.sdkAppId) throw new Error('未配置 TRTC SDKAppID（请在设置中填写）');
    if (!this.userSig) throw new Error('未获取 userSig，请先通过后端 /api/rtc/token 签发');
    // TODO: 按文件顶部注释实现 TRTC SDK 接入
    throw new Error('腾讯 TRTC 尚未接入 SDK（骨架桩），详见 frontend/rtc/trtc.js 顶部注释');
  }

  async disconnect() {
    // TODO: app.destroy() / client.leave() + stream.close()
    this.joined = false;
  }

  setMuted(muted) {
    // TODO: this.localStream.muteAudio(muted) / unmuteAudio()
  }
}
