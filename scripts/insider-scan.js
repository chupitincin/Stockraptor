// ══════════════════════════════════════════════════════════════
// StockRaptor · Weekly Insider Scan — SEC EDGAR Bulk Edition
// Uses SEC daily index files to get ALL Form 4s at once
// Much faster: ~5-10 min instead of hours
// ══════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SB_URL || !SB_KEY) {
  console.error('❌ Missing: SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY);
const SEC = 'https://www.sec.gov';
const HEADERS = { 'User-Agent': 'StockRaptor research@stockraptor.com' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── GET QUARTER FROM DATE ─────────────────────────────────────
function getQuarter(date) {
  const m = date.getMonth() + 1;
  return m <= 3 ? 'QTR1' : m <= 6 ? 'QTR2' : m <= 9 ? 'QTR3' : 'QTR4';
}

// ── LOAD CIK→TICKER MAP ───────────────────────────────────────
async function loadTickerMap() {
  console.log('📋 Loading SEC ticker map...');
  const res = await fetch(`${SEC}/files/company_tickers.json`, { headers: HEADERS });
  const data = await res.json();
  // Build both directions: CIK→ticker and ticker→CIK
  const cikToTicker = {};
  const tickerToCik = {};
  for (const entry of Object.values(data)) {
    const cik = String(entry.cik_str).padStart(10, '0');
    const ticker = entry.ticker.toUpperCase();
    cikToTicker[cik] = ticker;
    tickerToCik[ticker] = cik;
  }
  console.log(`   ${Object.keys(cikToTicker).length} companies mapped`);
  return { cikToTicker, tickerToCik };
}

// ── LOAD ACTIVE SYMBOLS FROM SUPABASE ────────────────────────
async function loadActiveSymbols() {
  console.log('📊 Loading active symbols from scan_cache...');
  const { data } = await sb.from('scan_cache').select('results').eq('id', 'daily').single();
  const symbols = new Set(data?.results?.map(r => r.sym).filter(Boolean) || []);
  console.log(`   ${symbols.size} active symbols`);
  return symbols;
}

// ── DOWNLOAD SEC DAILY INDEX FOR A DATE ──────────────────────
async function getDailyIndex(date) {
  const year = date.getFullYear();
  const qtr  = getQuarter(date);
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const dd   = String(date.getDate()).padStart(2, '0');
  
  // Try the form4.idx file for this quarter
  const url = `${SEC}/Archives/edgar/daily-index/${year}/${qtr}/form4.${year}${mm}${dd}.idx`;
  
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const text = await res.text();
    
    // Parse the idx file format:
    // Company Name|Form Type|CIK|Date Filed|Filename
    const lines = text.split('\n').slice(9); // skip header
    return lines
      .filter(l => l.includes('|4|') || l.includes('|4/A|'))
      .map(l => {
        const parts = l.split('|');
        if (parts.length < 5) return null;
        return {
          company: parts[0].trim(),
          formType: parts[1].trim(),
          cik: String(parts[2].trim()).padStart(10, '0'),
          dateFiled: parts[3].trim(),
          filename: parts[4].trim(),
        };
      })
      .filter(Boolean);
  } catch(e) {
    return [];
  }
}

// ── PARSE FORM 4 XML ──────────────────────────────────────────
async function parseForm4(filing) {
  try {
    const url = `${SEC}/Archives/edgar/${filing.filename}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const xml = await res.text();

    const name  = (xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/) || [])[1]?.trim() || '';
    const title = (xml.match(/<officerTitle>(.*?)<\/officerTitle>/) || [])[1]?.trim() || '';
    const isDir = xml.includes('<isDirector>1</isDirector>');
    const isOff = xml.includes('<isOfficer>1</isOfficer>');
    const role  = title || (isDir ? 'Director' : isOff ? 'Officer' : 'Insider');

    const codeMatches   = [...xml.matchAll(/<transactionCode>(.*?)<\/transactionCode>/g)];
    const sharesMatches = [...xml.matchAll(/<transactionShares>\s*<value>(.*?)<\/value>/g)];
    const priceMatches  = [...xml.matchAll(/<transactionPricePerShare>\s*<value>(.*?)<\/value>/g)];

    const transactions = [];
    for (let j = 0; j < codeMatches.length; j++) {
      const txCode = codeMatches[j]?.[1]?.trim();
      const shares = parseFloat(sharesMatches[j]?.[1] || '0');
      const price  = parseFloat(priceMatches[j]?.[1] || '0') || null;
      if (!txCode || shares <= 0) continue;
      if (!['P', 'S', 'A', 'M'].includes(txCode)) continue;
      transactions.push({
        name, title: role, txCode,
        type:   txCode === 'P' ? 'Purchase' : txCode === 'S' ? 'Sale' : txCode === 'A' ? 'Award' : 'Option',
        shares: Math.round(shares),
        price:  price ? Math.round(price * 100) / 100 : null,
        value:  price ? Math.round(shares * price) : null,
        date:   filing.dateFiled,
      });
    }
    return transactions;
  } catch(e) {
    return null;
  }
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log('🦅 StockRaptor Insider Scan (Bulk Edition) starting...');

  // Load maps in parallel
  const [{ cikToTicker, tickerToCik }, activeSymbols] = await Promise.all([
    loadTickerMap(),
    loadActiveSymbols(),
  ]);

  // Get Form 4 index for last 90 days
  console.log('\n📥 Downloading SEC Form 4 daily indexes (last 90 days)...');
  const allFilings = new Map(); // CIK → [filings]
  let indexDays = 0;

  const endDate   = new Date();
  const startDate = new Date(Date.now() - 90 * 86400000);

  for (let d = new Date(endDate); d >= startDate; d.setDate(d.getDate() - 1)) {
    const day = d.getDay();
    if (day === 0 || day === 6) continue; // skip weekends

    const filings = await getDailyIndex(new Date(d));
    indexDays++;

    for (const f of filings) {
      if (!allFilings.has(f.cik)) allFilings.set(f.cik, []);
      allFilings.get(f.cik).push(f);
    }

    if (indexDays % 10 === 0) {
      process.stdout.write(`\r  ${indexDays} days indexed, ${allFilings.size} companies with filings`);
    }
    await sleep(110); // SEC rate limit
  }

  console.log(`\n   Total: ${indexDays} trading days, ${allFilings.size} companies with Form 4 filings`);

  // Filter to only our active universe
  const relevantCiks = [...allFilings.keys()].filter(cik => {
    const ticker = cikToTicker[cik];
    return ticker && activeSymbols.has(ticker);
  });

  console.log(`\n🔍 Parsing Form 4s for ${relevantCiks.length} companies in our universe...`);

  // Parse Form 4 XMLs for relevant companies
  const results = {};
  let parsed = 0;

  for (const cik of relevantCiks) {
    const ticker = cikToTicker[cik];
    const filings = allFilings.get(cik) || [];
    const allTx = [];

    for (const filing of filings.slice(0, 10)) { // max 10 filings per company
      const txs = await parseForm4(filing);
      if (txs) allTx.push(...txs);
      await sleep(110);
    }

    if (allTx.length > 0) {
      const purchases = allTx.filter(t => t.txCode === 'P');
      const sales     = allTx.filter(t => t.txCode === 'S');
      results[ticker] = {
        buys:           purchases.length,
        sells:          sales.length,
        netChange:      purchases.length - sales.length,
        totalBuyValue:  purchases.reduce((a, t) => a + (t.value || 0), 0),
        totalSellValue: sales.reduce((a, t) => a + (t.value || 0), 0),
        transactions:   allTx.slice(0, 10),
        insiders:       [...new Set(allTx.map(t => t.name))].slice(0, 5),
      };
    }

    parsed++;
    if (parsed % 20 === 0) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      process.stdout.write(`\r  [${parsed}/${relevantCiks.length}] ${elapsed}s | ${Object.keys(results).length} with activity`);
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n\n✅ Done in ${elapsed}s`);
  console.log(`   ${Object.keys(results).length} companies with insider activity`);

  // Save to Supabase in batches
  console.log('💾 Saving to insider_cache...');
  const entries = Object.entries(results);
  const BATCH = 100;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH).map(([symbol, d]) => ({
      symbol,
      updated_at:       new Date().toISOString(),
      buys:             d.buys,
      sells:            d.sells,
      net_change:       d.netChange,
      total_buy_value:  d.totalBuyValue,
      total_sell_value: d.totalSellValue,
      transactions:     d.transactions,
      insiders:         d.insiders,
    }));
    const { error } = await sb.from('insider_cache').upsert(batch);
    if (error) console.error(`  Batch error:`, error.message);
  }

  // Print top buyers
  console.log('\n🏆 Top 10 insider buyers (by value):');
  Object.entries(results)
    .filter(([, d]) => d.buys > 0)
    .sort(([, a], [, b]) => b.totalBuyValue - a.totalBuyValue)
    .slice(0, 10)
    .forEach(([sym, d], i) => {
      const val = d.totalBuyValue > 0 ? ` $${(d.totalBuyValue/1000).toFixed(0)}K` : '';
      console.log(`   ${i+1}. ${sym.padEnd(6)} ${d.buys} buys${val}`);
    });

  console.log(`\n✨ Insider cache updated successfully`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
