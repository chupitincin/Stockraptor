// ══════════════════════════════════════════════════════════════
// StockRaptor · Weekly Insider Scan — SEC EDGAR Edition
// Runs every Monday at 07:00 UTC via GitHub Actions
// Downloads ALL Form 4 filings from the last 90 days in one batch
// Saves to Supabase insider_cache table
// ══════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SB_URL || !SB_KEY) {
  console.error('❌ Missing: SUPABASE_URL, SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY);
const SEC_HEADERS = { 'User-Agent': 'StockRaptor research@stockraptor.com' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── LOAD CIK MAP ─────────────────────────────────────────────
async function loadCikMap() {
  console.log('📋 Loading SEC ticker→CIK map...');
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS });
  const data = await res.json();
  const map = {};
  for (const entry of Object.values(data)) {
    map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, '0');
  }
  console.log(`   ${Object.keys(map).length} tickers mapped`);
  return map;
}

// ── LOAD ACTIVE UNIVERSE FROM SUPABASE ───────────────────────
async function loadActiveSymbols() {
  console.log('📊 Loading active symbols from scan_cache...');
  const { data, error } = await sb.from('scan_cache').select('results').eq('id', 'daily').single();
  if (error || !data?.results) {
    console.warn('  No scan_cache found, will use broad universe');
    return null;
  }
  const symbols = data.results.map(r => r.sym).filter(Boolean);
  console.log(`   ${symbols.length} symbols from last scan`);
  return symbols;
}

