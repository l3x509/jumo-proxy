const express = require('express');
const rateLimit = require('express-rate-limit');
const path     = require('path');

const app = express();
app.use(express.json({ limit: '4mb' }));

const ACCESS_TOKEN  = process.env.ACCESS_TOKEN        || 'jumo-test';
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN         || ACCESS_TOKEN;
const PARTNER_TOKEN = process.env.PARTNER_TOKEN       || 'partner-test';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const PORT          = process.env.PORT || 3000;

/* ── Domain labels (for send-to-partner) ── */
const DOMAIN_LABELS = {
  health:           'Health & Wellbeing',
  family:           'Family & Community',
  economic:         'Economic Life',
  institutional:    'Institutional Relationships',
  religious:        'Religious & Spiritual Life',
  education:        'Education & Knowledge',
  language_profile: 'Language Profile',
};

/* ── Persona files (source of truth for baseline content) ── */
const filePersonas = require('./personas/index');
const { buildSystemPrompt, validatePersona } = require('./personas/builder');

/*
 * personaCache — in-memory store used for every conversation.
 *
 * Priority on reads:
 *   1. Cache hit → return immediately
 *   2. Supabase (if connected) → load, cache, return
 *   3. File fallback → return from filePersonas
 *
 * Cache is invalidated when:
 *   - A PUT /api/personas/:id is called (admin saves)
 *   - Server restarts (cache is rebuilt from files + Supabase sync)
 */
const personaCache = { ...filePersonas };

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

const broadcastLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: { message: 'Broadcast rate limit reached. Wait 1 minute.' } }
});

/* ── Auth + storage guards ────────────────────────────────────────
   Use these at the top of every route handler.
   Returns false and sends the error response if auth fails,
   so callers just do: if (!requireAdmin(req, res)) return;
   ─────────────────────────────────────────────────────────────── */
const getToken = (req) =>
  req.query.token || req.headers['x-admin-token'] || req.headers['x-partner-token'] || '';

const requireAdmin = (req, res) => {
  const t = getToken(req);
  if (!t || t !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'Admin token required.' });
    return false;
  }
  return true;
};

const requirePartner = (req, res) => {
  const t = getToken(req);
  if (!t || (t !== PARTNER_TOKEN && t !== ADMIN_TOKEN)) {
    res.status(401).json({ error: 'Partner token required.' });
    return false;
  }
  return true;
};

const requireAccess = (req, res) => {
  const t = req.headers['x-access-token'] || '';
  if (!t || t !== ACCESS_TOKEN) {
    res.status(401).json({ error: 'Invalid access token.' });
    return false;
  }
  return true;
};

const requireStorage = (req, res) => {
  if (!supabase) {
    res.status(503).json({ error: 'Storage not configured.' });
    return false;
  }
  return true;
};

/* ── Static files ── */
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/partner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

/* ═══════════════════════════════════════════════════════════
   PERSONA HELPERS
   ═══════════════════════════════════════════════════════════ */

/**
 * getPersona(id)
 * Returns a persona object from cache, Supabase, or file.
 * Always returns something if the persona ID is valid.
 */
async function getPersona(id) {
  // 1. Cache hit
  if (personaCache[id]) return personaCache[id];

  // 2. Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('jumo_personas')
        .select('*')
        .eq('id', id)
        .single();
      if (!error && data) {
        personaCache[id] = data;
        return data;
      }
    } catch (e) {
      console.warn(`Supabase persona fetch failed for ${id}:`, e.message);
    }
  }

  // 3. File fallback
  return filePersonas[id] || null;
}

/**
 * syncPersonasOnStartup()
 *
 * Batch version — 2 Supabase queries regardless of persona count.
 *
 * Query 1: fetch all existing persona IDs + versions from DB
 * Query 2: batch upsert only what changed (new or file-is-newer)
 *
 * Version rules:
 *   - Not in DB yet           → insert from file
 *   - File version > DB       → update DB (committed change wins)
 *   - DB version >= file      → load full DB record into cache (portal edit wins)
 *
 * To promote a portal edit to permanent:
 *   export JSON → bump version → commit → redeploy → file wins
 */
