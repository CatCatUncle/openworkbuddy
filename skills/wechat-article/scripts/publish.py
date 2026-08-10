#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把排好版的 HTML 推进微信公众号「草稿箱」（不发布，人工在后台确认后再群发）。

用法：
  python3 publish.py --html 文章.html --title "标题" --cover 封面.jpg \
      --digest "摘要（可空，公众号会自动截）" --author "开发者猫叔"
  python3 publish.py --check          # 只验证凭据和出口 IP，不推送

凭据来源（按优先级）：
  1. 环境变量 WECHAT_APPID / WECHAT_SECRET
  2. ~/.openworkbuddy/wechat.json  ->  {"appid": "...", "secret": "..."}
  这个文件不要提交到仓库。

⚠️ 最容易踩的坑：errcode 40164 = 「invalid ip, not in whitelist」
   公众号后台给 access_token 接口配了 IP 白名单，家庭宽带是动态 IP，隔几天就变，
   于是脚本前一天还能跑，今天就全线 40164。两条出路：
     A. 走固定 IP 的服务器出网（推荐）：
          ssh -fN -D 1080 root@你的VPS
          export HTTPS_PROXY=socks5h://127.0.0.1:1080 ALL_PROXY=socks5h://127.0.0.1:1080
          # 本脚本用 requests 时 ALL_PROXY 才生效，见下面 _HAS_REQUESTS
        验证出口 IP：ALL_PROXY=socks5h://127.0.0.1:1080 curl -s https://api.ipify.org
     B. 去公众号后台把当前 IP 加进白名单——注意必须由管理员扫码确认、看到「保存成功」
        才算生效，只点保存不扫码是静默不生效的。
