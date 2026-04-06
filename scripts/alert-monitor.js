// ══════════════════════════════════════════════════════════════
// StockRaptor · Intraweek Alert Monitor
// Runs hourly during US market hours via GitHub Actions.
// Detects high-conviction entry signals and exit conditions
// for active picks. Sends via Resend email + Telegram bot.
// ══════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';

const FMP_KEY        = process.env.FMP_KEY;
const SB_URL         = process.env.SUPABASE_URL;
const SB_KEY         = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY     = process.env.RESEND_API_KEY || '';
const RESEND_FROM    = process.env.RESEND_FROM || 'StockRaptor <alerts@resend.dev>';
const ALERT_EMAIL_TO = process.env.ALERT_EMAIL_TO || '';
const TG_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT_ID     = process.env.TELEGRAM_CHAT_ID || '';
const SITE_URL       = process.env.SITE_URL || 'https://stockraptor.netlify.app';

if (!FMP_KEY || !SB_URL || !SB_KEY) {
  console.error('❌ Missing env vars: FMP_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb   = createClient(SB_URL, SB_KEY);
const BASE = 'https://financialmodelingprep.com/stable';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fmp(endpoint) {
  try {
    const sep = endpoint.includes('?') ? '&' : '?';
    const res = await fetch(`${BASE}${endpoint}${sep}apikey=${FMP_KEY}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── DEDUP: check if we already sent this alert today ────────
async function alreadySent(alertType, sym) {
  const today = new Date().toISOString().substring(0, 10);
  const { data } = await sb.from('alert_log')
    .select('id')
    .eq('alert_type', alertType)
    .eq('sym', sym)
    .gte('created_at', today + 'T00:00:00')
    .limit(1);
  return data && data.length > 0;
}

async function logAlert(alertType, sym, headline, details, sentEmail, sentTg) {
  try {
    await sb.from('alert_log').insert({
      alert_type: alertType, sym, headline, details,
      sent_email: sentEmail, sent_tg: sentTg
    });
  } catch (e) {
    console.warn(`   ⚠ alert_log insert failed: ${e.message}`);
  }
}

// ── EMAIL via Resend ────────────────────────────────────────
async function sendEmail(subject, htmlBody) {
  if (!RESEND_KEY || !ALERT_EMAIL_TO) {
    console.log(`   📧 [Email skipped — no RESEND_API_KEY or ALERT_EMAIL_TO]`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: ALERT_EMAIL_TO,
        subject,
        html: htmlBody,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn(`   ⚠ Resend error ${res.status}: ${err}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`   ⚠ Resend failed: ${e.message}`);
    return false;
  }
}

// ── TELEGRAM ─────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log(`   📱 [Telegram skipped — no token]`);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch { return false; }
}

// ── EMAIL TEMPLATE ──────────────────────────────────────────
function emailHtml(title, color, body, sym) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a18;font-family:-apple-system,sans-serif;color:#c8c8e8;">
<div style="max-width:560px;margin:0 auto;padding:32px 24px;">
  <div style="background:#13132a;border:1px solid ${color}44;border-radius:14px;padding:28px;">
    <div style="font-size:11px;letter-spacing:2px;color:${color};margin-bottom:8px;font-weight:600;">🦅 STOCKRAPTOR ALERT</div>
    <h1 style="margin:0 0 16px;color:#fff;font-size:22px;font-weight:700;">${title}</h1>
    <div style="font-size:14px;line-height:1.7;color:#c8c8e8;">${body}</div>
    <div style="margin-top:24px;padding-top:20px;border-top:1px solid #2a2a48;">
      <a href="${SITE_URL}/scanner.html?sym=${sym}" style="display:inline-block;background:${color};color:#0a0a18;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;">View ${sym} in Scanner →</a>
    </div>
  </div>
  <div style="text-align:center;margin-top:16px;font-size:11px;color:#5a5a7a;">
    StockRaptor · Intraweek Alert · ${new Date().toLocaleString('en-US')}
  </div>
</div></body></html>`;
}

// ── ENTRY ALERTS: scan_cache for high-conviction signals ───
async function checkEntryAlerts() {
  console.log('\n🔍 Checking entry alerts...');
  const alerts = [];

  // Load latest scan results
  const { data: cache } = await sb.from('scan_cache').select('*').eq('id','daily').single();
  if (!cache?.results) { console.log('   No scan_cache data'); return alerts; }

  const fresh = cache.results.filter(r => !r._stale);
  console.log(`   Analyzing ${fresh.length} fresh stocks`);

  for (const r of fresh) {
    // 1. FRESH INSIDER BUY > $500K (last 7 days)
    if (r.freshInsiderDays !== null && r.freshInsiderDays <= 7
        && r.freshInsiderValue > 500000 && r.total >= 45) {
      if (!(await alreadySent('entry_insider', r.sym))) {
        alerts.push({
          type: 'entry_insider',
          sym: r.sym, name: r.companyName,
          color: '#00e57a',
          title: '🔥 FRESH INSIDER BUY',
          headline: `Insider bought $${(r.freshInsiderValue/1000).toFixed(0)}K of ${r.sym} in the last ${r.freshInsiderDays}d`,
          body: `<strong>${r.companyName} (${r.sym})</strong> — $${r.price?.toFixed(2)}<br>
            Score: ${r.total} · Signal: ${r.signal}<br><br>
            👤 An insider purchased <strong>$${(r.freshInsiderValue/1000).toFixed(0)}K</strong> of shares ${r.freshInsiderDays<=1?'today':r.freshInsiderDays+' days ago'}.<br><br>
            <em style="color:#7b5cf0;">Why it matters: insiders rarely buy with their own money unless they believe the stock is significantly undervalued.</em>`,
          data: r,
        });
      }
    }

    // 2. VOLUME ANOMALY > 5x on a quality stock (score >= 50)
    if (r.volRatio > 5 && r.priceChange1D > 0 && r.total >= 50 && r.fund >= 12) {
      if (!(await alreadySent('entry_volume', r.sym))) {
        alerts.push({
          type: 'entry_volume',
          sym: r.sym, name: r.companyName,
          color: '#00b4ff',
          title: '⚡ EXTREME VOLUME SPIKE',
          headline: `${r.sym} trading at ${r.volRatio}x average volume`,
          body: `<strong>${r.companyName} (${r.sym})</strong> — $${r.price?.toFixed(2)} (+${r.priceChange1D}%)<br>
            Score: ${r.total} · Volume: <strong>${r.volRatio}x average</strong><br><br>
            ⚡ Unusual volume often signals institutional accumulation or imminent news. Combined with positive price action and a strong fundamental score (${r.fund}/32), this warrants attention.`,
          data: r,
        });
      }
    }

    // 3. RANK JUMP > 5 positions
    if (r.rankDelta != null && r.rankDelta >= 5 && r.total >= 55) {
      if (!(await alreadySent('entry_rankjump', r.sym))) {
        alerts.push({
          type: 'entry_rankjump',
          sym: r.sym, name: r.companyName,
          color: '#ffcc00',
          title: '📈 MAJOR RANK JUMP',
          headline: `${r.sym} jumped ${r.rankDelta} positions to #${r.rankToday}`,
          body: `<strong>${r.companyName} (${r.sym})</strong> — $${r.price?.toFixed(2)}<br>
            New rank: #${r.rankToday} (▲${r.rankDelta} positions)<br>
            Score: ${r.total} · Signal: ${r.signal}<br><br>
            📈 Multiple signals improved simultaneously to push this stock up the rankings. ${r.moverSummary || 'Check the detail panel for the breakdown.'}`,
          data: r,
        });
      }
    }

    // 4. RECENT 8-K filing (within 2 days) on a quality stock
    if (r.recent8K && r.recent8K.daysAgo <= 2 && r.total >= 50) {
      if (!(await alreadySent('entry_8k', r.sym))) {
        alerts.push({
          type: 'entry_8k',
          sym: r.sym, name: r.companyName,
          color: '#bf5fff',
          title: '📋 SEC 8-K FILING',
          headline: `${r.sym} filed an 8-K ${r.recent8K.daysAgo<=1?'today':r.recent8K.daysAgo+'d ago'}`,
          body: `<strong>${r.companyName} (${r.sym})</strong> — $${r.price?.toFixed(2)}<br>
            Score: ${r.total} · Signal: ${r.signal}<br><br>
            📋 8-K filings cover material corporate events: earnings surprises, FDA approvals, acquisitions, guidance changes, leadership transitions. Filed ${r.recent8K.date}.`,
          data: r,
        });
      }
    }
  }

  console.log(`   Found ${alerts.length} entry alert candidates`);
  return alerts;
}

