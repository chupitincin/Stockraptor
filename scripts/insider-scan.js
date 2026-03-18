// ══════════════════════════════════════════════════════════════
// StockRaptor · Weekly Insider Scan — SEC EDGAR Master Index
// Uses quarterly full-index to get ALL Form 4s efficiently
// ══════════════════════════════════════════════════════════════
import { createClient } from '@supabase/supabase-js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SB_URL || !SB_KEY) { console.error('❌ Missing env vars'); process.exit(1); }

const sb = createClient(SB_URL, SB_KEY);
const SEC = 'https://www.sec.gov';
const HEADERS = { 'User-Agent': 'StockRaptor research@stockraptor.com' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getQuarterInfo(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const q = m <= 3 ? 1 : m <= 6 ? 2 : m <= 9 ? 3 : 4;
  return { year: y, quarter: q, qtr: `QTR${q}` };
}

// ── LOAD CIK MAP ─────────────────────────────────────────────
async function loadTickerMap() {
  console.log('📋 Loading SEC ticker map...');
  const res = await fetch(`${SEC}/files/company_tickers.json`, { headers: HEADERS });
  const data = await res.json();
  const cikToTicker = {}, tickerToCik = {};
  for (const e of Object.values(data)) {
    const cik = String(e.cik_str).padStart(10, '0');
    cikToTicker[cik] = e.ticker.toUpperCase();
    tickerToCik[e.ticker.toUpperCase()] = cik;
  }
  console.log(`   ${Object.keys(cikToTicker).length} tickers`);
  return { cikToTicker, tickerToCik };
}

// ── LOAD ACTIVE SYMBOLS ───────────────────────────────────────
async function loadActiveSymbols() {
  const { data } = await sb.from('scan_cache').select('results').eq('id','daily').single();
  const syms = new Set(data?.results?.map(r => r.sym).filter(Boolean) || []);
  console.log(`📊 ${syms.size} active symbols`);
  return syms;
}

// ── GET FORM 4 FILINGS FROM QUARTERLY INDEX ───────────────────
async function getQuarterlyForm4s(year, qtr) {
  const url = `${SEC}/Archives/edgar/full-index/${year}/${qtr}/form.idx`;
  console.log(`  Fetching ${year}/${qtr}...`);
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { console.log(`  Not found: ${url}`); return []; }
    const text = await res.text();
    const lines = text.split('\n');

    // Line 7 (index 6) is the header row — use it to find column positions
    // Format: "Form Type           Company Name            CIK         Date Filed  Filename"
    const headerLine = lines[7] || lines[6] || '';
    const typeLoc  = headerLine.indexOf('Form Type');
    const nameLoc  = headerLine.indexOf('Company Name');
    const cikLoc   = headerLine.indexOf('CIK');
    const dateLoc  = headerLine.indexOf('Date Filed');
    const urlLoc   = headerLine.indexOf('Filename');

    if (typeLoc === -1 || urlLoc === -1) {
      // Fallback: use known fixed positions from SEC docs
      // Form Type(0-12), Company(12-74), CIK(74-86), Date(86-98), Filename(98+)
      const filings = [];
      for (const line of lines.slice(9)) {
        if (line.length < 100) continue;
        const formType = line.substring(0, 12).trim();
        if (formType !== '4' && formType !== '4/A') continue;
        const cik       = line.substring(74, 86).trim().padStart(10, '0');
        const dateFiled = line.substring(86, 98).trim();
        const filename  = line.substring(98).trim();
        if (cik && dateFiled && filename) filings.push({ cik, formType, dateFiled, filename });
      }
      console.log(`  ${filings.length} Form 4 filings (fallback parser)`);
      return filings;
    }

    // Use dynamic positions from header
    const filings = [];
    for (const line of lines.slice(9)) {
      if (line.length < urlLoc) continue;
      const formType  = line.substring(typeLoc, nameLoc).trim();
      if (formType !== '4' && formType !== '4/A') continue;
      const cik       = line.substring(cikLoc, dateLoc).trim().padStart(10, '0');
      const dateFiled = line.substring(dateLoc, urlLoc).trim();
      const filename  = line.substring(urlLoc).trim();
      if (cik && dateFiled && filename) filings.push({ cik, formType, dateFiled, filename });
    }
    console.log(`  ${filings.length} Form 4 filings found`);
    return filings;
  } catch(e) {
    console.warn(`  Error: ${e.message}`);
    return [];
  }
}