"""

import argparse
import json
import mimetypes
import os
import sys
import time
import uuid

try:  # 有 requests 就用它：SOCKS 代理（ALL_PROXY）只有 requests[socks] 认
    import requests

    _HAS_REQUESTS = True
except Exception:  # 没有也能跑，直连场景用标准库
    import urllib.request

    _HAS_REQUESTS = False

API = "https://api.weixin.qq.com/cgi-bin"


def _conf_path(name):
    """配置目录改过名（~/.openbuddy → ~/.openworkbuddy）。新目录优先，
    老用户的凭据还在老目录里就接着用，别让人重填一遍 appid/secret。"""
    new = os.path.expanduser(os.path.join("~", ".openworkbuddy", name))
    if os.path.exists(new):
        return new
    old = os.path.expanduser(os.path.join("~", ".openbuddy", name))
    return old if os.path.exists(old) else new


TOKEN_CACHE = _conf_path("wechat_token.json")


# ---------- HTTP ----------
def _get(url):
    if _HAS_REQUESTS:
        return requests.get(url, timeout=30).json()
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _post_json(url, payload):
    # ensure_ascii=False + utf-8：中文标题用 \u 转义有时会被公众号判成乱码
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if _HAS_REQUESTS:
        r = requests.post(url, data=body, headers={"Content-Type": "application/json"}, timeout=60)
        return r.json()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def _post_file(url, path, field="media"):
    name = os.path.basename(path)
    ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
    if _HAS_REQUESTS:
        with open(path, "rb") as f:
            r = requests.post(url, files={field: (name, f, ctype)}, timeout=120)
        return r.json()
    # 标准库手搓 multipart
    boundary = "----ob" + uuid.uuid4().hex
    with open(path, "rb") as f:
        data = f.read()
    body = b"".join(
        [
            ("--%s\r\n" % boundary).encode(),
            ('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (field, name)).encode("utf-8"),
            ("Content-Type: %s\r\n\r\n" % ctype).encode(),
            data,
            ("\r\n--%s--\r\n" % boundary).encode(),
        ]
    )
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def die(msg, resp=None):
    print("❌ " + msg, file=sys.stderr)
    if resp is not None:
        print("   接口返回：%s" % json.dumps(resp, ensure_ascii=False), file=sys.stderr)
        if resp.get("errcode") == 40164:
            print(
                "   → 40164 是 IP 白名单。当前出口 IP 不在公众号后台的白名单里。\n"
                "     走固定 IP 出网：ssh -fN -D 1080 root@你的VPS\n"
                "     然后 export ALL_PROXY=socks5h://127.0.0.1:1080 HTTPS_PROXY=socks5h://127.0.0.1:1080\n"
                "     或者去后台加白名单——必须管理员扫码并看到「保存成功」才生效。",
                file=sys.stderr,
            )
        elif resp.get("errcode") in (40001, 40013):
            print("   → AppID / AppSecret 不对，或 secret 被重置过。", file=sys.stderr)
        elif resp.get("errcode") == 45009:
            print("   → 接口调用超频，等一会儿再试（token 已缓存，不要反复重取）。", file=sys.stderr)
    sys.exit(1)


# ---------- 凭据与 token ----------
def credentials():
    appid = os.environ.get("WECHAT_APPID")
    secret = os.environ.get("WECHAT_SECRET")
    if appid and secret:
        return appid, secret
    path = _conf_path("wechat.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            c = json.load(f)
        if c.get("appid") and c.get("secret"):
            return c["appid"], c["secret"]
    die(
        "没找到公众号凭据。设置环境变量 WECHAT_APPID / WECHAT_SECRET，\n"
        "   或写入 ~/.openworkbuddy/wechat.json：{\"appid\": \"...\", \"secret\": \"...\"}"
    )


def access_token(force=False):
    """token 有效期 7200s 且日调用次数有限，缓存起来复用。"""
    appid, secret = credentials()
    if not force and os.path.exists(TOKEN_CACHE):
        try:
            with open(TOKEN_CACHE, encoding="utf-8") as f:
                c = json.load(f)
            if c.get("appid") == appid and c.get("expire_at", 0) - 300 > time.time():
                return c["token"]
        except Exception:
            pass
    r = _get("%s/token?grant_type=client_credential&appid=%s&secret=%s" % (API, appid, secret))
    if "access_token" not in r:
        die("拿 access_token 失败", r)
    os.makedirs(os.path.dirname(TOKEN_CACHE), exist_ok=True)
    with open(TOKEN_CACHE, "w", encoding="utf-8") as f:
        json.dump({"appid": appid, "token": r["access_token"], "expire_at": time.time() + r.get("expires_in", 7200)}, f)
    os.chmod(TOKEN_CACHE, 0o600)
    return r["access_token"]


# ---------- 素材 ----------
def upload_cover(token, path):
    """封面必须是永久素材，拿到的是 thumb_media_id。"""
    r = _post_file("%s/material/add_material?access_token=%s&type=image" % (API, token), path)
    if "media_id" not in r:
        die("上传封面失败（要求 jpg/png，小于 10MB，建议 900x383 或 1:1）", r)
    return r["media_id"]


def upload_body_image(token, path):
    """正文里的图片必须先传成公众号自己的 URL，外链图会被吞掉。"""
    r = _post_file("%s/media/uploadimg?access_token=%s" % (API, token), path)
    if "url" not in r:
        die("上传正文图片失败", r)
    return r["url"]


# ---------- 草稿 ----------
def add_draft(token, article):
    r = _post_json("%s/draft/add?access_token=%s" % (API, token), {"articles": [article]})
    if "media_id" not in r:
        die("推草稿失败", r)
    return r["media_id"]


def main():
    ap = argparse.ArgumentParser(description="把排版好的 HTML 推进公众号草稿箱")
    ap.add_argument("--html", help="format.py 生成的 HTML 文件")
    ap.add_argument("--title", help="文章标题（公众号限 64 字）")
    ap.add_argument("--cover", help="封面图（jpg/png，建议 900x383）")
    ap.add_argument("--author", default="", help="署名")
    ap.add_argument("--digest", default="", help="摘要，留空则公众号自动截取前 54 字")
    ap.add_argument("--source-url", default="", help="「阅读原文」链接")
    ap.add_argument("--open-comment", action="store_true", help="打开留言")
    ap.add_argument("--upload-image", help="只上传一张正文图片，打印可用的公众号 URL")
    ap.add_argument("--check", action="store_true", help="只验证凭据和出口 IP")
    a = ap.parse_args()

    if a.check:
        print("requests 可用：%s（SOCKS 代理只有它认）" % _HAS_REQUESTS)
        try:
            print("出口 IP：%s" % _get("https://api.ipify.org?format=json").get("ip"))
        except Exception as e:
            print("出口 IP 查不到：%s" % e)
        token = access_token(force=True)
        print("✅ access_token 拿到了（%s…），凭据和白名单都没问题。" % token[:12])
        return

    if a.upload_image:
        print(upload_body_image(access_token(), a.upload_image))
        return

    if not a.html or not a.title:
        ap.error("要 --html 和 --title（或者用 --check / --upload-image）")

    with open(a.html, encoding="utf-8") as f:
        content = f.read()
    if len(content) > 20000 * 50:
        die("正文过长，公众号单篇有长度上限，拆成上下篇吧")

    token = access_token()
    article = {
        "title": a.title[:64],
        "author": a.author,
        "digest": a.digest[:120],
        "content": content,
        "content_source_url": a.source_url,
        "need_open_comment": 1 if a.open_comment else 0,
        "only_fans_can_comment": 0,
    }
    if a.cover:
        article["thumb_media_id"] = upload_cover(token, a.cover)
    else:
        print("⚠️ 没给封面。公众号草稿一般要求封面，没有可能被拒；接口报 41005/9001005 就是这个原因。")

    media_id = add_draft(token, article)
    print("✅ 已推进草稿箱，draft media_id = %s" % media_id)
    print("   去公众号后台「草稿箱」预览、确认排版无误后再手动群发。脚本不负责发布。")


if __name__ == "__main__":
    main()
