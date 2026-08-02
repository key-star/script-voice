# -*- coding: utf-8 -*-
"""生成局域网 HTTPS 证书：
  1) 创建本地 CA（10年有效期）
  2) 用该 CA 签发服务器证书（覆盖 localhost / 127.0.0.1 / 本机局域网IP）
  生成文件放入 script_voice/certs/
  手机/其他电脑安装 ca.crt 并信任后，即可通过 https://<电脑IP>:8443 使用麦克风。
"""
import datetime
import ipaddress
import os
import socket

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

CERT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'certs')


def get_lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('223.5.5.5', 80))
        return s.getsockname()[0]
    except Exception:
        return '127.0.0.1'
    finally:
        s.close()


def make_ca():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'ScriptVoice Local CA')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=False, content_commitment=False, key_encipherment=False,
            data_encipherment=False, key_agreement=False, key_cert_sign=True,
            crl_sign=True, encipher_only=None, decipher_only=None), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return key, cert


def make_server_cert(ca_key, ca_cert, lan_ip):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'ScriptVoice LAN Server')])
    now = datetime.datetime.now(datetime.timezone.utc)
    san = [
        x509.DNSName('localhost'),
        x509.IPAddress(ipaddress.ip_address('127.0.0.1')),
    ]
    try:
        san.append(x509.IPAddress(ipaddress.ip_address(lan_ip)))
    except Exception:
        pass
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(
            digital_signature=True, content_commitment=False, key_encipherment=True,
            data_encipherment=False, key_agreement=False, key_cert_sign=False,
            crl_sign=False, encipher_only=None, decipher_only=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    return key, cert


def dump_key(cert, path):
    with open(path, 'wb') as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))


def dump_private(key, path):
    with open(path, 'wb') as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))


def main():
    os.makedirs(CERT_DIR, exist_ok=True)
    lan_ip = get_lan_ip()
    print('检测到局域网 IP:', lan_ip)

    ca_key, ca_cert = make_ca()
    srv_key, srv_cert = make_server_cert(ca_key, ca_cert, lan_ip)

    dump_key(ca_cert, os.path.join(CERT_DIR, 'ca.crt'))
    dump_key(srv_cert, os.path.join(CERT_DIR, 'server.crt'))
    dump_private(srv_key, os.path.join(CERT_DIR, 'server.key'))

    print('证书已生成到:', os.path.abspath(CERT_DIR))
    print('  ca.crt      本地 CA（安装到手机/电脑并信任）')
    print('  server.crt  服务器证书')
    print('  server.key  服务器私钥')
    print()
    print('电脑访问:   https://localhost:8443')
    print('局域网访问: https://%s:8443' % lan_ip)


if __name__ == '__main__':
    main()
