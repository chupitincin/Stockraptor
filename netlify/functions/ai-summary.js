// netlify/functions/ai-summary.js
// Genera resúmenes AI para daily picks y los guarda en Supabase
// Una vez generados quedan en caché — todos los usuarios ven el mismo texto

import { createClient } from '@supabase/supabase-js';

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '' };

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const SB_URL        = process.env.SUPABASE_URL;
  const SB_SERVICE    = process.env.SUPABASE_SERVICE_KEY;

  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  try {
    const { prompt, sym } = JSON.parse(event.body || '{}');
    if (!prompt || !sym) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing prompt or sym' }) };
    }

    // Generate summary via Claude
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const err = await res.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: err }) };
    }

    const data = await res.json();
    const summary = data.content?.[0]?.text?.trim() || null;

    // Save back to picks_cache so it's cached for all users permanently
    if (summary && SB_URL && SB_SERVICE) {
      try {
        const sb = createClient(SB_URL, SB_SERVICE);
        const { data: cache } = await sb
          .from('picks_cache')
          .select('picks')
          .eq('id', 'daily')
          .single();

        if (cache?.picks) {
          const updated = cache.picks.map(p =>
            p.sym === sym ? { ...p, aiSummary: summary } : p
          );
          await sb.from('picks_cache').update({ picks: updated }).eq('id', 'daily');
        }
      } catch (saveErr) {
        // Save failed but still return the summary to the user
        console.warn('Failed to save summary to cache:', saveErr.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ summary, sym }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
