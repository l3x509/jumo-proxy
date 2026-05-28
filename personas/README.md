# JUMO Personas

Each JSON file in this directory defines one persona. These files are the version-controlled
source of truth for persona content. Changes committed here flow into Jumo on the next deploy.

## File naming
Use the persona's slug ID exactly — must match the ID in PERSONA_COLORS in admin.html.

## Version control rules
- Increment `version` by 1 every time you make a meaningful content change
- Write a clear git commit message: "Update marie-ange health domain — field interview 003"
- If the Supabase version is higher than the file version, Supabase wins on startup
- To "lock in" an admin portal edit, export the JSON and commit it here

## Field reference

### Top level
| Field | Type | Description |
|-------|------|-------------|
| id | string | Persona slug. Must match filename and PERSONA_COLORS key |
| name | string | Display name shown in UI |
| color | string | Hex color for UI display |
| status | string | draft / pending_review / validated / published |
| version | number | Increment on every meaningful edit |
| system_prompt | string | Manual override — if set, used directly instead of auto-building from domains |
| updated_at | string | ISO timestamp of last edit |

### basic object
| Field | Type | Description |
|-------|------|-------------|
| age_range | string | e.g. "45–55" |
| region | string | e.g. "Léogâne", "Port-au-Prince", "Boston" |
| location_type | string | rural / urban_haiti / port_au_prince / diaspora_us / diaspora_canada / diaspora_other |
| education_level | string | none / primary / secondary / university / vocational |
| dominant_language | string | creole / french / english / mixed_fr / mixed_en |
| code_switch_frequency | string | never / occasional / frequent / constant |
| background | string | Narrative paragraph describing this person's life context |

### domains object
Each domain has the same structure:
| Field | Type | Description |
|-------|------|-------------|
| content | string | The cultural prose — what this person knows, believes, does in this domain |
| source | string | ai_generated / cultural_edit / field_interview / partner_validated |
| confidence | string | low / medium / high |
| notes | string | Private admin notes — gaps, open questions, things to verify |

### Domain keys
- health — health beliefs, illness response, relationship to medicine
- family — household structure, decision-making, community roles
- economic — livelihood, financial decisions, cooperative structures
- institutional — relationship to NGOs, government, outside organizations
- religious — spiritual life and practice
- education — knowledge transmission, relationship to formal learning
- language_profile — speech patterns, register, code-switching behavior

## Cultural integrity rule
Never fill content fields with general Haiti knowledge. Every word in a content field
must come from direct cultural knowledge (Dulex), field interview data, or partner validation.
Leave fields empty until there is verified content to put there.
