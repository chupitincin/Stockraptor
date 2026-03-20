#!/usr/bin/env python3
"""
StockRaptor — ML Scoring Optimizer (Capa 2)
============================================
Corre el primer lunes de cada mes via GitHub Actions.
Lee picks_history, entrena modelo, propone nuevos pesos.
Te manda a Telegram para que apruebes o rechaces.

Requiere env vars:
  SUPABASE_URL, SUPABASE_KEY
  ANTHROPIC_API_KEY
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
"""

import os, sys, json, math, time, requests
from datetime import datetime, timezone

# ── Deps (pip install supabase scikit-learn numpy anthropic) ─────────────────
try:
    from supabase import create_client
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.preprocessing import StandardScaler
    from sklearn.model_selection import cross_val_score
    import anthropic
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("Run: pip install supabase scikit-learn numpy anthropic")
    sys.exit(1)

# ── CONFIG ────────────────────────────────────────────────────────────────────
SUPABASE_URL   = os.environ["SUPABASE_URL"]
SUPABASE_KEY   = os.environ["SUPABASE_KEY"]
ANTHROPIC_KEY  = os.environ["ANTHROPIC_API_KEY"]
TG_TOKEN       = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT_ID     = os.environ.get("TELEGRAM_CHAT_ID", "")

MIN_PICKS      = 20   # minimum picks with 30d data to run analysis
FEATURES       = [
    "score_fund", "score_sent", "score_analyst",
    "score_momentum", "score_earnings", "score_volume", "score_insider",
    "confluence", "fresh_insider", "rel_strength", "vol_ratio",
]
WEIGHT_KEYS    = [
    "w_fund", "w_sent", "w_analyst",
    "w_momentum", "w_earnings", "w_volume", "w_insider",
]
FEATURE_TO_WEIGHT = {
    "score_fund":      "w_fund",
    "score_sent":      "w_sent",
    "score_analyst":   "w_analyst",
    "score_momentum":  "w_momentum",
    "score_earnings":  "w_earnings",
    "score_volume":    "w_volume",
    "score_insider":   "w_insider",
}

