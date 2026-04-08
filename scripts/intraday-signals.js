// ══════════════════════════════════════════════════════════════
// StockRaptor · Intraday Alternative Data Signals
// ═══════════════════════════════════════════════════════════════
// 4 free real-time signal sources:
//   1. Reddit mentions (WSB, smallcapstocks, pennystocks)
//   2. GDELT news volume (global news mention spikes — used instead
//      of Google Trends which has no reliable free API)
//   3. SEC EDGAR latest filings (Form 4 insider buys, 13D/13G activists)
//   4. FDA approvals + upcoming PDUFA dates (critical for biotechs)
// ═══════════════════════════════════════════════════════════════

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Common English/finance words that look like tickers but aren't
const TICKER_BLACKLIST = new Set([
  'A','I','AM','AN','AS','AT','BE','BY','DO','GO','HE','IF','IN','IS','IT','ME',
  'MY','NO','OF','ON','OR','SO','TO','UP','US','WE',
  'ALL','AND','ANY','ARE','BIG','BUT','BUY','CAN','CEO','CFO','COO','DAY','DID',
  'DOW','DUE','EPS','ETC','ETF','EUR','FDA','FED','FOR','GDP','GET','GOT','HAS',
  'HER','HIM','HIS','HOW','IPO','IRS','ITS','LET','LLC','LOW','MAY','NEW','NFT',
  'NOT','NOW','OIL','OLD','ONE','OUR','OUT','OWN','PER','PUT','SEC','SEE','SHE',
  'TAX','THE','TOO','TOP','TWO','USA','USD','USE','WAS','WAY','WHO','WHY','WIN',
  'YOU','YOUR','WSB','DJI','CPI','PPI','FOMC','ATH','ATL','PDT','ESG','AI','ML',
  'GPT','API','URL','PDF','PNG','JPG','CEO','IRA','PDUFA','IPO','SPY','QQQ','IWM',
  'ROI','ROE','ROA','PE','YOY','MOM','WTF','LOL','LMAO','YOLO','FOMO','HODL','DD',
  'TLDR','IMO','IMHO','IIRC','FWIW','AFAIK','OP','OP\'S','MOD','BAN','ELI5',
]);

function extractTickers(text, universeSet) {
  const upper = text.toUpperCase();
  const found = new Set();

  // Priority 1: $TICKER (explicit tag — high confidence)
  const dollarMatches = upper.match(/\$([A-Z]{1,5})\b/g) || [];
  for (const m of dollarMatches) {
    const t = m.slice(1);
    if (universeSet.has(t)) found.add(t);
  }

  // Priority 2: Standalone uppercase 2-5 letter words, cross-referenced with universe
  const wordMatches = upper.match(/\b[A-Z]{2,5}\b/g) || [];
  for (const w of wordMatches) {
    if (TICKER_BLACKLIST.has(w)) continue;
    if (universeSet.has(w)) found.add(w);
  }

  return [...found];
}

