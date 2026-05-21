const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

const ACCESS_TOKEN  = process.env.ACCESS_TOKEN || 'jumo-test';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT          = process.env.PORT || 3000;

/* ── Rate limiting ── */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Rate limit reached. Wait 15 minutes and try again.' } }
});

/* ── Static files ── */
app.use(express.static(path.join(__dirname, 'public')));

/* ── Anthropic proxy ── */
app.post('/api/messages', limiter, async (req, res) => {
  const token = req.headers['x-access-token'];
  if (!token || token !== ACCESS_TOKEN) {
    return res.status(401).json({ error: { message: 'Invalid access token.' } });
  }

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: { message: 'Server is not configured. Contact admin.' } });
  }

  // Whitelist only safe fields — client cannot control model params beyond these
  const { messages, system } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages must be a non-empty array.' } });
  }

  const payload = {
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,           // server-controlled — client cannot override
    messages,
    ...(system ? { system } : {})
  };

  // Broadcast requests (10 personas) get a shorter cap to control cost
  if (req.headers['x-broadcast'] === '1') {
    payload.max_tokens = 600;
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(payload)
    });

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: { message: 'Upstream connection error. Try again.' } });
  }
});

/* ── Health check ── */
app.get('/health', (req, res) => res.json({ status: 'ok', personas: 'loaded via static file' }));

app.listen(PORT, () => {
  console.log(`JUMO proxy on port ${PORT}`);
  console.log(`Access token: ${ACCESS_TOKEN ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`Anthropic key: ${ANTHROPIC_KEY ? 'SET ✓' : 'MISSING ✗'}`);
});