def main():
    print("🤖 StockRaptor ML Optimizer starting...")
    sb = create_client(SUPABASE_URL, SUPABASE_KEY)

    # ── 1. Load picks with 30d performance data ───────────────────────────────
    print("📊 Loading picks_history from Supabase...")
    res = sb.table("picks_history") \
        .select("*") \
        .not_.is_("perf_30d", "null") \
        .not_.is_("beat_30d", "null") \
        .execute()

    rows = res.data or []
    print(f"   Found {len(rows)} picks with 30d data")

    if len(rows) < MIN_PICKS:
        msg = (
            f"🦅 *StockRaptor ML* — Análisis mensual\n\n"
            f"⏳ Solo {len(rows)} picks con datos a 30 días.\n"
            f"Necesito mínimo {MIN_PICKS} para entrenar el modelo.\n\n"
            f"Volveré a intentarlo el mes que viene."
        )
        send_telegram(msg)
        print(f"Not enough data ({len(rows)} < {MIN_PICKS}). Exiting.")
        return

    # ── 2. Prepare dataset ────────────────────────────────────────────────────
    print("🔧 Preparing dataset...")
    X, y, pick_types = [], [], []
    valid_rows = []

    for r in rows:
        feat = []
        skip = False
        for f in FEATURES:
            val = r.get(f)
            if val is None:
                val = 0  # impute missing with 0
            if f == "fresh_insider":
                val = 1 if val else 0
            feat.append(float(val))
        X.append(feat)
        y.append(1 if r.get("beat_30d") else 0)
        pick_types.append(r.get("pick_type", "unknown"))
        valid_rows.append(r)

    X = np.array(X)
    y = np.array(y)

    print(f"   Dataset: {len(X)} picks | Win rate: {y.mean()*100:.1f}%")

    # ── 3. Train model ────────────────────────────────────────────────────────
    print("🧠 Training model...")
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # Use Logistic Regression if < 50 picks, Random Forest if more
    if len(X) < 50:
        model = LogisticRegression(max_iter=1000, C=1.0)
        model_name = "Logistic Regression"
    else:
        model = RandomForestClassifier(n_estimators=100, random_state=42, max_depth=4)
        model_name = "Random Forest"

    # Cross-validation score
    cv_scores = cross_val_score(model, X_scaled, y, cv=min(5, len(X)//4), scoring="accuracy")
    cv_accuracy = cv_scores.mean()
    model.fit(X_scaled, y)

    # Feature importances
    if hasattr(model, "feature_importances_"):
        importances = model.feature_importances_
    else:
        importances = np.abs(model.coef_[0])
        importances = importances / importances.sum()

    feat_imp = dict(zip(FEATURES, importances))
    feat_imp_sorted = sorted(feat_imp.items(), key=lambda x: x[1], reverse=True)

    print(f"   Model: {model_name} | CV accuracy: {cv_accuracy*100:.1f}%")
    print(f"   Top features: {', '.join([f'{k}:{v:.3f}' for k,v in feat_imp_sorted[:5]])}")

    # ── 4. Analyze by signal type ─────────────────────────────────────────────
    signal_stats = {}
    for stype in set(pick_types):
        idxs = [i for i, t in enumerate(pick_types) if t == stype]
        if len(idxs) < 3:
            continue
        wins = sum(y[i] for i in idxs)
        avg_30d = np.mean([valid_rows[i].get("perf_30d", 0) for i in idxs])
        avg_vs_russell = np.mean([
            (valid_rows[i].get("perf_30d", 0) or 0) - (valid_rows[i].get("russell_30d", 0) or 0)
            for i in idxs
        ])
        signal_stats[stype] = {
            "count":          len(idxs),
            "win_rate":       round(wins / len(idxs) * 100, 1),
            "avg_30d":        round(float(avg_30d), 1),
            "avg_vs_russell": round(float(avg_vs_russell), 1),
        }

    # ── 5. Load current weights ───────────────────────────────────────────────
    curr_res = sb.table("scoring_weights").select("*").eq("id", "active").execute()
    current_weights = curr_res.data[0] if curr_res.data else {
        "w_fund": 32, "w_sent": 8, "w_analyst": 15,
        "w_momentum": 17, "w_earnings": 15, "w_volume": 8, "w_insider": 8
    }

    # ── 6. Propose new weights based on feature importance ───────────────────
    # Only adjust weights that map directly to scoring factors
    total_base = sum(current_weights.get(w, 0) for w in WEIGHT_KEYS)
    if total_base == 0:
        total_base = 100

    # Normalize feature importances for the 7 main scoring features
    main_feats = {f: feat_imp.get(f, 0) for f in FEATURE_TO_WEIGHT.keys()}
    total_imp = sum(main_feats.values()) or 1
    normalized = {f: v / total_imp for f, v in main_feats.items()}

    # Blend: 60% current weights, 40% model suggestion (conservative update)
    proposed_weights = {}
    for feat, wkey in FEATURE_TO_WEIGHT.items():
        current = float(current_weights.get(wkey, 10))
        suggested = normalized[feat] * total_base
        blended = round(current * 0.6 + suggested * 0.4, 1)
        # Cap changes at ±5 points per cycle
        blended = max(current - 5, min(current + 5, blended))
        blended = max(3, blended)  # floor at 3
        proposed_weights[wkey] = blended

    # Rescale to keep total ~= total_base
    pw_total = sum(proposed_weights.values())
    scale = total_base / pw_total
    proposed_weights = {k: round(v * scale, 1) for k, v in proposed_weights.items()}

    # ── 7. Ask Claude for plain-English analysis ──────────────────────────────
    print("🤖 Asking Claude for analysis...")
    claude_analysis = get_claude_analysis(
        rows, signal_stats, feat_imp_sorted, current_weights,
        proposed_weights, cv_accuracy, y.mean(), model_name
    )

    # ── 8. Save proposed weights to feedback_log ──────────────────────────────
    log_res = sb.table("feedback_log").insert({
        "picks_count":   len(rows),
        "win_rate_30d":  round(float(y.mean() * 100), 1),
        "old_weights":   json.dumps({k: current_weights.get(k) for k in WEIGHT_KEYS}),
        "new_weights":   json.dumps(proposed_weights),
        "top_signals":   json.dumps(signal_stats),
        "notes":         f"Monthly ML run — {model_name} — CV {cv_accuracy*100:.1f}%",
        "approved":      False,
    }).execute()
    log_id = log_res.data[0]["id"] if log_res.data else None
    print(f"   Logged to feedback_log (id={log_id})")

    # ── 9. Send Telegram message ───────────────────────────────────────────────
    print("📱 Sending Telegram message...")
    send_analysis_telegram(
        signal_stats, feat_imp_sorted, current_weights,
        proposed_weights, claude_analysis, len(rows),
        y.mean(), cv_accuracy, log_id
    )

    print("✅ ML Optimizer complete!")


def get_claude_analysis(rows, signal_stats, feat_imp, curr_w, prop_w, cv_acc, win_rate, model_name):
    """Ask Claude to explain the findings in plain English."""
    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

        prompt = f"""Analiza estos resultados del sistema de scoring de StockRaptor y explica en 3-4 frases concisas qué está funcionando y qué no.

Datos:
- Total picks analizados: {len(rows)}
- Win rate global (batió Russell 2000 a 30 días): {win_rate*100:.1f}%
- Modelo usado: {model_name} (CV accuracy: {cv_acc*100:.1f}%)

Performance por tipo de señal:
{json.dumps(signal_stats, indent=2)}

Top 5 factores más predictivos según el modelo:
{json.dumps(feat_imp[:5], indent=2)}

Pesos actuales → propuestos:
{json.dumps({k: f"{curr_w.get(k, '?')} → {prop_w.get(k, '?')}" for k in prop_w.keys()}, indent=2)}

Responde en español, de forma directa y sin preamble. Máximo 4 frases.
Concluye si recomiendas aplicar los cambios propuestos (sí/no/parcialmente) y por qué."""

        msg = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}]
        )
        return msg.content[0].text
    except Exception as e:
        return f"(Análisis no disponible: {e})"


