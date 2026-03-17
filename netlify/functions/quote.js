// netlify/functions/quote.js
// Live prices via Yahoo Finance — free, no API key needed
// Usage: /.netlify/functions/quote?symbols=AAPL,TSLA,MSFT

export const handler = async (event) => {
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

    try {
          const symList = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);

      const results = await Promise.allSettled(
              symList.map(sym =>
                        fetch(
                                    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`,
                          {
                                        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
                                        signal: AbortSignal.timeout(8000),
                          }
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
