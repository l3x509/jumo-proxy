'use strict';

const express            = require('express');
const path               = require('path');
const fs                 = require('fs');
const Anthropic          = require('@anthropic-ai/sdk');
const { createClient }   = require('@supabase/supabase-js');
const { randomUUID }     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Clients ─────────────────────────────────────────────────── */
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

/* ── Tokens ──────────────────────────────────────────────────── */
const ACCESS_TOKEN  = process.env.ACCESS_TOKEN;
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN;
const PARTNER_TOKEN = process.env.PARTNER_TOKEN;

/* ── In-memory persona cache ─────────────────────────────────
   Supabase is the runtime source of truth.
   JSON files in /personas only seed new personas on first boot.
   Admin panel saves → Supabase → cache refreshed immediately.
   No redeploy needed for any content change.
──────────────────────────────────────────────────────────────── */
let personaCache = [];

/* ── Middleware ──────────────────────────────────────────────── */
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ── Auth helpers ────────────────────────────────────────────── */
function requireAuth(req, res, next) {
  const token = req.headers['x-access-token'] || req.query.token;
  if (!token || token !== ACCESS_TOKEN)
    return res.status(401).json({ error: { message: 'Invalid access token.' } });
  next();
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!token || token !== ADMIN_TOKEN)
    return res.status(401).json({ error: { message: 'Admin access required.' } });
  next();
}

function requirePartner(req, res, next) {
  const token = req.headers['x-partner-token'] || req.query.token;
  if (!token || (token !== PARTNER_TOKEN && token !== ADMIN_TOKEN))
    return res.status(401).json({ error: { message: 'Partner access required.' } });
  next();
}

/* ── Utility helpers ─────────────────────────────────────────── */
function computeInit(name) {
  const parts = (name || '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || 'P').slice(0, 2).toUpperCase();
}

function domainStats(domains) {
  const keys = ['health','family','economic','institutional','religious','education','language_profile'];
  const filled = keys.filter(k => (domains||{})[k]?.content?.trim()).length;
  return { filled, total: keys.length };
}

/* ── System prompt builder ───────────────────────────────────── */
function buildSystemPrompt(persona) {
  // Manual override: if system_prompt field has content, use it directly
  if (persona.system_prompt?.trim()) return persona.system_prompt.trim();

  // Otherwise build from domain sections
  const domains = persona.domains || {};
  const domainLabels = {
    health:           'Health & Wellbeing',
    family:           'Family & Community',
    economic:         'Economic Life',
    institutional:    'Institutional Relationships',
    religious:        'Religious & Spiritual Life',
    education:        'Education & Knowledge',
    language_profile: 'Language Profile'
  };

  const sections = [];
  for (const [key, label] of Object.entries(domainLabels)) {
    const d = domains[key];
    if (d?.content?.trim()) sections.push(`## ${label}\n${d.content.trim()}`);
  }

  if (!sections.length) return null; // No content yet — don't send empty prompt

  const basic = persona.basic || {};
  const profileLines = [
    basic.age_range          && `Age: ${basic.age_range}`,
    basic.region             && `Region: ${basic.region}`,
    basic.location_type      && `Setting: ${basic.location_type}`,
    basic.education_level    && `Education: ${basic.education_level}`,
    basic.dominant_language  && `Primary language: ${basic.dominant_language}`,
  ].filter(Boolean).join('\n');

  return [
    `You are ${persona.name}, a specific individual from Haiti.`,
    `Respond as this person — not as an AI, not as a general representative of Haiti.`,
    `Speak from personal experience. If you don't know something specific to your life, say so.`,
    `Institutional context: you may be speaking with an NGO researcher, health professional, or international organization staff.`,
    profileLines ? `\n## Profile\n${profileLines}` : '',
    ...sections
  ].filter(Boolean).join('\n\n');
}

/* ══════════════════════════════════════════════
   PERSONA CACHE MANAGEMENT
   ══════════════════════════════════════════════ */

async function loadPersonasFromSupabase() {
  const { data, error } = await supabase
    .from('jumo_personas')
    .select('*')
    .order('name');
  if (error) throw new Error(`Failed to load personas: ${error.message}`);
  personaCache = data || [];
  console.log(`[JUMO] ${personaCache.length} personas loaded from Supabase`);
}

function findPersona(id) {
  return personaCache.find(p => p.id === id) || null;
}

async function refreshPersona(id) {
  const { data, error } = await supabase
    .from('jumo_personas')
    .select('*')
    .eq('id', id)
    .single();
  if (error || !data) return;
  const idx = personaCache.findIndex(p => p.id === id);
  if (idx >= 0) personaCache[idx] = data;
  else personaCache.push(data);
}

/* ── Seed from JSON files (insert only, never overwrites) ────── */
async function seedFromJsonFiles() {
  const personasDir = path.join(__dirname, 'personas');
  if (!fs.existsSync(personasDir)) return;

  const files = fs.readdirSync(personasDir).filter(f => f.endsWith('.json'));
  if (!files.length) return;

  const { data: existing } = await supabase.from('jumo_personas').select('id');
  const existingIds = new Set((existing || []).map(r => r.id));

  let seeded = 0;
  for (const file of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(personasDir, file), 'utf8'));
      if (!p.id || existingIds.has(p.id)) continue; // Already in Supabase — skip

      const { error } = await supabase.from('jumo_personas').insert({
        id:            p.id,
        name:          p.name          || '',
        color:         p.color         || '#3A5A70',
        status:        p.status        || 'draft',
        version:       p.version       || 1,
        init:          p.init          || computeInit(p.name),
        archetype:     p.archetype     || '',
        age:           String(p.age    || ''),
        location:      p.location      || '',
        bio:           p.bio           || '',
        tags:          p.tags          || [],
        questions:     p.questions     || [],
        basic:         p.basic         || {},
        domains:       p.domains       || {},
        system_prompt: p.system_prompt || '',
        updated_at:    new Date().toISOString()
      });

      if (!error) { seeded++; console.log(`[JUMO] Seeded: ${p.id}`); }
      else console.warn(`[JUMO] Seed failed for ${p.id}: ${error.message}`);
    } catch(e) {
      console.warn(`[JUMO] Could not parse ${file}: ${e.message}`);
    }
  }
  if (seeded > 0) console.log(`[JUMO] Seeded ${seeded} new persona(s)`);
}

