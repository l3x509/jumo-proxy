/**
 * personas/builder.js
 *
 * Builds the LLM system prompt from a persona data object.
 *
 * Priority:
 *   1. If persona.system_prompt is set (non-empty), use it directly — manual override
 *   2. Otherwise, auto-build from basic info + domain content
 *
 * Cultural integrity rule:
 *   This file generates STRUCTURE only. All cultural content comes from the
 *   persona data object — never from this builder. If a field is empty,
 *   it is omitted from the prompt entirely. Never substitute defaults.
 */

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
  'health',
  'family',
  'economic',
  'institutional',
  'religious',
  'education',
  'language_profile',
];

const EDUCATION_LABELS = {
  none:        'No formal education',
  primary:     'Primary school',
  secondary:   'Secondary school',
  university:  'University',
  vocational:  'Vocational / trade',
};

const LANGUAGE_LABELS = {
  creole:    'Haitian Creole',
  french:    'French',
  english:   'English',
  mixed_fr:  'Haitian Creole and French',
  mixed_en:  'Haitian Creole and English',
};

const LOCATION_LABELS = {
  rural:           'Rural Haiti',
  urban_haiti:     'Urban Haiti',
  port_au_prince:  'Port-au-Prince',
  diaspora_us:     'Haitian diaspora, United States',
  diaspora_canada: 'Haitian diaspora, Canada',
  diaspora_other:  'Haitian diaspora',
};

const SWITCH_LABELS = {
  never:    'Speaks only in primary language — never code-switches',
  occasional: 'Occasionally code-switches',
  frequent:   'Frequently code-switches',
  constant:   'Constantly switches between languages',
};

/**
 * buildSystemPrompt(persona)
 * Returns a string ready to pass as the system prompt to Anthropic.
 */
function buildSystemPrompt(persona) {
  // Manual override — if a custom system_prompt is set, use it directly
  if (persona.system_prompt && persona.system_prompt.trim()) {
    return persona.system_prompt.trim();
  }

  const b = persona.basic || {};
  const d = persona.domains || {};
  const lines = [];

  // ── Identity ──
  lines.push(`You are ${persona.name}, a Haitian cultural intelligence persona.`);
  lines.push(`You speak from direct lived experience as a specific person with a specific life — not as a generalized representative of Haitian culture. Your perspective is your own.`);
  lines.push('');

  // ── Profile ──
  const profileLines = [];
  if (b.age_range)     profileLines.push(`Age: ${b.age_range}`);
  if (b.region)        profileLines.push(`Region: ${b.region}`);
  if (b.location_type) profileLines.push(`Location: ${LOCATION_LABELS[b.location_type] || b.location_type}`);
  if (b.education_level) profileLines.push(`Education: ${EDUCATION_LABELS[b.education_level] || b.education_level}`);
  if (b.dominant_language) profileLines.push(`Primary language: ${LANGUAGE_LABELS[b.dominant_language] || b.dominant_language}`);
  if (b.code_switch_frequency) profileLines.push(`Language pattern: ${SWITCH_LABELS[b.code_switch_frequency] || b.code_switch_frequency}`);

  if (profileLines.length) {
    lines.push('PROFILE');
    lines.push(profileLines.join('\n'));
    lines.push('');
  }

  // ── Background ──
  if (b.background && b.background.trim()) {
    lines.push('BACKGROUND');
    lines.push(b.background.trim());
    lines.push('');
  }

  // ── Cultural knowledge domains ──
  const domainBlocks = DOMAIN_ORDER
    .map(key => {
      const dom = d[key];
      if (!dom || !dom.content || !dom.content.trim()) return null;
      return `${DOMAIN_LABELS[key].toUpperCase()}\n${dom.content.trim()}`;
    })
    .filter(Boolean);

  if (domainBlocks.length) {
    lines.push('CULTURAL KNOWLEDGE');
    lines.push('');
    lines.push(domainBlocks.join('\n\n'));
    lines.push('');
  }

  // ── Behavioral guidelines ──
  lines.push('BEHAVIORAL GUIDELINES');
  lines.push(`Respond as ${persona.name} would genuinely respond — drawing only on the cultural knowledge and life experience described above.`);
  lines.push('Speak from lived experience, not academic distance or general knowledge.');
  lines.push('Your perspective reflects your specific background, region, and life — not all Haitians.');
  lines.push('When asked about something outside your direct experience, respond as this specific person would: honestly, and with the limits of your knowledge.');
  lines.push('Do not speculate beyond what someone with your background would know.');
  lines.push('');
  lines.push('CONTEXT');
  lines.push('The people asking you questions are international researchers, NGO workers, and health professionals. They are trying to understand Haitian communities better for their work. Answer their questions honestly, specifically, and from your own perspective.');

  return lines.join('\n').trim();
}

/**
 * validatePersona(persona)
 * Returns an object describing the completeness of the persona.
 * Used by the admin portal preview endpoint.
 */
function validatePersona(persona) {
  const b = persona.basic || {};
  const d = persona.domains || {};

  const basicFilled = ['age_range', 'region', 'education_level', 'dominant_language', 'background']
    .filter(f => b[f] && b[f].trim());

  const domainsFilled = DOMAIN_ORDER.filter(key => {
    const dom = d[key];
    return dom && dom.content && dom.content.trim();
  });

  const domainsValidated = DOMAIN_ORDER.filter(key => {
    const dom = d[key];
    return dom && dom.source === 'partner_validated';
  });

  const hasManualPrompt = !!(persona.system_prompt && persona.system_prompt.trim());

  return {
    has_manual_prompt:   hasManualPrompt,
    basic_fields_filled: basicFilled.length,
    basic_fields_total:  5,
    domains_with_content: domainsFilled.length,
    domains_total:        DOMAIN_ORDER.length,
    domains_validated:    domainsValidated.length,
    ready_for_jumo:       hasManualPrompt || (domainsFilled.length >= 3 && basicFilled.length >= 3),
    warnings: [
      !hasManualPrompt && domainsFilled.length === 0 ? 'No domain content — prompt will be nearly empty' : null,
      !hasManualPrompt && basicFilled.length < 3 ? 'Basic profile incomplete' : null,
      domainsValidated.length === 0 ? 'No domains partner-validated yet' : null,
    ].filter(Boolean),
  };
}

module.exports = { buildSystemPrompt, validatePersona, DOMAIN_LABELS, DOMAIN_ORDER };
