// ══════════════════════════════════════════════════════════════
// StockRaptor · Daily Scan Worker
// Corre en GitHub Actions a las 08:00 UTC (lunes–viernes)
// Analiza 200 tickers y guarda el resultado en Supabase
// ══════════════════════════════════════════════════════════════

import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

// ── CONFIGURACIÓN ─────────────────────────────────────────────
const KEY        = process.env.FINNHUB_KEY;
const SB_URL     = process.env.SUPABASE_URL;
const SB_KEY     = process.env.SUPABASE_SERVICE_KEY;

if (!KEY || !SB_URL || !SB_KEY) {
  console.error('❌ Faltan variables de entorno: FINNHUB_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY);

// ── TICKERS (200) ─────────────────────────────────────────────
const TICKERS = [
  // Tech & Software
  "ACMR","AMBA","CLFD","SEMR","LASR","AIOT","ALKT","ACVA","VERX","YEXT",
  "RSKD","SDGR","RMBS","PAYO","FTDR","LQDT","RCUS","XPOF","GBTG","IIPR",
  "BAND","BIGC","BLZE","CARG","CEVA","DOMO","EGAN","ENVX","EVCM","EVTC",
  "FORA","FOUR","FRSH","HCAT","HLIO","HURN","IOTS","ITOS","KTOS","NCNO",
  "NTNX","NTST","NVEI","OPEN","OPRX","OUST","PLAB","PLUS","POWI","PWSC",
  // Biotech & Healthcare
  "CRVS","DVAX","GERN","INVA","KIDS","KROS","MGNX","OPCH","PGNY","TBPH",
  "TARS","ACRS","ADMA","AGIO","AGEN","AKBA","ALDX","AMRX","ANIK","ANIP",
  "APLS","ARDX","ARQT","ARVN","ATRC","AVDL","AVNS","AXGN","BEAM","BHVN",
  "BLFS","BNGO","BTAI","CADL","CMRX","CPRX","FATE","FIXX","FOLD","FWRD",
  "GLYC","GRFS","HALO","HRMY","IMVT","INBX","IONS","IOVA","IRWD","ITCI",
  // Industrials & Energy
  "CNMD","FLNC","SWBI","PRCT","AEIS","ALGT","AMRC","AMSC","AMWD","APOG",
  "AQUA","ARCB","ARKO","ARLO","AROC","ASTE","ATNI","AVAV","AZTA","BCPC",
  "BFAM","BWXT","CACI","CAKE","CALM","CATO","CECO","CENX","CIEN","CIGI",
  "CLNE","CMCO","CMTL","CNDT","CNOB","CODI","COHU","CORE","CORT","COVA",
  // Consumer & Retail
  "RVLV","BOOT","HIMS","ACLS","ACTG","ADNT","AFRM","AFYA","AGCO","AMEH",
  "ANGI","AOSL","APAM","APLE","ARCH","ARHS","ASIX","ASPS","ATEX","ATLO",
  "AYTU","BJRI","BLMN","BLNK","BMBL","BNED","BODY","DRVN","DXPE","ECPG",
  // Financial & REITs
  "PEBO","PFBC","PFIS","PFLT","PFSI","ABCB","ACNB","AFBI","AMNB","AMTB",
  "ANCX","APRE","CBNK","CBSH","CCBG","CFFN","CFFI","CFNL","CHMG","CHMI",
  // Specialty & Diversified
  "PDCO","ALKS","AMPH","ASND","ATIF","BLRX","BPMC","CARA","CBPO","CBRL"
];

const SECTOR_PE = {
  'Technology':28,'Biotechnology':35,'Healthcare':22,'Software':32,
  'Consumer Cyclical':18,'Financial Services':14,'Industrials':18,
  'Energy':12,'Real Estate':20,'Communication Services':20,
  'Consumer Defensive':20,'Utilities':16,'Basic Materials':14,'default':22
};

// ── HELPERS ───────────────────────────────────────────────────
const slp  = ms => new Promise(r => setTimeout(r, ms));
const toDay = () => new Date().toISOString().slice(0, 10);
const futD  = d => { const t = new Date(); t.setDate(t.getDate()+d); return t.toISOString().slice(0,10); };
const pasD  = d => { const t = new Date(); t.setDate(t.getDate()-d); return t.toISOString().slice(0,10); };

async function apiFetch(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { console.log('  ⚠ rate limit, waiting 15s...'); await slp(15000); continue; }
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      if (i < tries - 1) await slp(2000);
    }
  }
  return null;
}

