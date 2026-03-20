#!/usr/bin/env python3
"""
StockRaptor — Telegram Webhook Handler
=======================================
Escucha callbacks de Telegram cuando el usuario pulsa
✅ Aplicar pesos  o  ❌ Rechazar

Deploy como Netlify Function o corre como script puntual:
  python apply_weights.py approve <log_id>
  python apply_weights.py reject  <log_id>

Requiere: SUPABASE_URL, SUPABASE_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
"""

import os, sys, json, requests
from datetime import datetime, timezone

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ.get("SUPABASE_KEY") or os.environ["SUPABASE_SERVICE_KEY"]
TG_TOKEN     = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT_ID   = os.environ.get("TELEGRAM_CHAT_ID", "")

def main():
    if len(sys.argv) < 3:
        print("Usage: python apply_weights.py [approve|reject] <log_id>")
        sys.exit(1)

    action = sys.argv[1]
    log_id = int(sys.argv[2])

    from supabase import create_client
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # Load the proposed weights from feedback_log
    res = sb.table("feedback_log").select("*").eq("id", log_id).execute()
    if not res.data:
        print(f"❌ Log entry {log_id} not found")
        sys.exit(1)

    log = res.data[0]

    if action == "approve":
        apply_weights(sb, log, log_id)
    elif action == "reject":
        reject_weights(sb, log, log_id)
    else:
        print(f"Unknown action: {action}")
        sys.exit(1)


def apply_weights(sb, log, log_id):
    new_weights = json.loads(log["new_weights"])

    # Update scoring_weights table
    sb.table("scoring_weights").update({
        **new_weights,
        "version":    (log.get("version", 1) or 1) + 1,
        "trained_on": log.get("picks_count", 0),
        "win_rate_30d": log.get("win_rate_30d"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "notes":      f"Applied from feedback_log #{log_id}",
    }).eq("id", "active").execute()

    # Mark as approved in feedback_log
    sb.table("feedback_log").update({
        "approved": True,
        "notes": (log.get("notes", "") or "") + " — APPROVED"
    }).eq("id", log_id).execute()

    msg = (
        f"✅ *Pesos aplicados correctamente*\n\n"
        f"Los nuevos pesos de scoring están activos.\n"
        f"El próximo scan usará la configuración actualizada."
    )
    send_telegram(msg)
    print(f"✅ Weights from log #{log_id} applied to scoring_weights")


def reject_weights(sb, log, log_id):
    # Mark as rejected
    sb.table("feedback_log").update({
        "approved": False,
        "notes": (log.get("notes", "") or "") + " — REJECTED"
    }).eq("id", log_id).execute()

    msg = (
        f"❌ *Cambios rechazados*\n\n"
        f"Los pesos actuales se mantienen sin cambios.\n"
        f"El análisis queda guardado para revisión futura."
    )
    send_telegram(msg)
    print(f"❌ Weights from log #{log_id} rejected — no changes made")


def send_telegram(text):
    if not TG_TOKEN or not TG_CHAT_ID:
        print(f"[Telegram]: {text}")
        return
    requests.post(
        f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
        json={"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "Markdown"},
        timeout=10
    )


if __name__ == "__main__":
    main()