def send_analysis_telegram(signal_stats, feat_imp, curr_w, prop_w, analysis, n_picks, win_rate, cv_acc, log_id):
    """Send formatted analysis to Telegram with approve/reject buttons."""
    if not TG_TOKEN or not TG_CHAT_ID:
        print("⚠ TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping Telegram")
        print("\n📊 ANALYSIS SUMMARY:")
        print(f"   Win rate: {win_rate*100:.1f}% | Picks: {n_picks}")
        print(f"   Top signals: {', '.join([s for s, d in sorted(signal_stats.items(), key=lambda x: x[1]['win_rate'], reverse=True)])}")
        print(f"\n🤖 Claude says: {analysis}")
        return

    # Format signal stats
    signal_lines = []
    for stype, s in sorted(signal_stats.items(), key=lambda x: x[1]["win_rate"], reverse=True):
        emoji = "🟢" if s["win_rate"] >= 60 else "🟡" if s["win_rate"] >= 45 else "🔴"
        signal_lines.append(
            f"{emoji} *{stype.upper()}*: {s['win_rate']}% win · {s['avg_vs_russell']:+.1f}% vs Russell · {s['count']} picks"
        )

    # Format weight changes
    weight_lines = []
    for wkey, new_val in prop_w.items():
        old_val = curr_w.get(wkey, "?")
        label = wkey.replace("w_", "").upper()
        diff = float(new_val) - float(old_val) if old_val != "?" else 0
        arrow = f"↑{diff:+.1f}" if diff > 0.5 else f"↓{diff:.1f}" if diff < -0.5 else "→"
        weight_lines.append(f"  • {label}: {old_val} {arrow} *{new_val}*")

    now = datetime.now(timezone.utc).strftime("%d %b %Y")
    msg = (
        f"🦅 *StockRaptor — Análisis ML Mensual*\n"
        f"_{now} · {n_picks} picks · {win_rate*100:.1f}% win rate_\n\n"
        f"*📊 Performance por señal:*\n"
        + "\n".join(signal_lines) +
        f"\n\n*⚖️ Cambios propuestos en pesos:*\n"
        + "\n".join(weight_lines) +
        f"\n\n*🤖 Análisis:*\n_{analysis}_\n\n"
        f"¿Aplicar los nuevos pesos al scoring?"
    )

    # Send with inline keyboard (approve/reject)
    url = f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage"
    payload = {
        "chat_id":    TG_CHAT_ID,
        "text":       msg,
        "parse_mode": "Markdown",
        "reply_markup": json.dumps({
            "inline_keyboard": [[
                {"text": "✅ Aplicar pesos",  "callback_data": f"approve_weights_{log_id}"},
                {"text": "❌ Rechazar",        "callback_data": f"reject_weights_{log_id}"},
            ]]
        })
    }

    try:
        r = requests.post(url, json=payload, timeout=15)
        if r.status_code == 200:
            print("   ✅ Telegram message sent")
        else:
            print(f"   ⚠ Telegram error: {r.status_code} {r.text}")
    except Exception as e:
        print(f"   ⚠ Telegram send failed: {e}")


def send_telegram(text):
    """Simple text message."""
    if not TG_TOKEN or not TG_CHAT_ID:
        print(f"[Telegram would send]: {text}")
        return
    requests.post(
        f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
        json={"chat_id": TG_CHAT_ID, "text": text, "parse_mode": "Markdown"},
        timeout=10
    )


if __name__ == "__main__":
    main()