// ── PARSE FORM 4 XML ──────────────────────────────────────────
async function parseForm4(filename, companyCik) {
  try {
    // filename from form.idx: edgar/data/FILER_CIK/ACCESSION.txt
    // But XML is always at: data/COMPANY_CIK/ACCESSION_NO_DASHES/ownership.xml
    const accWithDashes = filename.split('/').pop().replace('.txt', '');
    const accNoDashes   = accWithDashes.replace(/-/g, '');
    // Use company CIK (not filer CIK) for the path
    const xmlUrl = `${SEC}/Archives/edgar/data/${parseInt(companyCik)}/${accNoDashes}/ownership.xml`;

    await sleep(110); // SEC rate limit
    const res = await fetch(xmlUrl, { headers: HEADERS });
    if (!res.ok) {
      // Fallback: try with the filer CIK from filename
      const filerCik = filename.split('/')[2];
      const xmlUrl2  = `${SEC}/Archives/edgar/data/${parseInt(filerCik)}/${accNoDashes}/ownership.xml`;
      const res2 = await fetch(xmlUrl2, { headers: HEADERS });
      if (!res2.ok) return null;
      const xml2 = await res2.text();
      return extractTransactions(xml2, accWithDashes);
    }
    const xml = await res.text();
    return extractTransactions(xml, accWithDashes);
  } catch(e) { return null; }
}