async function syncPersonasOnStartup() {
  if (!supabase) return;

  const now = new Date().toISOString();

  try {
    // Query 1: get all existing persona id+version from DB (one round trip)
    const { data: dbRows, error: fetchErr } = await supabase
      .from('jumo_personas')
      .select('id, version');

    if (fetchErr) throw fetchErr;

    const dbVersionMap = Object.fromEntries(
      (dbRows || []).map(r => [r.id, r.version || 0])
    );

    const toUpsert    = [];  // new or file-is-newer
    const toLoadFromDb = []; // DB is newer — need full record for cache

    for (const [id, filePersona] of Object.entries(filePersonas)) {
      const fileVersion = filePersona.version || 1;
      const dbVersion   = dbVersionMap[id];

      if (dbVersion === undefined) {
        // New persona — not in DB yet
        toUpsert.push({ ...filePersona, created_at: now, updated_at: now });
        personaCache[id] = filePersona;
      } else if (fileVersion > dbVersion) {
        // File is newer — update DB
        toUpsert.push({ ...filePersona, updated_at: now });
        personaCache[id] = filePersona;
      } else {
        // DB is newer or equal — need to load full record
        toLoadFromDb.push(id);
      }
    }

    // Query 2a: batch upsert all new/updated personas (one round trip)
    if (toUpsert.length) {
      const { error: upsertErr } = await supabase
        .from('jumo_personas')
        .upsert(toUpsert, { onConflict: 'id' });
      if (upsertErr) console.warn('  Upsert warning:', upsertErr.message);
      else console.log(`  Upserted ${toUpsert.length} persona(s) from files`);
    }

    // Query 2b: load full records for DB-newer personas (one round trip)
    if (toLoadFromDb.length) {
      const { data: fullRecords, error: loadErr } = await supabase
        .from('jumo_personas')
        .select('*')
        .in('id', toLoadFromDb);

      if (!loadErr && fullRecords) {
        fullRecords.forEach(p => { personaCache[p.id] = p; });
        console.log(`  Loaded ${fullRecords.length} persona(s) from DB (portal edits)`);
      }
    }

    console.log(`  Cache ready: ${Object.keys(personaCache).length} personas`);

  } catch (e) {
    console.warn('  Startup sync failed — using file personas:', e.message);
    // personaCache already populated from filePersonas at declaration
  }
}

/* ═══════════════════════════════════════════════════════════
   AUTH — returns role based on token
   ═══════════════════════════════════════════════════════════ */
app.get('/api/auth', (req, res) => {
  const token = req.query.token || req.headers['x-admin-token'];
  if (!token)                  return res.status(401).json({ error: 'Token required.' });
  if (token === ADMIN_TOKEN)   return res.json({ role: 'admin' });
  if (token === PARTNER_TOKEN) return res.json({ role: 'partner' });
  return res.status(401).json({ error: 'Invalid token.' });
});

/* ═══════════════════════════════════════════════════════════
   ANTHROPIC PROXY
   Now supports persona_id for server-side prompt resolution.

   Client sends either:
     { persona_id: 'marie-ange', messages: [...] }   ← new: server builds prompt
     { system: '...', messages: [...] }               ← legacy: client provides prompt
   ═══════════════════════════════════════════════════════════ */
app.post('/api/messages', limiter, async (req, res) => {
  if (!requireAccess(req, res)) return;

  if (!ANTHROPIC_KEY)
    return res.status(500).json({ error: { message: 'Server not configured.' } });

  /* Apply tighter rate limit to broadcast requests */
  if (req.headers['x-broadcast'] === '1') {
    return broadcastLimiter(req, res, () => handleMessage(req, res));
  }
  return handleMessage(req, res);
});

