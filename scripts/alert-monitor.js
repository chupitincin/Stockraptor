// ══════════════════════════════════════════════════════════════
// StockRaptor · Intraweek Alert Monitor
// Runs hourly during US market hours via GitHub Actions.
// Detects high-conviction entry signals and exit conditions
// for active picks. Sends via Resend email + Telegram bot.
// ══════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';
import {
  checkRedditMentions,
  checkGdeltNews,
  checkSecLatestFilings,
  checkFdaSignals,
} from './intraday-signals.js';

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

// ── ENTRY ALERTS: real-time intraday detection ─────────────
async function checkEntryAlerts() {
  console.log('\n🔍 Checking entry alerts (live intraday data)...');
  const alerts = [];

  // Load cached baseline (yesterday's prices, volumes, scores)
  const { data: cache } = await sb.from('scan_cache').select('*').eq('id','daily').single();
  if (!cache?.results) { console.log('   No scan_cache baseline'); return alerts; }

  // Top 250 by score from cached scan = our watchlist for live monitoring
  const watchlist = cache.results
    .filter(r => !r._stale && r.total >= 40 && r.fund >= 10)
    .sort((a, b) => b.total - a.total)
    .slice(0, 250);

  console.log(`   Live monitoring ${watchlist.length} stocks`);
  const cacheMap = {};
  watchlist.forEach(r => { cacheMap[r.sym] = r; });

  // ── Step 1: Fetch live quotes (batched) ──
  // FMP /quote endpoint accepts comma-separated symbols, ~50 per call
  const liveQuotes = {};
  const symbols = watchlist.map(r => r.sym);
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50).join(',');
    const data = await fmp(`/quote/${batch}`);
    if (Array.isArray(data)) {
      data.forEach(q => {
        if (q?.symbol) liveQuotes[q.symbol] = q;
      });
    }
    if (i + 50 < symbols.length) await sleep(150);
  }
  console.log(`   Fetched live quotes for ${Object.keys(liveQuotes).length}/${symbols.length} stocks`);

  // ── Step 2: Detect intraday signals ──
  for (const sym of symbols) {
    const cached = cacheMap[sym];
    const live   = liveQuotes[sym];
    if (!live || !cached) continue;

    const livePrice  = live.price;
    const liveVolume = live.volume;
    const avgVolume  = live.avgVolume || cached.volRatio && cached.volRatio > 0
      ? (cached.volRatio ? liveVolume / cached.volRatio : null)
      : null;
    const liveVolRatio = avgVolume && avgVolume > 0 ? liveVolume / avgVolume : null;

    // Compare to cached (yesterday's close) to compute today's intraday move
    const priceJump = cached.price && cached.price > 0
      ? ((livePrice - cached.price) / cached.price) * 100
      : null;

    // ── 1. INTRADAY PRICE BREAKOUT — stock up >5% live with volume confirmation ──
    if (priceJump != null && priceJump >= 5
        && liveVolRatio != null && liveVolRatio >= 2
        && cached.total >= 50) {
      if (!(await alreadySent('entry_breakout', sym))) {
        alerts.push({
          type: 'entry_breakout',
          sym, name: cached.companyName,
          color: '#00e57a',
          title: '🚀 INTRADAY BREAKOUT',
          headline: `${sym} up ${priceJump.toFixed(1)}% intraday on ${liveVolRatio.toFixed(1)}x volume`,
          body: `<strong>${cached.companyName} (${sym})</strong> — $${livePrice.toFixed(2)} <span style="color:#00e57a;">(+${priceJump.toFixed(1)}% today)</span><br>
            Score: ${cached.total} · Volume: <strong>${liveVolRatio.toFixed(1)}x average</strong><br><br>
            🚀 Live intraday breakout. Strong upward move backed by ${liveVolRatio.toFixed(1)}x normal volume — institutional accumulation likely.`,
          data: { livePrice, priceJump, liveVolRatio, cached },
        });
      }
    }

    // ── 2. EXTREME LIVE VOLUME SPIKE >5x on quality stock ──
    if (liveVolRatio != null && liveVolRatio >= 5
        && livePrice > cached.price && cached.total >= 50 && cached.fund >= 12) {
      if (!(await alreadySent('entry_volume', sym))) {
        alerts.push({
          type: 'entry_volume',
          sym, name: cached.companyName,
          color: '#00b4ff',
          title: '⚡ EXTREME VOLUME SPIKE',
          headline: `${sym} live volume ${liveVolRatio.toFixed(1)}x average`,
          body: `<strong>${cached.companyName} (${sym})</strong> — $${livePrice.toFixed(2)} ${priceJump?`(+${priceJump.toFixed(1)}%)`:''}<br>
            Score: ${cached.total} · Live Volume: <strong>${liveVolRatio.toFixed(1)}x</strong><br><br>
            ⚡ Unusual volume detected in real time. Often signals institutional accumulation or imminent news catalyst.`,
          data: { livePrice, priceJump, liveVolRatio, cached },
        });
      }
    }

    // ── 3. INTRADAY DUMP — quality stock down >7% (potential dip-buy or warning) ──
    if (priceJump != null && priceJump <= -7 && cached.total >= 55) {
      if (!(await alreadySent('entry_dip', sym))) {
        alerts.push({
          type: 'entry_dip',
          sym, name: cached.companyName,
          color: '#ff7040',
          title: '📉 QUALITY STOCK DUMPING',
          headline: `${sym} down ${priceJump.toFixed(1)}% intraday — was high quality (score ${cached.total})`,
          body: `<strong>${cached.companyName} (${sym})</strong> — $${livePrice.toFixed(2)} <span style="color:#ff3b5c;">(${priceJump.toFixed(1)}% today)</span><br>
            Score: ${cached.total} · Sector: ${cached.sector}<br><br>
            📉 This is a flagged quality stock taking heavy intraday damage. Could be either a buying opportunity (overreaction) or a warning sign (material news pending). Worth investigating.`,
          data: { livePrice, priceJump, cached },
        });
      }
    }
  }

  // ── Step 3: Cache-based signals (don't change intraday) ──
  // These come from yesterday's scan but are still valuable to surface
  for (const r of watchlist) {
    // Fresh insider buy > $500K (data from weekly insider scan)
    if (r.freshInsiderDays !== null && r.freshInsiderDays <= 7
        && r.freshInsiderValue > 500000 && r.total >= 45) {
      if (!(await alreadySent('entry_insider', r.sym))) {
        alerts.push({
          type: 'entry_insider',
          sym: r.sym, name: r.companyName,
          color: '#00e57a',
          title: '🔥 FRESH INSIDER BUY',
          headline: `Insider bought $${(r.freshInsiderValue/1000).toFixed(0)}K of ${r.sym} in last ${r.freshInsiderDays}d`,
          body: `<strong>${r.companyName} (${r.sym})</strong> — $${liveQuotes[r.sym]?.price?.toFixed(2) || r.price?.toFixed(2)}<br>
            Score: ${r.total} · Signal: ${r.signal}<br><br>
            👤 An insider purchased <strong>$${(r.freshInsiderValue/1000).toFixed(0)}K</strong> of shares ${r.freshInsiderDays<=1?'today':r.freshInsiderDays+' days ago'}.<br><br>
            <em style="color:#7b5cf0;">Why it matters: insiders rarely buy with their own money unless they believe the stock is significantly undervalued.</em>`,
          data: r,
        });
      }
    }

    // Recent 8-K filing within 2 days
    if (r.recent8K && r.recent8K.daysAgo <= 2 && r.total >= 50) {
      if (!(await alreadySent('entry_8k', r.sym))) {
        alerts.push({
          type: 'entry_8k',
          sym: r.sym, name: r.companyName,
          color: '#bf5fff',
          title: '📋 SEC 8-K FILING',
          headline: `${r.sym} filed an 8-K ${r.recent8K.daysAgo<=1?'today':r.recent8K.daysAgo+'d ago'}`,
          body: `<strong>${r.companyName} (${r.sym})</strong> — $${liveQuotes[r.sym]?.price?.toFixed(2) || r.price?.toFixed(2)}<br>
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

  // Get current scores from latest scan (for thesis-broken check)
  const { data: cache } = await sb.from('scan_cache').select('results').eq('id','daily').single();
  const currentMap = {};
  (cache?.results || []).forEach(r => { currentMap[r.sym] = r; });

  // Fetch LIVE prices for ALL active picks (not just missing ones)
  // Even if a pick is in scan_cache, that price is from yesterday's close
  const uniquePickSyms = [...new Set(picks.map(p => p.sym))];
  const livePrices = {};
  for (let i = 0; i < uniquePickSyms.length; i += 50) {
    const batch = uniquePickSyms.slice(i, i+50).join(',');
    const quotes = await fmp(`/quote/${batch}`);
    if (Array.isArray(quotes)) {
      quotes.forEach(q => { if (q?.symbol && q?.price) livePrices[q.symbol] = q.price; });
    }
    if (i+50 < uniquePickSyms.length) await sleep(150);
  }
  console.log(`   Fetched live prices for ${Object.keys(livePrices).length}/${uniquePickSyms.length} active picks`);

  for (const pick of picks) {
    const current = currentMap[pick.sym];
    const currentPrice = livePrices[pick.sym] ?? current?.price;
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

// ── Build cacheMap for alternative signal checks ────────────
async function getCacheMap() {
  const { data: cache } = await sb.from('scan_cache').select('results').eq('id','daily').single();
  const cacheMap = {};
  (cache?.results || []).filter(r => !r._stale).forEach(r => { cacheMap[r.sym] = r; });
  return cacheMap;
}

// ── MAIN ─────────────────────────────────────────────────────
async function main() {
  console.log('🦅 StockRaptor Alert Monitor starting...');
  const t0 = Date.now();

  // Load universe once for alternative signal checks
  const cacheMap = await getCacheMap();
  console.log(`📋 Universe: ${Object.keys(cacheMap).length} fresh stocks`);

  // Core alerts (price/volume/insider from scan data)
  const entries = await checkEntryAlerts();
  const exits   = await checkExitAlerts();

  // Alternative data signals — run in parallel to save time
  const [reddit, gdelt, sec, fda] = await Promise.all([
    checkRedditMentions(cacheMap, alreadySent).catch(e => { console.warn('reddit failed:', e.message); return []; }),
    checkGdeltNews(cacheMap, alreadySent).catch(e => { console.warn('gdelt failed:', e.message); return []; }),
    checkSecLatestFilings(cacheMap, alreadySent).catch(e => { console.warn('sec failed:', e.message); return []; }),
    checkFdaSignals(cacheMap, alreadySent).catch(e => { console.warn('fda failed:', e.message); return []; }),
  ]);

  const all = [...entries, ...exits, ...reddit, ...gdelt, ...sec, ...fda];

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
