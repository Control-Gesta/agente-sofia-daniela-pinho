# -*- coding: utf-8 -*-
"""Aponta o webhook de mensagens da instância uazapi pro deploy (Desenho B).

Uso:  python scripts/set_uazapi_webhook.py
Lê UAZAPI_BASE_URL, UAZAPI_TOKEN, DEPLOY_URL e WEBHOOK_SECRET de .env.local
(ou env vars). Monta a URL https://<DEPLOY_URL>/api/uazapi?secret=<WEBHOOK_SECRET>,
liga o webhook (evento "messages") e confere lendo de volta.

Passe uma URL como 1º argumento pra sobrescrever o destino calculado.
Passe "off" como 1º argumento pra DESLIGAR o webhook (ao virar pro Desenho A).
"""
import json
import os
import sys
import urllib.request
import urllib.error


def load_env():
    env = dict(os.environ)
    path = os.path.join(os.path.dirname(__file__), "..", ".env.local")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env.setdefault(k.strip(), v.strip())
    return env


def call(base, token, method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        base.rstrip("/") + path, data=data, method=method,
        headers={"token": token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8")
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode("utf-8")[:400]}


def main():
    env = load_env()
    base = env.get("UAZAPI_BASE_URL")
    token = env.get("UAZAPI_TOKEN")
    if not base or not token:
        print("UAZAPI_BASE_URL/UAZAPI_TOKEN ausentes (env ou .env.local)")
        sys.exit(1)

    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    enabled = arg.lower() != "off"

    if arg and arg.lower() != "off":
        destination = arg
    else:
        deploy = (env.get("DEPLOY_URL") or "").rstrip("/")
        secret = env.get("WEBHOOK_SECRET") or ""
        if not deploy or not secret:
            print("DEPLOY_URL/WEBHOOK_SECRET ausentes — informe a URL como argumento")
            sys.exit(1)
        destination = f"{deploy}/api/uazapi?secret={secret}"

    st, resp = call(base, token, "POST", "/webhook", {
        "enabled": enabled, "url": destination, "events": ["messages"],
    })
    print(json.dumps({"set_status": st, "enabled": enabled, "url": destination}, ensure_ascii=True))

    # Confere lendo de volta
    st2, cur = call(base, token, "GET", "/webhook")
    if isinstance(cur, list) and cur:
        cur = cur[0]
    if isinstance(cur, dict):
        print(json.dumps({
            "verify_status": st2,
            "enabled": cur.get("enabled"),
            "events": cur.get("events"),
            "url": cur.get("url"),
        }, ensure_ascii=True))
    else:
        print(json.dumps({"verify_status": st2, "raw": str(cur)[:200]}, ensure_ascii=True))


if __name__ == "__main__":
    main()