/* ══════════════════════════════════════════════
   ROUTES
   ══════════════════════════════════════════════ */

/* ── Auth check ──────────────────────────────── */
app.get('/api/auth', (req, res) => {
  const token = req.query.token;
  if (token === ADMIN_TOKEN)   return res.json({ role: 'admin' });
  if (token === PARTNER_TOKEN) return res.json({ role: 'partner' });
  return res.status(401).json({ error: 'Invalid token' });
});

/* ── Personas list (no auth — same as personas.js was public) ── */
app.get('/api/personas', (req, res) => {
  res.json(personaCache.map(p => ({
    id:           p.id,
    name:         p.name,
    color:        p.color        || '#3A5A70',
    status:       p.status       || 'draft',
    version:      p.version      || 1,
    init:         p.init         || computeInit(p.name),
    archetype:    p.archetype    || '',
    age:          p.age          || '',
    location:     p.location     || '',
    bio:          p.bio          || '',
    tags:         p.tags         || [],
    questions:    p.questions    || [],
    domain_stats: domainStats(p.domains)
  })));
});

/* ── Full persona detail (admin) ─────────────── */
app.get('/api/personas/:id', requireAdmin, (req, res) => {
  const persona = findPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found' });
  res.json(persona);
});

/* ── Save persona (admin) ────────────────────── */
app.put('/api/personas/:id', requireAdmin, async (req, res) => {
  const id      = req.params.id;
  const current = findPersona(id);
  if (!current) return res.status(404).json({ error: 'Persona not found' });

  const {
    name, color, status, init, archetype, age, location, bio,
    tags, questions, basic, domains, system_prompt
  } = req.body;

  const update = {
    name:          name          ?? current.name,
    color:         color         ?? current.color,
    status:        status        ?? current.status,
    init:          init          || computeInit(name ?? current.name),
    archetype:     archetype     ?? current.archetype,
    age:           String(age    ?? current.age ?? ''),
    location:      location      ?? current.location,
    bio:           bio           ?? current.bio,
    tags:          tags          ?? current.tags,
    questions:     questions     ?? current.questions,
    basic:         basic         ?? current.basic,
    domains:       domains       ?? current.domains,
    system_prompt: system_prompt ?? current.system_prompt,
    version:       (current.version || 1) + 1,
    updated_at:    new Date().toISOString()
  };

  const { error } = await supabase
    .from('jumo_personas')
    .update(update)
    .eq('id', id);

  if (error) return res.status(500).json({ error: error.message });

  // Refresh in-memory cache immediately — change is live without redeploy
  await refreshPersona(id);
  res.json({ success: true, version: update.version });
});

/* ── System prompt preview (admin) ──────────── */
app.get('/api/personas/:id/prompt', requireAdmin, (req, res) => {
  const persona = findPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found' });

  const prompt   = buildSystemPrompt(persona);
  const warnings = [];
  if (!prompt)                        warnings.push('No content — system_prompt is empty and no domains have content yet');
  if (persona.status === 'draft')     warnings.push('Status is still draft');
  if (!persona.bio?.trim())           warnings.push('Bio is empty — UI profile card will be blank');
  if (!persona.questions?.length)     warnings.push('No preset questions defined');

  res.json({ prompt: prompt || '[No content yet]', warnings });
});

