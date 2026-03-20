// netlify/functions/quote.js
// Proxy para precios en tiempo real via Yahoo Finance (gratis, sin API key)
// Uso: /.netlify/functions/quote?symbols=AAPL,TSLA
// Uso histórico: /.netlify/functions/quote?sym=AAPL&interval=1d&range=1mo&history=1

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const p = event.queryStringParameters || {};

  // ── HISTORICAL CHART MODE ──────────────────────────────────
  if (p.history === '1' && p.sym) {
    const sym      = p.sym.trim().toUpperCase();
    const interval = p.interval || '1d';
    const range    = p.range    || '1mo';

    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=${interval}&range=${range}&includePrePost=false`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return { statusCode: 200, headers, body: JSON.stringify({ prices: [], labels: [] }) };

      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) return { statusCode: 200, headers, body: JSON.stringify({ prices: [], labels: [] }) };

      const timestamps = result.timestamp || [];
      const closes     = result.indicators?.quote?.[0]?.close || [];

      const prices = [], labels = [];
      timestamps.forEach((ts, i) => {
        const price = closes[i];
        if (price == null || isNaN(price)) return;
        prices.push(Math.round(price * 100) / 100);

        const d = new Date(ts * 1000);
        // Format label based on interval
        if (interval.includes('m') || interval.includes('h')) {
          labels.push(d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }));
        } else if (range === '1y' || range === '2y') {
          labels.push(d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
        } else {
          labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        }
      });

      return { statusCode: 200, headers, body: JSON.stringify({ prices, labels, sym }) };
    } catch(err) {
      return { statusCode: 200, headers, body: JSON.stringify({ prices: [], labels: [] }) };
    }
  }

  // ── COMPANY PROFILE MODE (website) ───────────────────────
  if (p.profile === '1' && p.symbols) {
    const sym = p.symbols.trim().toUpperCase();
    const FMP_KEY = process.env.FMP_KEY;
    if (!FMP_KEY) return { statusCode: 200, headers, body: JSON.stringify({}) };
    try {
      const res = await fetch(
        `https://financialmodelingprep.com/api/v3/profile/${sym}?apikey=${FMP_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!res.ok) return { statusCode: 200, headers, body: JSON.stringify({}) };
      const data = await res.json();
      const profile = data?.[0] || {};
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          website:     profile.website     || null,
          description: profile.description || null,
          ceo:         profile.ceo         || null,
          employees:   profile.fullTimeEmployees || null,
          ipo:         profile.ipoDate     || null,
        })
      };
    } catch(e) {
      return { statusCode: 200, headers, body: JSON.stringify({}) };
    }
  }

  // ── LIVE PRICE MODE ────────────────────────────────────────
  const symbols = p.symbols;
  if (!symbols) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing symbols param' }) };

  try {
    const symList = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 50);

    const results = await Promise.allSettled(
      symList.map(sym =>
        fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) }
        ).then(r => r.ok ? r.json() : null).catch(() => null)
      )
    );

    const prices = {};
    results.forEach((result, i) => {
      if (result.status !== 'fulfilled' || !result.value) return;
      const sym = symList[i];
      try {
        const meta = result.value?.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return;
        const price = meta.regularMarketPrice;
        const prevClose = meta.previousClose ?? meta.chartPreviousClose;
        prices[sym] = {
          price,
          change:    prevClose ? Math.round((price - prevClose) * 100) / 100 : null,
          changePct: prevClose ? Math.round(((price - prevClose) / prevClose) * 1000) / 10 : null,
          open:      meta.regularMarketOpen       ?? null,
          high:      meta.regularMarketDayHigh    ?? null,
          low:       meta.regularMarketDayLow     ?? null,
          volume:    meta.regularMarketVolume     ?? null,
          avgVolume: meta.averageDailyVolume10Day ?? meta.averageDailyVolume3Month ?? null,
          prevClose: prevClose ?? null,
          timestamp: meta.regularMarketTime       ?? null,
        };
      } catch (_) {}
    });

    return { statusCode: 200, headers, body: JSON.stringify(prices) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