// ── SCORING (idéntico al scanner.html) ────────────────────────
function computeScores(d) {
  const sPE = SECTOR_PE[d.sector] || SECTOR_PE.default;
  let fund = 0;
  if (d.pe > 0) { const r = d.pe/sPE; if(r<0.5) fund+=12; else if(r<0.8) fund+=9; else if(r<1.0) fund+=6; else if(r<1.3) fund+=3; }
  if (d.pb > 0 && d.pb < 1.5) fund+=5; else if(d.pb>0&&d.pb<3) fund+=3; else if(d.pb>0&&d.pb<5) fund+=1;
  if (d.currentRatio >= 2) fund+=4; else if(d.currentRatio>=1.5) fund+=2; else if(d.currentRatio<1) fund-=3;
  if (d.roe > 20) fund+=4; else if(d.roe>10) fund+=2;
  fund = Math.max(0, Math.min(25, fund));

  let revQ = 0;
  if (d.revenueGrowth>30) revQ=5; else if(d.revenueGrowth>15) revQ=4; else if(d.revenueGrowth>5) revQ=2; else if(d.revenueGrowth>0) revQ=1;
  if (d.grossMargin > 50) revQ = Math.min(5, revQ+1);

  let dilPenalty = 0;
  if (d.sharesDilution>15) dilPenalty=-10; else if(d.sharesDilution>8) dilPenalty=-6; else if(d.sharesDilution>3) dilPenalty=-3;

  let debtPenalty = 0;
  if (d.de>1.5&&d.revenueGrowth<0) debtPenalty=-5; else if(d.de>2&&d.revenueGrowth<5) debtPenalty=-3;

  let sent = 0;
  if (d.newsSent !== null) sent += Math.round(((Math.max(-1,Math.min(1,d.newsSent))+1)/2)*10);
  sent = Math.min(12, sent);

  let insider = 0;
  if (d.mspr !== null) insider = Math.round(((Math.max(-100,Math.min(100,d.mspr))+100)/200)*8);

  let analyst = 0;
  if (d.recMean!==null) { if(d.recMean<=1.5) analyst=10; else if(d.recMean<=2.2) analyst=7; else if(d.recMean<=2.8) analyst=4; else if(d.recMean<=3.5) analyst=2; }

  let upsideScore = 0;
  if (d.upside>40) upsideScore=5; else if(d.upside>25) upsideScore=4; else if(d.upside>15) upsideScore=2; else if(d.upside>5) upsideScore=1;

  let momentum = 0;
  if (d.pct52Low!==null) { if(d.pct52Low>=15&&d.pct52Low<=50) momentum+=8; else if(d.pct52Low<15) momentum+=4; else if(d.pct52Low<=80) momentum+=3; else momentum+=1; }

  let trend = 0;
  if (d.priceChange4W>15) trend=6; else if(d.priceChange4W>5) trend=4; else if(d.priceChange4W>0) trend=2; else if(d.priceChange4W>-10) trend=1;

  let betaB = 0;
  if (d.beta>=0.7&&d.beta<=1.6) betaB=3; else if(d.beta>0&&d.beta<2.2) betaB=1;

  let earPts = 0;
  if (d.earningsDays!==null) { if(d.earningsDays<=14) earPts=10; else if(d.earningsDays<=30) earPts=8; else if(d.earningsDays<=60) earPts=5; else if(d.earningsDays<=90) earPts=3; }

  const streak = d.epsHistory.filter(e => e.surprise > 3).length;
  let epsStreak = streak>=4?5:streak>=3?4:streak>=2?2:streak>=1?1:0;

  let volScore = 0;
  if (d.volRatio!==null) { if(d.volRatio>4) volScore=8; else if(d.volRatio>2.5) volScore=6; else if(d.volRatio>1.5) volScore=4; else if(d.volRatio>1.2) volScore=2; }

  let shortSq = 0;
  if (d.shortPct!==null) { if(d.shortPct>20&&d.priceChange4W>5) shortSq=5; else if(d.shortPct>15&&d.priceChange4W>0) shortSq=3; else if(d.shortPct>10) shortSq=1; }

  const total = Math.max(0, Math.min(100, fund+revQ+dilPenalty+debtPenalty+sent+insider+analyst+upsideScore+momentum+trend+betaB+earPts+epsStreak+volScore+shortSq));
  return {
    total,
    fund:      Math.max(0, fund+revQ+dilPenalty+debtPenalty),
    sent:      Math.max(0, sent+insider),
    analyst:   Math.max(0, analyst+upsideScore),
    momentum:  Math.max(0, momentum+trend+betaB),
    earPts:    Math.max(0, earPts+epsStreak),
    volShort:  Math.max(0, volScore+shortSq),
    dilPenalty, debtPenalty, epsStreak, streak
  };
}

