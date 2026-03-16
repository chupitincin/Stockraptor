// netlify/functions/quote.js
// Proxy para precios en tiempo real de FMP
// Uso: /.netlify/functions/quote?symbols=AAPL,TSLA,MSFT

const FMP_BASE = 'https://financialmodelingprep.com/stable';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const symbols = event.queryStringParameters?.symbols;
  if (!symbols) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing symbols param' }) };
  }

  const FMP_KEY = process.env.FMP_KEY;
  if (!FMP_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'FMP_KEY not configured' }) };
  }

  try {
    const symList = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);

    // Llamadas individuales en paralelo — más fiable que batch en plan Starter
    const results = await Promise.allSettled(
      symList.map(sym =>
        fetch(`${FMP_BASE}/quote?symbol=${sym}&apikey=${FMP_KEY}`, {
          signal: AbortSignal.timeout(8000)
        }).then(r => r.ok ? r.json() : null).catch(() => null)
      )
    );

    const prices = {};
    results.forEach((result, i) => {
      if (result.status !== 'fulfilled' || !result.value) return;
      const data = result.value;
      const q = Array.isArray(data) ? data[0] : data;
      if (!q?.symbol) return;
      prices[q.symbol] = {
        price:     q.price      ?? null,
        change:    q.change     ?? null,
        changePct: q.changesPercentage ?? (q.change && q.previousClose ? Math.round((q.change / q.previousClose) * 1000) / 10 : null),
        open:      q.open       ?? null,
        high:      q.high       ?? null,
        low:       q.low        ?? null,
        volume:    q.volume     ?? null,
        avgVolume: q.avgVolume  ?? null,
        prevClose: q.previousClose ?? null,
        timestamp: q.timestamp  ?? null,
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify(prices) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
