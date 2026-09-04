# -*- coding: utf-8 -*-
"""Simula um webhook add_message do Kommo no deploy (teste E2E sem WhatsApp).

Uso: python scripts/simulate_inbound.py <LEAD_ID> "texto da mensagem" [URL_BASE]
Lê WEBHOOK_SECRET, KOMMO_ACCOUNT_ID e DEPLOY_URL de .env.local (ou env vars).
O lead precisa ter a tag do gate (GATE_TAG) — senão o agente ignora de propósito.
"""
import json
import os
import sys
import time
import urllib.parse
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


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    lead_id = sys.argv[1]
    text = sys.argv[2]
    env = load_env()
    base = sys.argv[3] if len(sys.argv) > 3 else env.get("DEPLOY_URL", "")
    secret = env.get("WEBHOOK_SECRET", "")
    account = env.get("KOMMO_ACCOUNT_ID", "")
    if not base or not secret:
        print("DEPLOY_URL/WEBHOOK_SECRET ausentes")
        sys.exit(1)

    msg_id = f"sim-{int(time.time())}"
    form = {
        "account[id]": account,
        "message[add][0][id]": msg_id,
        "message[add][0][entity_id]": lead_id,
        "message[add][0][entity_type]": "lead",
        "message[add][0][text]": text,
        "message[add][0][created_at]": str(int(time.time())),
    }
    data = urllib.parse.urlencode(form).encode("utf-8")
    url = base.rstrip("/") + "/api/inbound?secret=" + urllib.parse.quote(secret)
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/x-www-form-urlencoded",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.status, r.read().decode("utf-8"))
    print(f"msg_id={msg_id} — acompanhe com: vercel logs (a resposta chega no WhatsApp do lead)")


if __name__ == "__main__":
    main()