async function handleMessage(req, res) {
  const { messages, system, persona_id } = req.body;

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: { message: 'messages must be a non-empty array.' } });

  // Resolve system prompt
  let resolvedSystem = '';

  if (persona_id) {
    // Server-side resolution — client never sees the prompt
    const persona = await getPersona(persona_id);
    if (!persona) {
      return res.status(404).json({ error: { message: `Unknown persona: ${persona_id}` } });
    }
    resolvedSystem = buildSystemPrompt(persona);
  } else if (system) {
    // Legacy: client-provided system prompt (test shell backward compat)
    resolvedSystem = system;
  }

  const LANG = `\n\nLANGUAGE RULE — ALWAYS FOLLOW: Detect the language of the user's most recent message and respond entirely in that language. English → English only. Kreyòl → Kreyòl only. French → French only. This overrides all other language instructions.`;

  const payload = {
    model:      'claude-sonnet-4-6',
    max_tokens: req.headers['x-broadcast'] === '1' ? 600 : 1500,
    messages,
    ...(resolvedSystem ? { system: resolvedSystem + LANG } : {}),
  };

  try {
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    const data = await up.json();
    res.status(up.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: { message: 'Upstream error. Try again.' } });
  }
}

/* ═══════════════════════════════════════════════════════════
   SESSIONS — original routes unchanged
   ═══════════════════════════════════════════════════════════ */
app.post('/api/sessions', async (req, res) => {
  if (!requireAccess(req, res))  return;
  if (!requireStorage(req, res)) return;

  const {
    id, type, persona_name, persona_id, session_timestamp,
    exchanges, broadcast_question, broadcast_results,
    researcher_notes, tester_id,
  } = req.body;

  if (!id || !type)
    return res.status(400).json({ error: 'id and type are required.' });

  const { error } = await supabase.from('jumo_sessions').upsert({
    id, type,
    persona_name:       persona_name       || null,
    persona_id:         persona_id         || null,
    session_timestamp:  session_timestamp  || null,
    exchanges:          exchanges          || [],
    broadcast_question: broadcast_question || null,
    broadcast_results:  broadcast_results  || null,
    researcher_notes:   researcher_notes   || null,
    tester_id:          tester_id          || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'id' });

  if (error) {
    console.error('Session save error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  res.json({ success: true });
});

app.get('/api/sessions', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

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

/* ═══════════════════════════════════════════════════════════
   PERSONAS — admin only
   ═══════════════════════════════════════════════════════════ */

/*
 * GET /api/personas — lightweight list for sidebar
 *
 * Returns only what the admin sidebar needs:
 * id, name, color, status, version, basic.region, basic.age_range,
 * and per-domain validation stats (no prose content).
 *
 * Scales to 100+ personas without sending megabytes to the browser.
 * The admin panel calls this for the list, then fetches full detail
 * only when a persona is selected.
 */
app.get('/api/personas', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  // Optional filters
  const statusFilter = req.query.status; // e.g. ?status=validated
  const search       = req.query.q;      // e.g. ?q=marie

  let personas;

  if (supabase) {
    try {
      // Fetch only the fields the list view needs — not the full domain prose
      let q = supabase
        .from('jumo_personas')
        .select('id, name, color, status, version, basic, domains, updated_at')
        .order('name');
      if (statusFilter) q = q.eq('status', statusFilter);

      const { data, error } = await q;
      if (!error && data) personas = data;
    } catch (e) {
      console.warn('Supabase personas list failed, using cache');
    }
  }

  if (!personas) {
    personas = Object.values(personaCache);
  }

  // Build lightweight list items — strip prose, keep stats
  const DOMAINS = ['health','family','economic','institutional','religious','education','language_profile'];
  const list = personas
    .map(p => {
      const domains = p.domains || {};
      const domainStats = DOMAINS.map(d => ({
        domain:     d,
        has_content: !!(domains[d] && domains[d].content && domains[d].content.trim()),
        source:     (domains[d] && domains[d].source) || 'ai_generated',
        confidence: (domains[d] && domains[d].confidence) || 'low',
      }));
      return {
        id:          p.id,
        name:        p.name,
        color:       p.color,
        status:      p.status,
        version:     p.version,
        updated_at:  p.updated_at,
        age_range:   (p.basic && p.basic.age_range)  || '',
        region:      (p.basic && p.basic.region)     || '',
        domain_stats: domainStats,
        domains_with_content:   domainStats.filter(d => d.has_content).length,
        domains_validated:      domainStats.filter(d => d.source === 'partner_validated').length,
        domains_total:          DOMAINS.length,
      };
    })
    .filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
                            p.region.toLowerCase().includes(search.toLowerCase()));

  res.json(list);
});

/*
 * GET /api/personas/:id — full persona detail
 *
 * Only called when admin selects a specific persona to edit.
 * Returns complete data including all domain prose.
 */
app.get('/api/personas/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  // Skip reserved sub-routes
  if (req.params.id === 'prompt') return res.status(400).json({ error: 'Use /api/personas/:id/prompt' });

  const persona = await getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found.' });

  res.json(persona);
});