function toSig(s) {
  return s >= 72 ? 'FUERTE COMPRA' : s >= 48 ? 'INTERESANTE' : s >= 25 ? 'VIGILAR' : 'DÉBIL';
}

// ── FETCH TICKER ──────────────────────────────────────────────
async function fetchTicker(sym) {
  const B = 'https://finnhub.io/api/v1', T = `token=${KEY}`;
  const [prof,metr,earn,quote,news,insiderS,rec,shorts] = await Promise.all([
    apiFetch(`${B}/stock/profile2?symbol=${sym}&${T}`),
    apiFetch(`${B}/stock/metric?symbol=${sym}&metric=all&${T}`),
    apiFetch(`${B}/calendar/earnings?symbol=${sym}&from=${toDay()}&to=${futD(120)}&${T}`),
    apiFetch(`${B}/quote?symbol=${sym}&${T}`),
    apiFetch(`${B}/company-news?symbol=${sym}&from=${pasD(14)}&to=${toDay()}&${T}`),
    apiFetch(`${B}/stock/insider-sentiment?symbol=${sym}&from=${pasD(90)}&to=${toDay()}&${T}`),
    apiFetch(`${B}/stock/recommendation?symbol=${sym}&${T}`),
    apiFetch(`${B}/stock/short-interest?symbol=${sym}&from=${pasD(60)}&to=${toDay()}&${T}`)
  ]);

  if (!metr?.metric) return null;
  const m = metr.metric;

  const pe            = m['peBasicExclExtraTTM'] || m['peTTM'] || null;
  const pb            = m['pbAnnual'] || m['pbQuarterly'] || null;
  const de            = m['totalDebt/totalEquityAnnual'] != null ? m['totalDebt/totalEquityAnnual']/100 : null;
  const revenueGrowth = m['revenueGrowthTTMYoy'] != null ? Math.round(m['revenueGrowthTTMYoy']*100) : m['revenueGrowth3Y'] != null ? Math.round(m['revenueGrowth3Y']) : null;
  const grossMargin   = m['grossMarginTTM'] != null ? Math.round(m['grossMarginTTM']*100) : null;
  const roa           = m['roaTTM'] != null ? Math.round(m['roaTTM']*100) : null;
  const roe           = m['roeTTM'] != null ? Math.round(m['roeTTM']*100) : null;
  const currentRatio  = m['currentRatioAnnual'] || null;
  const cap           = prof?.marketCapitalization ? prof.marketCapitalization*1e6 : null;
  const sector        = prof?.finnhubIndustry || null;
  const sharesNow     = m['sharesOutstanding'] || m['shareOutstanding'] || null;
  const sharesDilution = m['shareOutstandingGrowth'] != null ? Math.round(m['shareOutstandingGrowth']*100) : m['shareGrowthTTMYoy'] != null ? Math.round(m['shareGrowthTTMYoy']*100) : null;
  const price         = quote?.c || null;
  const prevClose     = quote?.pc || null;
  const priceChange1D = (price && prevClose) ? Math.round((price-prevClose)/prevClose*1000)/10 : null;
  const hi52          = m['52WeekHigh'] || null;
  const lo52          = m['52WeekLow'] || null;
  const pct52Low      = (price && lo52)  ? Math.round((price-lo52)/lo52*100)   : null;
  const pct52High     = (price && hi52)  ? Math.round((price-hi52)/hi52*100)   : null;
  const priceChange4W = m['4WeekPriceReturnDaily'] != null ? Math.round(m['4WeekPriceReturnDaily']*10)/10 : null;
  const beta          = m['beta'] || null;
  const vol10d        = m['10DayAverageTradingVolume'] || null;
  const volCurrent    = quote?.v || null;
  const volRatio      = (volCurrent && vol10d && vol10d > 0) ? Math.round(volCurrent/vol10d*10)/10 : null;

  let shortPct = null;
  if (shorts?.data?.length) {
    const l = shorts.data[shorts.data.length-1];
    const fl = m['float'] || sharesNow;
    if (l.shortInterest && fl) shortPct = Math.round(l.shortInterest/fl*1000)/10;
  }
  if (shortPct === null && m['shortInterestPercent'] != null) shortPct = Math.round(m['shortInterestPercent']*10)/10;

  const targetPrice = m['targetMeanConsensus'] || null;
  const upside      = (price && targetPrice) ? Math.round((targetPrice-price)/price*100) : null;

  let recMean = null, recBuy = 0, recHold = 0, recSell = 0;
  if (rec?.length) {
    const r0 = rec[0];
    recBuy  = (r0.strongBuy||0) + (r0.buy||0);
    recHold = r0.hold || 0;
    recSell = (r0.sell||0) + (r0.strongSell||0);
    const tot = recBuy + recHold + recSell;
    if (tot > 0) recMean = (recBuy*1 + recHold*3 + recSell*5) / tot;
  }

  let newsSent = null, newsItems = [];
  if (news?.length) {
    newsItems = news.slice(0,8).map(n => ({
      headline: n.headline, source: n.source,
      time: n.datetime ? new Date(n.datetime*1000).toLocaleDateString('en-US',{day:'2-digit',month:'short'}) : '',
      sentiment: n.sentiment || null
    }));
    const ws = newsItems.filter(n => n.sentiment);
    if (ws.length) {
      newsSent = ws.reduce((a,n) => a + (n.sentiment==='positive'?1:n.sentiment==='negative'?-1:0), 0) / ws.length;
    } else {
      const txt = news.slice(0,6).map(n=>(n.headline||'').toLowerCase()).join(' ');
      const pos = ['beat','growth','record','surge','rally','upgrade','strong','profit','raise','patent','fda','approval','deal','contract'];
      const neg = ['miss','decline','fall','loss','cut','downgrade','weak','debt','fraud','concern','lawsuit','secondary','dilut'];
      let sc = 0;
      pos.forEach(w => { if(txt.includes(w)) sc+=0.12; });
      neg.forEach(w => { if(txt.includes(w)) sc-=0.15; });
      newsSent = Math.max(-1, Math.min(1, sc));
    }
  }

  let mspr = null, insiderChange = null;
  if (insiderS?.data?.length) {
    const r = insiderS.data.slice(-3);
    if (r.length) { mspr = r[r.length-1].mspr || null; insiderChange = r.reduce((a,d)=>a+(d.change||0),0); }
  }

  let earningsDays = null, earningsDate = null;
  const epsHistory = [];
  const earList = earn?.earningsCalendar;
  if (earList?.length) {
    const t0 = new Date(); t0.setHours(0,0,0,0);
    for (const e of earList) {
      if (!e.date) continue;
      const d = new Date(e.date);
      const diff = Math.ceil((d - t0) / 86400000);
      if (diff >= 0 && earningsDays === null) { earningsDays = diff; earningsDate = e.date; }
      if (e.epsActual != null && e.epsEstimate != null) {
        const surp = e.epsEstimate !== 0 ? Math.round((e.epsActual-e.epsEstimate)/Math.abs(e.epsEstimate)*100) : 0;
        epsHistory.push({ q: e.period||e.date, actual: e.epsActual, est: e.epsEstimate, surprise: surp });
      }
      if (epsHistory.length >= 4) break;
    }
  }

  const flags = [];
  if (volRatio && volRatio > 2.5)                       flags.push({ label:`VOL ${volRatio}x`,          color:'pink'  });
  if (shortPct && shortPct > 15 && priceChange4W > 3)   flags.push({ label:`SHORT SQ ${shortPct}%`,     color:'teal'  });
  if (sharesDilution && sharesDilution > 8)              flags.push({ label:`DILUTION +${sharesDilution}%`, color:'red' });
  if (earningsDays !== null && earningsDays <= 20)       flags.push({ label:`EARN ${earningsDays}d`,     color:'gold'  });
  if (mspr && mspr > 30)                                 flags.push({ label:'INSIDER BUY',               color:'green' });
  if (de && de > 2)                                      flags.push({ label:'HIGH DEBT',                 color:'orange'});

  const raw = {
    sym, pe: pe?Math.round(pe*10)/10:null, pb: pb?Math.round(pb*10)/10:null,
    de, revenueGrowth, grossMargin, roa, roe, currentRatio, cap, sector,
    sharesDilution, price, prevClose, priceChange1D, hi52, lo52,
    pct52Low, pct52High, priceChange4W, beta, volRatio, shortPct,
    targetPrice, upside, recMean, recBuy, recHold, recSell,
    newsSent, newsItems, mspr, insiderChange,
    earningsDays, earningsDate, epsHistory, flags
  };

  const sc = computeScores(raw);
  return { ...raw, ...sc, signal: toSig(sc.total) };
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  console.log(`\n🦅 StockRaptor Daily Scan — ${new Date().toISOString()}`);
  console.log(`📋 ${TICKERS.length} tickers a analizar\n`);

  const results = [];
  let errors = 0;

  for (let i = 0; i < TICKERS.length; i++) {
    const sym = TICKERS[i];
    const pct = Math.round(((i+1)/TICKERS.length)*100);
    process.stdout.write(`\r[${(i+1).toString().padStart(3)}/${TICKERS.length}] ${sym.padEnd(6)} ${pct}%`);

    try {
      const d = await fetchTicker(sym);
      if (d) {
        results.push(d);
      } else {
        errors++;
      }
    } catch (e) {
      errors++;
    }

    await slp(420); // respetar rate limit Finnhub
  }

  results.sort((a, b) => b.total - a.total);

  console.log(`\n\n✅ Analizados: ${results.length} | ❌ Errores: ${errors}`);

  // Resumen top 5
  console.log('\n🏆 Top 5 STRONG BUY:');
  results.filter(d => d.signal === 'FUERTE COMPRA').slice(0,5).forEach((d,i) => {
    console.log(`  ${i+1}. ${d.sym} — Score: ${d.total} | ${d.sector||'—'}`);
  });

  // Guardar en Supabase
  console.log('\n💾 Guardando en Supabase...');
  const { error } = await sb
    .from('scan_cache')
    .upsert({
      id:          'daily',
      scan_date:   toDay(),
      scanned_at:  new Date().toISOString(),
      results:     results,
      total_count: results.length,
      errors:      errors
    }, { onConflict: 'id' });

  if (error) {
    console.error('❌ Error guardando en Supabase:', error.message);
    process.exit(1);
  }

  console.log(`✅ Guardado correctamente — ${results.length} empresas en scan_cache`);
  console.log(`📅 Fecha: ${toDay()}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