// ── GET FORM 4 FILINGS FOR A COMPANY ─────────────────────────
async function getInsiderData(sym, cik) {
  try {
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: SEC_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();

    const filings = data.filings?.recent;
    if (!filings) return null;

    // Find Form 4 filings in last 90 days
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const form4s = [];
    for (let i = 0; i < filings.form.length; i++) {
      if ((filings.form[i] === '4' || filings.form[i] === '4/A') &&
          new Date(filings.filingDate[i]) > cutoff) {
        form4s.push(i);
      }
    }

    if (form4s.length === 0) return { buys: 0, sells: 0, netChange: 0, totalBuyValue: 0, totalSellValue: 0, transactions: [], insiders: [] };

    // Fetch XML for each Form 4 (max 15)
    const transactions = [];
    for (const idx of form4s.slice(0, 15)) {
      try {
        const accNum = filings.accessionNumber[idx].replace(/-/g, '');
        const cikNum = parseInt(cik);
        const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNum}/${filings.primaryDocument[idx]}`;
        
        const xmlRes = await fetch(xmlUrl, { headers: SEC_HEADERS });
        if (!xmlRes.ok) continue;
        const xml = await xmlRes.text();

        // Parse XML fields
        const name    = (xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/) || [])[1]?.trim() || '';
        const title   = (xml.match(/<officerTitle>(.*?)<\/officerTitle>/) || [])[1]?.trim() || '';
        const isDir   = xml.includes('<isDirector>1</isDirector>');
        const isOff   = xml.includes('<isOfficer>1</isOfficer>');
        const role    = title || (isDir ? 'Director' : isOff ? 'Officer' : 'Insider');

        // Get all transactions in this filing (there can be multiple)
        const txMatches = [...xml.matchAll(/<transactionAmounts>([\s\S]*?)<\/transactionAmounts>/g)];
        const codeMatches = [...xml.matchAll(/<transactionCode>(.*?)<\/transactionCode>/g)];
        const sharesMatches = [...xml.matchAll(/<transactionShares>\s*<value>(.*?)<\/value>/g)];
        const priceMatches  = [...xml.matchAll(/<transactionPricePerShare>\s*<value>(.*?)<\/value>/g)];

        for (let j = 0; j < codeMatches.length; j++) {
          const txCode = codeMatches[j]?.[1]?.trim();
          const shares = parseFloat(sharesMatches[j]?.[1] || '0');
          const price  = parseFloat(priceMatches[j]?.[1] || '0') || null;

          if (!txCode || shares <= 0) continue;
          if (!['P', 'S', 'A', 'M'].includes(txCode)) continue;

          transactions.push({
            name,
            title: role,
            type: txCode === 'P' ? 'Purchase' : txCode === 'S' ? 'Sale' : txCode === 'A' ? 'Award' : 'Option',
            txCode,
            shares: Math.round(shares),
            price: price ? Math.round(price * 100) / 100 : null,
            value: price ? Math.round(shares * price) : null,
            date: filings.filingDate[idx],
          });
        }

        await sleep(110); // SEC rate limit: 10 req/sec max
      } catch (e) { /* skip failed */ }
    }

    const purchases = transactions.filter(t => t.txCode === 'P');
    const sales     = transactions.filter(t => t.txCode === 'S');

    return {
      buys:           purchases.length,
      sells:          sales.length,
      netChange:      purchases.length - sales.length,
      totalBuyValue:  purchases.reduce((a, t) => a + (t.value || 0), 0),
      totalSellValue: sales.reduce((a, t) => a + (t.value || 0), 0),
      transactions:   transactions.slice(0, 10),
      insiders:       [...new Set(transactions.map(t => t.name))].slice(0, 5),
    };

  } catch (e) {
    return null;
  }
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log('🦅 StockRaptor Insider Scan starting...');

  // Load data sources
  const [cikMap, activeSymbols] = await Promise.all([
    loadCikMap(),
    loadActiveSymbols(),
  ]);

  // Filter to symbols we actually track
  const symbols = activeSymbols
    ? activeSymbols.filter(s => cikMap[s])
    : Object.keys(cikMap).slice(0, 2000);

  console.log(`\n🔍 Scanning ${symbols.length} companies for insider activity...`);

  const results = {};
  let processed = 0, found = 0, errors = 0;

  for (const sym of symbols) {
    const cik = cikMap[sym];
    if (!cik) { errors++; continue; }

    const data = await getInsiderData(sym, cik);
    processed++;

    if (data) {
      results[sym] = data;
      if (data.transactions.length > 0) found++;
    } else {
      errors++;
    }

    if (processed % 50 === 0) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`  [${processed}/${symbols.length}] ${elapsed}s | ${found} with activity`);
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`\n✅ Done in ${elapsed}s | ${found} companies with insider activity | ${errors} errors`);

  // Save to Supabase in batches
  console.log('💾 Saving to Supabase insider_cache...');
  const entries = Object.entries(results);
  const BATCH = 100;

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH).map(([symbol, d]) => ({
      symbol,
      updated_at: new Date().toISOString(),
      buys:            d.buys,
      sells:           d.sells,
      net_change:      d.netChange,
      total_buy_value:  d.totalBuyValue,
      total_sell_value: d.totalSellValue,
      transactions:    d.transactions,
      insiders:        d.insiders,
    }));

    const { error } = await sb.from('insider_cache').upsert(batch);
    if (error) console.error(`  Batch ${i} error:`, error.message);
    else console.log(`  Saved batch ${Math.floor(i/BATCH)+1}/${Math.ceil(entries.length/BATCH)}`);
  }

  // Top insider buyers
  const topBuyers = Object.entries(results)
    .filter(([, d]) => d.buys > 0)
    .sort(([, a], [, b]) => b.totalBuyValue - a.totalBuyValue)
    .slice(0, 10);

  console.log('\n🏆 Top 10 insider buying activity:');
  topBuyers.forEach(([sym, d], i) => {
    const val = d.totalBuyValue > 0 ? ` ($${(d.totalBuyValue/1000).toFixed(0)}K)` : '';
    console.log(`   ${i+1}. ${sym.padEnd(6)} ${d.buys} buys${val} | ${d.insiders[0] || ''}`);
  });

  console.log(`\n✨ Insider cache updated — ${found} companies with recent activity`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
