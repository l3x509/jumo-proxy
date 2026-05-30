/**
 * JUMO Admin Panel — Display Info Patch
 * Adds archetype, age, location, bio, tags, questions fields to persona editor.
 *
 * Run: node patch-admin.js
 * Input:  admin.html  (in same directory)
 * Output: admin-updated.html
 */

const fs = require('fs');
const path = require('path');

const INPUT  = path.join(__dirname, 'admin.html');
const OUTPUT = path.join(__dirname, 'admin-updated.html');

if (!fs.existsSync(INPUT)) {
  console.error('❌ admin.html not found in current directory.');
  process.exit(1);
}

let html = fs.readFileSync(INPUT, 'utf8');
let changes = 0;

function replace(label, from, to) {
  if (!html.includes(from)) {
    console.warn(`⚠  ${label} — target string not found (may already be applied)`);
    return;
  }
  html = html.replace(from, to);
  changes++;
  console.log(`✓  ${label}`);
}

/* ══════════════════════════════════════════════════════════════
   CHANGE 1: Add Display Info block before Basic Profile in HTML
   ══════════════════════════════════════════════════════════════ */
replace(
  'Add Display Info block',

  // Target: the comment + opening of Basic Profile block
  `      <!-- Basic Info -->
      <div class="domain-block">
        <div class="domain-hdr" onclick="toggleDomain('basic')">
          <div class="domain-title">Basic Profile</div>`,

  // Replacement: Display Info block inserted before Basic Profile
  `      <!-- Display Info — controls test shell UI -->
      <div class="domain-block" style="border-color:#1E3A5F;">
        <div class="domain-hdr" onclick="toggleDomain('display')" style="background:#040C1A;">
          <div class="domain-title" style="color:#7EC8E3;">Display Info</div>
          <span style="font-size:10px;font-weight:400;color:#3A5A70;margin-left:4px;">— test shell UI fields</span>
          <span class="domain-chevron open" id="chev-display">▶</span>
        </div>
        <div class="domain-body" id="dom-display">
          <div style="font-size:10.5px;color:#3A5A70;margin-bottom:10px;line-height:1.5;">These fields populate the test shell directly — sidebar archetype, profile card, preset questions. Changes are live after Save with no deploy needed.</div>
          <div class="field-row">
            <div class="field-group">
              <div class="field-lbl">Archetype Label</div>
              <input type="text" class="field-input" id="f-archetype" placeholder="e.g. Rural Elder — Southern Haiti" oninput="markDirty()">
            </div>
            <div class="field-group">
              <div class="field-lbl">Display Age</div>
              <input type="text" class="field-input" id="f-age" placeholder="e.g. 58" oninput="markDirty()">
            </div>
          </div>
          <div class="field-row">
            <div class="field-group full">
              <div class="field-lbl">Display Location</div>
              <input type="text" class="field-input" id="f-location" placeholder="e.g. Jacmel, Sud, Haiti" oninput="markDirty()">
            </div>
          </div>
          <div class="field-group full" style="margin-bottom:10px;">
            <div class="field-lbl">Bio <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:9px;color:#2A3A50;">— shown on profile card in test shell</span></div>
            <textarea class="field-textarea" id="f-bio" placeholder="1–2 sentences. Specific and grounded. Third person." oninput="markDirty()" style="min-height:60px;"></textarea>
          </div>
          <div class="field-group full" style="margin-bottom:10px;">
            <div class="field-lbl">Tags <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:9px;color:#2A3A50;">— comma-separated</span></div>
            <input type="text" class="field-input" id="f-tags" placeholder="e.g. rural, Catholic, matriarch, southern Haiti" oninput="markDirty()">
          </div>
          <div class="field-group full">
            <div class="field-lbl">Preset Questions <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:9px;color:#2A3A50;">— one per line, clickable prompts in test shell</span></div>
            <textarea class="field-textarea" id="f-questions" placeholder="Tell me about a time someone in your family got sick.&#10;What goes through your mind when you see an outside organization in your community?&#10;Walk me through what happened yesterday." oninput="markDirty()" style="min-height:110px;"></textarea>
          </div>
        </div>
      </div>

      <!-- Basic Info -->
      <div class="domain-block">
        <div class="domain-hdr" onclick="toggleDomain('basic')">
          <div class="domain-title">Basic Profile</div>`
);

/* ══════════════════════════════════════════════════════════════
   CHANGE 2: Rename system_prompt_fragment textarea id/placeholder
   ══════════════════════════════════════════════════════════════ */
replace(
  'Rename system_prompt_fragment → system_prompt in HTML',
  `<textarea class="pe-system-txt" id="f-system_prompt_fragment" placeholder="Compiled text injected into Jumo's system prompt for this persona. Edit domains above or write directly here." oninput="markDirty()"></textarea>`,
  `<textarea class="pe-system-txt" id="f-system_prompt" placeholder="Full persona text injected into Jumo's system prompt. If filled, this takes priority over domain sections above." oninput="markDirty()"></textarea>`
);

