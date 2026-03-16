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
    // FMP /quote acepta símbolo único: hacemos batch en paralelo (máx 10 a la vez)
    const symList = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);

    // FMP stable endpoint acepta comma-separated en /quote
    const url = `${FMP_BASE}/quote?symbol=${symList.join(',')}&apikey=${FMP_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: `FMP error ${res.status}` }) };
    }

    const data = await res.json();

    // Devolver solo los campos necesarios para precio live (minimizar payload)
    const prices = {};
    (Array.isArray(data) ? data : [data]).forEach(q => {
      if (!q?.symbol) return;
      prices[q.symbol] = {
        price:      q.price       ?? null,
        change:     q.change      ?? null,
        changePct:  q.changesPercentage ?? null,
        open:       q.open        ?? null,
        high:       q.dayHigh     ?? null,
        low:        q.dayLow      ?? null,
        volume:     q.volume      ?? null,
        avgVolume:  q.avgVolume   ?? null,
        prevClose:  q.previousClose ?? null,
        timestamp:  q.timestamp   ?? null,
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify(prices) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