/* ── Send domains to partner ─────────────────── */
app.post('/api/personas/:id/send-to-partner', requireAdmin, async (req, res) => {
  const persona = findPersona(req.params.id);
  if (!persona) return res.status(404).json({ error: 'Persona not found' });

  const { domains: domainKeys, notes } = req.body;
  const items = (domainKeys || []).map(key => {
    const d = (persona.domains || {})[key];
    return {
      id:           randomUUID(),
      persona_id:   persona.id,
      persona_name: persona.name,
      domain:       key,
      domain_label: key.replace('_', ' '),
      content:      d?.content || '',
      admin_notes:  notes || null,
      status:       'pending',
      item_type:    'domain_validation',
      submitted_at: new Date().toISOString()
    };
  }).filter(item => item.content);

  if (!items.length) return res.status(400).json({ error: 'No domains with content to send' });

  const { error } = await supabase.from('jumo_validation_queue').insert(items);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, queued: items.length });
});

/* ── Partner queue ───────────────────────────── */
app.get('/api/partner/queue', requirePartner, async (req, res) => {
  const { data, error } = await supabase
    .from('jumo_validation_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/partner/validate', requirePartner, async (req, res) => {
  const { id, verdict, verdict_notes, partner_correction } = req.body;
  const { error } = await supabase
    .from('jumo_validation_queue')
    .update({
      verdict, verdict_notes, partner_correction,
      status:     'reviewed',
      updated_at: new Date().toISOString()
    })
    .eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/* ── Anthropic proxy ─────────────────────────── */
app.post('/api/messages', requireAuth, async (req, res) => {
  const { persona_id, system, messages } = req.body;
  let systemPrompt = null;

  if (persona_id) {
    const persona = findPersona(persona_id);
    if (!persona) return res.status(404).json({ error: { message: `Persona '${persona_id}' not found` } });
    systemPrompt = buildSystemPrompt(persona);
  } else if (system) {
    systemPrompt = system; // Legacy fallback
  }

  const requestBody = {
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages:   messages || []
  };
  if (systemPrompt) requestBody.system = systemPrompt;

  try {
    const response = await anthropic.messages.create(requestBody);
    res.json(response);
  } catch(e) {
    res.status(500).json({ error: { message: e.message } });
  }
});

/* ── Sessions ────────────────────────────────── */
app.post('/api/sessions', requireAuth, async (req, res) => {
  const {
    id, type, persona_name, persona_id, session_timestamp,
    exchanges, broadcast_question, broadcast_results,
    researcher_notes, tester_id
  } = req.body;

  const { error } = await supabase
    .from('jumo_sessions')
    .upsert({
      id, type: type || 'chat',
      persona_name, persona_id, session_timestamp,
      exchanges:          exchanges          || [],
      broadcast_question: broadcast_question || null,
      broadcast_results:  broadcast_results  || null,
      researcher_notes:   researcher_notes   || null,
      tester_id:          tester_id          || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get('/api/sessions', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('jumo_sessions')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

/* ── Flags ───────────────────────────────────── */
app.post('/api/flags', requireAuth, async (req, res) => {
  const flag = {
    ...req.body,
    status:     'open',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase.from('jumo_flags').insert(flag);
  if (error) return res.status(500).json({ error: error.message });

  // Auto-queue to partner if requested
  if (flag.send_to_partner) {
    await supabase.from('jumo_validation_queue').insert({
      id:           randomUUID(),
      persona_id:   flag.persona_id,
      persona_name: flag.persona_name,
      domain:       flag.domain_hint   || null,
      domain_label: flag.domain_hint   || 'general',
      content:      flag.response_text || '',
      admin_notes:  flag.admin_notes   || null,
      status:       'pending',
      item_type:    'flag_review',
      flag_id:      flag.id,
      submitted_at: new Date().toISOString()
    });
  }

  res.json({ success: true });
});

app.get('/api/flags', requireAdmin, async (req, res) => {
  let query = supabase
    .from('jumo_flags')
    .select('*')
    .order('created_at', { ascending: false });

  if (req.query.persona_id) query = query.eq('persona_id', req.query.persona_id);
  if (req.query.status)     query = query.eq('status',     req.query.status);
  if (req.query.domain)     query = query.eq('domain_hint', req.query.domain);

  const { data, error } = await query.limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.put('/api/flags/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from('jumo_flags')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

/* ── Cache refresh endpoint (admin — force reload from Supabase) */
app.post('/api/admin/refresh-cache', requireAdmin, async (req, res) => {
  try {
    await loadPersonasFromSupabase();
    res.json({ success: true, count: personaCache.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

/* ══════════════════════════════════════════════
   STARTUP
   ══════════════════════════════════════════════ */
async function start() {
  try {
    console.log('[JUMO] Starting…');
    await seedFromJsonFiles();        // Insert new personas from JSON (never overwrites Supabase)
    await loadPersonasFromSupabase(); // Load all personas into memory
    app.listen(PORT, () => {
      console.log(`[JUMO] Live on port ${PORT} — ${personaCache.length} personas ready`);
    });
  } catch(e) {
    console.error('[JUMO] Startup error:', e.message);
    process.exit(1);
  }
}

start();
