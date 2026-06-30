/* ============================================================================
   JUMO — personas/builder.js   (REPLACES your existing personas/builder.js)

   ──────────────────────────────────────────────────────────────────────────
   ONE-TIME SETUP (do these once, then this file is the only thing in the repo)
   ──────────────────────────────────────────────────────────────────────────

   STEP 1 — Run this in the Supabase SQL editor (paste, run, discard):

     alter table jumo_personas add column if not exists voice_examples   jsonb default '[]'::jsonb;
     alter table jumo_personas add column if not exists voice_anchor      text;
     alter table jumo_personas add column if not exists refusal_patterns  jsonb default '[]'::jsonb;
     alter table jumo_personas add column if not exists contradictions    jsonb default '[]'::jsonb;

     create table if not exists jumo_shared_context (
       id text primary key, domain text default 'general', title text,
       content text not null, source text default 'direct_knowledge',
       priority int default 0, active boolean default true, notes text,
       created_at timestamptz default now(), updated_at timestamptz default now()
     );

   STEP 2 — In server.js, add this helper + the 3 edits marked (A)(B)(C) below.

     // (helper) 60s-cached shared context loader
     let _ctxCache = { at: 0, rows: [] };
     async function loadSharedContext() {
       if (!supabase) return [];
       if (Date.now() - _ctxCache.at < 60000) return _ctxCache.rows;
       const { data, error } = await supabase
         .from('jumo_shared_context')
         .select('domain,content,priority,active').eq('active', true);
       if (error) { console.error('ctx:', error.message); return _ctxCache.rows; }
       _ctxCache = { at: Date.now(), rows: data || [] };
       return _ctxCache.rows;
     }

     (A) In POST /api/messages, where you call buildSystemPrompt(persona):
           const ctx = await loadSharedContext();
           const system = buildSystemPrompt(persona, ctx);

     (B) In GET /api/personas/:id/prompt (preview), same change so preview matches:
           const ctx = await loadSharedContext();
           const prompt = buildSystemPrompt(persona, ctx);

     (C) In the Anthropic call, tune generation:
           max_tokens: 350,      // real people answer short
           temperature: 0.72,    // consistent voice, still natural

   STEP 3 — In PUT /api/personas/:id, add the 4 new fields to your update object:
           voice_anchor:     req.body.voice_anchor     ?? current.voice_anchor,
           voice_examples:   req.body.voice_examples   ?? current.voice_examples   ?? [],
           refusal_patterns: req.body.refusal_patterns ?? current.refusal_patterns ?? [],
           contradictions:   req.body.contradictions   ?? current.contradictions   ?? [],

   STEP 4 — Add the 3 validated entries by hand in the admin Context tab:
           Vodou disclosure (domain: health), Sòl mechanics (domain: economic),
           Chaloska (domain: general). No seed script needed.

   That's the whole deployment. This file + 4 manual steps. Nothing else to track.
   ──────────────────────────────────────────────────────────────────────────

   System prompt assembly with voice-example few-shot injection.

   ASSEMBLY ORDER (top → bottom of prompt):
     1. Identity + basic profile        (who they are)
     2. Domain content                  (what they know / how they live)
     3. Shared context                  (general Haiti knowledge, injected by server)
     4. Behavioral guardrails           (refusal patterns, contradictions)
     5. Voice anchor                    (how they sound — short)
     6. Few-shot voice examples         (Q/A pairs — STRONGEST steering, kept LAST)

   Why voice examples go last: the model weights recency heavily. Content the
   model sees immediately before generating has the largest effect on output
   style. Domains inform WHAT is said; examples lock in HOW it is said.
   ============================================================================ */

const DOMAIN_LABELS = {
  health:           'Health & Wellbeing',
  family:           'Family & Community',
  economic:         'Economic Life',
  institutional:    'Institutional Relationships',
  religious:        'Religious & Spiritual Life',
  education:        'Education & Knowledge',
  language_profile: 'Language Profile',
};

const DOMAIN_ORDER = [
  'health', 'family', 'economic', 'institutional',
  'religious', 'education', 'language_profile',
];

