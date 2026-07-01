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
let filePersonas = {};
let buildSystemPrompt = (p) => p.system_prompt || p.system_prompt_fragment || '';
let validatePersona   = () => ({ warnings: [] });

try {
  filePersonas     = require('./personas/index');
  const builder    = require('./personas/builder');
  buildSystemPrompt = builder.buildSystemPrompt;
  validatePersona   = builder.validatePersona;
} catch(e) {
  console.warn('⚠ personas/index.js or personas/builder.js not found — using Supabase only.');
  console.warn('  Add personas/index.js and personas/builder.js to your repo.');
}

const personaCache = { ...filePersonas };

/* ── Supabase ── */
let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

/* ── Shared context cache (60s TTL) ── */
let _ctxCache = { at: 0, rows: [] };
async function loadSharedContext() {
  if (!supabase) return [];
  if (Date.now() - _ctxCache.at < 60000) return _ctxCache.rows;
  const { data, error } = await supabase
    .from('jumo_shared_context')
    .select('domain,content,priority,active')
    .eq('active', true);
  if (error) { console.error('shared context load:', error.message); return _ctxCache.rows; }
  _ctxCache = { at: Date.now(), rows: data || [] };
  return _ctxCache.rows;
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

/* ── Auth + storage guards ── */
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

async function getPersona(id) {
  if (personaCache[id]) return personaCache[id];

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

  return filePersonas[id] || null;
}

async function refreshPersona(id) {
  delete personaCache[id];
  return getPersona(id);
}

async function syncPersonasOnStartup() {
  if (!supabase) return;

  const now = new Date().toISOString();

  try {
    const { data: dbRows, error: fetchErr } = await supabase
      .from('jumo_personas')
      .select('id, version');

    if (fetchErr) throw fetchErr;

    const dbVersionMap = Object.fromEntries(
      (dbRows || []).map(r => [r.id, r.version || 0])
    );

    const toUpsert    = [];
    const toLoadFromDb = [];

    for (const [id, filePersona] of Object.entries(filePersonas)) {
      const fileVersion = filePersona.version || 1;
      const dbVersion   = dbVersionMap[id];

      if (dbVersion === undefined) {
        toUpsert.push({ ...filePersona, created_at: now, updated_at: now });
        personaCache[id] = filePersona;
      } else if (fileVersion > dbVersion) {
        toUpsert.push({ ...filePersona, updated_at: now });
        personaCache[id] = filePersona;
      } else {
        toLoadFromDb.push(id);
      }
    }

    if (toUpsert.length) {
      const { error: upsertErr } = await supabase
        .from('jumo_personas')
        .upsert(toUpsert, { onConflict: 'id' });
      if (upsertErr) console.warn('  Upsert warning:', upsertErr.message);
      else console.log(`  Upserted ${toUpsert.length} persona(s) from files`);
    }

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
  }
}

/* ═══════════════════════════════════════════════════════════
   AUTH
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
   ═══════════════════════════════════════════════════════════ */
app.post('/api/messages', limiter, async (req, res) => {
  if (!requireAccess(req, res)) return;

  if (!ANTHROPIC_KEY)
    return res.status(500).json({ error: { message: 'Server not configured.' } });

  if (req.headers['x-broadcast'] === '1') {
    return broadcastLimiter(req, res, () => handleMessage(req, res));
  }
  return handleMessage(req, res);
});

async function handleMessage(req, res) {
  const { messages, system, persona_id } = req.body;
  const isBroadcast = req.headers['x-broadcast'] === '1';

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: { message: 'messages must be a non-empty array.' } });

  let resolvedSystem = '';

  if (persona_id) {
    const persona = await getPersona(persona_id);
    if (!persona) {
      return res.status(404).json({ error: { message: `Unknown persona: ${persona_id}` } });
    }
    /* ── Pass shared context into prompt assembly ── */
    const ctx = await loadSharedContext();
    resolvedSystem = buildSystemPrompt(persona, ctx);
  } else if (system) {
    resolvedSystem = system;
  }

  const LANG = `\n\nLANGUAGE RULE — ALWAYS FOLLOW: Detect the language of the user's most recent message and respond entirely in that language. English → English only. Kreyòl → Kreyòl only. French → French only. This overrides all other language instructions.`;

  const payload = {
    model:       'claude-sonnet-4-6',
    max_tokens:  isBroadcast ? 600 : 350,
    temperature: 0.72,
    messages,
    ...(resolvedSystem ? { system: resolvedSystem + LANG } : {}),
  };

  try {
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         ANTHROPIC_KEY,
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
   SESSIONS
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
app.get('/api/personas', async (req, res) => {
  const statusFilter = req.query.status;
  const search       = req.query.q;

  let personas;

  if (supabase) {
    try {
      let q = supabase
        .from('jumo_personas')
        .select('id, name, color, status, version, basic, domains, updated_at, init, archetype, age, location, bio, tags, questions')
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

  const DOMAINS = ['health','family','economic','institutional','religious','education','language_profile'];
  const list = personas
    .map(p => {
      const domains = p.domains || {};
      const domainStats = DOMAINS.map(d => ({
        domain:      d,
        has_content: !!(domains[d] && domains[d].content && domains[d].content.trim()),
        source:      (domains[d] && domains[d].source) || 'ai_generated',
        confidence:  (domains[d] && domains[d].confidence) || 'low',
      }));
      return {
        id:         p.id,
        name:       p.name,
        color:      p.color,
        status:     p.status,
        version:    p.version,
        updated_at: p.updated_at,
        age_range:  (p.basic && p.basic.age_range) || '',
        region:     (p.basic && p.basic.region)    || '',
        init:      p.init      || (p.name ? p.name.trim().split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase() : ''),
        archetype: p.archetype || '',
        age:       p.age       || '',
        location:  p.location  || '',
        bio:       p.bio       || '',
        tags:      Array.isArray(p.tags)      ? p.tags      : [],
        questions: Array.isArray(p.questions) ? p.questions : [],
        domain_stats:           domainStats,
        domains_with_content:   domainStats.filter(d => d.has_content).length,
        domains_validated:      domainStats.filter(d => d.source === 'partner_validated').length,
        domains_total:          DOMAINS.length,
      };
    })
    .filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
                            p.region.toLowerCase().includes(search.toLowerCase()));

  res.json(list);
});

app.get('/api/personas/:id', async (req, res) => {
  if (req.params.id === 'prompt') return res.status(400).json({ error: 'Use /api/personas/:id/prompt' });

  const persona = await getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found.' });

  res.json(persona);
});

app.get('/api/personas/:id/prompt', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const persona = await getPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found.' });

  /* ── Pass shared context so preview matches what the model sees ── */
  const ctx        = await loadSharedContext();
  const prompt     = buildSystemPrompt(persona, ctx);
  const validation = validatePersona(persona);

  res.json({
    persona_id:     persona.id,
    persona_name:   persona.name,
    version:        persona.version,
    status:         persona.status,
    prompt,
    char_count:     prompt.length,
    token_estimate: Math.ceil(prompt.length / 4),
    validation,
  });
});

app.put('/api/personas/:id', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const { id } = req.params;
  const p = req.body;

  if (!id) return res.status(400).json({ error: 'Persona id required.' });

  const now = new Date().toISOString();
  const { error } = await supabase.from('jumo_personas').upsert({
    id,
    name:          p.name   || id,
    color:         p.color  || '#3A5A70',
    status:        p.status || 'draft',
    basic:         p.basic  || {},
    domains:       p.domains || {},
    system_prompt: p.system_prompt || p.system_prompt_fragment || '',
    version:       p.version || 1,
    init:      p.init      || '',
    archetype: p.archetype || '',
    age:       String(p.age || ''),
    location:  p.location  || '',
    bio:       p.bio       || '',
    tags:      Array.isArray(p.tags)      ? p.tags      : [],
    questions: Array.isArray(p.questions) ? p.questions : [],
    /* ── Voice & behavior fields ── */
    voice_anchor:     p.voice_anchor     ?? null,
    voice_examples:   Array.isArray(p.voice_examples)   ? p.voice_examples   : (p.voice_examples   ?? []),
    refusal_patterns: Array.isArray(p.refusal_patterns) ? p.refusal_patterns : (p.refusal_patterns ?? []),
    contradictions:   Array.isArray(p.contradictions)   ? p.contradictions   : (p.contradictions   ?? []),
    updated_at: now,
  }, { onConflict: 'id' });

  if (error) {
    console.error('Persona save error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  delete personaCache[id];

  res.json({ success: true });
});

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
app.get('/api/partner/personas', async (req, res) => {
  if (!requirePartner(req, res)) return;
  if (!requireStorage(req, res)) return;
  const { data, error } = await supabase
    .from('jumo_personas').select('id, name, color, status, basic');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

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
    status:       'pending_review',
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
   ═══════════════════════════════════════════════════════════ */
app.post('/api/flags', async (req, res) => {
  if (!requireAccess(req, res))  return;
  if (!requireStorage(req, res)) return;

  const flag = req.body;
  if (!flag.persona_id || !flag.response_text)
    return res.status(400).json({ error: 'persona_id and response_text required.' });

  const now    = new Date().toISOString();
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
      resolved_to:        update.resolved_to        || null,
      partner_correction: update.partner_correction || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/* ── Flag → voice-example promotion (admin only) ──
   Promotes a corrected flag response directly into the persona's
   voice_examples array. The correction is live immediately —
   no redeploy needed. Provenance fields (source, reviewer, from_flag)
   are stored in DB but builder.js only reads q/a so they never
   pollute the prompt. */
app.post('/api/flags/:id/promote', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const { data: flag, error: fe } = await supabase
    .from('jumo_flags').select('*').eq('id', req.params.id).single();
  if (fe || !flag) return res.status(404).json({ error: 'Flag not found.' });

  const q = (req.body.q ?? flag.question_text ?? '').trim();
  const a = (req.body.a ?? flag.correction    ?? '').trim();
  if (!q || !a)
    return res.status(400).json({ error: 'Both q (question) and a (correction) are required.' });

  const persona = await getPersona(flag.persona_id);
  if (!persona) return res.status(404).json({ error: 'Persona not found.' });

  const examples = Array.isArray(persona.voice_examples)
    ? persona.voice_examples.slice() : [];

  examples.push({
    q, a,
    source:    'flag_correction',
    reviewer:  req.body.reviewer || null,
    from_flag: flag.id,
    added_at:  new Date().toISOString(),
  });

  const { error: ue } = await supabase
    .from('jumo_personas')
    .update({ voice_examples: examples, updated_at: new Date().toISOString() })
    .eq('id', persona.id);
  if (ue) return res.status(500).json({ error: ue.message });

  await refreshPersona(persona.id);

  await supabase.from('jumo_flags')
    .update({ status: 'resolved', resolution: 'promoted_to_voice_example', updated_at: new Date().toISOString() })
    .eq('id', flag.id);

  res.json({ success: true, persona_id: persona.id, example_count: examples.length });
});

/* ═══════════════════════════════════════════════════════════
   SHARED CONTEXT
   ═══════════════════════════════════════════════════════════ */
app.get('/api/shared-context', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  let q = supabase.from('jumo_shared_context').select('*').order('priority', { ascending: false });
  if (req.query.domain) q = q.eq('domain', req.query.domain);
  if (req.query.active) q = q.eq('active', req.query.active === 'true');

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/shared-context', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const e = req.body;
  if (!e.content || !e.content.trim())
    return res.status(400).json({ error: 'content is required.' });

  const now = new Date().toISOString();
  const { error } = await supabase.from('jumo_shared_context').insert({
    id:       e.id       || `ctx-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    domain:   e.domain   || 'general',
    title:    e.title    || null,
    content:  e.content.trim(),
    source:   e.source   || 'direct_knowledge',
    priority: e.priority ?? 0,
    active:   e.active   ?? true,
    notes:    e.notes    || null,
    created_at: now,
    updated_at: now,
  });

  if (error) return res.status(500).json({ error: error.message });
  _ctxCache.at = 0; // bust cache so next message picks up new entry
  res.json({ success: true });
});

app.put('/api/shared-context/:id', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const e = req.body;
  const { error } = await supabase.from('jumo_shared_context').update({
    domain:   e.domain   || 'general',
    title:    e.title    || null,
    content:  e.content  || '',
    source:   e.source   || 'direct_knowledge',
    priority: e.priority ?? 0,
    active:   e.active   ?? true,
    notes:    e.notes    || null,
    updated_at: new Date().toISOString(),
  }).eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  _ctxCache.at = 0; // bust cache
  res.json({ success: true });
});

app.delete('/api/shared-context/:id', async (req, res) => {
  if (!requireAdmin(req, res))   return;
  if (!requireStorage(req, res)) return;

  const { error } = await supabase
    .from('jumo_shared_context').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  _ctxCache.at = 0; // bust cache
  res.json({ success: true });
});

/* ═══════════════════════════════════════════════════════════
   CORPUS
   ═══════════════════════════════════════════════════════════ */
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
  status:          'ok',
  supabase:        supabase ? 'connected' : 'not configured',
  personas_loaded: Object.keys(personaCache).length,
  partner_token:   PARTNER_TOKEN !== 'partner-test' ? 'configured' : 'using default',
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
