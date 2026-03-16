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

// Máximo teórico por factor — usado para normalizar a 0-100
const MAX_SCORES = {
  fund: 32, sent: 8, analyst: 15, momentum: 17, earPts: 15, volShort: 11, insider: 8
};
const MAX_TOTAL = Object.values(MAX_SCORES).reduce((a, b) => a + b, 0); // 106

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

  const ranges = [
    { min: 80000000,   max: 250000000  },
    { min: 250000000,  max: 500000000  },
    { min: 500000000,  max: 1000000000 },
    { min: 1000000000, max: 3000000000 },
  ];

  for (const exchange of ['NASDAQ', 'NYSE', 'AMEX']) {
    for (const range of ranges) {
      for (let page = 0; page < 20; page++) {
        const data = await fmp(
          `/company-screener?marketCapMoreThan=${range.min}&marketCapLowerThan=${range.max}&exchange=${exchange}&volumeMoreThan=100000&isActivelyTrading=true&limit=500&page=${page}`
        );
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
    fund = Math.max(0, Math.min(32, fund));

    // ── 2. SENTIMENT (0-8 pts) ────────────────────────────────
    // FIX: reducido de 12 a 8 pts — señal ruidosa con keyword matching
    // FIX: mínimo 4 noticias para que cuente, si no → 0 (neutral)
    let sent = 0, newsSent = null, newsItems = [];
    if (Array.isArray(news) && news.length >= 4) {
      const recent = news.slice(0, 10);
      const POS_WORDS = ['beat','beats','surge','surges','jumps','rises','gains','record','upgrade','upgraded','strong','growth','profit','revenue','bullish','buy','outperform','raises','raised','exceeds','positive','wins','award','partnership','deal','launch','launches'];
      const NEG_WORDS = ['miss','misses','falls','drops','decline','declines','loss','losses','downgrade','downgraded','weak','cut','cuts','lawsuit','investigation','recall','warning','disappoints','below','concern','risk','sell','underperform','layoffs','bankruptcy'];
      let posCount = 0, negCount = 0;
      newsItems = recent.slice(0, 6).map(n => {
        const title = (n.title || '').toLowerCase();
        const isPos = POS_WORDS.some(w => title.includes(w));
        const isNeg = NEG_WORDS.some(w => title.includes(w));
        const sentiment = isPos && !isNeg ? 'positive' : isNeg && !isPos ? 'negative' : 'neutral';
        if (sentiment === 'positive') posCount++;
        if (sentiment === 'negative') negCount++;
        return { headline: (n.title || '').substring(0, 90), source: n.site || '', time: (n.publishedDate || '').substring(0, 10), sentiment };
      });
      const total = recent.length;
      newsSent = total > 0 ? (posCount - negCount) / total : 0;
      sent = Math.min(8, Math.round(((newsSent + 1) / 2) * 8));
    }

    // ── 3. ANALYST (0-15 pts) ─────────────────────────────────
    let analyst = 0, targetPrice = null, upside = null;
    let recMean = null, recBuy = 0, recHold = 0, recSell = 0;

    // Price target from /price-target-consensus
    if (pt) {
      targetPrice = pt.targetConsensus ? Math.round(pt.targetConsensus * 100) / 100 : null;
      if (targetPrice && price) {
        upside = Math.round(((targetPrice - price) / price) * 100);
        analyst += upside > 40 ? 8 : upside > 25 ? 6 : upside > 15 ? 4 : upside > 5 ? 2 : upside < -10 ? -2 : 0;
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
      }
    }

    analyst = Math.min(15, Math.max(0, analyst));

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

    // FIX: máximo 2 pts por movimiento diario (era 4 — demasiado ruidoso)
    if (priceChange1D != null) {
      momentum += priceChange1D > 3 ? 2 : priceChange1D > 1 ? 1 : priceChange1D < -3 ? -1 : 0;
    }

    const beta = p?.beta;
    if (beta) momentum += beta > 1.8 ? 3 : beta > 1.3 ? 2 : beta > 0.9 ? 1 : 0;

    const ma50 = q?.priceAvg50;
    if (ma50 && price > ma50 * 1.05) momentum += 2;
    else if (ma50 && price > ma50) momentum += 1;

    const volRatio = volume && avgVol && avgVol > 0 ? Math.round((volume / avgVol) * 10) / 10 : null;
    if (volRatio) momentum += volRatio > 3 ? 2 : volRatio > 2 ? 1 : 0;

    // FIX: penalización trampa — >40% bajo máximo + revenue negativo = caída estructural
    let momentumTrap = 0;
    if (pct52High !== null && pct52High < -40 && revGrowth !== null && revGrowth < 0) {
      momentumTrap = -5;
      momentum += momentumTrap;
    }

    momentum = Math.max(0, Math.min(17, momentum));

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
    earPts = Math.min(15, earPts);

    // ── 6. VOL/SHORT (0-11 pts) ───────────────────────────────
    let volShort = 0;
    if (volRatio) volShort += volRatio > 5 ? 5 : volRatio > 3 ? 4 : volRatio > 2 ? 3 : 0;
    const shortPct = null;
    volShort = Math.min(11, volShort);

    // ── 7. INSIDER (0-8 pts) ──────────────────────────────────
    // FIX: corregido bug — 0 pts cuando no hay actividad (era 2 erróneamente)
    // FIX: penaliza ventas netas con -2 pts
    let insiderScore = 0, insiderChange = null, mspr = null;
    if (insider && (insider.buys > 0 || insider.sells > 0)) {
      insiderChange = insider.netChange;
      const totalTx = insider.buys + insider.sells;
      mspr = totalTx > 0 ? Math.round((insider.netChange / totalTx) * 100) / 100 : null;

      if (insider.buys > 3)       insiderScore = 8;
      else if (insider.buys > 1)  insiderScore = 6;
      else if (insider.buys === 1) insiderScore = 4;
      else if (insider.sells > 2)  insiderScore = -2; // FIX: penaliza ventas netas
      else                         insiderScore = 0;  // FIX: era 2, ahora 0

      // Bonus por volumen de compra significativo
      if (insider.totalBuyValue > 1000000) insiderScore = Math.min(8, insiderScore + 2);
      else if (insider.totalBuyValue > 500000) insiderScore = Math.min(8, insiderScore + 1);
    }
    // Sin actividad insider → 0 (neutral, no penaliza ni bonifica)
    insiderScore = Math.max(-2, Math.min(8, insiderScore));

    // ── FLAGS ─────────────────────────────────────────────────
    const flags = [];
    if (volRatio && volRatio > 3)                             flags.push({ label: '⚡ VOL SPIKE',   color: '#00b4ff' });
    if (insider?.buys > 0 && insider?.netChange > 0)          flags.push({ label: '👤 INSIDER BUY', color: '#00ff94' });
    if (insider?.totalBuyValue > 1000000)                     flags.push({ label: '💼 BIG INSIDER',  color: '#00ff94' });
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
    const total = Math.max(0, Math.min(100, Math.round((rawTotal / MAX_TOTAL) * 100)));

    const signal = total >= 70 ? 'STRONG BUY'
                 : total >= 55 ? 'INTERESTING'
                 : total >= 35 ? 'WATCH' : 'WEAK';

    return {
      sym, sector, signal, total,
      companyName: p?.companyName || baseData?.companyName || sym,
      fund, sent, analyst, momentum, earPts, volShort,
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
      shortPct, mspr, insiderChange,
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
async function main() {
  const t0 = Date.now();
  console.log('🦅 StockRaptor Daily Scan v3 starting...');

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

  for (let i = 0; i < tickers.length; i++) {
    const sym = tickers[i];
    if (i % 10 === 0) process.stdout.write(`\r[${i+1}/${tickers.length}] ${Math.round((i/tickers.length)*100)}% | ${Math.round((Date.now()-t0)/1000)}s | ${results.length} scored`);
    const r = await analyzeTicker(sym, universe.get(sym), insiderCache);
    if (r) results.push(r); else errors++;
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  results.sort((a, b) => b.total - a.total);

  const signals = results.reduce((acc, r) => { acc[r.signal] = (acc[r.signal]||0)+1; return acc; }, {});
  console.log(`\n\n✅ Done in ${elapsed}s | ${results.length} results | ${errors} errors`);
  console.log(`   Signals:`, signals);

  const { error } = await sb.from('scan_cache').upsert({
    id: 'daily',
    scan_date: new Date().toISOString().substring(0, 10),
    scanned_at: new Date().toISOString(),
    results, total_count: results.length, errors,
  });

  if (error) { console.error('❌ Supabase:', error.message); process.exit(1); }

  console.log(`\n🏆 Top 10:`);
  results.slice(0, 10).forEach((r, i) =>
    console.log(`   ${i+1}. ${r.sym.padEnd(6)} ${r.signal.padEnd(12)} score:${r.total}`)
  );
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