/* ══════════════════════════════════════════════════════════════
   CHANGE 3: Update makeDefaultPersona to include new fields
   ══════════════════════════════════════════════════════════════ */
replace(
  'Update makeDefaultPersona',
  `  return { id:id, name:id, color:'#3A5A70', status:'draft', basic:{}, domains:doms, system_prompt_fragment:'', version:1, updated_at:null };`,
  `  return { id:id, name:id, color:'#3A5A70', status:'draft', archetype:'', age:'', location:'', bio:'', tags:[], questions:[], basic:{}, domains:doms, system_prompt:'', version:1, updated_at:null };`
);

/* ══════════════════════════════════════════════════════════════
   CHANGE 4: Update populateEditor to populate new fields
   ══════════════════════════════════════════════════════════════ */
replace(
  'Update populateEditor — populate Display Info fields',
  `  document.getElementById('f-background').value=b.background||'';
  DOMAINS.forEach(function(d){`,
  `  document.getElementById('f-background').value=b.background||'';

  /* ── Display Info fields ── */
  document.getElementById('f-archetype').value = p.archetype || '';
  document.getElementById('f-age').value        = String(p.age || '');
  document.getElementById('f-location').value   = p.location  || '';
  document.getElementById('f-bio').value        = p.bio       || '';
  document.getElementById('f-tags').value       = Array.isArray(p.tags)      ? p.tags.join(', ')  : (p.tags      || '');
  document.getElementById('f-questions').value  = Array.isArray(p.questions) ? p.questions.join('\\n') : (p.questions || '');

  DOMAINS.forEach(function(d){`
);

/* ══════════════════════════════════════════════════════════════
   CHANGE 5: Update populateEditor — system_prompt field name
   ══════════════════════════════════════════════════════════════ */
replace(
  'Update populateEditor — system_prompt field',
  `  document.getElementById('f-system_prompt_fragment').value=p.system_prompt_fragment||'';`,
  `  document.getElementById('f-system_prompt').value = p.system_prompt || p.system_prompt_fragment || '';`
);

/* ══════════════════════════════════════════════════════════════
   CHANGE 6: Update collectPersonaData to collect new fields
   ══════════════════════════════════════════════════════════════ */
replace(
  'Update collectPersonaData — collect Display Info fields',
  `  var b=p.basic||{};
  ['age_range','region','education_level','dominant_language','code_switch_frequency','location_type'].forEach(function(f){
    var el=document.getElementById('f-'+f); if(el) b[f]=el.value;
  });
  b.background=document.getElementById('f-background').value;
  p.basic=b;
  p.status=document.getElementById('pe-status').value;`,
  `  /* ── Display Info fields ── */
  p.archetype = document.getElementById('f-archetype').value.trim();
  p.age       = document.getElementById('f-age').value.trim();
  p.location  = document.getElementById('f-location').value.trim();
  p.bio       = document.getElementById('f-bio').value.trim();
  p.tags      = document.getElementById('f-tags').value.split(',').map(function(t){ return t.trim(); }).filter(Boolean);
  p.questions = document.getElementById('f-questions').value.split('\\n').map(function(q){ return q.trim(); }).filter(Boolean);

  var b=p.basic||{};
  ['age_range','region','education_level','dominant_language','code_switch_frequency','location_type'].forEach(function(f){
    var el=document.getElementById('f-'+f); if(el) b[f]=el.value;
  });
  b.background=document.getElementById('f-background').value;
  p.basic=b;
  p.status=document.getElementById('pe-status').value;`
);

/* ══════════════════════════════════════════════════════════════
   CHANGE 7: Update collectPersonaData — system_prompt field name
   ══════════════════════════════════════════════════════════════ */
replace(
  'Update collectPersonaData — system_prompt field',
  `  p.system_prompt_fragment=document.getElementById('f-system_prompt_fragment').value;`,
  `  /* ── System prompt — correct field name for server ── */
  p.system_prompt = document.getElementById('f-system_prompt').value;
  delete p.system_prompt_fragment;`
);

/* ══════════════════════════════════════════════════════════════
   CHANGE 8: Update confirmImport to use system_prompt
   ══════════════════════════════════════════════════════════════ */
replace(
  'Update confirmImport — system_prompt field',
  `  if(_importParsed.systemPrompt) existing.system_prompt_fragment=_importParsed.systemPrompt;`,
  `  if(_importParsed.systemPrompt) existing.system_prompt=_importParsed.systemPrompt;`
);

/* ══════════════════════════════════════════════════════════════
   Write output
   ══════════════════════════════════════════════════════════════ */
fs.writeFileSync(OUTPUT, html, 'utf8');

console.log(`\n${changes > 0 ? '✅' : '⚠'} ${changes} change(s) applied`);
console.log(`📄 Output: ${OUTPUT}`);
if (changes < 8) {
  console.log('\n⚠  Some changes were skipped — the corresponding strings may already be applied or the file structure differs slightly.');
  console.log('   Check admin-updated.html and manually apply any missing changes.');
}
console.log('\nDeploy: copy admin-updated.html → public/admin.html in your repo\n');
