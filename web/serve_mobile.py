#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把手机端页面通过局域网发给手机（HTTPS，手机才允许调用摄像头）

用法
----
    python serve_mobile.py                # 默认 8443 端口
    python serve_mobile.py --port 9000
    python serve_mobile.py --http         # 不走 TLS（仅本机自测用，手机相机可能被拒）

启动后：
  1) 终端会打印若干局域网地址和二维码
  2) 手机连同一个 WiFi，扫码或手输地址
  3) 首次会提示"证书不受信任" → 点【高级】→【继续前往】
  4) 允许相机权限，即可使用

为什么必须 HTTPS：
  浏览器规定 getUserMedia（摄像头）只能在"安全上下文"里用，
  局域网 IP 走 http 不算安全上下文，手机上会直接报错。
"""
import argparse
import http.server
import socket
import ssl
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def lan_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    return ips or ["127.0.0.1"]


def ensure_cert(cert_path: Path, key_path: Path, ips):
    """自签证书，把局域网 IP 写进 SAN，减少手机端报错。"""
    if cert_path.exists() and key_path.exists():
        return cert_path, key_path
    cert_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        import datetime as dt
        import ipaddress
    except ImportError:
        sys.exit("缺少 cryptography 库：pip install cryptography")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "voc-local"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "VOC Monitor"),
    ])
    san = [x509.DNSName("localhost")]
    for ip in ips + ["127.0.0.1"]:
        try:
            san.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError:
            pass
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption(),
    ))
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        # 页面和脚本不缓存，避免改了代码手机还看旧的；模型/wasm 允许缓存
        p = self.path.split("?")[0]
        if p.endswith((".html", "/", ".js", ".css", ".webmanifest")) and "vendor" not in p:
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "public, max-age=604800")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt, *a):
        # 只打印非静态的大件请求，减少刷屏
        try:
            if self.path.endswith((".onnx", ".wasm")):
                sys.stdout.write(f"  [加载模型] {self.path}\n")
        except Exception:
            pass


def print_qr(text):
    try:
        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(text)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except Exception:
        print("  （未安装 qrcode，无法打印二维码：pip install qrcode）")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8443)
    ap.add_argument("--http", action="store_true", help="不用 TLS（仅本机自测）")
    args = ap.parse_args()

    ips = lan_ips()
    scheme = "http" if args.http else "https"
    url = f"{scheme}://{ips[0]}:{args.port}/index.html"

    try:
        srv = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    except OSError as e:
        sys.exit(f"端口 {args.port} 无法监听：{e}\n换个端口试试：python serve_mobile.py --port 9443")

    if not args.http:
        cert, key = ensure_cert(ROOT / ".cert" / "cert.pem", ROOT / ".cert" / "key.pem", ips)
        sslctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        sslctx.load_cert_chain(certfile=str(cert), keyfile=str(key))
        srv.socket = sslctx.wrap_socket(srv.socket, server_side=True)

    print("=" * 62)
    print("  手机端 VOCs 读数采集 —— 局域网服务已启动")
    print("=" * 62)
    print(f"  手机请访问（同一个 WiFi）：\n    {url}")
    if len(ips) > 1:
        print("\n  其它可用地址：")
        for ip in ips[1:]:
            print(f"    {scheme}://{ip}:{args.port}/index.html")
    if not args.http:
        print("\n  首次打开会提示证书不安全 → 点【高级】→【继续前往】")
        print("  （自签证书的正常现象，只影响本机局域网）")
    print("\n  扫描下面的二维码直接打开：\n")
    print_qr(url)
    print("\n  Ctrl+C 停止服务")
    print("=" * 62)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