// ── EXIT ALERTS: check active picks for thesis breaks ──────
async function checkExitAlerts() {
  console.log('\n🚪 Checking exit alerts on active picks...');
  const alerts = [];

  // Get picks from last 60 days that haven't been "exited" yet
  const cutoff = new Date(Date.now() - 60*86400000).toISOString().substring(0,10);
  const { data: picks } = await sb.from('picks_history')
    .select('*')
    .gte('scan_date', cutoff)
    .order('scan_date', { ascending: false });

  if (!picks?.length) { console.log('   No recent picks to monitor'); return alerts; }
  console.log(`   Monitoring ${picks.length} picks from last 60 days`);

  // Get current scores from latest scan
  const { data: cache } = await sb.from('scan_cache').select('results').eq('id','daily').single();
  const currentMap = {};
  (cache?.results || []).forEach(r => { currentMap[r.sym] = r; });

  // Fetch current prices for symbols not in scan_cache
  const missingSyms = picks.filter(p => !currentMap[p.sym]).map(p => p.sym);
  const uniqueMissing = [...new Set(missingSyms)];
  const externalPrices = {};
  for (let i = 0; i < uniqueMissing.length; i += 50) {
    const batch = uniqueMissing.slice(i, i+50).join(',');
    const quotes = await fmp(`/quote/${batch}`);
    if (Array.isArray(quotes)) {
      quotes.forEach(q => { if (q?.symbol && q?.price) externalPrices[q.symbol] = q.price; });
    }
    if (i+50 < uniqueMissing.length) await sleep(300);
  }

  for (const pick of picks) {
    const current = currentMap[pick.sym];
    const currentPrice = current?.price ?? externalPrices[pick.sym];
    if (!currentPrice || !pick.entry_price) continue;

    const perf = ((currentPrice - pick.entry_price) / pick.entry_price) * 100;

    // 1. STOP-LOSS: -12% from entry
    if (perf <= -12) {
      if (!(await alreadySent('exit_stoploss', pick.sym))) {
        alerts.push({
          type: 'exit_stoploss',
          sym: pick.sym, name: pick.company_name,
          color: '#ff3b5c',
          title: '🔴 STOP-LOSS TRIGGERED',
          headline: `${pick.sym} hit -12% stop-loss`,
          body: `<strong>${pick.company_name} (${pick.sym})</strong> picked ${pick.scan_date} at $${Number(pick.entry_price).toFixed(2)}<br>
            Current: $${currentPrice.toFixed(2)} <span style="color:#ff3b5c;font-weight:700;">(${perf.toFixed(1)}%)</span><br><br>
            🔴 Stop-loss threshold reached. Consider closing this position to limit further downside.`,
          data: { perf, currentPrice, pick },
        });
        continue; // skip other exit checks if stop-loss already fired
      }
    }

    // 2. THESIS BROKEN: score dropped below 30 (was >=48 at pick time)
    if (current && current.total < 30 && pick.score >= 48) {
      if (!(await alreadySent('exit_thesis', pick.sym))) {
        alerts.push({
          type: 'exit_thesis',
          sym: pick.sym, name: pick.company_name,
          color: '#ff7040',
          title: '⚠️ THESIS BROKEN',
          headline: `${pick.sym} score dropped from ${pick.score} → ${current.total}`,
          body: `<strong>${pick.company_name} (${pick.sym})</strong> picked ${pick.scan_date} at $${Number(pick.entry_price).toFixed(2)}<br>
            Current: $${currentPrice.toFixed(2)} (${perf.toFixed(1)}%)<br><br>
            ⚠️ The original thesis no longer holds. Score dropped from <strong>${pick.score}</strong> to <strong>${current.total}</strong>. The fundamentals or technical setup that made this a pick have deteriorated significantly.`,
          data: { oldScore: pick.score, newScore: current.total, perf, pick },
        });
        continue;
      }
    }

    // 3. TREND COLLAPSE: stock fell >35% from 52w high
    if (current && current.pct52High != null && current.pct52High < -35) {
      if (!(await alreadySent('exit_trend', pick.sym))) {
        alerts.push({
          type: 'exit_trend',
          sym: pick.sym, name: pick.company_name,
          color: '#ff3b5c',
          title: '📉 TREND COLLAPSE',
          headline: `${pick.sym} now ${current.pct52High}% below 52w high`,
          body: `<strong>${pick.company_name} (${pick.sym})</strong> picked ${pick.scan_date} at $${Number(pick.entry_price).toFixed(2)}<br>
            Current: $${currentPrice.toFixed(2)} (${perf.toFixed(1)}%)<br><br>
            📉 Stock is now ${current.pct52High}% below its 52-week high — structurally broken trend. Recovery from this level rarely happens within a weekly pick horizon.`,
          data: { pct52High: current.pct52High, perf, pick },
        });
      }
    }
  }

  console.log(`   Found ${alerts.length} exit alert candidates`);
  return alerts;
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log('🦅 StockRaptor Alert Monitor starting...');
  const t0 = Date.now();

  const entries = await checkEntryAlerts();
  const exits   = await checkExitAlerts();
  const all = [...entries, ...exits];

  if (all.length === 0) {
    console.log('\n✅ No alerts to send');
    return;
  }

  console.log(`\n📤 Sending ${all.length} alerts...`);

  for (const a of all) {
    const subject = `🦅 ${a.title} — ${a.sym}`;
    const html    = emailHtml(a.title + ' — ' + a.sym, a.color, a.body, a.sym);
    const tgText  = `*${a.title}* — \`${a.sym}\`\n\n${a.headline}\n\n[View in Scanner](${SITE_URL}/scanner.html?sym=${a.sym})`;

    const sentEmail = await sendEmail(subject, html);
    const sentTg    = await sendTelegram(tgText);

    await logAlert(a.type, a.sym, a.headline, a.data || {}, sentEmail, sentTg);

    console.log(`   ${sentEmail||sentTg?'✅':'⚠'} ${a.type} ${a.sym} (email:${sentEmail} tg:${sentTg})`);
    await sleep(500); // rate limit pause
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n🏁 Alert monitor complete in ${elapsed}s — ${all.length} alerts sent`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
