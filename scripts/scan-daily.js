// ══════════════════════════════════════════════════════════════
// StockRaptor · Daily Scan Worker — FMP v2
// Scoring v3 improvements:
// 1. Sentiment reducido de 12 a 8 pts (señal ruidosa)
// 2. Momentum diario reducido de 4 a 2 pts máximo
// 3. Bug insider corregido (0 pts cuando no hay actividad, no 2)
// 4. Insider penaliza ventas netas (-2 pts)
// 5. Penalización momentum trampa (-5 pts)
// 6. Analyst: validación precio > targetHigh
// 7. Sentiment: mínimo 4 noticias para que cuente
// 8. Score normalizado a 0-100 al final
// 9. Umbrales subidos: STRONG BUY ≥70, INTERESTING ≥55, WATCH ≥35
// ══════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';

const FMP_KEY = process.env.FMP_KEY;
const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;

if (!FMP_KEY || !SB_URL || !SB_KEY) {
  console.error('❌ Missing env vars: FMP_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb   = createClient(SB_URL, SB_KEY);
const BASE = 'https://financialmodelingprep.com/stable';

const SECTOR_PE = {
  'Technology': 22, 'Software': 28, 'Biotechnology': 35,
  'Healthcare': 22, 'Industrials': 18, 'Energy': 14,
  'Consumer Cyclical': 20, 'Consumer Defensive': 18,
  'Financial Services': 13, 'Real Estate': 22,
  'Basic Materials': 15, 'Communication Services': 18,
  'Utilities': 16, 'default': 20
};

// Máximo teórico por factor — loaded from Supabase scoring_weights
// Defaults used if table not available
const DEFAULT_MAX_SCORES = {
  fund: 32, sent: 8, analyst: 15, momentum: 17, earPts: 15, volShort: 11, insider: 8
};
let MAX_SCORES = { ...DEFAULT_MAX_SCORES };
let MAX_TOTAL  = Object.values(MAX_SCORES).reduce((a, b) => a + b, 0); // 106

async function loadScoringWeights(sb) {
  try {
    const { data, error } = await sb
      .from('scoring_weights')
      .select('*')
      .eq('id', 'active')
      .single();

    if (error || !data) {
      console.log('   ⚠ scoring_weights not found — using defaults');
      return;
    }

    // Map Supabase weight keys → internal factor names
    const loaded = {
      fund:      data.w_fund      ?? DEFAULT_MAX_SCORES.fund,
      sent:      data.w_sent      ?? DEFAULT_MAX_SCORES.sent,
      analyst:   data.w_analyst   ?? DEFAULT_MAX_SCORES.analyst,
      momentum:  data.w_momentum  ?? DEFAULT_MAX_SCORES.momentum,
      earPts:    data.w_earnings  ?? DEFAULT_MAX_SCORES.earPts,
      volShort:  data.w_volume    ?? DEFAULT_MAX_SCORES.volShort,
      insider:   data.w_insider   ?? DEFAULT_MAX_SCORES.insider,
    };

    // Validate — all values must be positive numbers
    const valid = Object.values(loaded).every(v => typeof v === 'number' && v > 0);
    if (!valid) {
      console.log('   ⚠ Invalid weights in Supabase — using defaults');
      return;
    }

    MAX_SCORES = loaded;
    MAX_TOTAL  = Object.values(MAX_SCORES).reduce((a, b) => a + b, 0);

    const version = data.version || 1;
    const winRate = data.win_rate_30d ? ` | win_rate_30d: ${data.win_rate_30d}%` : '';
    console.log(`   ✅ Scoring weights loaded from Supabase (v${version}${winRate})`);
    console.log(`   Weights: ${Object.entries(MAX_SCORES).map(([k,v])=>`${k}:${v}`).join(' | ')} → total: ${MAX_TOTAL}`);

  } catch (e) {
    console.warn('   ⚠ Could not load scoring weights:', e.message, '— using defaults');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fmp(endpoint, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const sep = endpoint.includes('?') ? '&' : '?';
      const res = await fetch(`${BASE}${endpoint}${sep}apikey=${FMP_KEY}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.['Error Message']) throw new Error(data['Error Message']);
      return data;
    } catch (e) {
      if (i === retries) return null;
      await sleep(400 * (i + 1));
    }
  }
}

function isRealStock(s) {
  if (!s?.symbol) return false;
  if (s.isEtf || s.isFund) return false;
  if (s.symbol.includes('.') || s.symbol.includes('-')) return false;
  if (s.symbol.length > 5) return false;
  if (s.isActivelyTrading === false) return false;
  const validExchanges = ['NYSE', 'NASDAQ', 'AMEX', 'NYSEARCA', 'NYSEMKT'];
  if (s.exchangeShortName && !validExchanges.includes(s.exchangeShortName)) return false;
  return true;
}

// ── PHASE 1: GET UNIVERSE ─────────────────────────────────────
async function getUniverse() {
  console.log('📡 Phase 1: Fetching small cap universe...');
  const allTickers = new Map();

  // Buffer: ranges overlap slightly at boundaries to catch companies that float in/out
  // Volume floor lowered from 100K to 20K to avoid excluding stocks on quiet days
  const ranges = [
    { min: 70000000,   max: 260000000  },
    { min: 240000000,  max: 520000000  },
    { min: 480000000,  max: 1050000000 },
    { min: 950000000,  max: 3200000000 },
  ];

  for (const exchange of ['NASDAQ', 'NYSE', 'AMEX']) {
    for (const range of ranges) {
      for (let page = 0; page < 20; page++) {
        const data = await fmp(
          `/company-screener?marketCapMoreThan=${range.min}&marketCapLowerThan=${range.max}&exchange=${exchange}&volumeMoreThan=20000&isActivelyTrading=true&limit=500&page=${page}`
        );
        if (data === null) { console.warn(`   ⚠ Screener page ${page} failed — continuing`); continue; }
        if (!Array.isArray(data) || data.length === 0) break;
        for (const s of data) {
          if (!isRealStock(s)) continue;
          if (!allTickers.has(s.symbol)) {
            allTickers.set(s.symbol, { sym: s.symbol, sector: s.sector || 'default', cap: s.marketCap || 0, companyName: s.companyName || s.symbol });
          }
        }
        if (data.length < 500) break;
        await sleep(100);
      }
    }
    console.log(`  ${exchange}: ${allTickers.size} tickers total`);
  }

  console.log(`✅ Universe: ${allTickers.size} stocks`);
  return allTickers;
}

// ── ANALYZE SINGLE TICKER ─────────────────────────────────────

// ── SHORT FLOAT SCRAPER (Finviz — free, updates bi-monthly) ──────────────
// Returns shortPct as a number (e.g. 24.3 for 24.3%) or null
async function getShortFloat(sym) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`https://finviz.com/quote.ashx?t=${sym}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 429) { await sleep(2000); continue; } // rate limited, retry
      if (!res.ok) return null;
      const html = await res.text();
      // Multiple regex patterns to handle Finviz layout changes
      const match = html.match(/Short Float[^<]*<\/td>\s*<td[^>]*>\s*([0-9.]+)%/i)
                  || html.match(/Short Float.*?<b[^>]*>([0-9.]+)%/i)
                  || html.match(/Short Float[^%]*?([0-9]+\.[0-9]+)%/i)
                  || html.match(/"shortFloat"\s*:\s*"?([0-9.]+)/i);
      if (match) {
        const val = parseFloat(match[1]);
        if (val > 0 && val < 100) return val; // sanity check
      }
      return null;
    } catch {
      if (attempt === 0) { await sleep(1000); continue; }
      return null;
    }
  }
  return null;
}


// ── SEC 8-K REAL-TIME SIGNAL ──────────────────────────────────────────────────
// Checks SEC EDGAR for recent 8-K filings (material events) in the last 7 days
// 8-Ks include: earnings, FDA approvals, acquisitions, guidance changes
const _8kCache = {};  // in-memory cache per run

async function getRecent8K(cik, sym) {
  if (!cik || _8kCache[sym] !== undefined) return _8kCache[sym] || null;
  try {
    const padded = String(cik).padStart(10, '0');
    const url = `https://data.sec.gov/submissions/CIK${padded}.json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'StockRaptor research@stockraptor.com' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) { _8kCache[sym] = null; return null; }
    const data = await res.json();
    const filings = data?.filings?.recent;
    if (!filings?.form) { _8kCache[sym] = null; return null; }

    const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().substring(0,10);
    const idx = filings.form.findIndex((f, i) =>
      (f === '8-K' || f === '8-K/A') && filings.filingDate[i] >= cutoff
    );

    if (idx === -1) { _8kCache[sym] = null; return null; }

    // Return most recent 8-K
    const result = {
      date: filings.filingDate[idx],
      description: (filings.primaryDocument[idx] || '').toLowerCase(),
      daysAgo: Math.floor((Date.now() - new Date(filings.filingDate[idx])) / 86400000),
    };
    _8kCache[sym] = result;
    return result;
  } catch { _8kCache[sym] = null; return null; }
}

async function analyzeTicker(sym, baseData, insiderCache = {}) {
  try {
    const profile     = await fmp(`/profile?symbol=${sym}`);
    const quote       = await fmp(`/quote?symbol=${sym}`);
    const ratios      = await fmp(`/ratios-ttm?symbol=${sym}`);
    const keyMetrics  = await fmp(`/key-metrics-ttm?symbol=${sym}`);
    const cashflow    = await fmp(`/cash-flow-statement?symbol=${sym}&limit=2`);
    const income      = await fmp(`/income-statement?symbol=${sym}&limit=4`);
    const earnings    = await fmp(`/earnings?symbol=${sym}&limit=5`);
    const priceTarget = await fmp(`/price-target-consensus?symbol=${sym}`);
    const ratings     = await fmp(`/grades-consensus?symbol=${sym}`);
    const news        = await fmp(`/news/stock?symbols=${sym}&limit=10`);

    const insiderRow = insiderCache[sym];
    const insider = insiderRow ? {
      buys:           insiderRow.buys || 0,
      sells:          insiderRow.sells || 0,
      netChange:      insiderRow.net_change || 0,
      totalBuyValue:  insiderRow.total_buy_value || 0,
      totalSellValue: insiderRow.total_sell_value || 0,
      transactions:   insiderRow.transactions || [],
      insiders:       insiderRow.insiders || [],
    } : null;

    const p   = profile?.[0];
    const q   = quote?.[0];
    const r   = ratios?.[0];
    const km  = keyMetrics?.[0];
    const cf  = cashflow?.[0];
    const cf1 = cashflow?.[1];
    const inc = income?.[0];
    const inc1 = income?.[1];
    const pt  = priceTarget?.[0];

    const price  = q?.price || p?.price || 0;
    const cap    = q?.marketCap || p?.marketCap || baseData?.cap || 0;
    const sector = p?.sector || baseData?.sector || 'default';

    if (!price || price < 0.5) return null;
    if (cap < 50_000_000 || cap > 6_000_000_000) return null;
    if (p?.isActivelyTrading === false) return null;

    const benchPE = SECTOR_PE[sector] || 20;

    // ── 1. FUNDAMENTAL SCORE (0-32 pts) ──────────────────────
    let fund = 0;

    const pe = r?.priceToEarningsRatioTTM ?? r?.peRatioTTM;
    if (pe && pe > 0 && pe < 300) {
      fund += pe < benchPE * 0.6 ? 6 : pe < benchPE * 0.85 ? 4 : pe < benchPE ? 2 : pe < benchPE * 1.3 ? 1 : 0;
    }

    const pb = r?.priceToBookRatioTTM;
    if (pb && pb > 0) fund += pb < 1 ? 4 : pb < 2 ? 3 : pb < 3 ? 2 : pb < 5 ? 1 : 0;

    const grossMargin = r?.grossProfitMarginTTM != null ? r.grossProfitMarginTTM * 100 : null;
    if (grossMargin != null) fund += grossMargin > 60 ? 4 : grossMargin > 40 ? 3 : grossMargin > 25 ? 2 : grossMargin > 10 ? 1 : 0;

    const ebitdaMargin = r?.ebitdaMarginTTM != null ? r.ebitdaMarginTTM * 100 : null;
    if (ebitdaMargin != null) fund += ebitdaMargin > 25 ? 4 : ebitdaMargin > 15 ? 3 : ebitdaMargin > 8 ? 2 : ebitdaMargin > 0 ? 1 : 0;

    const fcf  = cf?.freeCashFlow;
    const fcf1 = cf1?.freeCashFlow;
    if (fcf != null) {
      if (fcf > 0) fund += 3;
      if (fcf > 0 && fcf1 != null && fcf1 > 0) fund += 2;
      if (fcf1 && fcf1 > 0 && (fcf - fcf1) / fcf1 > 0.2) fund += 1;
    }

    const cr = r?.currentRatioTTM;
    if (cr) fund += cr >= 2 ? 3 : cr >= 1.5 ? 2 : cr >= 1 ? 1 : 0;

    const roe = km?.returnOnEquityTTM != null ? km.returnOnEquityTTM * 100
              : r?.returnOnEquityTTM  != null ? r.returnOnEquityTTM  * 100
              : null;
    if (roe != null) fund += roe > 20 ? 4 : roe > 12 ? 3 : roe > 8 ? 2 : roe > 0 ? 1 : 0;

    const netDebtEbitda = km?.netDebtToEBITDATTM;
    if (netDebtEbitda != null) fund += netDebtEbitda < 1 ? 3 : netDebtEbitda < 2 ? 2 : netDebtEbitda < 3 ? 1 : netDebtEbitda > 5 ? -3 : 0;

    const rev0 = inc?.revenue, rev1 = inc1?.revenue;
    let revGrowth = null;
    if (rev0 && rev1 && rev1 > 0) {
      revGrowth = Math.round(((rev0 - rev1) / rev1) * 100);
      fund += revGrowth > 25 ? 4 : revGrowth > 15 ? 3 : revGrowth > 5 ? 2 : revGrowth > 0 ? 1 : 0;
    }

    const eps0 = inc?.eps, eps1 = inc1?.eps;
    let epsGrowth = null;
    if (eps0 && eps1 && Math.abs(eps1) > 0.01) {
      epsGrowth = Math.round(((eps0 - eps1) / Math.abs(eps1)) * 100);
      fund += epsGrowth > 20 ? 3 : epsGrowth > 10 ? 2 : epsGrowth > 0 ? 1 : 0;
    }

    const de = r?.debtToEquityRatioTTM ?? r?.debtToEquityTTM;
    let debtPenalty = 0;
    if (de != null && de > 2.5 && (revGrowth == null || revGrowth < 5)) debtPenalty = -5;
    else if (de != null && de > 4) debtPenalty = -3;
    fund += debtPenalty;

    const shares0 = inc?.weightedAverageShsOut, shares1 = inc1?.weightedAverageShsOut;
    let sharesDilution = null, dilPenalty = 0;
    if (shares0 && shares1 && shares1 > 0) {
      sharesDilution = Math.round(((shares0 - shares1) / shares1) * 100 * 10) / 10;
      if (sharesDilution > 10) dilPenalty = -10;
      else if (sharesDilution > 5) dilPenalty = -5;
      else if (sharesDilution > 2) dilPenalty = -2;
    }
    fund += dilPenalty;
    fund = Math.max(0, Math.min(MAX_SCORES.fund, fund));

    // ── 2. SENTIMENT (0-8 pts) ────────────────────────────────
    // FIX: reducido de 12 a 8 pts — señal ruidosa con keyword matching
    // FIX: mínimo 4 noticias para que cuente, si no → 0 (neutral)
    let sent = 0, newsSent = null, newsItems = [];
    if (Array.isArray(news) && news.length >= 4) {
      const recent = news.slice(0, 10);
      // Weighted keywords: high-confidence words score more, common/ambiguous words score less
      const POS_WEIGHTED = {
        // Strong signals (0.15)
        'beat earnings':0.15,'fda approval':0.15,'raised guidance':0.15,'record revenue':0.15,
        'strong results':0.15,'upgraded to buy':0.15,
        // Medium signals (0.10)
        'beat':0.10,'beats':0.10,'surge':0.10,'surges':0.10,'upgrade':0.10,'upgraded':0.10,
        'outperform':0.10,'bullish':0.10,'record':0.08,'exceeds':0.10,'raises guidance':0.12,
        // Weak signals (0.05) — common/ambiguous
        'growth':0.05,'profit':0.05,'gains':0.05,'rises':0.05,'jumps':0.05,
        'partnership':0.05,'deal':0.05,'launch':0.05,'launches':0.05,'award':0.05,
      };
      const NEG_WEIGHTED = {
        // Strong signals (0.15)
        'missed earnings':0.15,'lowered guidance':0.15,'downgraded to sell':0.15,
        'bankruptcy':0.15,'fraud':0.15,'sec investigation':0.15,
        // Medium signals (0.10)
        'miss':0.10,'misses':0.10,'downgrade':0.10,'downgraded':0.10,'underperform':0.10,
        'layoffs':0.10,'recall':0.10,'disappoints':0.10,'lawsuit':0.10,
        // Weak signals (0.05)
        'decline':0.05,'declines':0.05,'falls':0.05,'drops':0.05,'loss':0.05,
        'losses':0.05,'weak':0.05,'warning':0.05,'concern':0.05,'cut':0.05,'cuts':0.05,
      };
      let totalScore = 0;
      newsItems = recent.slice(0, 6).map(n => {
        const title = (n.title || '').toLowerCase();
        let posScore = 0, negScore = 0;
        for (const [w, weight] of Object.entries(POS_WEIGHTED)) { if (title.includes(w)) posScore += weight; }
        for (const [w, weight] of Object.entries(NEG_WEIGHTED)) { if (title.includes(w)) negScore += weight; }
        const net = posScore - negScore;
        const sentiment = net > 0.05 ? 'positive' : net < -0.05 ? 'negative' : 'neutral';
        totalScore += net;
        return { headline: (n.title || '').substring(0, 90), source: n.site || '', time: (n.publishedDate || '').substring(0, 10), sentiment };
      });
      // Normalize: totalScore typically ranges from -0.6 to +0.6
      newsSent = Math.max(-1, Math.min(1, totalScore / 0.4));
      sent = Math.min(MAX_SCORES.sent, Math.round(((newsSent + 1) / 2) * MAX_SCORES.sent));
    }

    // ── SEC 8-K BONUS ──────────────────────────────────────────────────────────
    // Recent 8-K filing = material corporate event → boost sentiment score
    let recent8K = null;
    const profileCik = p?.cik;
    if (profileCik) {
      recent8K = await getRecent8K(profileCik, sym);
      if (recent8K) {
        const boost = recent8K.daysAgo <= 2 ? 3 : recent8K.daysAgo <= 5 ? 2 : 1;
        sent = Math.min(MAX_SCORES.sent, sent + boost);
      }
    }

    // ── 3. ANALYST (0-15 pts) ─────────────────────────────────
    let analyst = 0, targetPrice = null, upside = null;
    let recMean = null, recBuy = 0, recHold = 0, recSell = 0;

    // Price target from /price-target-consensus
    if (pt) {
      targetPrice = pt.targetConsensus ? Math.round(pt.targetConsensus * 100) / 100 : null;
      if (targetPrice && price) {
        upside = Math.round(((targetPrice - price) / price) * 100);
        // Cap analyst scoring at 100% upside — beyond that targets are often stale
        const cappedUpside = Math.min(upside, 100);
        analyst += cappedUpside > 40 ? 8 : cappedUpside > 25 ? 6 : cappedUpside > 15 ? 4 : cappedUpside > 5 ? 2 : cappedUpside < -10 ? -2 : 0;
      }
      if (pt.targetHigh && pt.targetLow && price &&
          (pt.targetHigh - pt.targetLow) > 0 &&
          price <= pt.targetHigh) {
        const pct = (pt.targetHigh - price) / (pt.targetHigh - pt.targetLow);
        analyst += pct > 0.7 ? 7 : pct > 0.5 ? 5 : pct > 0.3 ? 3 : 1;
      }
    }

    // Buy/Hold/Sell consensus from /grades-consensus
    const rs = Array.isArray(ratings) ? ratings[0] : ratings;
    if (rs) {
      recBuy  = (rs.strongBuy || rs.strongBuyRatings || 0) + (rs.buy || rs.buyRatings || 0);
      recHold = rs.hold || rs.holdRatings || 0;
      recSell = (rs.sell || rs.sellRatings || 0) + (rs.strongSell || rs.strongSellRatings || 0);
      const total = recBuy + recHold + recSell;
      if (total > 0) {
        recMean = Math.round(((recBuy * 1 + recHold * 3 + recSell * 5) / total) * 10) / 10;
        analyst += recMean <= 1.5 ? 5 : recMean <= 2.2 ? 3 : recMean <= 2.8 ? 1 : 0;
        // Buy ratio: % of analysts with Buy/Strong Buy — more direct than recMean
        const buyRatio = total > 3 ? recBuy / total : 0;
        analyst += buyRatio > 0.75 ? 3 : buyRatio > 0.55 ? 2 : buyRatio > 0.40 ? 1 : 0;
      }
    }

    analyst = Math.min(MAX_SCORES.analyst, Math.max(0, analyst));

    // ── 4. MOMENTUM (0-17 pts) ────────────────────────────────
    // FIX: movimiento diario reducido de 4 a 2 pts máximo — muy ruidoso
    // FIX: penalización trampa momentum añadida
    let momentum = 0;
    const prev     = q?.previousClose;
    const yearHigh = q?.yearHigh;
    const yearLow  = q?.yearLow;
    const volume   = q?.volume || p?.volume;
    const avgVol   = p?.volAvg || p?.averageVolume || q?.avgVolume;

    const priceChange1D = prev && prev > 0 ? Math.round(((price - prev) / prev) * 100 * 10) / 10 : null;

    let pct52Low = null, pct52High = null;
    if (yearLow && yearHigh && price && yearHigh > yearLow) {
      pct52Low  = Math.round(((price - yearLow)  / yearLow)  * 100);
      pct52High = Math.round(((price - yearHigh) / yearHigh) * 100);
      const pos = (price - yearLow) / (yearHigh - yearLow);
      momentum += pos > 0.85 ? 8 : pos > 0.65 ? 6 : pos > 0.45 ? 4 : pos > 0.25 ? 2 : 0;
    }

    // Stale target detection: analyst targets set when price was much higher are unreliable
    // Tier 1: >50% below high + >150% upside → certainly stale, null out completely
    // Tier 2: >30% below high + >80% upside → likely stale, cap upside to reduce noise
    if (upside !== null && pct52High !== null) {
      if (pct52High < -50 && upside > 150) {
        upside = null;
        targetPrice = null;
      } else if (pct52High < -30 && upside > 80) {
        upside = Math.min(upside, 40); // cap at 40% — don't trust the full target
      }
    }

    // FIX: máximo 2 pts por movimiento diario (era 4 — demasiado ruidoso)
    if (priceChange1D != null) {
      momentum += priceChange1D > 3 ? 2 : priceChange1D > 1 ? 1 : priceChange1D < -3 ? -1 : 0;
    }

    const beta = p?.beta;
    if (beta) momentum += beta > 1.8 ? 3 : beta > 1.3 ? 2 : beta > 0.9 ? 1 : 0;

    const ma50  = q?.priceAvg50;
    const ma200 = q?.priceAvg200;
    // MA50 vs price
    if (ma50 && price > ma50 * 1.05) momentum += 2;
    else if (ma50 && price > ma50) momentum += 1;
    // MA200 — longer-term trend confirmation
    if (ma200 && price > ma200 * 1.05) momentum += 2;
    else if (ma200 && price > ma200) momentum += 1;
    // Golden cross: MA50 above MA200 — strong bull signal
    if (ma50 && ma200 && ma50 > ma200 * 1.02) momentum += 2;

    const volRatio = volume && avgVol && avgVol > 0 ? Math.round((volume / avgVol) * 10) / 10 : null;
    if (volRatio) momentum += volRatio > 3 ? 2 : volRatio > 2 ? 1 : 0;

    // FIX: penalización trampa — >40% bajo máximo + revenue negativo = caída estructural
    let momentumTrap = 0;
    if (pct52High !== null && pct52High < -40 && revGrowth !== null && revGrowth < 0) {
      momentumTrap = -5;
      momentum += momentumTrap;
    }

    momentum = Math.max(0, Math.min(MAX_SCORES.momentum, momentum));

    // ── 5. EARNINGS (0-15 pts) ────────────────────────────────
    let earPts = 0, epsHistory = [], streak = 0;
    let earningsDate = null, earningsDays = null;
    if (Array.isArray(earnings) && earnings.length > 0) {
      const past = earnings.filter(e => e.epsActual != null).slice(0, 4);
      const future = earnings.find(e => e.epsActual == null);
      epsHistory = past.map(e => ({
        q: (e.date || '').substring(0, 7),
        actual: e.epsActual ?? null,
        est: e.epsEstimated ?? null,
        surprise: e.epsActual != null && e.epsEstimated != null && Math.abs(e.epsEstimated) > 0.01
          ? Math.round(((e.epsActual - e.epsEstimated) / Math.abs(e.epsEstimated)) * 100) : 0
      }));
      streak = epsHistory.filter(e => (e.surprise || 0) > 0).length;
      earPts += streak >= 4 ? 8 : streak >= 3 ? 6 : streak >= 2 ? 4 : streak >= 1 ? 2 : 0;
      const avgSurprise = epsHistory.reduce((a, e) => a + (e.surprise || 0), 0) / Math.max(epsHistory.length, 1);
      earPts += avgSurprise > 15 ? 4 : avgSurprise > 8 ? 3 : avgSurprise > 2 ? 2 : 0;
      if (future?.date) {
        earningsDate = future.date;
        const diff = Math.round((new Date(earningsDate) - new Date()) / 86400000);
        earningsDays = diff >= 0 ? diff : null;
        if (earningsDays != null) earPts += earningsDays <= 7 ? 3 : earningsDays <= 20 ? 2 : earningsDays <= 45 ? 1 : 0;
      }
    }
    earPts = Math.min(MAX_SCORES.earPts, earPts);

    // ── 6. VOL/SHORT (0-11 pts) ───────────────────────────────
    let volShort = 0;
    if (volRatio) volShort += volRatio > 5 ? 5 : volRatio > 3 ? 4 : volRatio > 2 ? 3 : 0;

    // Short % float — try key-metrics first, then Finviz scraper
    const shortInterest = km?.shortInterest ?? p?.shortInterest ?? null;
    const floatShares   = km?.floatShares   ?? p?.floatShares   ?? null;
    let shortPct = null;
    if (shortInterest && floatShares && floatShares > 0) {
      shortPct = Math.round((shortInterest / floatShares) * 1000) / 10;
    }
    // Fallback: scrape Finviz (free, updates bi-monthly)
    // Fetch for stocks with notable volume OR positive momentum — broader coverage
    if (shortPct == null && ((volRatio > 1.5 && priceChange1D > 0) || (momentum >= 8))) {
      shortPct = await getShortFloat(sym);
    }
    if (shortPct != null) volShort += shortPct > 20 ? 5 : shortPct > 15 ? 4 : shortPct > 10 ? 2 : 0;
    volShort = Math.min(MAX_SCORES.volShort, volShort);

    // ── 7. INSIDER (0-8 pts) ──────────────────────────────────
    // FIX: corregido bug — 0 pts cuando no hay actividad (era 2 erróneamente)
    // FIX: penaliza ventas netas con -2 pts
    let insiderScore = 0, insiderChange = null, mspr = null;
    let freshInsiderDays = null; // days since most recent insider buy
    let freshInsiderValue = 0;   // $ value of buys in last 7 days

    if (insider && (insider.buys > 0 || insider.sells > 0)) {
      insiderChange = insider.netChange;
      const totalTx = insider.buys + insider.sells;
      mspr = totalTx > 0 ? Math.round((insider.netChange / totalTx) * 100) / 100 : null;

      // Calculate recency from transaction dates
      const today = Date.now();
      const buyTxs = (insider.transactions || []).filter(t => t.txCode === 'P' && t.date);
      if (buyTxs.length > 0) {
        const sortedDates = buyTxs.map(t => new Date(t.date).getTime()).sort((a,b) => b-a);
        freshInsiderDays = Math.floor((today - sortedDates[0]) / 86400000);
        freshInsiderValue = buyTxs
          .filter(t => (today - new Date(t.date).getTime()) < 7 * 86400000)
          .reduce((s, t) => s + (t.value || 0), 0);
      }

      // Base score by number of buys
      if (insider.buys > 3)        insiderScore = 5;
      else if (insider.buys > 1)   insiderScore = 4;
      else if (insider.buys === 1) insiderScore = 3;
      else if (insider.sells > 2)  insiderScore = -2; // FIX: penaliza ventas netas
      else                         insiderScore = 0;  // FIX: era 2, ahora 0

      // Recency bonus: recent buys are more meaningful (additive, not multiplicative)
      if (freshInsiderDays !== null && insider.buys > 0) {
        insiderScore += freshInsiderDays <= 7 ? 2 : freshInsiderDays <= 30 ? 1 : 0;
      }

      // Bonus por volumen de compra significativo
      if (insider.totalBuyValue > 1000000) insiderScore += 2;
      else if (insider.totalBuyValue > 500000) insiderScore += 1;
    }
    // Sin actividad insider → 0 (neutral, no penaliza ni bonifica)
    insiderScore = Math.max(-2, Math.min(MAX_SCORES.insider, insiderScore));

    // ── FLAGS ─────────────────────────────────────────────────
    const flags = [];
    if (volRatio && volRatio > 3)                             flags.push({ label: '⚡ VOL SPIKE',   color: '#00b4ff' });
    if (insider?.buys > 0 && insider?.netChange > 0)          flags.push({ label: '👤 INSIDER BUY', color: '#00ff94' });
    if (insider?.totalBuyValue > 1000000)                     flags.push({ label: '💼 BIG INSIDER',  color: '#00ff94' });
    if (freshInsiderDays !== null && freshInsiderDays <= 7 && freshInsiderValue > 50000) flags.push({ label: '🔥 FRESH INSIDER', color: '#ff7040' });
    if (recent8K && recent8K.daysAgo <= 3)                                                flags.push({ label: '📋 8-K EVENT',     color: '#bf5fff' });
    if (streak >= 3)                                          flags.push({ label: '📈 EPS STREAK',  color: '#ffcc00' });
    if (fcf != null && fcf > 0 && fcf1 != null && fcf1 > 0)  flags.push({ label: '💰 FCF+',        color: '#00e5cc' });
    if (ebitdaMargin != null && ebitdaMargin > 25)            flags.push({ label: '💎 EBITDA+',     color: '#bf5fff' });
    if (epsGrowth != null && epsGrowth > 25)                  flags.push({ label: '🚀 EPS GROWTH',  color: '#ff7040' });
    if (upside != null && upside > 35)                        flags.push({ label: '🎯 HIGH UPSIDE', color: '#ffcc00' });
    if (ma50 && price > ma50 * 1.1)                           flags.push({ label: '📊 ABOVE MA50',  color: '#00b4ff' });
    if (momentumTrap < 0)                                     flags.push({ label: '⚠ TREND TRAP',  color: '#ff2d55' });

    // ── TOTAL & SIGNAL ────────────────────────────────────────
    // FIX: normalizado a 0-100 para consistencia con umbrales
    const rawTotal = fund + sent + analyst + momentum + earPts + volShort + insiderScore;
    // Dynamic normalization: if shortPct is null, volShort only reflects volume (no short bonus)
    // Remove the short squeeze pts (max 5) from denominator so scores aren't artificially depressed
    const effectiveMax = shortPct == null
      ? MAX_TOTAL - 5   // subtract short squeeze bonus pts (not volume pts)
      : MAX_TOTAL;
    const total = Math.max(0, Math.min(100, Math.round((rawTotal / effectiveMax) * 100)));

    const signal = total >= 68 ? 'STRONG BUY'
                 : total >= 52 ? 'INTERESTING'
                 : total >= 33 ? 'WATCH' : 'WEAK';

    return {
      sym, sector, signal, total,
      companyName: p?.companyName || baseData?.companyName || sym,
      website: p?.website || null,
      fund, sent, analyst, momentum, earPts, volShort, insiderScore,
      price: Math.round(price * 100) / 100,
      prevClose: prev ? Math.round(prev * 100) / 100 : null,
      priceChange1D, lo52: yearLow || null, hi52: yearHigh || null,
      pct52Low, pct52High, cap,
      beta: beta ? Math.round(beta * 1000) / 1000 : null,
      volRatio,
      pe: pe ? Math.round(pe * 10) / 10 : null,
      pb: pb ? Math.round(pb * 10) / 10 : null,
      de: de != null ? Math.round(de * 100) / 100 : null,
      roe: roe != null ? Math.round(roe * 10) / 10 : null,
      roa: km?.returnOnAssetsTTM != null ? Math.round(km.returnOnAssetsTTM * 1000) / 10 : null,
      grossMargin: grossMargin != null ? Math.round(grossMargin * 10) / 10 : null,
      ebitdaMargin: ebitdaMargin != null ? Math.round(ebitdaMargin * 10) / 10 : null,
      currentRatio: cr ? Math.round(cr * 100) / 100 : null,
      netDebtEbitda: netDebtEbitda != null ? Math.round(netDebtEbitda * 10) / 10 : null,
      fcf: fcf || null, revGrowth, epsGrowth,
      sharesDilution, dilPenalty, debtPenalty,
      targetPrice, upside, recMean, recBuy, recHold, recSell,
      buyRatio: (recBuy + recHold + recSell) > 3
        ? Math.round((recBuy / (recBuy + recHold + recSell)) * 100) : null,
      ma50: ma50 ? Math.round(ma50 * 100) / 100 : null,
      ma200: ma200 ? Math.round(ma200 * 100) / 100 : null,
      goldenCross: (ma50 && ma200 && ma50 > ma200) ? true : false,
      shortPct, mspr, insiderChange,
      freshInsiderDays: freshInsiderDays,
      freshInsiderValue: freshInsiderValue > 0 ? Math.round(freshInsiderValue) : null,
      relStrength: null, // filled after sector median calculation
      recent8K: recent8K ? { date: recent8K.date, daysAgo: recent8K.daysAgo } : null,
      insiderData: insider ? {
        buys: insider.buys, sells: insider.sells, netChange: insider.netChange,
        totalBuyValue: insider.totalBuyValue, totalSellValue: insider.totalSellValue,
        transactions: insider.transactions, insiders: insider.insiders,
      } : null,
      earningsDate, earningsDays, streak, epsHistory,
      newsSent: newsSent != null ? Math.round(newsSent * 100) / 100 : null,
      newsItems, flags,
    };

  } catch (e) {
    console.warn(`  ⚠ ${sym}: ${e.message}`);
    return null;
  }
}

// ── MAIN ──────────────────────────────────────────────────────

// ── SAVE PICKS TO HISTORY ─────────────────────────────────────
async function savePicksHistory(sb, picks, scanDate) {
  try {
    const rows = picks.map(p => ({
      scan_date:      scanDate,
      sym:            p.sym,
      company_name:   p.companyName || p.sym,
      sector:         p.sector || null,
      pick_type:      p.pickType || null,
      score:          p.total || null,
      entry_price:    p.price || null,
      ai_summary:     p.aiSummary || null,
      perf_1d:        null,
      perf_5d:        null,
      perf_1w:        null,
      perf_30d:       null,
      perf_60d:       null,
      perf_90d:       null,
      russell_30d:    null,
      russell_60d:    null,
      russell_90d:    null,
      beat_30d:       null,
      beat_60d:       null,
      beat_90d:       null,
      // ── Signal breakdown for ML feedback ──
      score_fund:     p.fund     ?? null,
      score_sent:     p.sent     ?? null,
      score_analyst:  p.analyst  ?? null,
      score_momentum: p.momentum ?? null,
      score_earnings: p.earPts       ?? null,
      score_volume:   p.volShort     ?? null,
      score_insider:  p.insiderScore ?? null,
      flags_fired:    Array.isArray(p.flags) ? p.flags.map(f => f.label) : [],
      confluence:     p.confluence ?? null,
      rel_strength:   p.relStrength ?? null,
      vol_ratio:      p.volRatio ?? null,
      fresh_insider:  p.freshInsiderDays !== null && p.freshInsiderDays <= 7,
      earnings_days:  p.earningsDays ?? null,
    }));

    const { error } = await sb
      .from('picks_history')
      .upsert(rows, { onConflict: 'scan_date,sym' });

    if (error) console.warn('⚠ picks_history save error:', error.message);
    else console.log(`✅ ${rows.length} picks saved to picks_history (with signal breakdown)`);
  } catch (e) {
    console.warn('⚠ savePicksHistory failed:', e.message);
  }
}

// ── UPDATE PAST PICKS PERFORMANCE ─────────────────────────────
// Called each day to fill perf columns and Russell benchmark.
// Fetches its own current prices for all symbols in picks_history.
async function updatePicksPerformance(sb) {
  try {
    const today = new Date();
    console.log('\n📊 Phase 4: Updating past picks performance...');

    // Load all picks with incomplete performance data (no limit — process all)
    const { data: rows, error } = await sb
      .from('picks_history')
      .select('id, sym, scan_date, entry_price, perf_1d, perf_5d, perf_1w, perf_30d, perf_60d, perf_90d, beat_30d, beat_60d, beat_90d')
      .or('perf_1d.is.null,perf_5d.is.null,perf_1w.is.null,perf_30d.is.null,perf_60d.is.null,perf_90d.is.null')
      .order('scan_date', { ascending: false })
      .limit(500);

    if (error || !rows?.length) {
      console.log('   No picks pending performance update');
      return;
    }

    console.log(`   ${rows.length} picks need performance updates`);

    // ── Fetch current prices for all unique symbols in pending picks ──
    const uniqueSyms = [...new Set(rows.map(r => r.sym))];
    const currentPrices = {};

    // Batch fetch quotes (FMP supports comma-separated symbols)
    for (let i = 0; i < uniqueSyms.length; i += 50) {
      const batch = uniqueSyms.slice(i, i + 50).join(',');
      const quotes = await fmp(`/quote/${batch}`);
      if (Array.isArray(quotes)) {
        quotes.forEach(q => { if (q?.symbol && q?.price) currentPrices[q.symbol] = q.price; });
      }
      if (i + 50 < uniqueSyms.length) await sleep(200);
    }

    console.log(`   Fetched prices for ${Object.keys(currentPrices).length}/${uniqueSyms.length} symbols`);

    // ── Fetch Russell 2000 (IWM) for benchmark ──
    let russellPrice = null;
    try {
      const iwmData = await fmp(`/quote/IWM`);
      russellPrice = iwmData?.[0]?.price ?? null;
    } catch(e) {}

    // Get Russell historical prices (120 trading days ≈ 6 months)
    const russellHistory = {};
    try {
      const hist = await fmp(`/historical-price-full/IWM?timeseries=120`);
      if (hist?.historical) {
        hist.historical.forEach(d => { russellHistory[d.date] = d.close; });
      }
    } catch(e) {}

    // Helper: find closest trading day price (handles weekends/holidays)
    function findRussellPrice(dateStr) {
      if (russellHistory[dateStr]) return russellHistory[dateStr];
      // Try previous 5 days to find nearest trading day
      const d = new Date(dateStr);
      for (let offset = 1; offset <= 5; offset++) {
        const prev = new Date(d);
        prev.setDate(prev.getDate() - offset);
        const key = prev.toISOString().substring(0, 10);
        if (russellHistory[key]) return russellHistory[key];
      }
      return null;
    }

    // ── Process each pick ──
    const updates = [];
    const WINDOWS = [
      { field: 'perf_1d',  days: 1 },
      { field: 'perf_5d',  days: 5 },
      { field: 'perf_1w',  days: 7 },
      { field: 'perf_30d', days: 30,  benchmark: true },
      { field: 'perf_60d', days: 60,  benchmark: true },
      { field: 'perf_90d', days: 90,  benchmark: true },
    ];

    for (const row of rows) {
      const currentPrice = currentPrices[row.sym];
      if (!currentPrice || !row.entry_price || row.entry_price <= 0) continue;

      const perf = pct(row.entry_price, currentPrice);
      if (perf === null) continue;

      const scanDate = new Date(row.scan_date);
      const daysAgo  = Math.floor((today - scanDate) / 86400000);

      const update = { id: row.id };

      for (const w of WINDOWS) {
        if (row[w.field] !== null) continue; // already filled
        if (daysAgo < w.days) continue;      // not enough time elapsed

        update[w.field] = perf;

        // Add Russell benchmark for 30d/60d/90d windows
        if (w.benchmark) {
          const scanDateStr = row.scan_date.substring(0, 10);
          const russellEntry = findRussellPrice(scanDateStr);
          const russellPerf = russellEntry && russellPrice
            ? pct(russellEntry, russellPrice)
            : null;

          const daysField = w.field.replace('perf_', '');
          update[`russell_${daysField}`] = russellPerf;
          update[`beat_${daysField}`] = russellPerf !== null ? perf > russellPerf : null;
        }
      }

      if (Object.keys(update).length > 1) updates.push(update);
    }

    // ── Write updates to Supabase ──
    if (updates.length > 0) {
      for (const upd of updates) {
        const { id, ...fields } = upd;
        await sb.from('picks_history').update(fields).eq('id', id);
      }
      console.log(`   ✅ Updated performance for ${updates.length} past picks`);

      // Log summary stats to feedback_log for ML analysis
      await logFeedbackSummary(sb);
    } else {
      console.log('   No updates needed (all within time windows)');
    }
  } catch (e) {
    console.warn('⚠ updatePicksPerformance failed:', e.message);
  }
}

// Helper: % change between two prices (2 decimal precision)
function pct(entry, current) {
  if (!entry || entry <= 0 || !current || current <= 0) return null;
  return Math.round(((current - entry) / entry) * 10000) / 100;
}

// ── LOG FEEDBACK SUMMARY ──────────────────────────────────────
// After updating performance, log aggregate stats for ML analysis
async function logFeedbackSummary(sb) {
  try {
    // Get picks with 30d data
    const { data: rows30 } = await sb
      .from('picks_history')
      .select('pick_type, score_fund, score_sent, score_analyst, score_momentum, score_earnings, score_volume, score_insider, confluence, flags_fired, perf_30d, beat_30d, perf_60d, beat_60d')
      .not('perf_30d', 'is', null);

    if (!rows30?.length || rows30.length < 10) return; // need min 10 picks

    const total = rows30.length;
    const beat30 = rows30.filter(r => r.beat_30d === true).length;
    const beat60 = rows30.filter(r => r.beat_60d === true).length;
    const winRate30 = Math.round((beat30 / total) * 100);
    const winRate60 = rows30.filter(r => r.beat_60d !== null).length > 0
      ? Math.round((beat60 / rows30.filter(r => r.beat_60d !== null).length) * 100)
      : null;

    // Signal performance breakdown
    const signalTypes = ['catalyst','volume','insider','fresh_insider','squeeze','breakout','momentum'];
    const signalStats = {};
    signalTypes.forEach(type => {
      const typePicks = rows30.filter(r => r.pick_type === type && r.beat_30d !== null);
      if (typePicks.length > 0) {
        signalStats[type] = {
          count: typePicks.length,
          win_rate: Math.round((typePicks.filter(r => r.beat_30d).length / typePicks.length) * 100),
          avg_30d: Math.round((typePicks.reduce((s,r) => s + (r.perf_30d||0), 0) / typePicks.length) * 10) / 10,
        };
      }
    });

    // Get current weights
    const { data: weights } = await sb.from('scoring_weights').select('*').eq('id', 'active').single();

    // Update win rates in scoring_weights
    await sb.from('scoring_weights').update({
      trained_on:   total,
      win_rate_30d: winRate30,
      win_rate_60d: winRate60,
      updated_at:   new Date().toISOString(),
    }).eq('id', 'active');

    // Log to feedback_log
    await sb.from('feedback_log').insert({
      picks_count:  total,
      win_rate_30d: winRate30,
      win_rate_60d: winRate60,
      old_weights:  weights ? JSON.stringify(weights) : null,
      top_signals:  JSON.stringify(signalStats),
      notes:        `Auto-log: ${total} picks tracked, ${winRate30}% beat Russell at 30d`,
      approved:     false,
    });

    console.log(`📊 Feedback logged: ${total} picks | 30d win rate: ${winRate30}% | Signal stats: ${Object.keys(signalStats).join(', ')}`);
  } catch(e) {
    console.warn('⚠ logFeedbackSummary failed:', e.message);
  }
}

async function main() {
  const t0 = Date.now();
  console.log('🦅 StockRaptor Daily Scan v3 starting...');

  // ── Load scoring weights from Supabase (replaces hardcoded defaults) ──
  console.log('\n⚖️  Loading scoring weights...');
  await loadScoringWeights(sb);

  const universe = await getUniverse();
  const tickers = [...universe.keys()];

  console.log('📋 Loading insider cache...');
  let insiderCache = {};
  try {
    const { data: icData } = await sb.from('insider_cache').select('*');
    if (icData) {
      icData.forEach(r => { insiderCache[r.symbol] = r; });
      console.log(`   ${icData.length} symbols with insider data`);
    }
  } catch(e) {
    console.warn('  ⚠ Could not load insider cache:', e.message);
  }

  console.log(`\n🔬 Phase 2: Analyzing ${tickers.length} tickers...`);

  const results = [];
  let errors = 0;

  // Track which symbols failed analysis so we can retain their previous data
  const failedSyms = new Set();
  for (let i = 0; i < tickers.length; i++) {
    const sym = tickers[i];
    if (i % 10 === 0) process.stdout.write(`\r[${i+1}/${tickers.length}] ${Math.round((i/tickers.length)*100)}% | ${Math.round((Date.now()-t0)/1000)}s | ${results.length} scored`);
    const r = await analyzeTicker(sym, universe.get(sym), insiderCache);
    if (r) results.push(r);
    else { errors++; failedSyms.add(sym); }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);

  // ── MERGE with previous results: retain companies missing today for up to 3 days ──
  console.log('\n🔄 Merging with previous scan results...');
  const todayScanDate = new Date().toISOString().substring(0, 10);
  const todaySyms = new Set(results.map(r => r.sym));
  let retained = 0;

  try {
    const { data: prevCache } = await sb.from('scan_cache')
      .select('results, scan_date').eq('id', 'daily').single();

    if (prevCache?.results && Array.isArray(prevCache.results)) {
      for (const old of prevCache.results) {
        if (todaySyms.has(old.sym)) continue; // already in today's results

        // Calculate how many days since this company was last freshly scanned
        const lastSeen = old._lastSeen || prevCache.scan_date || todayScanDate;
        const daysSinceLastSeen = Math.floor(
          (new Date(todayScanDate) - new Date(lastSeen)) / 86400000
        );

        // Keep for up to 3 days, then drop
        // Also retain companies that were in today's universe but failed API analysis
        const wasInUniverse = failedSyms.has(old.sym);
        const maxStaleDays = wasInUniverse ? 5 : 3; // more patience for known-good companies

        if (daysSinceLastSeen <= maxStaleDays) {
          old._stale = true;
          old._lastSeen = old._lastSeen || prevCache.scan_date;
          old._staleDays = daysSinceLastSeen + (wasInUniverse ? 0 : 1);
          old._staleReason = wasInUniverse ? 'api_error' : 'not_in_universe';
          results.push(old);
          todaySyms.add(old.sym);
          retained++;
        }
      }
    }
  } catch (e) {
    console.warn('   ⚠ Could not load previous results for merge:', e.message);
  }

  if (retained > 0) console.log(`   ✅ Retained ${retained} companies from previous days`);

  results.sort((a, b) => b.total - a.total);

  const signals = results.reduce((acc, r) => { acc[r.signal] = (acc[r.signal]||0)+1; return acc; }, {});
  const freshCount = results.filter(r => !r._stale).length;
  const staleCount = results.filter(r => r._stale).length;
  console.log(`\n✅ Done in ${elapsed}s | ${freshCount} fresh + ${staleCount} retained = ${results.length} total | ${errors} errors`);
  console.log(`   Signals:`, signals);

  const { error } = await sb.from('scan_cache').upsert({
    id: 'daily',
    scan_date: todayScanDate,
    scanned_at: new Date().toISOString(),
    results, total_count: results.length, errors,
  });

  if (error) { console.error('❌ Supabase:', error.message); process.exit(1); }

  console.log(`\n🏆 Top 10:`);
  results.slice(0, 10).forEach((r, i) =>
    console.log(`   ${i+1}. ${r.sym.padEnd(6)} ${r.signal.padEnd(12)} score:${r.total}`)
  );

  // ── PHASE 3: DELTA RANKING + TOP MOVERS ──────────────────
  console.log('\n📈 Phase 3: Calculating rank deltas...');

  // Load yesterday's ranking from scan_history
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().substring(0, 10);

  let prevRanks = {};
  try {
    const { data: hist } = await sb
      .from('scan_history')
      .select('rankings')
      .eq('scan_date', yesterdayStr)
      .single();
    if (hist?.rankings) {
      hist.rankings.forEach((sym, idx) => { prevRanks[sym] = idx + 1; });
      console.log(`   Loaded ${Object.keys(prevRanks).length} previous ranks from ${yesterdayStr}`);
    }
  } catch(e) {
    console.warn('   No previous ranking found — first run or new day');
  }

  // Calculate delta for each result and find top movers
  const todayRankings = results.map(r => r.sym);
  const hasPrevHistory = Object.keys(prevRanks).length > 0;
  results.forEach((r, idx) => {
    const todayRank = idx + 1;
    const prevRank  = prevRanks[r.sym];
    r.rankToday = todayRank;
    r.rankDelta = prevRank != null ? prevRank - todayRank : null; // positive = moved up
    r.rankNew   = hasPrevHistory && prevRank == null; // only mark NEW if we have history but sym is absent
  });

  // Save today's ranking to scan_history
  const { error: histError } = await sb.from('scan_history').upsert({
    scan_date: new Date().toISOString().substring(0, 10),
    scanned_at: new Date().toISOString(),
    rankings: todayRankings,
    total_count: results.length,
  });
  if (histError) console.warn('⚠ scan_history save failed:', histError.message);
  else console.log(`   ✅ Saved today's rankings to scan_history`);

  // Top 10 movers (biggest rank increase)
  const topMovers = results
    .filter(r => r.rankDelta != null && r.rankDelta >= 3)
    .sort((a, b) => b.rankDelta - a.rankDelta)
    .slice(0, 10);

  console.log(`   Top movers: ${topMovers.length} companies moved up 3+ positions`);

  // Generate AI summaries for top movers
  if (topMovers.length > 0 && process.env.ANTHROPIC_API_KEY) {
    console.log('   Generating mover AI summaries...');
    for (const mover of topMovers) {
      mover.moverSummary = await generateMoverSummary(mover);
      process.stdout.write('.');
      await sleep(300);
    }
    console.log(' done');
  }

  // Update scan_cache with deltas + top movers included
  const { error: cacheError2 } = await sb.from('scan_cache').upsert({
    id: 'daily',
    scan_date: todayScanDate,
    scanned_at: new Date().toISOString(),
    results, total_count: results.length, errors,
    top_movers: topMovers.map(r => ({
      sym: r.sym, companyName: r.companyName, sector: r.sector,
      rankDelta: r.rankDelta, rankToday: r.rankToday,
      total: r.total, signal: r.signal,
      price: r.price, priceChange1D: r.priceChange1D,
      volRatio: r.volRatio, earningsDays: r.earningsDays,
      revenueGrowth: r.revGrowth ?? r.revenueGrowth,
      moverSummary: r.moverSummary || null,
    })),
  });
  if (cacheError2) console.warn('⚠ scan_cache update with top_movers failed:', cacheError2.message);

  console.log(`\n🔺 Top 10 Movers:`);
  topMovers.forEach((r, i) =>
    console.log(`   ${i+1}. ${r.sym.padEnd(6)} ▲${r.rankDelta} (now #${r.rankToday})`)
  );

  // ── RELATIVE STRENGTH vs SECTOR ───────────────────────────────────────────
  // Compare each stock's 1D return to its sector median — stocks beating their
  // sector are more interesting picks regardless of absolute price movement
  const sectorReturns = {};
  results.forEach(r => {
    if (r.priceChange1D === null) return;
    if (!sectorReturns[r.sector]) sectorReturns[r.sector] = [];
    sectorReturns[r.sector].push(r.priceChange1D);
  });
  const sectorMedians = {};
  Object.entries(sectorReturns).forEach(([sec, vals]) => {
    const sorted = [...vals].sort((a, b) => a - b);
    sectorMedians[sec] = sorted[Math.floor(sorted.length / 2)];
  });
  results.forEach(r => {
    const median = sectorMedians[r.sector] ?? 0;
    r.relStrength = r.priceChange1D !== null
      ? Math.round((r.priceChange1D - median) * 10) / 10
      : null;
  });
  console.log(`   ✅ Sector medians: ${Object.entries(sectorMedians).map(([s,v])=>`${s}:${v>0?'+':''}${v}%`).join(' | ')}`);

  // ── PHASE 3: WEEKLY PICKS + AI SUMMARIES ──────────────────
  // Picks regenerate once per week (Monday). Other days skip unless forced.
  const todayUTC  = new Date();
  const dayOfWeek = todayUTC.getUTCDay(); // 0=Sun,1=Mon...5=Fri
  const scanDateStr = todayUTC.toISOString().substring(0, 10);

  // Calculate Monday of current week as the week_of key
  const daysFromMon = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(todayUTC);
  monday.setUTCDate(todayUTC.getUTCDate() - daysFromMon);
  const weekOf = monday.toISOString().substring(0, 10);

  // Check if we already have picks for this week
  const { data: existingPicks } = await sb
    .from('picks_cache')
    .select('week_of, total_count')
    .eq('id', 'weekly')
    .single();

  const alreadyThisWeek = existingPicks?.week_of === weekOf;

  if (alreadyThisWeek && !process.env.FORCE_PICKS) {
    console.log(`\n🎯 Phase 3: Weekly picks already generated for week of ${weekOf} — skipping.`);
    console.log('   Set FORCE_PICKS=1 env var to regenerate.');
  } else {
    console.log(`\n⚖️  Active weights: fund:${MAX_SCORES.fund} sent:${MAX_SCORES.sent} analyst:${MAX_SCORES.analyst} momentum:${MAX_SCORES.momentum} earPts:${MAX_SCORES.earPts} insider:${MAX_SCORES.insider}`);
    console.log(`\n🎯 Phase 3: Generating weekly picks (week of ${weekOf})...`);

    // Get last week's picks to avoid repeating same companies
    const { data: lastWeekData } = await sb
      .from('picks_cache')
      .select('picks')
      .eq('id', 'weekly_prev')
      .single();
    const lastWeekSyms = new Set((lastWeekData?.picks || []).map(p => p.sym));

    const picks = selectPicks(results, lastWeekSyms);
    console.log(`   ${picks.length} picks selected`);

    if (picks.length > 0 && process.env.ANTHROPIC_API_KEY) {
      console.log('   Generating AI summaries...');
      for (const pick of picks) {
        pick.aiSummary = await generateAISummary(pick);
        process.stdout.write('.');
        await sleep(300);
      }
      console.log(' done');
    }

    // Archive current picks as previous week before overwriting
    if (existingPicks?.total_count > 0) {
      const { data: currentPicks } = await sb
        .from('picks_cache').select('picks').eq('id', 'weekly').single();
      if (currentPicks?.picks) {
        await sb.from('picks_cache').upsert({
          id: 'weekly_prev',
          week_of: existingPicks.week_of,
          picks: currentPicks.picks,
          generated_at: new Date().toISOString(),
        });
      }
    }

    // Save new weekly picks
    const { error: picksError } = await sb.from('picks_cache').upsert({
      id: 'weekly',
      week_of: weekOf,
      scan_date: scanDateStr,
      generated_at: new Date().toISOString(),
      picks,
      total_count: picks.length,
    });

    // Keep 'daily' id for backwards compatibility with old picks.html
    await sb.from('picks_cache').upsert({
      id: 'daily',
      week_of: weekOf,
      scan_date: scanDateStr,
      generated_at: new Date().toISOString(),
      picks,
      total_count: picks.length,
    });

    if (picksError) console.warn('⚠ picks_cache save failed:', picksError.message);
    else console.log(`✅ ${picks.length} weekly picks saved (week of ${weekOf})`);

    await savePicksHistory(sb, picks, scanDateStr);
  }

  // ── PHASE 4: UPDATE PAST PICKS PERFORMANCE ──────────────
  // Runs every day (not just on pick generation days) to fill
  // perf_1d, perf_5d, perf_1w, perf_30d, perf_60d, perf_90d
  await updatePicksPerformance(sb);

  const totalElapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n🏁 StockRaptor Daily Scan complete in ${totalElapsed}s`);
}

// ── SELECT TOP PICKS ──────────────────────────────────────
// v4: sector diversification, balanced slots, tighter quality floors
// Max 4 picks, max 2 per sector, all categories require fund >= 10
function selectPicks(results, excludeSyms = new Set()) {
  const picks = [];
  const used  = new Set([...excludeSyms]); // exclude last week's picks
  const sectorCount = {}; // track picks per sector
  const MAX_PER_SECTOR = 2;

  // Never select stale stocks as picks — their data is outdated
  const freshResults = results.filter(r => !r._stale);

  const norm = freshResults.map(r => {
    const revGrowth = r.revenueGrowth ?? r.revGrowth ?? null;

    // ── Weighted confluence score: higher-conviction signals worth more ──
    let confluence = 0;
    if (r.flags?.some(f => f.label?.includes('INSIDER')))  confluence += 2;   // insider buy (high conviction)
    if (r.fund >= 20)                                      confluence += 2;   // strong fundamentals
    if (revGrowth > 15)                                    confluence += 1.5; // revenue growing
    if (r.streak >= 3)                                     confluence += 1.5; // EPS beat streak
    if (r.upside > 25)                                     confluence += 1;   // analyst upside
    if (r.volRatio > 2)                                    confluence += 1;   // unusual volume
    if (r.relStrength > 2)                                 confluence += 1;   // beating sector
    if (r.momentum >= 12)                                  confluence += 1;   // strong momentum
    if (r.earningsDays != null && r.earningsDays <= 20)    confluence += 0.5; // earnings soon
    if (r.priceChange1D > 2)                               confluence += 0.5; // price up today (noisy)

    // ── Trend health: tighter filter ──
    // Stocks >35% below 52w high are structurally broken regardless of today's move
    const brokenTrend = r.pct52High != null && r.pct52High < -35;

    return {
      ...r,
      revGrowth,
      revenueGrowth: revGrowth,
      epsHistory: Array.isArray(r.epsHistory) ? r.epsHistory : [],
      flags: Array.isArray(r.flags) ? r.flags : [],
      confluence,
      brokenTrend,
    };
  }).filter(r => !r.brokenTrend); // drop broken-trend stocks globally

  // ── Helper: fill slots with sector diversification ──
  function fillSlots(filterFn, sortFn, limit, pickType) {
    const candidates = norm
      .filter(r => filterFn(r) && !used.has(r.sym))
      .sort(sortFn);

    let added = 0;
    for (const r of candidates) {
      if (added >= limit) break;
      const sec = r.sector || 'Unknown';
      if ((sectorCount[sec] || 0) >= MAX_PER_SECTOR) continue; // sector cap
      r.pickType = pickType;
      picks.push(r);
      used.add(r.sym);
      sectorCount[sec] = (sectorCount[sec] || 0) + 1;
      added++;
    }
  }

  // Global minimum: all categories require fund >= 10 and confluence >= 2
  const BASE_FILTER = r => r.fund >= 10 && r.confluence >= 2;

  // ── 1. EARNINGS CATALYST (1 slot — was 2, rebalanced) ───
  fillSlots(
    r => BASE_FILTER(r) && r.earningsDays != null && r.earningsDays <= 14
      && r.streak >= 2 && r.total >= 50 && r.fund >= 14,
    (a, b) => (b.streak * 8 + b.total + b.confluence * 4)
            - (a.streak * 8 + a.total + a.confluence * 4),
    1, 'catalyst'
  );

  // ── 2. INSIDER BUYING (fresh or recent) ──────────────────
  // Moved up: insider buying is highest-conviction signal
  fillSlots(
    r => BASE_FILTER(r) && r.freshInsiderDays !== null && r.freshInsiderDays <= 14
      && r.freshInsiderValue > 50000 && r.total >= 48,
    (a, b) => {
      const sa = (a.freshInsiderValue||0)/1000 + a.total + a.confluence * 4;
      const sb = (b.freshInsiderValue||0)/1000 + b.total + b.confluence * 4;
      return sb - sa;
    },
    1, 'insider'
  );

  // ── 3. VOLUME ANOMALY ────────────────────────────────────
  fillSlots(
    r => BASE_FILTER(r) && r.volRatio > 2.5 && r.priceChange1D > 0
      && r.total >= 50 && r.fund >= 12,
    (a, b) => (b.volRatio * 2 + b.total + b.confluence * 5 + (b.relStrength||0))
            - (a.volRatio * 2 + a.total + a.confluence * 5 + (a.relStrength||0)),
    1, 'volume'
  );

  // ── 4. SHORT SQUEEZE — real data only, no proxy ──────────
  // Only select when we have actual short float data > 20%
  fillSlots(
    r => BASE_FILTER(r) && r.shortPct > 20 && r.priceChange1D > 0
      && r.volRatio > 1.5 && r.total >= 48,
    (a, b) => {
      const scoreA = a.shortPct * 2 + a.volRatio * 2 + a.total + a.confluence * 4;
      const scoreB = b.shortPct * 2 + b.volRatio * 2 + b.total + b.confluence * 4;
      return scoreB - scoreA;
    },
    1, 'squeeze'
  );

  // ── 5. TECHNICAL BREAKOUT ───────────────────────────────
  fillSlots(
    r => BASE_FILTER(r) && r.goldenCross && r.pct52Low > 25
      && r.priceChange1D >= 0 && r.total >= 50 && r.fund >= 12,
    (a, b) => (b.pct52Low + b.total + b.confluence * 5)
            - (a.pct52Low + a.total + a.confluence * 5),
    1, 'breakout'
  );

  // ── 6. MOMENTUM BREAKOUT ─────────────────────────────────
  fillSlots(
    r => BASE_FILTER(r) && r.momentum >= 11 && r.fund >= 14
      && r.total >= 55 && r.priceChange1D >= 0,
    (a, b) => (b.momentum + b.fund + b.confluence * 4)
            - (a.momentum + a.fund + a.confluence * 4),
    1, 'momentum'
  );

  // ── 7. FILL remaining with best multi-signal stocks ──────
  const target = 4;
  if (picks.length < target) {
    fillSlots(
      r => r.total >= 52 && r.confluence >= 3 && r.fund >= 12
        && r.priceChange1D >= 0,
      (a, b) => (b.total + b.confluence * 6) - (a.total + a.confluence * 6),
      target - picks.length, 'confluence'
    );
  }

  // Final quality check: remove any with bad price action
  return picks
    .filter(p => p.priceChange1D === null || p.priceChange1D > -5)
    .slice(0, 4);
}

// ── GENERATE MOVER SUMMARY ────────────────────────────────
async function generateMoverSummary(p) {
  try {
    const reasons = [];
    if (p.volRatio > 2)        reasons.push(`volume ${p.volRatio}x above average`);
    if (p.priceChange1D > 2)   reasons.push(`price up ${p.priceChange1D}% today`);
    if (p.earningsDays != null && p.earningsDays <= 14) reasons.push(`earnings in ${p.earningsDays} days`);
    if ((p.revGrowth ?? p.revenueGrowth) > 20) reasons.push(`revenue growing ${p.revGrowth ?? p.revenueGrowth}%`);
    if (p.shortPct > 15 && p.priceChange1D > 0) reasons.push(`short squeeze setup (${p.shortPct}% short)`);

    const prompt = `You are a concise financial analyst. ${p.sym} (${p.companyName}, ${p.sector}) just jumped ${p.rankDelta} positions in the StockRaptor ranking to #${p.rankToday} today.
Score: ${p.total}/100. Key signals: ${reasons.length ? reasons.join(', ') : 'improved fundamentals and momentum'}.
In exactly 2 sentences, explain why this stock moved up today. Be specific and direct. No disclaimers. Max 35 words.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch(e) {
    console.warn(`  ⚠ Mover summary failed for ${p.sym}:`, e.message);
    return null;
  }
}

// ── GENERATE AI SUMMARY ───────────────────────────────────
async function generateAISummary(p) {
  try {
    const signals = [];
    if (p.volRatio > 2.5)    signals.push(`volume is ${p.volRatio}x the 10-day average`);
    if (p.shortPct > 15)     signals.push(`${p.shortPct}% of float is sold short`);
    if (p.earningsDays != null && p.earningsDays <= 20) signals.push(`earnings in ${p.earningsDays} days`);
    if (p.streak >= 2)       signals.push(`${p.streak} consecutive EPS beats`);
    if (p.upside > 20)       signals.push(`analyst price target ${p.upside}% above current price`);
    if (p.revenueGrowth > 15) signals.push(`revenue growing ${p.revenueGrowth}% YoY`);

    // Build rich context for the AI
    const analystCtx = p.buyRatio != null ? `${p.buyRatio}% of analysts rate Buy` : '';
    const maCtx      = p.goldenCross ? 'golden cross (MA50>MA200)' : '';
    const fundCtx    = p.roe > 15 ? `ROE ${p.roe}%` : p.grossMargin > 40 ? `gross margin ${p.grossMargin}%` : '';
    const peCtx      = p.pe && p.pe > 0 ? `P/E ${p.pe}` : '';
    const extras     = [analystCtx, maCtx, fundCtx, peCtx].filter(Boolean).join(', ');

    const prompt = `You are a sharp financial analyst writing for active traders. In 2 sentences (max 45 words), explain why ${p.sym} (${p.companyName}, ${p.sector}) is the top ${p.pickType} setup today.
Context: price $${p.price}, score ${p.total}/100, setup: ${p.pickType}.
Key signals: ${signals.length ? signals.join('; ') : 'strong multi-factor confluence'}.
${extras ? 'Additional: ' + extras + '.' : ''}
Be specific and quantitative. No generic phrases. No disclaimers.`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch(e) {
    console.warn(`  ⚠ AI summary failed for ${p.sym}:`, e.message);
    return null;
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