/* ---------------------------------------------------------------------------
   buildSystemPrompt(persona, sharedContext)
   - persona:       the full persona object from Supabase/cache
   - sharedContext: optional array of {domain, content, priority, active}
                    (server passes this in; builder stays pure)
   --------------------------------------------------------------------------- */
function buildSystemPrompt(persona, sharedContext = []) {
  if (!persona) return '';

  // If a full manual override exists, it still gets voice examples appended.
  // This lets monolith-mode personas benefit from few-shot steering too.
  const parts = [];

  if (persona.system_prompt && persona.system_prompt.trim()) {
    parts.push(persona.system_prompt.trim());
  } else {
    parts.push(...assembleFromDomains(persona));
  }

  // ── Shared context injection ──
  // general → always; domain-tagged → only if persona has that domain filled
  const filledDomains = new Set(
    DOMAIN_ORDER.filter(k => (persona.domains?.[k]?.content || '').trim())
  );
  const ctx = (sharedContext || [])
    .filter(c => c.active !== false)
    .filter(c => c.domain === 'general' || filledDomains.has(c.domain))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  if (ctx.length) {
    const ctxBlock = ctx.map(c => {
      const label = c.domain === 'general' ? 'Kontèks jeneral' : (DOMAIN_LABELS[c.domain] || c.domain);
      return `[${label}] ${c.content.trim()}`;
    }).join('\n\n');
    parts.push(
      '── KONTÈKS KILTIRÈL PATAJE ──\n' +
      'Sa se konesans background. Itilize l sèlman si li enpòtan pou repons lan. ' +
      'Pa resite l. Konesans pèsonèl pèsonaj la toujou gen priyorite sou sa.\n\n' +
      ctxBlock
    );
  }

  // ── Behavioral guardrails (refusal patterns + contradictions) ──
  const guardrails = buildGuardrails(persona);
  if (guardrails) parts.push(guardrails);

  // ── Voice anchor (short, descriptive) ──
  if (persona.voice_anchor && persona.voice_anchor.trim()) {
    parts.push('── VWA ──\n' + persona.voice_anchor.trim());
  }

  // ── Few-shot voice examples (LAST — strongest steering) ──
  const examples = normalizeExamples(persona.voice_examples);
  if (examples.length) {
    const exBlock = examples.map(ex =>
      `Q: ${ex.q.trim()}\n${persona.name || 'Reponn'}: ${ex.a.trim()}`
    ).join('\n\n');
    parts.push(
      '── EGZANP FASON OU PALE ──\n' +
      'Men egzanp ki montre EGZAKTEMAN ki jan ou reponn — longè, ton, vokabilè, ' +
      'fason ou evite oswa detounen kèk sijè. Swiv stil sa a nan tout repons ou yo. ' +
      'Pa kopye mo yo — kopye fason an.\n\n' +
      exBlock
    );
  }

  return parts.filter(Boolean).join('\n\n');
}

/* ---------------------------------------------------------------------------
   assembleFromDomains — identity + basic profile + 7 domains
   --------------------------------------------------------------------------- */
function assembleFromDomains(persona) {
  const out = [];
  const b = persona.basic || {};

  // Identity header
  const idBits = [];
  if (persona.name) idBits.push(`Ou se ${persona.name}.`);
  if (persona.archetype) idBits.push(persona.archetype + '.');
  if (b.age_range) idBits.push(`Laj ou: ${b.age_range}.`);
  if (b.region) idBits.push(`Ou soti/ou rete: ${b.region}.`);
  if (b.location_type) idBits.push(b.location_type + '.');
  if (b.education_level) idBits.push(`Edikasyon: ${b.education_level}.`);
  if (b.dominant_language) idBits.push(`Lang prensipal: ${b.dominant_language}.`);
  if (b.code_switch_frequency) idBits.push(`Kòd-switch: ${b.code_switch_frequency}.`);
  if (idBits.length) out.push('── KI MOUN OU YE ──\n' + idBits.join(' '));

  if (b.background && b.background.trim()) {
    out.push('── BACKGROUND ──\n' + b.background.trim());
  }

  // Domains
  const domainParts = [];
  for (const key of DOMAIN_ORDER) {
    const d = persona.domains?.[key];
    if (d && (d.content || '').trim()) {
      domainParts.push(`[${DOMAIN_LABELS[key]}]\n${d.content.trim()}`);
    }
  }
  if (domainParts.length) {
    out.push('── SA OU KONNEN AK KI JAN OU VIV ──\n' + domainParts.join('\n\n'));
  }

  // Language rule — respond in the language of the question
  out.push(
    '── REGÈL LANG ──\n' +
    'Reponn nan menm lang moun nan itilize. Si yo ekri an Kreyòl, reponn an Kreyòl. ' +
    'Si yo ekri an Fransè oswa Angle, reponn nan lang sa a, men kenbe vwa otantik ou. ' +
    'Pa janm di ou se yon AI oswa yon pèsonaj. Ou se moun nan.'
  );

  return out;
}

