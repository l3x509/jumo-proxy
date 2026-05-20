const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

const ACCESS_TOKEN   = process.env.ACCESS_TOKEN   || 'jumo-test';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const PORT           = process.env.PORT || 3000;

/* ── Rate limiting ── */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,                   // 60 requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Rate limit reached. Wait 15 minutes and try again.' } }
});

/* ── Static files (the HTML shell) ── */
app.use(express.static(path.join(__dirname, 'public')));

/* ── Anthropic proxy ── */
app.post('/api/messages', limiter, async (req, res) => {
  // Validate shared access token
  const token = req.headers['x-access-token'];
  if (!token || token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: { message: 'Invalid access token. Ask the admin for the correct token.' } });
  }

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not set on server. Contact admin.' } });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(502).json({ error: { message: 'Upstream error: ' + err.message } });
  }
});

/* ── Health check ── */
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`JUMO proxy running on port ${PORT}`);
  console.log(`Access token: ${ACCESS_TOKEN}`);
  console.log(`Anthropic key: ${ANTHROPIC_KEY ? 'SET ✓' : 'MISSING ✗'}`);
});
