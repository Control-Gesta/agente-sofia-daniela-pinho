# -*- coding: utf-8 -*-
"""Registra o webhook add_message do Kommo apontando pro deploy.

Uso: python scripts/create_webhook.py "https://<SEU-DEPLOY>/api/inbound?secret=XXX"
Lê KOMMO_DOMAIN e KOMMO_TOKEN de .env.local (ou env vars).
"""
import json
import os
import sys
import urllib.request


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


def call(env, method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        env["KOMMO_DOMAIN"].rstrip("/") + path, data=data, method=method,
        headers={
            "Authorization": "Bearer " + env["KOMMO_TOKEN"],
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode("utf-8")[:400]}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    destination = sys.argv[1]
    env = load_env()
    if not env.get("KOMMO_DOMAIN") or not env.get("KOMMO_TOKEN"):
        print("KOMMO_DOMAIN/KOMMO_TOKEN ausentes (env ou .env.local)")
        sys.exit(1)

    st, existing = call(env, "GET", "/api/v4/webhooks")
    if st == 200:
        for w in existing.get("_embedded", {}).get("webhooks", []):
            if w.get("destination") == destination:
                print(json.dumps({"created": False, "reason": "ja existe", "id": w.get("id")}))
                return

    st, d = call(env, "POST", "/api/v4/webhooks", {
        "destination": destination,
        "settings": ["add_message"],
    })
    print(json.dumps({"status": st, "resp": d}, ensure_ascii=True))


if __name__ == "__main__":
    main()