function extractTransactions(xml, date) {
  const name  = (xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/) || [])[1]?.trim() || '';
  const title = (xml.match(/<officerTitle>(.*?)<\/officerTitle>/) || [])[1]?.trim() || '';
  const isDir = xml.includes('<isDirector>1</isDirector>');
  const isOff = xml.includes('<isOfficer>1</isOfficer>');
  const role  = title || (isDir ? 'Director' : isOff ? 'Officer' : 'Insider');

  const codes  = [...xml.matchAll(/<transactionCode>(.*?)<\/transactionCode>/g)];
  const shares = [...xml.matchAll(/<transactionShares>\s*<value>(.*?)<\/value>/g)];
  const prices = [...xml.matchAll(/<transactionPricePerShare>\s*<value>(.*?)<\/value>/g)];

  const txs = [];
  for (let i = 0; i < codes.length; i++) {
    const txCode = codes[i]?.[1]?.trim();
    const sh     = parseFloat(shares[i]?.[1] || '0');
    const pr     = parseFloat(prices[i]?.[1] || '0') || null;
    if (!txCode || sh <= 0 || !['P','S','A','M'].includes(txCode)) continue;
    txs.push({
      name, title: role, txCode,
      type:   txCode==='P'?'Purchase':txCode==='S'?'Sale':txCode==='A'?'Award':'Option',
      shares: Math.round(sh),
      price:  pr ? Math.round(pr*100)/100 : null,
      value:  pr ? Math.round(sh*pr) : null,
    });
  }
  return txs.length > 0 ? { name, role, txs } : null;
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log('🦅 StockRaptor Insider Scan v3 starting...\n');

  const [{ cikToTicker }, activeSymbols] = await Promise.all([
    loadTickerMap(),
    loadActiveSymbols(),
  ]);

  // Get relevant quarters (last 90 days = current + maybe previous quarter)
  const now    = new Date();
  const q1     = getQuarterInfo(now);
  const q2     = getQuarterInfo(new Date(Date.now() - 90*86400000));
  const quarters = [q1];
  if (q2.year !== q1.year || q2.quarter !== q1.quarter) quarters.push(q2);

  console.log(`\n📥 Loading Form 4 indexes for ${quarters.map(q=>`${q.year}/${q.qtr}`).join(', ')}...`);

  // Get all Form 4 filings from relevant quarters
  let allFilings = [];
  for (const { year, qtr } of quarters) {
    const filings = await getQuarterlyForm4s(year, qtr);
    allFilings = allFilings.concat(filings);
    await sleep(200);
  }

  // Filter to last 90 days and our universe
  const cutoff = new Date(Date.now() - 90*86400000).toISOString().substring(0,10);
  const relevant = allFilings.filter(f => {
    if (f.dateFiled < cutoff) return false;
    const ticker = cikToTicker[f.cik];
    return ticker && activeSymbols.has(ticker);
  });

  // Group by CIK
  const byCik = {};
  for (const f of relevant) {
    if (!byCik[f.cik]) byCik[f.cik] = [];
    byCik[f.cik].push(f);
  }

  const uniqueCompanies = Object.keys(byCik).length;
  console.log(`\n🔍 ${relevant.length} Form 4s for ${uniqueCompanies} companies in our universe (last 90d)`);
  console.log('   Parsing XML filings...\n');

  // Parse each filing
  const results = {};
  let parsed = 0, withActivity = 0;

  for (const [cik, filings] of Object.entries(byCik)) {
    const ticker = cikToTicker[cik];
    const allTx = [];
    const insiderNames = new Set();

    for (const f of filings.slice(0, 8)) {
      const parsed = await parseForm4(f.filename, cik);
      if (parsed) {
        allTx.push(...parsed.txs.map(t => ({ ...t, date: f.dateFiled })));
        insiderNames.add(parsed.name);
      }
      await sleep(110);
    }

    if (allTx.length > 0) {
      const buys  = allTx.filter(t => t.txCode === 'P');
      const sells = allTx.filter(t => t.txCode === 'S');
      results[ticker] = {
        buys:           buys.length,
        sells:          sells.length,
        netChange:      buys.length - sells.length,
        totalBuyValue:  buys.reduce((a,t) => a+(t.value||0), 0),
        totalSellValue: sells.reduce((a,t) => a+(t.value||0), 0),
        transactions:   allTx.slice(0, 10),
        insiders:       [...insiderNames].slice(0, 5),
      };
      withActivity++;
    }

    parsed++;
    if (parsed % 25 === 0) {
      const elapsed = Math.round((Date.now()-t0)/1000);
      process.stdout.write(`\r  [${parsed}/${uniqueCompanies}] ${elapsed}s | ${withActivity} with activity`);
    }
  }

  const elapsed = Math.round((Date.now()-t0)/1000);
  console.log(`\n\n✅ Done in ${elapsed}s | ${withActivity} companies with insider activity`);

  // Save to Supabase
  console.log('💾 Saving to insider_cache...');
  const entries = Object.entries(results);
  for (let i = 0; i < entries.length; i += 100) {
    const batch = entries.slice(i, i+100).map(([symbol, d]) => ({
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
    if (error) console.error('Batch error:', error.message);
  }

  console.log('\n🏆 Top 10 insider buyers:');
  Object.entries(results)
    .filter(([,d]) => d.buys > 0)
    .sort(([,a],[,b]) => b.totalBuyValue - a.totalBuyValue)
    .slice(0,10)
    .forEach(([sym,d],i) => {
      const val = d.totalBuyValue > 0 ? ` $${(d.totalBuyValue/1000).toFixed(0)}K` : '';
      console.log(`   ${i+1}. ${sym.padEnd(6)} ${d.buys} buys${val}`);
    });

  console.log(`\n✨ Done — ${withActivity} companies with insider activity saved`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