/* GET single persona prompt preview — admin only */
app.get('/api/personas/:id/prompt', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const persona = await getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found.' });

  const prompt     = buildSystemPrompt(persona);
  const validation = validatePersona(persona);

  res.json({
    persona_id:  persona.id,
    persona_name: persona.name,
    version:     persona.version,
    status:      persona.status,
    prompt,
    char_count:  prompt.length,
    token_estimate: Math.ceil(prompt.length / 4),
    validation,
  });
});

/* PUT — save persona from admin portal */
app.put('/api/personas/:id', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const { id } = req.params;
  const p = req.body;

  if (!id) return res.status(400).json({ error: 'Persona id required.' });

  const now = new Date().toISOString();
  const { error } = await supabase.from('jumo_personas').upsert({
    id,
    name:                   p.name                   || id,
    color:                  p.color                  || '#3A5A70',
    status:                 p.status                 || 'draft',
    basic:                  p.basic                  || {},
    domains:                p.domains                || {},
    system_prompt:          p.system_prompt || p.system_prompt_fragment || '',
    version:                p.version                || 1,
    updated_at: now,
  }, { onConflict: 'id' });

  if (error) {
    console.error('Persona save error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Invalidate cache — next request will reload from Supabase
  delete personaCache[id];

  res.json({ success: true });
});

/* POST — send persona to partner validation queue */
app.post('/api/personas/:id/send-to-partner', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const persona = req.body;
  if (!persona || !persona.id)
    return res.status(400).json({ error: 'Persona data required.' });

  const now = new Date().toISOString();
  const items = Object.keys(persona.domains || {})
    .filter(d => persona.domains[d] && persona.domains[d].content && persona.domains[d].content.trim())
    .map(d => ({
      id:           `${persona.id}-${d}-${Date.now()}`,
      persona_id:   persona.id,
      persona_name: persona.name,
      domain:       d,
      domain_label: DOMAIN_LABELS[d] || d,
      content:      persona.domains[d].content,
      admin_notes:  persona.domains[d].notes || '',
      status:       'pending',
      created_at:   now,
      updated_at:   now,
    }));

  if (!items.length)
    return res.status(400).json({ error: 'No domain content to send. Fill in domain sections first.' });

  // Clear existing pending items for this persona
  await supabase
    .from('jumo_validation_queue')
    .delete()
    .eq('persona_id', persona.id)
    .eq('status', 'pending');

  const { error } = await supabase.from('jumo_validation_queue').insert(items);
  if (error) return res.status(500).json({ error: error.message });

  await supabase
    .from('jumo_personas')
    .update({ status: 'pending_review', updated_at: now })
    .eq('id', persona.id);

  delete personaCache[persona.id];

  res.json({ success: true, items_sent: items.length });
});