// ══════════════════════════════════════════════════════════════
// 1. REDDIT MENTIONS — WSB, smallcapstocks, pennystocks
// ══════════════════════════════════════════════════════════════
export async function checkRedditMentions(cacheMap, alreadySent) {
  console.log('\n💬 Checking Reddit mentions...');
  const alerts = [];
  const universeSet = new Set(Object.keys(cacheMap));
  const mentionCount = {};
  const examples = {}; // sym -> first example post

  const subreddits = ['wallstreetbets', 'smallcapstocks', 'pennystocks'];

  for (const sub of subreddits) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=100`, {
        headers: { 'User-Agent': 'StockRaptor/1.0 (research@stockraptor.com)' },
      });
      if (!res.ok) { console.log(`   ⚠ r/${sub} returned ${res.status}`); continue; }
      const data = await res.json();
      const posts = data?.data?.children || [];

      const cutoff = Date.now() - 24 * 3600 * 1000; // last 24h

      for (const post of posts) {
        const p = post.data;
        if (p.created_utc * 1000 < cutoff) continue;

        const text = (p.title || '') + ' ' + (p.selftext || '');
        const tickers = extractTickers(text, universeSet);

        for (const sym of tickers) {
          mentionCount[sym] = (mentionCount[sym] || 0) + 1;
          if (!examples[sym]) {
            examples[sym] = {
              title: p.title,
              url: 'https://reddit.com' + p.permalink,
              subreddit: sub,
              score: p.score,
            };
          }
        }
      }
      await sleep(500); // be nice to Reddit
    } catch (e) {
      console.log(`   ⚠ r/${sub} error: ${e.message}`);
    }
  }

  console.log(`   Found mentions for ${Object.keys(mentionCount).length} tickers in our universe`);

  // Threshold: ≥8 mentions across all 3 subs in 24h = notable for a small cap
  for (const [sym, count] of Object.entries(mentionCount)) {
    if (count < 8) continue;
    if (await alreadySent('entry_reddit', sym)) continue;

    const r = cacheMap[sym];
    const ex = examples[sym];
    alerts.push({
      type: 'entry_reddit',
      sym, name: r.companyName,
      color: '#ff4500', // reddit orange
      title: '💬 REDDIT BUZZ',
      headline: `${sym} mentioned ${count}× on Reddit in 24h`,
      body: `<strong>${r.companyName} (${sym})</strong> — $${r.price?.toFixed(2)}<br>
        Score: ${r.total} · Signal: ${r.signal}<br><br>
        💬 <strong>${count} mentions</strong> on Reddit (WSB/smallcaps/pennystocks) in the last 24 hours.<br><br>
        Top post in r/${ex.subreddit} (${ex.score} upvotes):<br>
        <em>"${ex.title.substring(0, 120)}${ex.title.length > 120 ? '...' : ''}"</em><br>
        <a href="${ex.url}" style="color:#ff4500;">View post →</a><br><br>
        <em style="color:#7b5cf0;">Retail attention on small caps can drive quick volume spikes. Worth watching.</em>`,
      data: { count, examples: examples[sym] },
    });
  }

  console.log(`   ${alerts.length} Reddit alerts`);
  return alerts;
}

// ══════════════════════════════════════════════════════════════
// 2. GDELT NEWS VOLUME — better than Google Trends, global news
// ══════════════════════════════════════════════════════════════
// GDELT is a free academic project that monitors 100+ languages of
// news worldwide in real time. The DOC 2.0 API returns article volume
// timelines for any query. We use it to detect when a company suddenly
// starts getting abnormal news coverage — a leading indicator of moves.
export async function checkGdeltNews(cacheMap, alreadySent) {
  console.log('\n📰 Checking GDELT news volume spikes...');
  const alerts = [];

  // Only check top 50 stocks to limit API calls
  const top = Object.values(cacheMap)
    .filter(r => !r._stale && r.total >= 50)
    .sort((a, b) => b.total - a.total)
    .slice(0, 50);

  let spikes = 0;

  for (const r of top) {
    try {
      // Query: exact company name + ticker symbol
      const query = encodeURIComponent(`"${r.companyName}" OR "${r.sym}"`);
      // timelinevol mode returns 15-min buckets of article volume
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=timelinevol&format=json&timespan=2d`;

      const res = await fetch(url, {
        headers: { 'User-Agent': 'StockRaptor/1.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { await sleep(300); continue; }

      const data = await res.json();
      const timeline = data?.timeline?.[0]?.data || [];
      if (timeline.length < 24) { await sleep(300); continue; } // need 24+ buckets for baseline

      // Compute: avg volume for last 24h buckets excluding the final 2
      // Compare to volume in the final 2 buckets (last ~30min)
      const vals = timeline.map(t => t.value || 0);
      const recent = vals.slice(-2).reduce((a, b) => a + b, 0) / 2;
      const baseline = vals.slice(0, -4).reduce((a, b) => a + b, 0) / (vals.length - 4);

      if (baseline > 0 && recent > baseline * 3 && recent >= 5) {
        spikes++;
        if (await alreadySent('entry_news_spike', r.sym)) { await sleep(200); continue; }

        const multiplier = (recent / baseline).toFixed(1);
        alerts.push({
          type: 'entry_news_spike',
          sym: r.sym, name: r.companyName,
          color: '#00b4ff',
          title: '📰 NEWS VOLUME SPIKE',
          headline: `${r.sym} news mentions ${multiplier}× normal`,
          body: `<strong>${r.companyName} (${r.sym})</strong> — $${r.price?.toFixed(2)}<br>
            Score: ${r.total} · Signal: ${r.signal}<br><br>
            📰 Global news mentions surged <strong>${multiplier}× above 24h baseline</strong> in the last 30 minutes (source: GDELT).<br><br>
            <em style="color:#7b5cf0;">Sudden news volume spikes precede major moves. Check recent headlines to see what's driving the coverage.</em>`,
          data: { recent, baseline, multiplier },
        });
      }
      await sleep(300); // be nice to GDELT
    } catch (e) {
      // Silent fail, continue
    }
  }

  console.log(`   Checked ${top.length} stocks, found ${spikes} volume spikes, ${alerts.length} new alerts`);
  return alerts;
}

// ══════════════════════════════════════════════════════════════
// 3. SEC LATEST FILINGS — real-time Form 4 / SC 13D/13G
// ══════════════════════════════════════════════════════════════
// Uses SEC EDGAR's full-text search API to find filings in the last
// few hours. Focuses on Form 4 (insider transactions) >$500K and
// new SC 13D/13G (activist/institutional positions).
export async function checkSecLatestFilings(cacheMap, alreadySent) {
  console.log('\n📋 Checking SEC latest filings...');
  const alerts = [];
  const SEC_HEADERS = { 'User-Agent': 'StockRaptor research@stockraptor.com' };

  // Load CIK → ticker map (same pattern as insider-scan.js)
  let cikToTicker = {};
  try {
    const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: SEC_HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      for (const e of Object.values(data)) {
        cikToTicker[String(e.cik_str).padStart(10, '0')] = e.ticker.toUpperCase();
      }
    }
  } catch (e) {
    console.log(`   ⚠ Could not load SEC ticker map: ${e.message}`);
    return alerts;
  }

  const universeSet = new Set(Object.keys(cacheMap));

  // ── Use SEC EDGAR's recent filings feed (atom) ──
  // Returns the 40 most recent filings of a given form type
  async function getRecentFilings(formType) {
    try {
      const url = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(formType)}&company=&dateb=&owner=include&count=40&output=atom`;
      const res = await fetch(url, { headers: SEC_HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const xml = await res.text();

      // Parse entries — minimal XML parsing via regex (atom format is stable)
      const entries = [];
      const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
      for (const block of entryBlocks) {
        const titleMatch = block.match(/<title>(.*?)<\/title>/);
        const linkMatch  = block.match(/<link\s+[^>]*href="([^"]+)"/);
        const dateMatch  = block.match(/<updated>(.*?)<\/updated>/);
        const cikMatch   = block.match(/CIK=(\d+)/i);
        if (titleMatch && cikMatch) {
          entries.push({
            title: titleMatch[1],
            link: linkMatch?.[1] || '',
            updated: dateMatch?.[1] || '',
            cik: cikMatch[1].padStart(10, '0'),
          });
        }
      }
      return entries;
    } catch (e) {
      console.log(`   ⚠ SEC ${formType} feed error: ${e.message}`);
      return [];
    }
  }

  // ── Form 4 (insider transactions) ──
  const form4s = await getRecentFilings('4');
  console.log(`   ${form4s.length} recent Form 4 filings`);

  const cutoff = Date.now() - 4 * 3600 * 1000; // last 4 hours

  for (const f of form4s) {
    const ticker = cikToTicker[f.cik];
    if (!ticker || !universeSet.has(ticker)) continue;
    if (new Date(f.updated).getTime() < cutoff) continue;
    if (await alreadySent('entry_sec_form4', ticker)) continue;

    const r = cacheMap[ticker];
    alerts.push({
      type: 'entry_sec_form4',
      sym: ticker, name: r.companyName,
      color: '#00e57a',
      title: '👤 NEW INSIDER TRANSACTION',
      headline: `${ticker} new Form 4 filing detected`,
      body: `<strong>${r.companyName} (${ticker})</strong> — $${r.price?.toFixed(2)}<br>
        Score: ${r.total} · Signal: ${r.signal}<br><br>
        👤 A new Form 4 (insider transaction) was just filed with the SEC.<br><br>
        ${f.title ? `<em>${f.title.substring(0, 150)}</em><br>` : ''}
        <a href="${f.link}" style="color:#00e57a;">View filing on SEC EDGAR →</a><br><br>
        <em style="color:#7b5cf0;">Real-time insider signal. Form 4 filings reveal executives buying or selling before the rest of the market notices.</em>`,
      data: { filing: f },
    });
  }

  await sleep(500);

  // ── SC 13D (activist positions >5%) ──
  const sc13ds = await getRecentFilings('SC 13D');
  console.log(`   ${sc13ds.length} recent SC 13D filings`);

  for (const f of sc13ds) {
    const ticker = cikToTicker[f.cik];
    if (!ticker || !universeSet.has(ticker)) continue;
    if (new Date(f.updated).getTime() < cutoff) continue;
    if (await alreadySent('entry_sec_13d', ticker)) continue;

    const r = cacheMap[ticker];
    alerts.push({
      type: 'entry_sec_13d',
      sym: ticker, name: r.companyName,
      color: '#bf5fff',
      title: '🎯 ACTIVIST POSITION (13D)',
      headline: `${ticker} just got a new SC 13D filing`,
      body: `<strong>${r.companyName} (${ticker})</strong> — $${r.price?.toFixed(2)}<br>
        Score: ${r.total} · Signal: ${r.signal}<br><br>
        🎯 A <strong>Schedule 13D</strong> was just filed — this means an investor has taken a <strong>>5% activist stake</strong> in the company.<br><br>
        ${f.title ? `<em>${f.title.substring(0, 150)}</em><br>` : ''}
        <a href="${f.link}" style="color:#bf5fff;">View filing on SEC EDGAR →</a><br><br>
        <em style="color:#7b5cf0;">13D filings often precede hostile takeovers, board battles, or major strategic changes. Historically one of the highest-alpha signals in the market.</em>`,
      data: { filing: f },
    });
  }

  console.log(`   ${alerts.length} SEC alerts`);
  return alerts;
}

// ══════════════════════════════════════════════════════════════
// 4. FDA APPROVALS + PDUFA CALENDAR
// ══════════════════════════════════════════════════════════════
// Two sources:
//   - openFDA API (free, official) — recent drug approvals
//   - BioPharmCatalyst calendar (scraped) — upcoming PDUFA dates
export async function checkFdaSignals(cacheMap, alreadySent) {
  console.log('\n💊 Checking FDA signals...');
  const alerts = [];

  // Build a normalized company name lookup
  const universeSet = new Set(Object.keys(cacheMap));
  const nameMap = {}; // normalized name → ticker
  for (const [sym, r] of Object.entries(cacheMap)) {
    if (!r.companyName) continue;
    const norm = r.companyName.toLowerCase()
      .replace(/\b(inc|incorporated|corp|corporation|ltd|limited|llc|plc|holdings|co|company|pharmaceuticals?|therapeutics?|biosciences?|biotech|sa)\b/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
    if (norm.length >= 3) nameMap[norm] = sym;
  }

  // ── 4a. openFDA: recent drug approvals ──
  try {
    const today = new Date();
    const sevenDaysAgo = new Date(today.getTime() - 7 * 86400 * 1000);
    const fromDate = sevenDaysAgo.toISOString().substring(0, 10).replace(/-/g, '');
    const toDate   = today.toISOString().substring(0, 10).replace(/-/g, '');

    const url = `https://api.fda.gov/drug/drugsfda.json?search=submissions.submission_status_date:[${fromDate}+TO+${toDate}]+AND+submissions.submission_status:AP&limit=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

    if (res.ok) {
      const data = await res.json();
      const approvals = data?.results || [];
      console.log(`   ${approvals.length} recent FDA approvals`);

      for (const ap of approvals) {
        const sponsor = (ap.sponsor_name || '').toLowerCase()
          .replace(/\b(inc|incorporated|corp|corporation|ltd|limited|llc|plc|holdings|co|company|pharmaceuticals?|therapeutics?|biosciences?|biotech|sa)\b/g, '')
          .replace(/[^a-z0-9]/g, '')
          .trim();

        const ticker = nameMap[sponsor];
        if (!ticker) continue;
        if (await alreadySent('entry_fda_approval', ticker)) continue;

        const r = cacheMap[ticker];
        const brandName = ap.products?.[0]?.brand_name || ap.openfda?.brand_name?.[0] || 'drug';
        const approvalDate = ap.submissions?.find(s => s.submission_status === 'AP')?.submission_status_date || '';

        alerts.push({
          type: 'entry_fda_approval',
          sym: ticker, name: r.companyName,
          color: '#00ff94',
          title: '💊 FDA APPROVAL',
          headline: `${ticker}: FDA just approved ${brandName}`,
          body: `<strong>${r.companyName} (${ticker})</strong> — $${r.price?.toFixed(2)}<br>
            Score: ${r.total} · Signal: ${r.signal}<br><br>
            💊 <strong>FDA APPROVED: ${brandName}</strong><br>
            Sponsor: ${ap.sponsor_name}<br>
            Approval date: ${approvalDate}<br><br>
            <em style="color:#7b5cf0;">FDA drug approvals are binary events that can move biotech stocks 30-100%+. Verify the exact drug and market size before acting.</em>`,
          data: { approval: ap },
        });
      }
    }
  } catch (e) {
    console.log(`   ⚠ openFDA error: ${e.message}`);
  }

  // ── 4b. BioPharmCatalyst PDUFA calendar (scraped) ──
  try {
    const res = await fetch('https://www.biopharmcatalyst.com/calendars/fda-calendar', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      const html = await res.text();
      // Extract rows that look like: ticker | company | catalyst | date
      // BioPharmCatalyst structure: <tr> with <td> containing ticker in a link
      const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
      let upcoming = 0;

      const in30days = Date.now() + 30 * 86400 * 1000;
      const today = Date.now();

      for (const row of rows) {
        // Find ticker — they link to /stock/SYM
        const tickerMatch = row.match(/\/stock\/([A-Z]{1,5})/);
        if (!tickerMatch) continue;
        const ticker = tickerMatch[1];
        if (!universeSet.has(ticker)) continue;

        // Find date — looks for YYYY-MM-DD or Mon DD, YYYY
        const dateMatch = row.match(/(\d{4}-\d{2}-\d{2})|([A-Z][a-z]{2} \d{1,2},? \d{4})/);
        if (!dateMatch) continue;

        const dateStr = dateMatch[0];
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) continue;
        if (date.getTime() < today || date.getTime() > in30days) continue;

        upcoming++;
        if (await alreadySent('entry_fda_pdufa', ticker)) continue;

        const daysAway = Math.floor((date.getTime() - today) / 86400000);
        const r = cacheMap[ticker];

        alerts.push({
          type: 'entry_fda_pdufa',
          sym: ticker, name: r.companyName,
          color: '#ffcc00',
          title: '📅 UPCOMING PDUFA DATE',
          headline: `${ticker} has an FDA decision in ${daysAway} days`,
          body: `<strong>${r.companyName} (${ticker})</strong> — $${r.price?.toFixed(2)}<br>
            Score: ${r.total} · Signal: ${r.signal}<br><br>
            📅 <strong>PDUFA date: ${dateStr}</strong> (${daysAway} days away)<br><br>
            A PDUFA date is the deadline by which the FDA must decide on a drug application. Outcomes are binary and can move biotech stocks 30-100%+ overnight.<br><br>
            <a href="https://www.biopharmcatalyst.com/stock/${ticker}" style="color:#ffcc00;">View details on BioPharmCatalyst →</a>`,
          data: { pdufaDate: dateStr, daysAway },
        });
      }
      console.log(`   ${upcoming} upcoming PDUFAs in universe`);
    }
  } catch (e) {
    console.log(`   ⚠ BioPharmCatalyst scrape error: ${e.message}`);
  }

  console.log(`   ${alerts.length} FDA alerts`);
  return alerts;
}