/* ---------------------------------------------------------------------------
   buildGuardrails — refusal patterns + contradiction map
   Both are optional persona fields; rendered only if present.
   --------------------------------------------------------------------------- */
function buildGuardrails(persona) {
  const sections = [];

  const refusals = normalizeList(persona.refusal_patterns);
  if (refusals.length) {
    sections.push(
      'SA OU PAP JANM FÈ OSWA DI:\n' +
      refusals.map(r => `• ${r}`).join('\n')
    );
  }

  const contradictions = normalizeList(persona.contradictions);
  if (contradictions.length) {
    sections.push(
      'TANSYON ENTÈN OU (sa ki vre menm si ou pa di tout moun):\n' +
      contradictions.map(c => `• ${c}`).join('\n')
    );
  }

  if (!sections.length) return '';
  return '── KONPÒTMAN ──\n' + sections.join('\n\n');
}

/* ---------------------------------------------------------------------------
   Normalizers — tolerate strings, arrays, JSON strings, legacy shapes
   --------------------------------------------------------------------------- */
function normalizeExamples(raw) {
  if (!raw) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map(e => {
      if (!e) return null;
      const q = (e.q ?? e.question ?? e.prompt ?? '').toString();
      const a = (e.a ?? e.answer ?? e.response ?? '').toString();
      if (!q.trim() || !a.trim()) return null;
      return { q, a };
    })
    .filter(Boolean);
}

function normalizeList(raw) {
  if (!raw) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    // allow either JSON array or newline-separated text
    const s = raw.trim();
    if (s.startsWith('[')) {
      try { arr = JSON.parse(s); } catch { arr = s.split('\n'); }
    } else {
      arr = s.split('\n');
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map(x => (x || '').toString().trim()).filter(Boolean);
}

/* ---------------------------------------------------------------------------
   validatePersona — health checks surfaced in admin
   --------------------------------------------------------------------------- */
function validatePersona(persona) {
  const hasManualPrompt = !!(persona.system_prompt && persona.system_prompt.trim());
  const basicFilled = Object.values(persona.basic || {}).filter(v => (v || '').toString().trim());
  const domainsWithContent = DOMAIN_ORDER.filter(k => (persona.domains?.[k]?.content || '').trim());
  const examples = normalizeExamples(persona.voice_examples);

  return {
    hasManualPrompt,
    domainCount: domainsWithContent.length,
    exampleCount: examples.length,
    hasVoiceAnchor: !!(persona.voice_anchor && persona.voice_anchor.trim()),
    warnings: [
      !hasManualPrompt && domainsWithContent.length === 0
        ? 'No domain content — prompt will be nearly empty' : null,
      !hasManualPrompt && basicFilled.length < 3 ? 'Basic profile incomplete' : null,
      examples.length === 0 ? 'No voice examples — responses will drift toward generic' : null,
      examples.length > 0 && examples.length < 4 ? 'Fewer than 4 voice examples — add more for stable voice' : null,
      !(persona.voice_anchor && persona.voice_anchor.trim()) ? 'No voice anchor set' : null,
    ].filter(Boolean),
  };
}

module.exports = {
  buildSystemPrompt,
  validatePersona,
  normalizeExamples,
  normalizeList,
  DOMAIN_LABELS,
  DOMAIN_ORDER,
};
