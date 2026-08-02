"""RTC 令牌签发（TRTC userSig / Agora token）

- 腾讯 TRTC：HMAC-SHA256 版 userSig，无需额外依赖（标准库实现）。
  SDKAppID 与 SecretKey 通过环境变量 TRTC_SDKAPPID / TRTC_SECRETKEY 配置
  （也可在 start.bat 中写入），或后端配置文件扩展。
- 声网 Agora：需声网官方 token 算法（需 appId + appCertificate），
  当前为骨架，返回 501，后续可用官方 RtcTokenBuilder 实现。

参考：
  https://cloud.tencent.com/document/product/647/17275 （userSig 计算）
"""
import base64
import hashlib
import hmac
import json
import os
import time


def gen_user_sig(sdk_app_id, secret_key, user_id, expire=86400 * 30):
    """生成腾讯云 TRTC userSig（TLS 2.0，HMAC-SHA256）。"""
    cur = int(time.time())
    sdk_app_id = str(sdk_app_id)
    secret_key = str(secret_key)
    user_id = str(user_id)
    plaintext = (
        f'TLS.identifier:{user_id}:'
        f'TLS.sdkappid:{sdk_app_id}:'
        f'TLS.expire:{expire}:'
        f'TLS.time:{cur}'
    )
    sig = hmac.new(secret_key.encode('utf-8'), plaintext.encode('utf-8'),
                   hashlib.sha256).hexdigest()
    sig_doc = {
        'TLS.ver': '2.0',
        'TLS.identifier': user_id,
        'TLS.sdkappid': int(sdk_app_id),
        'TLS.expire': expire,
        'TLS.time': cur,
        'TLS.sig': sig,
    }
    data = json.dumps(sig_doc, separators=(',', ':')).encode('utf-8')
    return base64.b64encode(data).decode('utf-8')


def trtc_config():
    return {
        'sdk_app_id': os.environ.get('TRTC_SDKAPPID', ''),
        'secret_key': os.environ.get('TRTC_SECRETKEY', ''),
    }


def get_rtc_token(provider, room_id, uid):
    """统一入口：返回 { 'token': str, 'note': str }。

    provider: 'trtc' / 'agora'
    """
    if provider == 'trtc':
        cfg = trtc_config()
        if not cfg['sdk_app_id'] or not cfg['secret_key']:
            return {
                'token': '',
                'note': '未配置 TRTC_SDKAPPID / TRTC_SECRETKEY 环境变量',
            }
        token = gen_user_sig(cfg['sdk_app_id'], cfg['secret_key'], uid or 'guest')
        return {'token': token, 'note': 'trtc userSig'}

    if provider == 'agora':
        # TODO: 用声网官方 RtcTokenBuilder（appId + appCertificate）
        # 生成 channelToken，密钥建议环境变量 AGORA_APP_CERTIFICATE。
        raise NotImplementedError('声网 token 生成尚未实现（骨架桩）')

    return {'token': '', 'note': f'未知 provider: {provider}'}