/* ═══════════════════════════════════════════════════════════
   PARTNER — validation queue
   ═══════════════════════════════════════════════════════════ */
/* GET /api/partner/personas — basic persona info for context headers */
app.get('/api/partner/personas', async (req, res) => {
  if (!requirePartner(req, res)) return;
  if (!requireStorage(req, res)) return;
  const { data, error } = await supabase
    .from('jumo_personas').select('id, name, color, status, basic');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/* POST /api/partner/send-response
   Admin sends a Q&A pair from session log to partner for validation.
   Creates a response_validation queue item. */
app.post('/api/partner/send-response', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const { question_text, response_text, persona_id, persona_name, domain, admin_notes } = req.body;
  if (!response_text) return res.status(400).json({ error: 'response_text required.' });

  const now = new Date().toISOString();
  const { error } = await supabase.from('jumo_validation_queue').insert({
    id:           `rv-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    persona_id:   persona_id   || null,
    persona_name: persona_name || null,
    domain:       domain       || 'general',
    domain_label: domain       || 'Response',
    content:      response_text,
    question_text: question_text || null,
    admin_notes:  admin_notes || (question_text ? 'Q: '+question_text : null),
    item_type:    'response_validation',
    status:       'pending',
    created_at:   now,
    updated_at:   now,
  });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/* POST /api/partner/notes
   Partner submits unsolicited cultural observation.
   Saved to jumo_corpus with status=pending_review for admin to approve. */
app.post('/api/partner/notes', async (req, res) => {
  if (!requirePartner(req, res)) return;
  if (!requireStorage(req, res)) return;

  const { persona_id, persona_name, domain, content, confidence, notes } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'content required.' });

  const now = new Date().toISOString();
  const { error } = await supabase.from('jumo_corpus').insert({
    id:           `cn-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    persona_id:   persona_id   || null,
    persona_name: persona_name || null,
    domain:       domain       || 'general',
    source:       'partner_correction',
    title:        'Partner cultural note' + (persona_name ? ' — '+persona_name : ''),
    content:      content.trim(),
    notes:        (notes||'') + (confidence ? ' [Confidence: '+confidence+']' : ''),
    status:       'pending_review',   /* Admin must approve before it appears in corpus */
    created_at:   now,
    updated_at:   now,
  });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/partner/queue', async (req, res) => {
  if (!requirePartner(req, res)) return;
  if (!requireStorage(req, res)) return;

  const { data, error } = await supabase
    .from('jumo_validation_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/partner/validate', async (req, res) => {
  if (!requirePartner(req, res)) return;
  if (!requireStorage(req, res)) return;

  const { verdicts, submitted_at } = req.body;
  if (!Array.isArray(verdicts) || !verdicts.length)
    return res.status(400).json({ error: 'verdicts must be a non-empty array.' });

  const now = submitted_at || new Date().toISOString();
  const updates = verdicts.map(v =>
    supabase.from('jumo_validation_queue').update({
      verdict:       v.verdict    || 'pending',
      verdict_notes: v.notes      || '',
      status:        'reviewed',
      submitted_at:  now,
      updated_at:    new Date().toISOString(),
    }).eq('id', v.id)
  );

  const results = await Promise.all(updates);
  const failed  = results.filter(r => r.error);

  if (failed.length) {
    console.error('Verdict update errors:', failed.map(r => r.error.message));
    return res.status(500).json({ error: 'Some verdicts failed.', count: failed.length });
  }

  /* Sync corrections back to jumo_flags for flag_correction items */
  const flagSyncs = verdicts
    .filter(v => v.flag_id && v.notes && v.notes.trim())
    .map(v =>
      supabase.from('jumo_flags').update({
        partner_correction: v.notes,
        status: 'partner_responded',
        updated_at: new Date().toISOString(),
      }).eq('id', v.flag_id)
    );

  if (flagSyncs.length) await Promise.all(flagSyncs);

  res.json({ success: true, verdicts_saved: verdicts.length });
});

/* ═══════════════════════════════════════════════════════════
   FLAGS
   Quality feedback loop: test shell → flag → partner → corpus

   Requires jumo_flags table in Supabase:

   create table jumo_flags (
     id text primary key,
     session_id text,
     persona_id text,
     persona_name text,
     persona_color text default '#3A5A70',
     question_text text,
     response_text text,
     flag_type text default 'culturally_inaccurate',
     domain_hint text,
     admin_notes text,
     send_to_partner boolean default false,
     partner_correction text,
     partner_notes text,
     status text default 'open',
     resolved_to text,
     created_at timestamptz default now(),
     updated_at timestamptz default now()
   );

   Also add item_type column to jumo_validation_queue:
   alter table jumo_validation_queue
     add column if not exists item_type text default 'domain_validation',
     add column if not exists flag_id text;
   ═══════════════════════════════════════════════════════════ */

/* POST /api/flags — create flag from test shell */
app.post('/api/flags', async (req, res) => {
  if (!requireAccess(req, res)) return;

  if (!requireStorage(req, res)) return;

  const flag = req.body;
  if (!flag.persona_id || !flag.response_text)
    return res.status(400).json({ error: 'persona_id and response_text required.' });

  const now = new Date().toISOString();
  const flagId = flag.id || `flag-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;

  const { error } = await supabase.from('jumo_flags').insert({
    id:            flagId,
    session_id:    flag.session_id    || null,
    persona_id:    flag.persona_id,
    persona_name:  flag.persona_name  || flag.persona_id,
    persona_color: flag.persona_color || '#3A5A70',
    question_text: flag.question_text || '',
    response_text: flag.response_text,
    flag_type:     flag.flag_type     || 'culturally_inaccurate',
    domain_hint:   flag.domain_hint   || null,
    admin_notes:   flag.admin_notes   || null,
    send_to_partner: flag.send_to_partner || false,
    status:        flag.send_to_partner ? 'sent_to_partner' : 'open',
    created_at:    now,
    updated_at:    now,
  });

  if (error) {
    console.error('Flag insert error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  /* If send_to_partner: insert into validation_queue as a flag_correction item */
  if (flag.send_to_partner) {
    const domainLabel = flag.domain_hint
      ? (DOMAIN_LABELS[flag.domain_hint] || flag.domain_hint)
      : 'Response Correction';

    const partnerNote = [
      '⚑ WRONG RESPONSE — please provide the correct information',
      '',
      'Question asked:',
      flag.question_text || '(not captured)',
      '',
      'Admin note:',
      flag.admin_notes || '(none)',
    ].join('\n');

    await supabase.from('jumo_validation_queue').insert({
      id:           `flag-${flagId}`,
      persona_id:   flag.persona_id,
      persona_name: flag.persona_name || flag.persona_id,
      domain:       flag.domain_hint  || 'general',
      domain_label: domainLabel,
      content:      flag.response_text,
      admin_notes:  partnerNote,
      item_type:    'flag_correction',
      flag_id:      flagId,
      status:       'pending',
      created_at:   now,
      updated_at:   now,
    });
  }

  res.json({ success: true, flag_id: flagId });
});

/* GET /api/flags — admin: list all flags */
app.get('/api/flags', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  let q = supabase
    .from('jumo_flags')
    .select('*')
    .order('created_at', { ascending: false });

  if (req.query.persona_id) q = q.eq('persona_id', req.query.persona_id);
  if (req.query.status)     q = q.eq('status', req.query.status);
  if (req.query.domain)     q = q.eq('domain_hint', req.query.domain);

  const { data, error } = await q.limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/* PUT /api/flags/:id — admin: update status, add correction, resolve */
app.put('/api/flags/:id', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const update = req.body;
  const { error } = await supabase
    .from('jumo_flags')
    .update({
      status:             update.status,
      admin_notes:        update.admin_notes,
      domain_hint:        update.domain_hint,
      resolved_to:        update.resolved_to   || null,
      partner_correction: update.partner_correction || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/* ═══════════════════════════════════════════════════════════
   CORPUS
   Admin manages cultural knowledge entries.

   Requires jumo_corpus table in Supabase:

   create table jumo_corpus (
     id text primary key,
     persona_id text,
     persona_name text,
     domain text default 'general',
     source text default 'manual',
     reference text,
     title text,
     content text not null,
     notes text,
     status text default 'active',
     created_at timestamptz default now(),
     updated_at timestamptz default now()
   );
   ═══════════════════════════════════════════════════════════ */

/* GET /api/corpus — list active entries */
app.get('/api/corpus', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  let q = supabase
    .from('jumo_corpus')
    .select('*')
    .in('status', ['active', 'pending_review'])
    .order('created_at', { ascending: false });

  if (req.query.persona_id) q = q.eq('persona_id', req.query.persona_id);
  if (req.query.domain)     q = q.eq('domain', req.query.domain);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/* POST /api/corpus — add entry */
app.post('/api/corpus', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const entry = req.body;
  if (!entry.content || !entry.content.trim())
    return res.status(400).json({ error: 'content is required.' });

  const now = new Date().toISOString();
  const { error } = await supabase.from('jumo_corpus').insert({
    id:           entry.id || `corpus-${Date.now()}`,
    persona_id:   entry.persona_id   || null,
    persona_name: entry.persona_name || null,
    domain:       entry.domain       || 'general',
    source:       entry.source       || 'manual',
    reference:    entry.reference    || null,
    title:        entry.title        || null,
    content:      entry.content.trim(),
    notes:        entry.notes        || null,
    status:       'active',
    created_at:   entry.created_at   || now,
    updated_at:   now,
  });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/* PUT /api/corpus/:id — update entry */
app.put('/api/corpus/:id', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const update = req.body;
  const { error } = await supabase
    .from('jumo_corpus')
    .update({
      title:        update.title        || null,
      persona_id:   update.persona_id   || null,
      persona_name: update.persona_name || null,
      domain:       update.domain       || 'general',
      source:       update.source       || 'manual',
      reference:    update.reference    || null,
      content:      update.content      || '',
      notes:        update.notes        || null,
      status:       update.status       || 'active',
      updated_at:   new Date().toISOString(),
    })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/* ── Health ── */
app.get('/health', (req, res) => res.json({
  status:         'ok',
  supabase:       supabase        ? 'connected'        : 'not configured',
  personas_loaded: Object.keys(personaCache).length,
  partner_token:  PARTNER_TOKEN !== 'partner-test' ? 'configured' : 'using default',
}));

/* ── Start ── */
app.listen(PORT, async () => {
  console.log(`\nJUMO on port ${PORT}`);
  console.log(`Anthropic key:   ${ANTHROPIC_KEY ? 'SET ✓' : 'MISSING ✗'}`);
  console.log(`Supabase:        ${supabase ? 'connected ✓' : 'not configured'}`);
  console.log(`Admin token:     ${ADMIN_TOKEN !== ACCESS_TOKEN ? 'separate ✓' : 'same as access token'}`);
  console.log(`Partner token:   ${PARTNER_TOKEN !== 'partner-test' ? 'SET ✓' : 'default — set PARTNER_TOKEN'}`);
  console.log(`Personas loaded: ${Object.keys(filePersonas).length} from files`);

  if (supabase) {
    console.log('\nSyncing personas with Supabase…');
    await syncPersonasOnStartup();
    console.log('Persona sync complete.\n');
  }
});
