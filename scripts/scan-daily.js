// ══════════════════════════════════════════════════════════════
// StockRaptor · Daily Scan Worker — FMP v2 (correct field names)
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

// ── SEC EDGAR INSIDER DATA (free, official) ───────────────────
let secTickerMap = null; // cached CIK lookup

async function loadSecTickerMap() {
  if (secTickerMap) return secTickerMap;
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'StockRaptor research@stockraptor.com' }
    });
    const data = await res.json();
    secTickerMap = {};
    for (const entry of Object.values(data)) {
      secTickerMap[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, '0');
    }
    console.log(`\n  📋 SEC ticker map loaded: ${Object.keys(secTickerMap).length} tickers`);
  } catch(e) {
    console.warn('  ⚠ SEC ticker map failed:', e.message);
    secTickerMap = {};
  }
  return secTickerMap;
}

async function getSecInsider(sym) {
  try {
    const map = await loadSecTickerMap();
    const cik = map[sym.toUpperCase()];
    if (!cik) return null;

    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': 'StockRaptor research@stockraptor.com' }
    });
    if (!res.ok) return null;
    const data = await res.json();

    // Get recent Form 4 filings
    const filings = data.filings?.recent;
    if (!filings) return null;

    const form4Indices = [];
    for (let i = 0; i < filings.form.length; i++) {
      if (filings.form[i] === '4' || filings.form[i] === '4/A') {
        form4Indices.push(i);
      }
    }

    // Last 90 days
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const recent = form4Indices
      .filter(i => new Date(filings.filingDate[i]) > cutoff)
      .slice(0, 20);

    if (recent.length === 0) return { transactions: [], buys: 0, sells: 0, netChange: 0, insiders: [] };

    // Fetch actual Form 4 XML for each recent filing to get transaction details
    const transactions = [];
    for (const idx of recent.slice(0, 10)) { // limit to 10 most recent
      try {
        const accession = filings.accessionNumber[idx].replace(/-/g, '');
        const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/` +
                       `${accession}/${filings.primaryDocument[idx]}`;
        const xmlRes = await fetch(xmlUrl, {
          headers: { 'User-Agent': 'StockRaptor research@stockraptor.com' }
        });
        if (!xmlRes.ok) continue;
        const xml = await xmlRes.text();

        // Parse key fields from XML
        const name = (xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/) || [])[1] || '';
        const title = (xml.match(/<officerTitle>(.*?)<\/officerTitle>/) || [])[1] || '';
        const isDirector = xml.includes('<isDirector>1</isDirector>');
        const isOfficer = xml.includes('<isOfficer>1</isOfficer>');
        const txCode = (xml.match(/<transactionCode>(.*?)<\/transactionCode>/) || [])[1] || '';
        const shares = parseFloat((xml.match(/<transactionShares>\s*<value>(.*?)<\/value>/) || [])[1] || '0');
        const priceStr = (xml.match(/<transactionPricePerShare>\s*<value>(.*?)<\/value>/) || [])[1];
        const price = priceStr ? parseFloat(priceStr) : null;
        const date = filings.filingDate[idx];

        if (txCode && shares > 0) {
          transactions.push({
            name: name.trim(),
            title: title.trim() || (isDirector ? 'Director' : isOfficer ? 'Officer' : 'Insider'),
            type: txCode === 'P' ? 'Purchase' : txCode === 'S' ? 'Sale' : txCode === 'A' ? 'Award' : txCode,
            txCode,
            shares: Math.round(shares),
            price,
            value: price ? Math.round(shares * price) : null,
            date,
          });
        }
        await sleep(110); // SEC rate limit: max 10 req/sec
      } catch(e) { /* skip failed filings */ }
    }

    const purchases = transactions.filter(t => t.txCode === 'P');
    const sales = transactions.filter(t => t.txCode === 'S');

    return {
      transactions: transactions.slice(0, 8),
      buys: purchases.length,
      sells: sales.length,
      netChange: purchases.length - sales.length,
      totalBuyValue: purchases.reduce((a, t) => a + (t.value || 0), 0),
      totalSellValue: sales.reduce((a, t) => a + (t.value || 0), 0),
      insiders: [...new Set(transactions.map(t => t.name))].slice(0, 5),
    };
  } catch(e) {
    return null;
  }
}


function isRealStock(s) {
  if (!s?.symbol) return false;
  if (s.isEtf || s.isFund) return false;
  if (s.symbol.includes('.') || s.symbol.includes('-')) return false;
  if (s.symbol.length > 5) return false;
  if (s.isActivelyTrading === false) return false;
  // Only main US tradeable exchanges - no OTC/Pink Sheets
  const validExchanges = ['NYSE', 'NASDAQ', 'AMEX', 'NYSEARCA', 'NYSEMKT'];
  if (s.exchangeShortName && !validExchanges.includes(s.exchangeShortName)) return false;
  return true;
}

// ── PHASE 1: GET UNIVERSE ─────────────────────────────────────
async function getUniverse() {
  console.log('📡 Phase 1: Fetching small cap universe...');
  const allTickers = new Map();

  // Use smaller cap ranges to get more granular results from screener
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
async function analyzeTicker(sym, baseData) {
  try {
    // 7 parallel API calls — using correct FMP stable endpoints
    // Sequential calls - avoid parallel rate limiting
    const profile     = await fmp(`/profile?symbol=${sym}`);
    const quote       = await fmp(`/quote?symbol=${sym}`);
    const ratios      = await fmp(`/ratios-ttm?symbol=${sym}`);
    const keyMetrics  = await fmp(`/key-metrics-ttm?symbol=${sym}`);
    const cashflow    = await fmp(`/cash-flow-statement?symbol=${sym}&limit=2`);
    const income      = await fmp(`/income-statement?symbol=${sym}&limit=4`);
    const earnings    = await fmp(`/earnings?symbol=${sym}&limit=5`);
    const priceTarget = await fmp(`/price-target-consensus?symbol=${sym}`);
    const news        = await fmp(`/news/stock?symbols=${sym}&limit=8`);
    const insider     = await getSecInsider(sym);

    const p   = profile?.[0];
    const q   = quote?.[0];
    const r   = ratios?.[0];
    const km  = keyMetrics?.[0];
    const cf  = cashflow?.[0];
    const cf1 = cashflow?.[1];
    const inc = income?.[0];
    const inc1 = income?.[1];
    const pt  = priceTarget?.[0];

    // Use quote for real-time price data (more fields than profile)
    const price  = q?.price || p?.price || 0;
    const cap    = q?.marketCap || p?.marketCap || baseData?.cap || 0;
    const sector = p?.sector || baseData?.sector || 'default';

    if (!price || price < 0.5) return null;
    if (cap < 50_000_000 || cap > 6_000_000_000) return null;
    if (p?.isActivelyTrading === false) return null;

    const benchPE = SECTOR_PE[sector] || 20;

    // ── 1. FUNDAMENTAL SCORE (0-32 pts) ──────────────────────
    let fund = 0;

    const pe = r?.peRatioTTM;
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

    const roe = r?.returnOnEquityTTM != null ? r.returnOnEquityTTM * 100 : null;
    if (roe != null) fund += roe > 20 ? 4 : roe > 12 ? 3 : roe > 8 ? 2 : roe > 0 ? 1 : 0;

    // Net Debt / EBITDA (key metric from keyMetrics)
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

    const de = r?.debtToEquityTTM;
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

    // ── 2. SENTIMENT (0-12 pts) ───────────────────────────────
    let sent = 0, newsSent = null, newsItems = [];
    if (Array.isArray(news) && news.length > 0) {
      const recent = news.slice(0, 8);
      
      // Keyword-based sentiment since FMP Starter doesn't include sentiment field
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
        return {
          headline: (n.title || '').substring(0, 90),
          source: n.site || '', time: (n.publishedDate || '').substring(0, 10),
          sentiment
        };
      });
      
      const total = recent.length;
      newsSent = total > 0 ? (posCount - negCount) / total : 0;
      sent = Math.min(12, Math.round(((newsSent + 1) / 2) * 12));
    }

    // ── 3. ANALYST (0-15 pts) ─────────────────────────────────
    let analyst = 0, targetPrice = null, upside = null;
    let recMean = null, recBuy = 0, recHold = 0, recSell = 0;
    if (pt) {
      targetPrice = pt.targetConsensus ? Math.round(pt.targetConsensus * 100) / 100 : null;
      recBuy = pt.numberOfAnalystOpinions || 0;
      if (targetPrice && price) {
        upside = Math.round(((targetPrice - price) / price) * 100);
        analyst += upside > 40 ? 8 : upside > 25 ? 6 : upside > 15 ? 4 : upside > 5 ? 2 : 0;
      }
      if (pt.targetHigh && pt.targetLow && price && (pt.targetHigh - pt.targetLow) > 0) {
        const pct = (pt.targetHigh - price) / (pt.targetHigh - pt.targetLow);
        analyst += pct > 0.7 ? 7 : pct > 0.5 ? 5 : pct > 0.3 ? 3 : 1;
      }
    }
    analyst = Math.min(15, analyst);

    // ── 4. MOMENTUM (0-17 pts) — using QUOTE fields ───────────
    let momentum = 0;
    // quote has: price, previousClose, yearHigh, yearLow, volume, priceAvg50, priceAvg200
    const prev     = q?.previousClose;
    const yearHigh = q?.yearHigh;
    const yearLow  = q?.yearLow;
    const volume   = q?.volume || p?.volume;
    const avgVol   = p?.averageVolume; // from profile

    const priceChange1D = prev && prev > 0
      ? Math.round(((price - prev) / prev) * 100 * 10) / 10 : null;

    let pct52Low = null, pct52High = null;
    if (yearLow && yearHigh && price && yearHigh > yearLow) {
      pct52Low  = Math.round(((price - yearLow)  / yearLow)  * 100);
      pct52High = Math.round(((price - yearHigh) / yearHigh) * 100);
      const pos = (price - yearLow) / (yearHigh - yearLow);
      momentum += pos > 0.85 ? 8 : pos > 0.65 ? 6 : pos > 0.45 ? 4 : pos > 0.25 ? 2 : 0;
    }

    if (priceChange1D != null) {
      momentum += priceChange1D > 4 ? 4 : priceChange1D > 2 ? 3 : priceChange1D > 0.5 ? 2 : priceChange1D > -0.5 ? 1 : 0;
    }

    const beta = p?.beta;
    if (beta) momentum += beta > 1.8 ? 3 : beta > 1.3 ? 2 : beta > 0.9 ? 1 : 0;

    // Price vs 50-day MA — trend signal
    const ma50 = q?.priceAvg50;
    if (ma50 && price > ma50 * 1.05) momentum += 2;
    else if (ma50 && price > ma50) momentum += 1;

    const volRatio = volume && avgVol && avgVol > 0
      ? Math.round((volume / avgVol) * 10) / 10 : null;
    if (volRatio) momentum += volRatio > 3 ? 2 : volRatio > 2 ? 1 : 0;

    momentum = Math.min(17, momentum);

    // ── 5. EARNINGS (0-15 pts) ────────────────────────────────
    let earPts = 0, epsHistory = [], streak = 0;
    let earningsDate = null, earningsDays = null;

    if (Array.isArray(earnings) && earnings.length > 0) {
      // FMP /earnings has: date, epsActual, epsEstimated, revenueActual, revenueEstimated
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
    // shortRatio not available in FMP stable — skip short pts for now
    const shortPct = null;
    volShort = Math.min(11, volShort);

    // ── 7. INSIDER (0-8 pts) ──────────────────────────────────
    let insiderScore = 0, insiderChange = null, mspr = null;
    if (insider && insider.transactions) {
      insiderChange = insider.netChange;
      const total = insider.buys + insider.sells;
      mspr = total > 0 ? Math.round((insider.netChange / total) * 100) / 100 : null;
      insiderScore = insider.buys > 3 ? 8 : insider.buys > 1 ? 6 : insider.buys === 1 ? 4 : insider.sells > 2 ? 0 : 2;
      // Bonus for high buy value
      if (insider.totalBuyValue > 500000) insiderScore = Math.min(8, insiderScore + 2);
    }

    // ── FLAGS ─────────────────────────────────────────────────
    const flags = [];
    if (volRatio && volRatio > 3)                        flags.push({ label: '⚡ VOL SPIKE',   color: '#00b4ff' });
    if (insider?.buys > 0 && insider?.netChange > 0)        flags.push({ label: '👤 INSIDER BUY', color: '#00ff94' });
    if (insider?.totalBuyValue > 1000000)                    flags.push({ label: '💼 BIG INSIDER',  color: '#00ff94' });
    if (streak >= 3)                                     flags.push({ label: '📈 EPS STREAK',  color: '#ffcc00' });
    if (fcf != null && fcf > 0 && fcf1 != null && fcf1 > 0) flags.push({ label: '💰 FCF+',    color: '#00e5cc' });
    if (ebitdaMargin != null && ebitdaMargin > 25)       flags.push({ label: '💎 EBITDA+',     color: '#bf5fff' });
    if (epsGrowth != null && epsGrowth > 25)             flags.push({ label: '🚀 EPS GROWTH',  color: '#ff7040' });
    if (upside != null && upside > 35)                   flags.push({ label: '🎯 HIGH UPSIDE', color: '#ffcc00' });
    if (ma50 && price > ma50 * 1.1)                      flags.push({ label: '📊 ABOVE MA50',  color: '#00b4ff' });

    // ── TOTAL & SIGNAL ────────────────────────────────────────
    const total = fund + sent + analyst + momentum + earPts + volShort + insiderScore;
    const signal = total >= 62 ? 'STRONG BUY'
                 : total >= 46 ? 'INTERESTING'
                 : total >= 28 ? 'WATCH' : 'WEAK';

    return {
      sym, sector, signal, total,
      companyName: p?.companyName || baseData?.companyName || sym,
      fund, sent, analyst, momentum, earPts, volShort,
      price: Math.round(price * 100) / 100,
      prevClose: prev ? Math.round(prev * 100) / 100 : null,
      priceChange1D,
      lo52: yearLow || null, hi52: yearHigh || null,
      pct52Low, pct52High,
      cap, beta: beta ? Math.round(beta * 1000) / 1000 : null,
      volRatio,
      pe: pe ? Math.round(pe * 10) / 10 : null,
      pb: pb ? Math.round(pb * 10) / 10 : null,
      de: de != null ? Math.round(de * 100) / 100 : null,
      roe: roe != null ? Math.round(roe * 10) / 10 : null,
      roa: r?.returnOnAssetsTTM != null ? Math.round(r.returnOnAssetsTTM * 1000) / 10 : null,
      grossMargin: grossMargin != null ? Math.round(grossMargin * 10) / 10 : null,
      ebitdaMargin: ebitdaMargin != null ? Math.round(ebitdaMargin * 10) / 10 : null,
      currentRatio: cr ? Math.round(cr * 100) / 100 : null,
      netDebtEbitda: netDebtEbitda != null ? Math.round(netDebtEbitda * 10) / 10 : null,
      fcf: fcf || null, revGrowth, epsGrowth,
      sharesDilution, dilPenalty, debtPenalty,
      targetPrice, upside, recMean, recBuy, recHold, recSell,
      shortPct, mspr, insiderChange,
      insiderData: insider ? {
        buys: insider.buys,
        sells: insider.sells,
        netChange: insider.netChange,
        totalBuyValue: insider.totalBuyValue,
        totalSellValue: insider.totalSellValue,
        transactions: insider.transactions,
        insiders: insider.insiders,
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
  console.log('🦅 StockRaptor Full Universe Scan v2 starting...');

  const universe = await getUniverse();
  const tickers = [...universe.keys()];

  console.log(`\n🔬 Phase 2: Analyzing ${tickers.length} tickers (5 concurrent)...`);

  const DELAY = 0; // sequential calls per ticker already take ~900ms naturally
  const results = [];
  let errors = 0;

  for (let i = 0; i < tickers.length; i++) {
    const sym = tickers[i];
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const pct = Math.round((i / tickers.length) * 100);
    if (i % 10 === 0) process.stdout.write(`\r[${i+1}/${tickers.length}] ${pct}% | ${elapsed}s | ${results.length} scored`);
    
    const r = await analyzeTicker(sym, universe.get(sym));
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
