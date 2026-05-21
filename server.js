const express = require('express');
const rateLimit = require('express-rate-limit');
const path     = require('path');

const app = express();
app.use(express.json({ limit: '4mb' }));

const ACCESS_TOKEN  = process.env.ACCESS_TOKEN       || 'jumo-test';
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN        || ACCESS_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const PORT          = process.env.PORT || 3000;

/* ── Supabase ── */
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

/* ── Rate limiting ── */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Rate limit reached. Wait 15 minutes and try again.' } }
});

/* ── Static files + admin route ── */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

/* ── Anthropic proxy ── */
app.post('/api/messages', limiter, async (req, res) => {
  const token = req.headers['x-access-token'];
  if (!token || token !== ACCESS_TOKEN)
    return res.status(401).json({ error: { message: 'Invalid access token.' } });

  if (!ANTHROPIC_KEY)
    return res.status(500).json({ error: { message: 'Server not configured. Contact admin.' } });

  const { messages, system } = req.body;
  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: { message: 'messages must be a non-empty array.' } });

  const LANG = `\n\nLANGUAGE RULE — ALWAYS FOLLOW: Detect the language of the user's most recent message and respond entirely in that language. English → English only. Kreyòl → Kreyòl only. French → French only. This overrides all other language instructions.`;

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: req.headers['x-broadcast'] === '1' ? 600 : 1500,
    messages,
    ...(system ? { system: system + LANG } : {})
  };

  try {
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(payload)
    });
    const data = await up.json();
    res.status(up.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: { message: 'Upstream error. Try again.' } });
  }
});

/* ── Save / update session (upsert) ── */
app.post('/api/sessions', async (req, res) => {
  const token = req.headers['x-access-token'];
  if (!token || token !== ACCESS_TOKEN)
    return res.status(401).json({ error: 'Invalid access token.' });

  if (!supabase)
    return res.status(503).json({ error: 'Session storage not configured.' });

  const { id, type, persona_name, persona_id, session_timestamp,
          exchanges, broadcast_question, broadcast_results,
          researcher_notes, tester_id } = req.body;

  if (!id || !type)
    return res.status(400).json({ error: 'id and type are required.' });

  const { error } = await supabase.from('jumo_sessions').upsert({
    id, type,
    persona_name:      persona_name      || null,
    persona_id:        persona_id        || null,
    session_timestamp: session_timestamp || null,
    exchanges:         exchanges         || [],
    broadcast_question:broadcast_question|| null,
    broadcast_results: broadcast_results || null,
    researcher_notes:  researcher_notes  || null,
    tester_id:         tester_id         || null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'id' });

  if (error) { console.error('Session save error:', error.message); return res.status(500).json({ error: error.message }); }
  res.json({ success: true });
});

/* ── Read sessions (admin only) ── */
app.get('/api/sessions', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || token !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'Admin token required.' });

  if (!supabase)
    return res.status(503).json({ error: 'Session storage not configured.' });

  const limit   = Math.min(parseInt(req.query.limit) || 200, 500);
  const persona = req.query.persona;
  const type    = req.query.type;
  const tester  = req.query.tester;

  let q = supabase.from('jumo_sessions').select('*')
    .order('created_at', { ascending: false }).limit(limit);
  if (persona) q = q.eq('persona_id', persona);
  if (type)    q = q.eq('type', type);
  if (tester)  q = q.eq('tester_id', tester);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/* ── Health ── */
app.get('/health', (req, res) => res.json({
  status: 'ok',
  supabase: supabase ? 'connected' : 'not configured'
}));

app.listen(PORT, () => {
  console.log(`JUMO on port ${PORT}`);
  console.log(`Anthropic key:  ${ANTHROPIC_KEY  ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`Supabase:       ${supabase        ? 'connected ✓' : 'not configured'}`);
  console.log(`Admin token:    ${ADMIN_TOKEN !== ACCESS_TOKEN ? 'separate ✓' : 'same as access token'}`);
});
