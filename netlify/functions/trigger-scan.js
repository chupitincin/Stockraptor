// netlify/functions/trigger-scan.js
// Triggers the GitHub Actions daily scan workflow on demand.
// Only accessible to Elite users — verified via Supabase.

const { createClient } = require('@supabase/supabase-js');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;       // GitHub PAT with workflow scope
const GITHUB_OWNER = process.env.GITHUB_OWNER;       // e.g. 'chupitincin'
const GITHUB_REPO  = process.env.GITHUB_REPO;        // e.g. 'Stockraptor'
const WORKFLOW_ID  = 'daily-scan.yml';               // workflow filename

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // ── 1. Verify user is Elite ───────────────────────────
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const token = authHeader.replace('Bearer ', '');
    const sb = createClient(SB_URL, SB_KEY);

    // Verify the JWT and get the user
    const { data: { user }, error: authError } = await sb.auth.getUser(token);
    if (authError || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
    }

    // Check plan in profiles table
    const { data: profile } = await sb.from('profiles').select('plan').eq('id', user.id).single();
    if (!profile || profile.plan !== 'elite') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Elite plan required' }) };
    }

    // ── 2. Check if scan is already running ───────────────
    // Avoid triggering multiple scans simultaneously
    const runsRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_ID}/runs?status=in_progress&per_page=1`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' } }
    );
    const runsData = await runsRes.json();
    if (runsData.total_count > 0) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'Scan already running', running: true }) };
    }

    // ── 3. Trigger GitHub Actions workflow ────────────────
    const triggerRes = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_ID}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({ ref: 'main' })
      }
    );

    if (!triggerRes.ok) {
      const err = await triggerRes.text();
      console.error('GitHub dispatch error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to trigger scan' }) };
    }

    // GitHub returns 204 No Content on success
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Scan triggered successfully' })
    };

  } catch (e) {
    console.error('trigger-scan error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
