/* ═══ MAIN ═══ */

/* ════════════════════════════
   CONSTANTS
   ════════════════════════════ */
var DOMAINS = ['health','family','economic','institutional','religious','education','language_profile'];
var DOMAIN_INFO = {
  health:           { label:'Health & Wellbeing',         placeholder:'How does this persona understand illness? Who do they consult first? What role do traditional practices play?' },
  family:           { label:'Family & Community',         placeholder:'How are household decisions made? Who holds authority? What are community support networks?' },
  economic:         { label:'Economic Life',              placeholder:'How does this persona generate income? How do they handle financial decisions? Sòl/cooperative structures?' },
  institutional:    { label:'Institutional Relationships',placeholder:'How do they view NGOs and aid organizations? What builds trust? What destroys it?' },
  religious:        { label:'Religious & Spiritual Life', placeholder:'What is their relationship to religious practice? How does spiritual life intersect with daily decisions and health?' },
  education:        { label:'Education & Knowledge',      placeholder:'How does this persona think about education? How is knowledge transmitted in their community?' },
  language_profile: { label:'Language Profile',           placeholder:'How does this persona speak? What vocabulary domains are distinctive? How and when do they code-switch?' }
};
var PARTNER_VERDICTS = [
  { key:'accurate', label:'✓ Ekzak',     sub:'Enfòmasyon kòrèk',    cls:'sel-accurate' },
  { key:'wrong',    label:'✗ Pa bon',    sub:'Enfòmasyon pa kòrèk', cls:'sel-wrong'    },
  { key:'partial',  label:'◑ Pasyèl',   sub:'Kèk pati kòrèk',      cls:'sel-partial'  },
  { key:'missing',  label:'+ Manke',     sub:'Gen bagay ki manke',  cls:'sel-missing'  }
];

/* ════════════════════════════
   STATE
   ════════════════════════════ */
function adminFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({'x-admin-token': currentToken}, opts.headers || {});
  return fetch(url, opts);
}
function partnerFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({'x-partner-token': currentToken}, opts.headers || {});
  return fetch(url, opts);
}

var currentRole    = '';
var currentToken   = '';
var allSessions    = [], filtered = [], selectedSessionId = null;
var personaData    = {}, selectedPersonaId = null, isDirty = false;
var personaListData = [];
var partnerItems   = [], partnerVerdicts = {}, partnerPersonaContext = {};
var P_STORAGE_KEY  = 'jumo_partner_v2';

/* ════════════════════════════
   AUTH
   ════════════════════════════ */
async function tryAuth() {
  var token = document.getElementById('auth-input').value.trim();
  if (!token) return;
  var btn = document.getElementById('auth-btn');
  var errEl = document.getElementById('auth-error');
  btn.textContent = '…'; btn.disabled = true;
  try {
    var res = await fetch('/api/auth?token=' + encodeURIComponent(token));
    if (res.status === 401) {
      errEl.textContent = 'Kòd pa bon. / Invalid token.';
      errEl.style.display = 'block';
      btn.textContent = 'Antre / Sign In'; btn.disabled = false;
      return;
    }
    if (!res.ok) {
      errEl.textContent = 'Server error ' + res.status + ' — check Railway logs.';
      errEl.style.display = 'block';
      btn.textContent = 'Antre / Sign In'; btn.disabled = false;
      return;
    }
    var data = await res.json();
    currentToken = token;
    currentRole  = data.role;
    document.getElementById('auth').style.display = 'none';
    errEl.style.display = 'none';
    try {
      initByRole();
    } catch(ie) {
      console.error('initByRole error:', ie);
      document.getElementById('auth').style.display = 'none'; // stay logged in
      showToast('UI error after login — check console: ' + ie.message);
    }
  } catch(e) {
    errEl.textContent = 'Network error — is Railway running? ' + e.message;
    errEl.style.display = 'block';
  }
  btn.textContent = 'Antre / Sign In'; btn.disabled = false;
}
document.getElementById('auth-input').addEventListener('keydown', function(e){ if (e.key==='Enter') tryAuth(); });

function signOut() {
  currentToken=''; currentRole=''; allSessions=[]; personaData={}; partnerItems=[]; partnerVerdicts={};
  document.getElementById('auth').style.display='flex';
  document.getElementById('auth-input').value='';
  document.getElementById('auth-error').style.display='none';
  document.getElementById('hdr').style.display='none';
  document.getElementById('tab-bar').classList.remove('visible');
  ['sessions-view','personas-view'].forEach(function(id){ document.getElementById(id).classList.remove('active'); });
  document.getElementById('partner-view').classList.remove('active');
}

function initByRole() {
  var hdr = document.getElementById('hdr');
  hdr.style.display = 'flex';
  if (currentRole === 'admin') {
    document.getElementById('role-badge').textContent = 'Admin';
    document.getElementById('role-badge').style.color = '#4B7A8A';
    document.getElementById('tab-bar').classList.add('visible');
    document.getElementById('hdr-refresh').style.display = '';
    document.getElementById('hdr-export').style.display = '';
    buildDomainBlocks();
    showTab('sessions');
    loadSessions();
  } else if (currentRole === 'partner') {
    document.getElementById('role-badge').textContent = 'Patnè Kiltirèl';
    document.getElementById('role-badge').style.color = '#34D399';
    document.getElementById('partner-view').classList.add('active');
    loadPartnerQueue();
  }
}

/* ════════════════════════════
   TAB NAVIGATION (admin)
   ════════════════════════════ */
function showTab(tab) {
  document.getElementById('sessions-view').classList.toggle('active', tab==='sessions');
  document.getElementById('personas-view').classList.toggle('active', tab==='personas');
  document.getElementById('flags-view').classList.toggle('active', tab==='flags');
  document.getElementById('corpus-view').classList.toggle('active', tab==='corpus');
  var gv = document.getElementById('gaps-view'); if (gv) gv.classList.toggle('active', tab==='gaps');
  document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.toggle('tab-active', b.dataset.tab===tab); });
  if (tab==='personas' && Object.keys(personaData).length===0) loadPersonas();
  if (tab==='flags')  loadFlags();
  if (tab==='corpus') loadCorpus();
  if (tab==='gaps')   loadGaps();
}

/* ════════════════════════════
   SESSIONS (admin)
   ════════════════════════════ */
async function loadSessions() {
  document.getElementById('session-list').innerHTML='<div style="padding:12px;color:#2A3A50">Loading…</div>';
  try {
    var res = await adminFetch('/api/sessions?limit=500');
    if (!res.ok) throw new Error('fail');
    allSessions = await res.json();
    buildFilters(); applyFilters(); updateStats();
  } catch(e) {
    document.getElementById('session-list').innerHTML='<div style="padding:12px;color:#EF4444">Failed to load.</div>';
  }
}
function buildFilters() {
  var personas={}, testers={};
  allSessions.forEach(function(s){
    if(s.persona_id) personas[s.persona_id]=s.persona_name;
    if(s.tester_id)  testers[s.tester_id]=s.tester_id.slice(0,8);
  });
  var pSel=document.getElementById('f-persona');
  pSel.innerHTML='<option value="">All personas</option>';
  Object.keys(personas).sort().forEach(function(id){ pSel.innerHTML+='<option value="'+esc(id)+'">'+esc(personas[id]||id)+'</option>'; });
  var tSel=document.getElementById('f-tester');
  tSel.innerHTML='<option value="">All testers</option>';
  Object.keys(testers).forEach(function(id){ tSel.innerHTML+='<option value="'+esc(id)+'">…'+esc(testers[id])+'</option>'; });
}
function applyFilters() {
  var type=document.getElementById('f-type').value, persona=document.getElementById('f-persona').value, tester=document.getElementById('f-tester').value;
  filtered=allSessions.filter(function(s){
    if(type    && s.type!==type)        return false;
    if(persona && s.persona_id!==persona) return false;
    if(tester  && s.tester_id!==tester)  return false;
    return true;
  });
  renderSessionList();
}
function clearFilters(){ document.getElementById('f-type').value=''; document.getElementById('f-persona').value=''; document.getElementById('f-tester').value=''; applyFilters(); }
function updateStats() {
  var chats=allSessions.filter(function(s){return s.type==='chat';}).length;
  var bcs=allSessions.filter(function(s){return s.type==='broadcast';}).length;
  var testers=new Set(allSessions.map(function(s){return s.tester_id;}).filter(Boolean)).size;
  document.getElementById('stat-total').textContent=allSessions.length;
  document.getElementById('stat-chat').textContent=chats;
  document.getElementById('stat-bc').textContent=bcs;
  document.getElementById('stat-testers').textContent=testers;
}
function renderSessionList() {
  var col=document.getElementById('session-list');
  if(!filtered.length){ col.innerHTML='<div style="padding:12px;color:#2A3A50">No sessions match.</div>'; return; }
  var html='';
  filtered.forEach(function(s){
    var color=(s.persona_id&&personaColor(s.persona_id))||'#3A5A70';
    var icon=s.type==='broadcast'?'⊕':s.type==='compare'?'⇔':'▣';
    var count=s.type==='broadcast'?(s.broadcast_results?Object.keys(s.broadcast_results).filter(function(k){return s.broadcast_results[k].status==='done';}).length+'/10':'0/10'):((s.exchanges||[]).length+' msg');
    var noteIcon=s.researcher_notes?' 📝':'';
    var tester=s.tester_id?'…'+s.tester_id.slice(-8):'unknown';
    var dt=s.created_at?new Date(s.created_at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):s.session_timestamp||'';
    html+='<div class="s-item'+(s.id===selectedSessionId?' active':'')+'" onclick="selectSession(\''+esc(s.id)+'\')">'+
      '<div class="s-name" style="color:'+color+'">'+icon+' '+esc(s.persona_name||'Unknown')+noteIcon+'</div>'+
      '<div class="s-meta">'+esc(dt)+' · '+esc(count)+' · '+esc(tester)+'</div></div>';
  });
  col.innerHTML=html;
}
function selectSession(id) {
  selectedSessionId=id; renderSessionList();
  var s=allSessions.find(function(x){return x.id===id;});
  if(!s) return;
  var color=(s.persona_id&&personaColor(s.persona_id))||'#3A5A70';
  var dt=s.created_at?new Date(s.created_at).toLocaleString():s.session_timestamp||'';
  var html='<div class="anim">';
  html+='<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">'+
    '<div style="width:36px;height:36px;border-radius:9px;background:'+color+'22;border:1px solid '+color+'66;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">'+(s.type==='broadcast'?'⊕':s.type==='compare'?'⇔':'▣')+'</div>'+
    '<div><div style="font-size:14px;font-weight:600;color:#E2E8F0">'+esc(s.persona_name||'Unknown')+'</div>'+
    '<div style="font-size:10.5px;color:#3A5A70">'+esc(dt)+' · Tester: '+esc(s.tester_id?'…'+s.tester_id.slice(-8):'unknown')+'</div></div></div>';
  if(s.researcher_notes){
    html+='<div style="background:#040710;border:1px solid #1E3A5F;border-radius:7px;padding:10px 12px;margin-bottom:16px">'+
      '<div class="lbl" style="margin-bottom:5px">Researcher Notes</div>'+
      '<div style="font-size:12px;color:#94A3B8;line-height:1.6;white-space:pre-wrap">'+esc(s.researcher_notes)+'</div></div>';
  }
  if(s.type==='broadcast'){
    html+='<div style="font-size:13px;font-weight:600;color:#E2E8F0;margin-bottom:14px;line-height:1.4">'+esc(s.broadcast_question||'')+'</div>';
    var results=s.broadcast_results||{};
    Object.keys(results).forEach(function(pid){
      var r=results[pid]; if(!r||r.status!=='done') return;
      var c=personaColor(pid)||'#3A5A70';
      html+='<div class="bc-resp" style="border-left:3px solid '+c+'"><div style="font-size:10.5px;font-weight:600;color:'+c+';margin-bottom:6px">'+esc(pid)+'</div><div style="font-size:12px;color:#94A3B8;line-height:1.65;white-space:pre-wrap">'+esc(r.text||'')+'</div></div>';
    });
  } else {
    var exchanges=s.exchanges||[];
    if(!exchanges.length) html+='<div style="color:#2A3A50;font-size:11.5px">No messages recorded.</div>';
    var pairs=[];
    for(var j=0;j<exchanges.length;j++){
      if(exchanges[j].role==='user') pairs.push({q:exchanges[j].content,a:null});
      else if(pairs.length && exchanges[j].role==='assistant') pairs[pairs.length-1].a=exchanges[j].content;
    }
    exchanges.forEach(function(e,j){
      var isUser=e.role==='user';
      var sendBtn='';
      if(!isUser && pairs.length){
        var pair=pairs.find(function(p){ return p.a===e.content; });
        if(pair && pair.a){
          var qJson=JSON.stringify(pair.q||'');
          var aJson=JSON.stringify(pair.a);
          var pidJson=JSON.stringify(s.persona_id||'');
          var pnJson=JSON.stringify(s.persona_name||'');
          sendBtn='<div style="margin-top:4px;text-align:right;">' +
            '<button onclick="sendResponseToPartner('+qJson+','+aJson+','+pidJson+','+pnJson+')" style="background:transparent;border:1px solid #1E3A5F;border-radius:5px;color:#3A5A70;font-size:10px;padding:2px 8px;cursor:pointer;font-family:inherit;">↗ Send to partner</button>' +
          '</div>';
        }
      }
      html+='<div style="margin-bottom:4px;"><div style="display:flex;justify-content:'+(isUser?'flex-end':'flex-start')+'"><div class="bubble '+(isUser?'bubble-user':'bubble-asst')+'" style="'+(!isUser?'border-left:3px solid '+color+';':'')+'">'+esc(e.content)+'</div></div>'+sendBtn+'</div>';
    });
  }
  html+='</div>';
  document.getElementById('detail-empty').style.display='none';
  document.getElementById('detail-content').style.display='block';
  document.getElementById('detail-content').innerHTML=html;
}

/* ════════════════════════════
   PERSONAS (admin)
   ════════════════════════════ */
function buildDomainBlocks() {
  var container = document.getElementById('domain-blocks-container');
  var html = '';
  DOMAINS.forEach(function(d) {
    var info = DOMAIN_INFO[d];
    html += '<div class="domain-block" id="block-'+d+'">' +
      '<div class="domain-hdr" onclick="toggleDomain(\''+d+'\')">' +
        '<div class="domain-title">'+info.label+'</div>' +
        '<span class="domain-badge badge-ai" id="badge-'+d+'">AI</span>' +
        '<span class="conf-low" id="conf-'+d+'">Low</span>' +
        '<span class="domain-chevron" id="chev-'+d+'">▶</span>' +
      '</div>' +
      '<div class="domain-body hidden" id="dom-'+d+'">' +
        '<div class="field-group" style="margin-bottom:8px">' +
          '<div class="field-lbl">Cultural content</div>' +
          '<textarea class="field-textarea" id="fd-'+d+'-content" style="min-height:90px" oninput="markDirty()" placeholder="'+info.placeholder.replace(/"/g,"'")+'"></textarea>' +
        '</div>' +
        '<div class="domain-meta-row">' +
          '<div class="field-group"><div class="field-lbl">Source</div>' +
            '<select class="field-select" id="fd-'+d+'-source" onchange="markDirty();updateDomainBadge(\''+d+'\')">' +
              '<option value="ai_generated">AI Generated</option>' +
              '<option value="cultural_edit">Cultural Edit</option>' +
              '<option value="field_interview">Field Interview</option>' +
              '<option value="partner_validated">Partner Validated ✓</option>' +
            '</select></div>' +
          '<div class="field-group"><div class="field-lbl">Confidence</div>' +
            '<select class="field-select" id="fd-'+d+'-confidence" onchange="markDirty();updateDomainBadge(\''+d+'\')">' +
              '<option value="low">Low</option>' +
              '<option value="medium">Medium</option>' +
              '<option value="high">High</option>' +
            '</select></div>' +
        '</div>' +
        '<textarea class="field-notes" id="fd-'+d+'-notes" placeholder="Private notes — gaps, questions, issues…" oninput="markDirty()"></textarea>' +
      '</div>' +
    '</div>';
  });
  container.innerHTML = html;
}

function makeDefaultPersona(id) {
  var doms={};
  DOMAINS.forEach(function(d){ doms[d]={content:'',source:'ai_generated',confidence:'low',notes:''}; });
  return { id:id, name:id, color:'#3A5A70', status:'draft', archetype:'', age:'', location:'', bio:'', tags:[], questions:[], basic:{}, domains:doms, system_prompt:'', version:1, updated_at:null };
}

function personaColor(id) {
  var item = personaListData.find(function(p){ return p.id===id; });
  return (item && item.color) || (personaData[id] && personaData[id].color) || '#3A5A70';
}

async function loadPersonas() {
  var list = document.getElementById('persona-list');
  var searchVal = document.getElementById('persona-search') ? document.getElementById('persona-search').value : '';
  list.innerHTML='<div style="padding:12px;color:#2A3A50">Loading…</div>';
  try {
    var url = '/api/personas';
    if (searchVal) url += '&q=' + encodeURIComponent(searchVal);
    var res = await adminFetch(url);
    if(res.ok){
      personaListData = await res.json();
    } else { throw new Error(); }
  } catch(e) {
    personaListData = Object.values(personaData).map(function(p){
      return { id:p.id, name:p.name, color:p.color, status:p.status||'draft',
               domains_with_content:0, domains_validated:0, domains_total:DOMAINS.length };
    });
  }
  renderPersonaList();
  updatePersonaSummary();
  renderHealthDashboard();
}

function renderPersonaList() {
  var html='';
  if (!personaListData.length) {
    document.getElementById('persona-list').innerHTML='<div style="padding:12px;color:#2A3A50">No personas found.</div>';
    return;
  }
  personaListData.forEach(function(p){
    var initials=p.name.split(/[\s-]/).map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
    var subline = p.domains_validated+'/'+p.domains_total+' validated';
    if (p.region) subline = p.region + ' · ' + subline;
    html+='<div class="p-item'+(p.id===selectedPersonaId?' active':'')+'" onclick="selectPersona(\''+esc(p.id)+'\')">'+
      '<div class="p-avatar" style="background:'+esc(p.color)+'">'+initials+'</div>'+
      '<div style="flex:1;overflow:hidden">'+
        '<div class="p-iname">'+esc(p.name)+'</div>'+
        '<div class="p-imeta">'+esc(subline)+'</div>'+
      '</div>'+
      '<div class="status-dot '+esc(p.status||'draft')+'"></div>'+
    '</div>';
  });
  document.getElementById('persona-list').innerHTML=html;
}

function updatePersonaSummary() {
  var pub=personaListData.filter(function(p){return p.status==='published';}).length;
  var val=personaListData.filter(function(p){return p.status==='validated';}).length;
  var total=personaListData.length;
  document.getElementById('persona-summary').textContent=
    total+' total · '+pub+' published · '+val+' validated';
}

async function selectPersona(id) {
  if(isDirty&&selectedPersonaId&&!confirm('Unsaved changes. Discard?')) return;
  selectedPersonaId=id; isDirty=false;
  renderPersonaList();
  document.getElementById('persona-detail-empty').style.display='none';
  document.getElementById('persona-editor').style.display='block';
  document.getElementById('pe-name').textContent='Loading…';

  if (personaData[id]) {
    populateEditor(personaData[id]);
    return;
  }

  try {
    var res = await adminFetch('/api/personas/'+encodeURIComponent(id));
    if (res.ok) {
      var full = await res.json();
      personaData[id] = full;
      populateEditor(full);
    } else {
      var listItem = personaListData.find(function(p){ return p.id===id; });
      var skeleton = makeDefaultPersona(id);
      if (listItem) { skeleton.name=listItem.name; skeleton.color=listItem.color; skeleton.status=listItem.status; }
      personaData[id] = skeleton;
      populateEditor(skeleton);
      showToast('Full detail endpoint pending — editing skeleton');
    }
  } catch(e) {
    showToast('Could not load persona — check connection');
  }
}

function populateEditor(p) {
  var initials=p.name.split(/[\s-]/).map(function(w){return w[0];}).join('').slice(0,2).toUpperCase();
  var av=document.getElementById('pe-avatar');
  av.textContent=initials; av.style.background=p.color;
  document.getElementById('pe-name').textContent=p.name;
  document.getElementById('pe-status').value=p.status||'draft';
  var b=p.basic||{};
  ['age_range','region','education_level','dominant_language','code_switch_frequency','location_type'].forEach(function(f){
    var el=document.getElementById('f-'+f); if(el) el.value=b[f]||'';
  });
  document.getElementById('f-background').value=b.background||'';

  document.getElementById('f-archetype').value = p.archetype || '';
  document.getElementById('f-age').value        = String(p.age || '');
  document.getElementById('f-location').value   = p.location  || '';
  document.getElementById('f-bio').value        = p.bio       || '';
  document.getElementById('f-tags').value       = Array.isArray(p.tags)      ? p.tags.join(', ')  : (p.tags      || '');
  document.getElementById('f-questions').value  = Array.isArray(p.questions) ? p.questions.join('\n') : (p.questions || '');

  DOMAINS.forEach(function(d){
    var dom=(p.domains&&p.domains[d])||{content:'',source:'ai_generated',confidence:'low',notes:''};
    var c=document.getElementById('fd-'+d+'-content');
    var s=document.getElementById('fd-'+d+'-source');
    var cf=document.getElementById('fd-'+d+'-confidence');
    var n=document.getElementById('fd-'+d+'-notes');
    if(c) c.value=dom.content||'';
    if(s) s.value=dom.source||'ai_generated';
    if(cf) cf.value=dom.confidence||'low';
    if(n) n.value=dom.notes||'';
    updateDomainBadge(d);
  });
  document.getElementById('f-system_prompt').value = p.system_prompt || p.system_prompt_fragment || '';
  var upd=p.updated_at?new Date(p.updated_at).toLocaleString():'Never';
  var exN = Array.isArray(p.voice_examples) ? p.voice_examples.length : 0;
  var hasAnchor = !!(p.voice_anchor && p.voice_anchor.trim());
  var openFlags = (typeof flagsData!=='undefined') ? flagsData.filter(function(fl){return fl.persona_id===p.id && fl.status!=='resolved';}).length : 0;
  var readiness = [];
  readiness.push(exN+' voice example'+(exN===1?'':'s'));
  readiness.push(hasAnchor?'anchor set':'no anchor');
  if (openFlags) readiness.push('⚑ '+openFlags+' open flag'+(openFlags===1?'':'s'));
  document.getElementById('pe-version').innerHTML =
    'Version '+(p.version||1)+' · Last saved '+esc(upd)+
    ' <span style="color:'+(exN>=3?'#34D399':exN>0?'#F59E0B':'#EF4444')+';">· '+readiness.join(' · ')+'</span>';
  document.getElementById('persona-detail-empty').style.display='none';
  document.getElementById('persona-editor').style.display='block';
  /* ── PATCH: Voice & behavior fields ── */
  if (window.vePopulate) window.vePopulate(p);
}

function updateDomainBadge(d) {
  var s=document.getElementById('fd-'+d+'-source');
  var cf=document.getElementById('fd-'+d+'-confidence');
  var badge=document.getElementById('badge-'+d);
  var conf=document.getElementById('conf-'+d);
  if(!s||!badge) return;
  badge.className='domain-badge';
  var src=s.value;
  if(src==='ai_generated')      { badge.classList.add('badge-ai');        badge.textContent='AI'; }
  else if(src==='cultural_edit'){ badge.classList.add('badge-edited');    badge.textContent='Edited'; }
  else if(src==='field_interview'){badge.classList.add('badge-field');    badge.textContent='Field'; }
  else if(src==='partner_validated'){badge.classList.add('badge-validated');badge.textContent='✓ Validated'; }
  if(conf&&cf){
    var cv=cf.value;
    conf.className='conf-'+cv;
    conf.textContent=cv.charAt(0).toUpperCase()+cv.slice(1);
  }
}

function toggleDomain(id) {
  var body=document.getElementById('dom-'+id);
  var chev=document.getElementById('chev-'+id);
  if(!body) return;
  var hidden=body.classList.contains('hidden');
  body.classList.toggle('hidden',!hidden);
  if(chev) chev.classList.toggle('open',hidden);
}

function markDirty() { isDirty=true; }

function collectPersonaData() {
  var id=selectedPersonaId; if(!id) return null;
  var existing=personaData[id]||makeDefaultPersona(id);
  var p=JSON.parse(JSON.stringify(existing));
  p.archetype = document.getElementById('f-archetype').value.trim();
  p.age       = document.getElementById('f-age').value.trim();
  p.location  = document.getElementById('f-location').value.trim();
  p.bio       = document.getElementById('f-bio').value.trim();
  p.tags      = document.getElementById('f-tags').value.split(',').map(function(t){ return t.trim(); }).filter(Boolean);
  p.questions = document.getElementById('f-questions').value.split('\n').map(function(q){ return q.trim(); }).filter(Boolean);

  var b=p.basic||{};
  ['age_range','region','education_level','dominant_language','code_switch_frequency','location_type'].forEach(function(f){
    var el=document.getElementById('f-'+f); if(el) b[f]=el.value;
  });
  b.background=document.getElementById('f-background').value;
  p.basic=b;
  p.status=document.getElementById('pe-status').value;
  DOMAINS.forEach(function(d){
    if(!p.domains[d]) p.domains[d]={content:'',source:'ai_generated',confidence:'low',notes:''};
    var c=document.getElementById('fd-'+d+'-content');
    var s=document.getElementById('fd-'+d+'-source');
    var cf=document.getElementById('fd-'+d+'-confidence');
    var n=document.getElementById('fd-'+d+'-notes');
    if(c) p.domains[d].content=c.value;
    if(s) p.domains[d].source=s.value;
    if(cf) p.domains[d].confidence=cf.value;
    if(n) p.domains[d].notes=n.value;
  });
  p.system_prompt = document.getElementById('f-system_prompt').value;
  delete p.system_prompt_fragment;
  /* ── PATCH: Voice & behavior fields ── */
  if (window.veCollect) Object.assign(p, window.veCollect());
  p.version=(existing.version||1)+(isDirty?1:0);
  p.updated_at=new Date().toISOString();
  return p;
}

async function savePersona() {
  var p=collectPersonaData(); if(!p) return;
  try {
    var res=await adminFetch('/api/personas/'+encodeURIComponent(p.id), {
      method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)
    });
    personaData[p.id]=p; isDirty=false;
    document.getElementById('pe-version').textContent='Version '+p.version+' · Last saved '+new Date(p.updated_at).toLocaleString();
    renderPersonaList(); updatePersonaSummary();
    showToast(res.ok?'Saved ✓':'Saved locally (API pending)');
  } catch(e){ personaData[p.id]=p; isDirty=false; renderPersonaList(); showToast('Saved locally'); }
}

async function sendToPartner() {
  if(!selectedPersonaId) return;
  var p=collectPersonaData(); if(!p) return;
  if(!confirm('Send '+p.name+' to partner for validation?')) return;
  try {
    var res=await adminFetch('/api/personas/'+encodeURIComponent(p.id)+'/send-to-partner',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)
    });
    if(res.ok){
      p.status='pending_review'; personaData[p.id]=p;
      document.getElementById('pe-status').value='pending_review';
      renderPersonaList(); updatePersonaSummary(); showToast('Sent to partner ↗');
    } else { showToast('Fill in domain content first'); }
  } catch(e){ showToast('Could not reach server'); }
}

function showToast(msg) {
  var el=document.createElement('div'); el.className='save-toast'; el.textContent=msg;
  document.body.appendChild(el); setTimeout(function(){ el.remove(); },2500);
}

/* ════════════════════════════
   PARTNER QUEUE
   ════════════════════════════ */
window.addEventListener('online',  function(){ document.getElementById('offline-bar').style.display='none'; retryPending(); });
window.addEventListener('offline', function(){ document.getElementById('offline-bar').style.display='block'; });

async function loadPartnerQueue() {
  try {
    var res = await (currentRole==='partner' ? partnerFetch('/api/partner/queue') : adminFetch('/api/partner/queue'));
    if(res.status===401){ signOut(); return; }
    partnerItems=res.ok ? await res.json() : [];
    try {
      var pRes = await (currentRole==='partner' ? partnerFetch('/api/partner/personas') : adminFetch('/api/partner/personas'));
      if(pRes.ok){
        var personas=await pRes.json();
        personas.forEach(function(p){ partnerPersonaContext[p.id]=p; });
      }
    } catch(e){}
  } catch(e){ partnerItems=[]; }
  try { var s=localStorage.getItem(P_STORAGE_KEY); if(s) partnerVerdicts=JSON.parse(s); } catch(e){}
  renderPartnerItems(); updatePartnerProgress();
}

function renderPartnerItems() {
  var container=document.getElementById('p-items-container');
  var empty=document.getElementById('partner-empty');
  var success=document.getElementById('partner-success');
  success.style.display='none';
  if(!partnerItems.length){ container.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';
  var html='';
  partnerItems.forEach(function(item,idx){
    var color=personaColor(item.persona_id)||'#3A5A70';
    var v=partnerVerdicts[item.id];
    var isFlagCorrection=(item.item_type==='flag_correction');
    var cardClass='val-card'+(v&&v.verdict?(v.verdict==='wrong'?' flagged':' done'):'');
    var animDelay='animation-delay:'+Math.min(idx*.05,.3)+'s';
    var ctx = partnerPersonaContext[item.persona_id] || {};
    var basic = ctx.basic || {};
    var contextParts = [];
    if (basic.age_range)       contextParts.push(basic.age_range + ' ans');
    if (basic.region)          contextParts.push(basic.region);
    if (basic.education_level) contextParts.push(basic.education_level);
    if (basic.dominant_language) contextParts.push(basic.dominant_language);
    var contextStr = contextParts.join(' · ');
    var personaContextHtml = '<div style="padding:8px 14px;background:#040710;border-bottom:1px solid #0A1628;display:flex;align-items:center;gap:10px;">'+
      '<div style="width:28px;height:28px;min-width:28px;border-radius:7px;background:'+color+'22;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:'+color+';">'+
        esc((item.persona_name||'?').slice(0,2).toUpperCase())+
      '</div>'+
      '<div>'+
        '<div style="font-size:12px;font-weight:600;color:'+color+';">'+esc(item.persona_name||item.persona_id)+'</div>'+
        (contextStr ? '<div style="font-size:10.5px;color:#3A5A70;margin-top:1px;">'+esc(contextStr)+'</div>' : '')+
        (basic.background ? '<div style="font-size:10px;color:#2A3A50;margin-top:2px;line-height:1.4;">'+esc(basic.background.slice(0,120))+(basic.background.length>120?'…':'')+'</div>' : '')+
      '</div>'+
    '</div>';

    if(isFlagCorrection){
      var typeLabel=item.domain_label||item.domain||'Response';
      html+='<div class="'+cardClass+' anim" id="pcard-'+item.id+'" style="'+animDelay+';border-color:#78350F">'+
        personaContextHtml+
        '<div class="val-card-header" style="background:#1A0A00">'+
          '<div style="font-size:10px;background:#78350F;color:#FCD34D;border-radius:4px;padding:2px 8px;font-weight:600;">⚑ Repons ki pa bon</div>'+
          '<div class="val-domain-badge">'+esc(typeLabel)+'</div>'+
        '</div>'+
        '<div class="val-content">'+
          '<div class="val-content-lbl" style="color:#F59E0B">Sa JUMO te di (pa bon)</div>'+
          '<div class="val-content-text" style="border-left:3px solid #EF4444;">'+esc(item.content)+'</div>'+
          (item.admin_notes?'<div class="val-admin-note" style="white-space:pre-wrap">'+esc(item.admin_notes)+'</div>':'')+
        '</div>'+
        '<div class="verdict-section">'+
          '<div class="verdict-lbl" style="color:#F59E0B">Ekri enfòmasyon ki kòrèk la:</div>'+
          buildStructuredCorrectionForm(item.id,'flag',v)+
          '<div style="margin-top:8px;display:flex;gap:6px;">'+
            '<button class="verdict-btn'+(v&&v.verdict==='accurate'?' sel-accurate':'')+'" onclick="setPartnerVerdict(\''+item.id+'\',\'accurate\')" style="flex:1">✓ Mwen ekri kòreksyon an</button>'+
            '<button class="verdict-btn'+(v&&v.verdict==='wrong'?' sel-wrong':'')+'" onclick="setPartnerVerdict(\''+item.id+'\',\'wrong\')" style="flex:1">✗ Mwen pa konn repons lan</button>'+
          '</div>'+
          (v&&v.verdict?'<div class="done-indicator">✓ Ou reponn sou eleman sa</div>':'')+
        '</div>'+
      '</div>';
    } else if(item.item_type==='response_validation'){
      var questionText=item.question_text||extractQuestionFromNotes(item.admin_notes||'');
      html+='<div class="'+cardClass+' anim" id="pcard-'+item.id+'" style="'+animDelay+';border-color:#7C3AED">'+
        personaContextHtml+
        '<div class="val-card-header" style="background:#130D2A;border-bottom-color:#2D1B6E;">'+
          '<div style="font-size:10px;background:#7C3AED;color:#E9D5FF;border-radius:4px;padding:2px 8px;font-weight:600;">💬 Repons JUMO</div>'+
          '<div class="val-domain-badge">'+esc(item.domain_label||item.domain||'Repons')+'</div>'+
        '</div>'+
        '<div class="val-content">'+
          (questionText?'<div class="val-content-lbl" style="margin-bottom:4px;">Kesyon yo te poze</div><div style="font-size:12px;color:#64748B;line-height:1.5;font-style:italic;margin-bottom:10px;padding:6px 10px;background:#040710;border-radius:5px;">'+esc(questionText)+'</div>':'')+
          '<div class="val-content-lbl" style="color:#A78BFA;">Repons JUMO a</div>'+
          '<div class="val-content-text" style="border-left:3px solid #7C3AED;">'+esc(item.content)+'</div>'+
        '</div>'+
        '<div class="verdict-section">'+
          '<div class="verdict-lbl">Repons sa a kòrèk pou persona sa?</div>'+
          '<div class="verdict-grid" style="grid-template-columns:1fr 1fr;">'+
            '<button class="verdict-btn'+(v&&v.verdict==='accurate'?' sel-accurate':'')+'" onclick="setPartnerVerdict(\''+item.id+'\',\'accurate\')">✓ Kòrèk<br><span style="font-size:10px;font-weight:400;opacity:.7">Repons lan bon</span></button>'+
            '<button class="verdict-btn'+(v&&v.verdict==='partial'?' sel-partial':'')+'" onclick="setPartnerVerdict(\''+item.id+'\',\'partial\')">≈ Pasyèlman<br><span style="font-size:10px;font-weight:400;opacity:.7">Gen pati ki manke</span></button>'+
            '<button class="verdict-btn'+(v&&v.verdict==='wrong'?' sel-wrong':'')+'" onclick="setPartnerVerdict(\''+item.id+'\',\'wrong\')">✗ Pa kòrèk<br><span style="font-size:10px;font-weight:400;opacity:.7">Enfòmasyon ki mal</span></button>'+
            '<button class="verdict-btn'+(v&&v.verdict==='off_persona'?' sel-wrong':'')+'" onclick="setPartnerVerdict(\''+item.id+'\',\'off_persona\')">👤 Pa sanble li<br><span style="font-size:10px;font-weight:400;opacity:.7">Vwa a pa bon</span></button>'+
          '</div>'+
          ((v&&v.verdict&&v.verdict!=='accurate')?buildStructuredCorrectionForm(item.id,'response',v):'')+
          (v&&v.verdict?'<div class="done-indicator">✓ Ou revize repons sa</div>':'')+
        '</div>'+
      '</div>';
    } else {
      var btns=PARTNER_VERDICTS.map(function(vd){
        var sel=v&&v.verdict===vd.key?' '+vd.cls:'';
        return '<button class="verdict-btn'+sel+'" onclick="setPartnerVerdict(\''+item.id+'\',\''+vd.key+'\')">'+vd.label+'<br><span style="font-size:10px;font-weight:400;opacity:.7">'+vd.sub+'</span></button>';
      }).join('');
      html+='<div class="'+cardClass+' anim" id="pcard-'+item.id+'" style="'+animDelay+'">'+
        personaContextHtml+
        '<div class="val-card-header">'+
          '<div class="val-domain-badge">'+esc(item.domain_label||item.domain)+'</div>'+
        '</div>'+
        '<div class="val-content">'+
          '<div class="val-content-lbl">Kontni ki ekri pou persona sa</div>'+
          '<div class="val-content-text">'+esc(item.content)+'</div>'+
          (item.admin_notes?'<div class="val-admin-note">💬 '+esc(item.admin_notes)+'</div>':'')+
        '</div>'+
        '<div class="verdict-section">'+
          '<div class="verdict-lbl">Ki opinyon ou sou enfòmasyon sa?</div>'+
          '<div class="verdict-grid">'+btns+'</div>'+
          ((v&&v.verdict&&v.verdict!=='accurate')?buildStructuredCorrectionForm(item.id,'domain',v):'<textarea class="notes-area" id="pnotes-'+item.id+'" placeholder="Nòt ou yo (opsyonèl)…" oninput="savePartnerNote(\''+item.id+'\')">'+(v&&v.notes?esc(v.notes):'')+'</textarea>')+
          (v&&v.verdict?'<div class="done-indicator">✓ Ou revize eleman sa</div>':'')+
        '</div>'+
      '</div>';
    }
  });
  container.innerHTML=html;
}

function setPartnerVerdict(itemId, verdict) {
  if (!partnerVerdicts[itemId]) partnerVerdicts[itemId] = { verdict:'', notes:'' };
  partnerVerdicts[itemId].verdict = verdict;
  savePartnerLocal();
  var card = document.getElementById('pcard-'+itemId);
  if (!card) return;
  card.className = 'val-card anim ' + (verdict === 'wrong' || verdict === 'off_persona' ? 'flagged' : 'done');
  card.querySelectorAll('.verdict-btn').forEach(function(b) {
    var m = b.getAttribute('onclick').match(/'([^']+)'\)$/);
    if (!m) return;
    var bVerdict = m[1];
    var isSelected = bVerdict === verdict;
    b.classList.remove('sel-accurate','sel-partial','sel-wrong');
    if (isSelected) {
      if (bVerdict === 'accurate')  b.classList.add('sel-accurate');
      else if (bVerdict === 'partial') b.classList.add('sel-partial');
      else b.classList.add('sel-wrong');
    }
  });
  var scf = document.getElementById('scf-'+itemId);
  var verdictSection = card.querySelector('.verdict-section');
  var needsCorrection = verdict && verdict !== 'accurate';
  if (needsCorrection && !scf && verdictSection) {
    var item = partnerItems.find(function(x){ return x.id===itemId; });
    var type  = item ? (item.item_type === 'response_validation' ? 'response' : 'domain') : 'domain';
    var formEl = document.createElement('div');
    formEl.innerHTML = buildStructuredCorrectionForm(itemId, type, partnerVerdicts[itemId]);
    var firstChild = formEl.firstChild;
    var grid = verdictSection.querySelector('.verdict-grid');
    if (grid && grid.nextSibling) {
      verdictSection.insertBefore(firstChild, grid.nextSibling);
    } else if (verdictSection) {
      verdictSection.appendChild(firstChild);
    }
  } else if (!needsCorrection && scf) {
    scf.remove();
  }
  var di = card.querySelector('.done-indicator');
  if (verdict && !di) {
    var nd = document.createElement('div');
    nd.className = 'done-indicator';
    nd.textContent = '✓ Ou revize eleman sa';
    if (verdictSection) verdictSection.appendChild(nd);
  }
  updatePartnerProgress();
}

function savePartnerNote(itemId){
  if(!partnerVerdicts[itemId]) partnerVerdicts[itemId]={verdict:'',notes:''};
  var el=document.getElementById('pnotes-'+itemId); if(el) partnerVerdicts[itemId].notes=el.value;
  savePartnerLocal();
}

function savePartnerLocal(){
  try{ localStorage.setItem(P_STORAGE_KEY,JSON.stringify(partnerVerdicts)); }catch(e){}
  updatePartnerProgress();
}

function updatePartnerProgress(){
  var done=partnerItems.filter(function(it){return partnerVerdicts[it.id]&&partnerVerdicts[it.id].verdict;}).length;
  var total=partnerItems.length;
  var pct=total?Math.round((done/total)*100):0;
  document.getElementById('prog-pct').textContent=pct+'%';
  document.getElementById('prog-bar').style.width=pct+'%';
  document.getElementById('prog-count').textContent=done+' / '+total+' eleman revize';
  var btn=document.getElementById('p-submit-btn');
  var hint=document.getElementById('p-submit-hint');
  if(done===total&&total>0){ btn.disabled=false; hint.textContent='Tout eleman revize — ou ka soumèt'; }
  else { btn.disabled=true; hint.textContent=(total-done)+' eleman toujou rete'; }
}

async function partnerSubmit(){
  var btn=document.getElementById('p-submit-btn');
  btn.textContent='Ap voye…'; btn.disabled=true;
  var payload={ submitted_at:new Date().toISOString(), verdicts:partnerItems.map(function(item){
    var v=partnerVerdicts[item.id]||{}; return {id:item.id,persona_id:item.persona_id,domain:item.domain,verdict:v.verdict||'pending',notes:v.notes||''};
  })};
  try {
    var res=await adminFetch('/api/partner/validate', {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)
    });
    if(res.ok){ localStorage.removeItem(P_STORAGE_KEY); showPartnerSuccess(); }
    else { alert('Erè nan voye. Eseye ankò.'); btn.textContent='Soumèt tout repons yo'; btn.disabled=false; }
  } catch(e){
    localStorage.setItem(P_STORAGE_KEY+'_pending',JSON.stringify(payload));
    showPartnerSuccess(true);
  }
}

function showPartnerSuccess(offline){
  document.getElementById('p-items-container').innerHTML='';
  document.getElementById('partner-empty').style.display='none';
  var sc=document.getElementById('partner-success');
  sc.style.display='flex';
  if(offline){ sc.querySelector('.p-success-title').textContent='Sove — ap voye lè ou konekte'; }
}

function partnerReset(){ partnerItems=[]; partnerVerdicts={}; document.getElementById('partner-success').style.display='none'; loadPartnerQueue(); }

async function retryPending(){
  var pending=localStorage.getItem(P_STORAGE_KEY+'_pending');
  if(!pending||!currentToken||currentRole!=='partner') return;
  try {
    var res=await adminFetch('/api/partner/validate', {
      method:'POST',headers:{'Content-Type':'application/json'},body:pending
    });
    if(res.ok){ localStorage.removeItem(P_STORAGE_KEY+'_pending'); localStorage.removeItem(P_STORAGE_KEY); }
  } catch(e){}
}

/* ════════════════════════════
   CSV EXPORT (admin)
   ════════════════════════════ */
function csvCell(v){ var s=String(v===null||v===undefined?'':v).replace(/\r?\n/g,' ').replace(/"/g,'""'); if(s.search(/[,"]/)!==-1) s='"'+s+'"'; return s; }
function exportCSV(){
  if(!allSessions.length){ alert('No sessions to export.'); return; }
  var rows=[['Type','Session ID','Date','Persona','Persona ID','Tester','Role','Content','Notes'].join(',')];
  allSessions.forEach(function(s){
    var dt=s.created_at?new Date(s.created_at).toLocaleString():s.session_timestamp||'';
    var tester=s.tester_id?s.tester_id.slice(-8):''; var note=s.researcher_notes||'';
    if(s.type==='broadcast'){
      rows.push([csvCell('broadcast'),csvCell(s.id),csvCell(dt),csvCell('All 10'),'',csvCell(tester),csvCell('QUESTION'),csvCell(s.broadcast_question||''),csvCell(note)].join(','));
      var results=s.broadcast_results||{};
      Object.keys(results).forEach(function(pid){ var r=results[pid]; if(!r||r.status!=='done') return;
        rows.push([csvCell('broadcast'),csvCell(s.id),csvCell(dt),csvCell(pid),csvCell(pid),csvCell(tester),csvCell('response'),csvCell(r.text||''),''].join(','));
      });
    } else {
      var exchanges=s.exchanges||[];
      if(!exchanges.length) rows.push([csvCell(s.type),csvCell(s.id),csvCell(dt),csvCell(s.persona_name||''),csvCell(s.persona_id||''),csvCell(tester),'','',csvCell(note)].join(','));
      exchanges.forEach(function(e,j){ rows.push([csvCell(s.type),csvCell(s.id),csvCell(dt),csvCell(s.persona_name||''),csvCell(s.persona_id||''),csvCell(tester),csvCell(e.role),csvCell(e.content),j===0?csvCell(note):''].join(',')); });
    }
  });
  var csv='\uFEFF'+rows.join('\n');
  var blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  var url=URL.createObjectURL(blob); var a=document.createElement('a');
  a.href=url; a.download='jumo-admin-'+new Date().toISOString().slice(0,10)+'.csv'; a.click(); URL.revokeObjectURL(url);
}

function esc(str){ return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ════════════════════════════
   FLAGS (admin)
   ════════════════════════════ */
var flagsData = [];
var selectedFlagId = null;

var FLAG_TYPE_LABELS = {
  culturally_inaccurate: '🌍 Culturally inaccurate',
  off_persona:           '👤 Off-persona',
  too_generic:           '📋 Too generic',
  factually_wrong:       '✗ Factually wrong',
  missing_info:          '+ Missing info',
  wrong_register:        '💬 Wrong register'
};

var FLAG_STATUS_COLORS = {
  open:               '#EF4444',
  sent_to_partner:    '#F59E0B',
  partner_responded:  '#22D3EE',
  resolved:           '#34D399'
};

async function loadFlags() {
  document.getElementById('flags-list').innerHTML='<div style="padding:12px;color:#2A3A50">Loading…</div>';
  var statusFilter  = document.getElementById('flag-filter-status')  ? document.getElementById('flag-filter-status').value  : '';
  var personaFilter = document.getElementById('flag-filter-persona') ? document.getElementById('flag-filter-persona').value : '';
  var url = '/api/flags';
  if (statusFilter)  url += '&status='+encodeURIComponent(statusFilter);
  if (personaFilter) url += '&persona_id='+encodeURIComponent(personaFilter);
  try {
    var res = await adminFetch(url);
    if (res.ok) { flagsData = await res.json(); }
    else { flagsData = []; }
  } catch(e) { flagsData = []; }
  buildFlagPersonaFilter();
  renderFlagsList();
  updateFlagsBadge();
}

function buildFlagPersonaFilter() {
  var sel = document.getElementById('flag-filter-persona');
  if (!sel) return;
  var current = sel.value;
  var seen = {};
  var opts = '<option value="">All personas</option>';
  flagsData.forEach(function(f) {
    if (!seen[f.persona_id]) {
      seen[f.persona_id] = true;
      opts += '<option value="'+esc(f.persona_id)+'">'+esc(f.persona_name||f.persona_id)+'</option>';
    }
  });
  sel.innerHTML = opts;
  if (current) sel.value = current;
}

function updateFlagsBadge() {
  var open = flagsData.filter(function(f){ return f.status !== 'resolved'; }).length;
  var badge = document.getElementById('flags-badge');
  if (badge) { badge.textContent = open; badge.style.display = open > 0 ? 'inline' : 'none'; }
}

function renderFlagsList() {
  var list = document.getElementById('flags-list');
  if (!flagsData.length) {
    list.innerHTML = '<div style="padding:12px;color:#2A3A50;font-size:11.5px;">No flags yet. Flag wrong responses in the test shell.</div>';
    return;
  }
  var html = '';
  flagsData.forEach(function(f) {
    var statusColor = FLAG_STATUS_COLORS[f.status] || '#3A5A70';
    var typeLabel   = FLAG_TYPE_LABELS[f.flag_type] || f.flag_type || 'Flagged';
    var dt = f.created_at ? new Date(f.created_at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
    var hasCorrection = !!(f.partner_correction && f.partner_correction.trim());
    html += '<div class="s-item'+(f.id===selectedFlagId?' active':'')+'" onclick="selectFlag(\''+esc(f.id)+'\')" style="border-left:3px solid '+(f.persona_color||'#3A5A70')+'">'+
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">'+
        '<div style="font-size:11px;font-weight:600;color:#CBD5E1;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(f.persona_name||f.persona_id)+'</div>'+
        '<div style="width:7px;height:7px;border-radius:50%;background:'+statusColor+';flex-shrink:0;"></div>'+
      '</div>'+
      '<div style="font-size:10px;color:#3A5A70;">'+esc(typeLabel.replace(/^[^\s]+\s/,''))+(f.domain_hint?' · '+esc(f.domain_hint):'')+'</div>'+
      '<div style="font-size:10px;color:#2A3A50;margin-top:1px;">'+esc(dt)+(hasCorrection?' · <span style="color:#22D3EE">correction ✓</span>':'')+'</div>'+
    '</div>';
  });
  list.innerHTML = html;
}

function selectFlag(id) {
  selectedFlagId = id;
  renderFlagsList();
  var f = flagsData.find(function(x){ return x.id===id; });
  if (!f) return;

  // Ensure persona is loaded so we can show its voice-example count + re-render
  if (f.persona_id && !personaData[f.persona_id]) {
    adminFetch('/api/personas/'+encodeURIComponent(f.persona_id))
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(p){ if (p) { personaData[f.persona_id] = p; if (selectedFlagId===id) selectFlag(id); } })
      .catch(function(){});
  }

  var detail = document.getElementById('flag-detail');
  var statusColor  = FLAG_STATUS_COLORS[f.status] || '#3A5A70';
  var typeLabel    = FLAG_TYPE_LABELS[f.flag_type] || f.flag_type;
  var domainLabel  = f.domain_hint ? (DOMAIN_INFO[f.domain_hint] ? DOMAIN_INFO[f.domain_hint].label : f.domain_hint) : 'Unknown domain';
  var dt = f.created_at ? new Date(f.created_at).toLocaleString() : '';

  var html = '<div class="anim">';

  html += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #0F2040;">'+
    '<div style="width:10px;height:10px;border-radius:50%;background:'+(f.persona_color||'#3A5A70')+';flex-shrink:0;"></div>'+
    '<div style="flex:1;">'+
      '<div style="font-size:14px;font-weight:600;color:#E2E8F0;">'+esc(f.persona_name||f.persona_id)+'</div>'+
      '<div style="font-size:10.5px;color:#3A5A70;margin-top:2px;">'+esc(typeLabel)+' · '+esc(domainLabel)+' · '+esc(dt)+'</div>'+
    '</div>'+
    '<div style="font-size:10px;font-weight:600;color:'+statusColor+';background:'+statusColor+'22;border:1px solid '+statusColor+'44;border-radius:4px;padding:2px 8px;">'+esc(f.status.replace(/_/g,' '))+'</div>'+
  '</div>';

  html += '<div style="margin-bottom:12px;">'+
    '<div class="lbl" style="margin-bottom:5px;">Question asked</div>'+
    '<div style="background:#040710;border-radius:6px;padding:10px 12px;font-size:12.5px;color:#64748B;line-height:1.6;font-style:italic;">'+esc(f.question_text||'(not captured)')+'</div>'+
  '</div>';

  html += '<div style="margin-bottom:12px;">'+
    '<div class="lbl" style="margin-bottom:5px;color:#EF4444;">⚑ Jumo said this (flagged as wrong)</div>'+
    '<div style="background:#0A1628;border:1px solid #0F2040;border-left:3px solid #EF4444;border-radius:6px;padding:10px 12px;font-size:12.5px;color:#CBD5E1;line-height:1.65;white-space:pre-wrap;">'+esc(f.response_text)+'</div>'+
  '</div>';

  if (f.admin_notes) {
    html += '<div style="margin-bottom:12px;">'+
      '<div class="lbl" style="margin-bottom:5px;">Admin notes</div>'+
      '<div style="font-size:12px;color:#94A3B8;line-height:1.6;">'+esc(f.admin_notes)+'</div>'+
    '</div>';
  }

  if (f.partner_correction) {
    html += '<div style="margin-bottom:12px;background:#022C22;border:1px solid #065F46;border-radius:8px;padding:12px 14px;">'+
      '<div class="lbl" style="margin-bottom:6px;color:#34D399;">✓ Partner correction</div>'+
      '<div style="font-size:13px;color:#6EE7B7;line-height:1.7;white-space:pre-wrap;">'+esc(f.partner_correction)+'</div>'+
    '</div>';
  }

  html += '<div style="background:#070D18;border:1px solid #0F2040;border-radius:8px;padding:14px;margin-bottom:12px;">'+
    '<div class="lbl" style="margin-bottom:10px;">Resolution — where does this fix go?</div>';

  // ── Correction input — the correct text this flag should produce ──
  if (f.status !== 'resolved') {
    html += '<div style="margin-bottom:14px;">'+
      '<div style="font-size:9.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#34D399;margin-bottom:5px;">Correct response — what Jumo should have said</div>'+
      '<textarea id="flag-correction-'+esc(f.id)+'" oninput="flagCorrectionDirty=true" placeholder="Type the culturally correct answer here. This feeds every action below." style="width:100%;background:#040710;border:1px solid #0F2040;border-radius:6px;color:#CBD5E1;padding:9px 11px;font-size:12px;font-family:inherit;resize:vertical;min-height:80px;line-height:1.6;">'+esc(f.partner_correction||'')+'</textarea>'+
      '<div style="font-size:10px;color:#3A5A70;margin-top:4px;">Saved automatically when you Promote, Send to partner, or Mark resolved.</div>'+
    '</div>';
  }

  // ── Guidance: which path to choose ──
  if (f.status !== 'resolved') {
    var exCount = 0;
    var pd = personaData[f.persona_id];
    if (pd && Array.isArray(pd.voice_examples)) exCount = pd.voice_examples.length;
    html += '<div style="background:#04131F;border:1px solid #0E2A3A;border-radius:7px;padding:10px 12px;margin-bottom:12px;font-size:11px;line-height:1.7;color:#7EA8C0;">'+
      '<div style="color:#7EC8E3;font-weight:600;margin-bottom:4px;">Which fix should you use?</div>'+
      '<div><span style="color:#22D3EE;">⬆ Promote</span> — quick fix. The persona learns to <em>say it better</em> next time. Best for tone, phrasing, register. Live instantly.</div>'+
      '<div><span style="color:#34D399;">✎ Domain</span> — deeper fix. Updates the persona\'s actual <em>knowledge</em>. Best when the answer was factually or culturally wrong, not just worded badly.</div>'+
      '<div style="color:#3A5A70;margin-top:4px;">Rule of thumb: wrong <em>voice</em> → Promote. Wrong <em>knowledge</em> → Domain. Both is fine.</div>'+
    '</div>';

    // PRIMARY action — Promote (filled)
    html += '<button class="btn" id="promote-btn-'+esc(f.id)+'" onclick="jumoPromoteFlag(\''+esc(f.id)+'\')" style="text-align:left;padding:11px 13px;background:#0C2B3A;border-color:#22D3EE;color:#7EC8E3;margin-bottom:8px;">'+
      '⬆ Promote correction to voice example'+(exCount?' <span style="opacity:.6;font-weight:400;">('+exCount+' now)</span>':'')+'<br>'+
      '<span style="font-size:10px;font-weight:400;opacity:.75;">Correction becomes a live Q/A voice example for '+esc(f.persona_name||f.persona_id)+' — instant</span>'+
    '</button>';
  }

  html += '<div style="display:flex;flex-direction:column;gap:8px;">';

  if (f.domain_hint && f.status !== 'resolved') {
    html += '<button class="btn btn-success" onclick="applyFlagToPersona(\''+esc(f.id)+'\',\''+esc(f.persona_id)+'\',\''+esc(f.domain_hint)+'\',getFlagCorrection(\''+esc(f.id)+'\'))" style="text-align:left;padding:10px 12px;">'+
      '✎ Open '+esc(domainLabel)+' domain for '+esc(f.persona_name||f.persona_id)+' + load correction<br>'+
      '<span style="font-size:10px;font-weight:400;opacity:.7;">Loads the correction above into the domain textarea for a deeper edit</span>'+
    '</button>';
  }

  if (f.status === 'open') {
    html += '<button class="btn" onclick="sendFlagToPartner(\''+esc(f.id)+'\')" style="text-align:left;padding:10px 12px;">'+
      '↗ Send to partner for validation<br>'+
      '<span style="font-size:10px;font-weight:400;opacity:.7;">Not sure of the answer? Route it to your cultural partner instead</span>'+
    '</button>';
  }

  html += '<button class="btn" onclick="downloadCorpusSnippet(\''+esc(f.id)+'\')" style="text-align:left;padding:10px 12px;">'+
    '⬇ Download corpus snippet<br>'+
    '<span style="font-size:10px;font-weight:400;opacity:.7;">Export as .md to append to your local master corpus</span>'+
  '</button>';

  if (f.status !== 'resolved') {
    html += '<button class="btn" onclick="resolveFlag(\''+esc(f.id)+'\')" style="text-align:left;padding:10px 12px;color:#94A3B8;">'+
      '✓ Mark as resolved<br>'+
      '<span style="font-size:10px;font-weight:400;opacity:.7;">Close this flag once you\'ve applied the fix somewhere above</span>'+
    '</button>';
  }

  html += '</div></div>';
  html += '</div>';
  detail.innerHTML = html;
}

function applyFlagToPersona(flagId, personaId, domainHint, correction) {
  showTab('personas');
  setTimeout(async function() {
    await selectPersona(personaId);
    setTimeout(function() {
      var body = document.getElementById('dom-'+domainHint);
      var chev = document.getElementById('chev-'+domainHint);
      if (body && body.classList.contains('hidden')) {
        body.classList.remove('hidden');
        if (chev) chev.classList.add('open');
      }
      var block = document.getElementById('block-'+domainHint);
      if (block) block.scrollIntoView({behavior:'smooth', block:'center'});
      if (correction && correction.trim()) {
        var textarea = document.getElementById('fd-'+domainHint+'-content');
        if (textarea) {
          textarea.dataset.previous = textarea.value;
          textarea.value = correction.trim();
          var srcSel = document.getElementById('fd-'+domainHint+'-source');
          var cfSel  = document.getElementById('fd-'+domainHint+'-confidence');
          if (srcSel) srcSel.value = 'partner_validated';
          if (cfSel)  cfSel.value  = 'high';
          markDirty();
          textarea.style.borderColor = '#34D399';
          textarea.style.background  = '#022C22';
          var existingBanner = document.getElementById('correction-banner-'+domainHint);
          if (existingBanner) existingBanner.remove();
          var banner = document.createElement('div');
          banner.id = 'correction-banner-'+domainHint;
          banner.style.cssText = 'background:#022C22;border:1px solid #065F46;border-radius:7px;padding:10px 14px;margin-bottom:8px;font-size:11.5px;color:#6EE7B7;line-height:1.6;';
          banner.innerHTML =
            '<div style="font-weight:600;margin-bottom:4px;display:flex;align-items:center;gap:6px;">'+
              '<span style="color:#34D399">✓</span> Partner correction loaded'+
              '<button onclick="revertDomainContent(\''+domainHint+'\')" style="margin-left:auto;background:transparent;border:1px solid #065F46;border-radius:4px;color:#94A3B8;font-size:10px;padding:2px 8px;cursor:pointer;font-family:inherit;">Revert to previous</button>'+
            '</div>'+
            '<div style="color:#3A5A70;font-size:10.5px;">Review the correction above, adjust if needed, then click Save.</div>';
          if (block) block.insertBefore(banner, block.firstChild);
        }
      } else {
        showToast('Edit the '+domainHint+' domain — apply the correction, then save');
      }
    }, 400);
  }, 200);
}

function revertDomainContent(domainHint) {
  var textarea = document.getElementById('fd-'+domainHint+'-content');
  if (!textarea) return;
  textarea.value = textarea.dataset.previous || '';
  textarea.style.borderColor = '';
  textarea.style.background  = '';
  var banner = document.getElementById('correction-banner-'+domainHint);
  if (banner) banner.remove();
  markDirty();
  showToast('Reverted to previous content');
}

function downloadCorpusSnippet(flagId) {
  var f = flagsData.find(function(x){ return x.id===flagId; });
  if (!f) return;
  var dt = new Date().toISOString().slice(0,10);
  var correction = getFlagCorrection(flagId) || f.partner_correction || f.admin_notes || '[correction pending]';
  var domain = f.domain_hint || 'general';
  var snippet = [
    '---',
    'persona: '+( f.persona_name || f.persona_id),
    'domain: '+domain,
    'source: flag_correction',
    'date: '+dt,
    'flag_id: '+f.id,
    '---',
    '',
    '## '+( f.persona_name||f.persona_id)+' — '+(DOMAIN_INFO[domain]?DOMAIN_INFO[domain].label:domain),
    '',
    '**Original wrong response flagged:**',
    '> Q: '+(f.question_text||'(not captured)'),
    '> A (wrong): '+f.response_text,
    '',
    '**Correct information:**',
    correction,
    '',
  ].join('\n');
  var blob = new Blob([snippet], {type:'text/markdown'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'corpus-snippet-'+(f.persona_id||'unknown')+'-'+dt+'.md';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Downloaded — append to /corpus/master-corpus.md and commit');
}

async function resolveFlag(flagId) {
  var correction = getFlagCorrection(flagId);
  try {
    await adminFetch('/api/flags/'+encodeURIComponent(flagId), {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(correction ? {status:'resolved', partner_correction:correction} : {status:'resolved'})
    });
    flagsData = flagsData.map(function(f){ return f.id===flagId ? Object.assign({},f,{status:'resolved'},correction?{partner_correction:correction}:{}) : f; });
    renderFlagsList();
    selectFlag(flagId);
    updateFlagsBadge();
    showToast('Flag resolved ✓');
  } catch(e) { showToast('Could not update — check connection'); }
}

async function sendFlagToPartner(flagId) {
  var f = flagsData.find(function(x){ return x.id===flagId; });
  if (!f) return;
  try {
    await fetch('/api/flags', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-access-token':currentToken},
      body:JSON.stringify(Object.assign({},f,{id:flagId+'-resend-'+Date.now(),send_to_partner:true}))
    });
    await adminFetch('/api/flags/'+encodeURIComponent(flagId), {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({status:'sent_to_partner'})
    });
    flagsData = flagsData.map(function(f2){ return f2.id===flagId ? Object.assign({},f2,{status:'sent_to_partner'}) : f2; });
    renderFlagsList(); selectFlag(flagId); showToast('Sent to partner ↗');
  } catch(e) { showToast('Could not send — check connection'); }
}

/* ════════════════════════════
   PROMPT PREVIEW + EXPORT
   ════════════════════════════ */
async function previewPrompt() {
  if (!selectedPersonaId) return;
  if (isDirty) {
    var saved = await savePersonaQuiet();
    if (!saved) { showToast('Save failed — cannot preview'); return; }
  }
  var modal = document.getElementById('prompt-modal');
  var promptText = document.getElementById('prompt-text');
  var promptTitle = document.getElementById('prompt-title');
  var promptSubtitle = document.getElementById('prompt-subtitle');
  var promptMeta = document.getElementById('prompt-meta');
  var promptWarnings = document.getElementById('prompt-warnings');
  promptText.textContent = 'Loading…';
  promptWarnings.innerHTML = '';
  modal.style.display = 'flex';
  try {
    var res = await adminFetch('/api/personas/' + encodeURIComponent(selectedPersonaId) + '/prompt');
    if (!res.ok) {
      var p = collectPersonaData();
      promptTitle.textContent = p.name + ' — System Prompt';
      promptSubtitle.textContent = 'Preview (server endpoint pending — built from current form values)';
      promptMeta.textContent = '';
      promptText.textContent = buildClientPrompt(p);
      return;
    }
    var data = await res.json();
    var v = data.validation || {};
    promptTitle.textContent = data.persona_name + ' — System Prompt';
    promptSubtitle.textContent = 'Version ' + data.version + ' · Status: ' + data.status;
    promptMeta.textContent = data.char_count + ' chars · ~' + data.token_estimate + ' tokens';
    promptText.textContent = data.prompt;
    if (v.warnings && v.warnings.length) {
      promptWarnings.innerHTML = v.warnings
        .map(function(w){ return '<div class="prompt-warn">⚠ ' + esc(w) + '</div>'; })
        .join('');
      promptWarnings.style.padding = '10px 16px';
    }
  } catch(e) {
    var p = collectPersonaData();
    promptTitle.textContent = p.name + ' — System Prompt';
    promptSubtitle.textContent = 'Preview (offline — built from current form values)';
    promptMeta.textContent = '';
    promptText.textContent = buildClientPrompt(p);
  }
}

function buildClientPrompt(persona) {
  if (persona.system_prompt_fragment && persona.system_prompt_fragment.trim()) {
    return persona.system_prompt_fragment.trim();
  }
  var b = persona.basic || {};
  var d = persona.domains || {};
  var lines = [];
  lines.push('You are ' + persona.name + ', a Haitian cultural intelligence persona.');
  lines.push('You speak from direct lived experience as a specific person — not as a generalized representative of Haitian culture.');
  lines.push('');
  var profileLines = [];
  if (b.age_range)               profileLines.push('Age: ' + b.age_range);
  if (b.region)                  profileLines.push('Region: ' + b.region);
  if (b.location_type)           profileLines.push('Location: ' + b.location_type);
  if (b.education_level)         profileLines.push('Education: ' + b.education_level);
  if (b.dominant_language)       profileLines.push('Primary language: ' + b.dominant_language);
  if (b.code_switch_frequency)   profileLines.push('Language pattern: ' + b.code_switch_frequency);
  if (profileLines.length) { lines.push('PROFILE'); lines.push(profileLines.join('\n')); lines.push(''); }
  if (b.background && b.background.trim()) { lines.push('BACKGROUND'); lines.push(b.background.trim()); lines.push(''); }
  var domainOrder = ['health','family','economic','institutional','religious','education','language_profile'];
  var domainLabels = { health:'Health & Wellbeing', family:'Family & Community', economic:'Economic Life',
    institutional:'Institutional Relationships', religious:'Religious & Spiritual Life',
    education:'Education & Knowledge', language_profile:'Language Profile' };
  var blocks = domainOrder.filter(function(k){ return d[k]&&d[k].content&&d[k].content.trim(); })
    .map(function(k){ return domainLabels[k].toUpperCase()+'\n'+d[k].content.trim(); });
  if (blocks.length) { lines.push('CULTURAL KNOWLEDGE'); lines.push(''); lines.push(blocks.join('\n\n')); lines.push(''); }
  lines.push('BEHAVIORAL GUIDELINES');
  lines.push('Respond as ' + persona.name + ' would genuinely respond — drawing only on the cultural knowledge above.');
  lines.push('Speak from lived experience, not academic distance.');
  lines.push('Your perspective reflects your specific background and region — not all Haitians.');
  lines.push('');
  lines.push('CONTEXT');
  lines.push('The people asking are international researchers, NGOs, and health professionals trying to understand Haitian communities better.');
  return lines.join('\n').trim();
}

function closePromptModal(event) {
  if (event && event.target !== document.getElementById('prompt-modal')) return;
  document.getElementById('prompt-modal').style.display = 'none';
}

function exportPersonaJSON() {
  var p = collectPersonaData();
  if (!p) return;
  var exportData = JSON.parse(JSON.stringify(p));
  Object.keys(exportData.domains || {}).forEach(function(d) {
    if (exportData.domains[d]) exportData.domains[d].notes = '';
  });
  exportData.system_prompt = exportData.system_prompt_fragment || '';
  delete exportData.system_prompt_fragment;
  var json = JSON.stringify(exportData, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = p.id + '.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Downloaded ' + p.id + '.json — commit to /personas/ in repo');
}

async function savePersonaQuiet() {
  var p = collectPersonaData();
  if (!p) return false;
  try {
    await adminFetch('/api/personas/' + encodeURIComponent(p.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p)
    });
    personaData[p.id] = p;
    isDirty = false;
    return true;
  } catch(e) {
    personaData[p.id] = p;
    isDirty = false;
    return true;
  }
}

/* ════════════════════════════════════════════
   STRUCTURED CORRECTION FORM
   ════════════════════════════════════════════ */
function buildStructuredCorrectionForm(itemId, type, existingVerdict) {
  var parsed = existingVerdict && existingVerdict.notes ? parseStructuredNotes(existingVerdict.notes) : {};
  return '<div class="struct-correction" id="scf-'+itemId+'" style="margin-top:10px;display:flex;flex-direction:column;gap:7px;">'+
    '<div>'+
      '<div style="font-size:9.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#F59E0B;margin-bottom:4px;">Ki sa ki pa kòrèk?</div>'+
      '<textarea class="notes-area" id="scf-wrong-'+itemId+'" oninput="syncStructuredNotes(\''+itemId+'\')" placeholder="Kopye pati oswa mo ki pa bon an…" style="min-height:50px;">'+(parsed.wrong||'')+'</textarea>'+
    '</div>'+
    '<div>'+
      '<div style="font-size:9.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#34D399;margin-bottom:4px;">Ki sa ki kòrèk?</div>'+
      '<textarea class="notes-area" id="scf-correct-'+itemId+'" oninput="syncStructuredNotes(\''+itemId+'\')" placeholder="Ekri repons ki kòrèk la…" style="min-height:80px;">'+(parsed.correct||'')+'</textarea>'+
    '</div>'+
    '<div style="display:flex;gap:6px;">'+
      buildConfBtn(itemId,'certain','Mwen sèten',parsed.confidence)+
      buildConfBtn(itemId,'fairly_sure','Mwen panse',parsed.confidence)+
      buildConfBtn(itemId,'needs_checking','Bezwen verifye',parsed.confidence)+
    '</div>'+
    '<div>'+
      '<div style="font-size:9.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#3A5A70;margin-bottom:4px;">Sous konesans ou</div>'+
      '<select id="scf-source-'+itemId+'" onchange="syncStructuredNotes(\''+itemId+'\')" style="width:100%;background:#040710;border:1px solid #0F2040;border-radius:5px;color:#94A3B8;padding:6px 8px;font-size:11.5px;font-family:inherit;">'+
        '<option value="personal_experience"'+(parsed.source==='personal_experience'?' selected':'')+'>Eksperyans pèsonèl</option>'+
        '<option value="community_knowledge"'+(parsed.source==='community_knowledge'?' selected':'')+'>Konesans kominotè</option>'+
        '<option value="professional_knowledge"'+(parsed.source==='professional_knowledge'?' selected':'')+'>Konesans pwofesyonèl</option>'+
        '<option value="general_knowledge"'+((!parsed.source||parsed.source==='general_knowledge')?' selected':'')+'>Konesans jeneral</option>'+
      '</select>'+
    '</div>'+
  '</div>';
}

function buildConfBtn(itemId, val, label, current) {
  var sel = current === val;
  return '<button onclick="setStructuredConf(\''+itemId+'\',\''+val+'\')" style="flex:1;background:'+(sel?'#0C2B3A':'#0A1628')+';border:1px solid '+(sel?'#22D3EE':'#1E3A5F')+';border-radius:5px;color:'+(sel?'#22D3EE':'#64748B')+';padding:5px 4px;font-size:10.5px;cursor:pointer;font-family:inherit;">'+label+'</button>';
}

function setStructuredConf(itemId, val) {
  var form = document.getElementById('scf-'+itemId);
  if (!form) return;
  form.querySelectorAll('[onclick*="setStructuredConf"]').forEach(function(b) {
    var isThis = b.getAttribute('onclick').indexOf("'"+val+"'") !== -1;
    b.style.background  = isThis ? '#0C2B3A' : '#0A1628';
    b.style.borderColor = isThis ? '#22D3EE' : '#1E3A5F';
    b.style.color       = isThis ? '#22D3EE' : '#64748B';
  });
  form.dataset.conf = val;
  syncStructuredNotes(itemId);
}

function syncStructuredNotes(itemId) {
  var wrong   = (document.getElementById('scf-wrong-'+itemId)   ||{}).value||'';
  var correct = (document.getElementById('scf-correct-'+itemId) ||{}).value||'';
  var source  = (document.getElementById('scf-source-'+itemId)  ||{}).value||'';
  var form    = document.getElementById('scf-'+itemId);
  var conf    = form ? (form.dataset.conf||'general_knowledge') : 'general_knowledge';
  var structured = '';
  if (wrong.trim())   structured += 'WRONG: '+wrong.trim()+'\n';
  if (correct.trim()) structured += 'CORRECT: '+correct.trim()+'\n';
  structured += 'CONFIDENCE: '+conf+'\nSOURCE: '+source;
  if (!partnerVerdicts[itemId]) partnerVerdicts[itemId]={verdict:'',notes:''};
  partnerVerdicts[itemId].notes = structured.trim();
  savePartnerLocal();
}

function parseStructuredNotes(notes) {
  if (!notes) return {};
  var r={};
  var wm=notes.match(/^WRONG:\s*(.+)/m);
  var cm=notes.match(/^CORRECT:\s*([\s\S]+?)(?=\nCONFIDENCE:|$)/m);
  var fm=notes.match(/^CONFIDENCE:\s*(.+)/m);
  var sm=notes.match(/^SOURCE:\s*(.+)/m);
  if(wm) r.wrong=wm[1].trim();
  if(cm) r.correct=cm[1].trim();
  if(fm) r.confidence=fm[1].trim();
  if(sm) r.source=sm[1].trim();
  return r;
}

function extractQuestionFromNotes(notes) {
  if (!notes) return '';
  var m = notes.match(/^Q:\s*(.+)/m);
  return m ? m[1].trim() : '';
}

async function sendResponseToPartner(question, response, personaId, personaName) {
  if (!currentToken) { showToast('Sign in as admin first'); return; }
  try {
    var res = await adminFetch('/api/partner/send-response', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ question_text:question, response_text:response, persona_id:personaId, persona_name:personaName })
    });
    showToast(res.ok ? '↗ Sent to partner queue' : 'Could not send — check connection');
  } catch(e) { showToast('Could not send — check connection'); }
}

/* ════════════════════════════════════════════
   IMPORT PERSONA FROM MARKDOWN
   ════════════════════════════════════════════ */
var _importParsed = null;

var IMPORT_SECTION_MAP = [
  { domain:'health',           match:['health'] },
  { domain:'religious',        match:['spiritual','religion','vodou','bapti','lwa','church','faith'] },
  { domain:'economic',         match:['economic','madan sara','boutik','market work','what she carries','daily economic','income','financial','sòl','sol '] },
  { domain:'institutional',    match:['trust','security','refusal','ngo','organization','institution','research value','outsider','authority'] },
  { domain:'family',           match:['family','15-year','children','household','stigma','social','community','neighbor','network'] },
  { domain:'education',        match:['education','school','literacy','learning'] },
  { domain:'language_profile', match:['voice','tone','proverb','vocabulary','media','information habit','sample response','language','cultural vocabulary','repertoire'] },
];
var IMPORT_BG_MATCH   = ['foundational condition','background','who she is','who he is'];
var IMPORT_SKIP_MATCH = ['demographics','system prompt','version','previous title','secondary description'];

function handleMarkdownImport(event) {
  var file = event.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    _importParsed = parsePersonaMarkdown(e.target.result);
    showImportPreview(_importParsed);
  };
  reader.readAsText(file);
  event.target.value = '';
}

function parsePersonaMarkdown(text) {
  var lines=text.split('\n'), sections=[], current=null;
  for(var i=0;i<lines.length;i++){
    var h2=lines[i].match(/^##\s+(.+)/), h3=lines[i].match(/^###\s+(.+)/), hdr=h2||h3;
    if(hdr){ if(current) sections.push(current); current={title:hdr[1].trim(),lines:[]}; }
    else if(current) current.lines.push(lines[i]);
  }
  if(current) sections.push(current);
  sections=sections.map(function(s){ return {title:s.title,content:s.lines.join('\n').trim()}; });
  function classify(title){
    var lower=title.toLowerCase();
    if(IMPORT_SKIP_MATCH.some(function(m){return lower.includes(m);})) return 'skip';
    if(IMPORT_BG_MATCH.some(function(m){return lower.includes(m);}))   return 'background';
    for(var i=0;i<IMPORT_SECTION_MAP.length;i++){
      if(IMPORT_SECTION_MAP[i].match.some(function(m){return lower.includes(m);})) return IMPORT_SECTION_MAP[i].domain;
    }
    return 'unmatched';
  }
  var promptMatch=text.match(/###\s*System Prompt[^\n]*\n[\s\S]*?```[^\n]*\n([\s\S]*?)```/);
  var systemPrompt=promptMatch?promptMatch[1].trim():null;
  var pick=function(p){var m=text.match(p);return m?m[1].trim():null;};
  var basic={age_range:pick(/\*\*Age:\*\*\s*(.+)/),region:pick(/\*\*Location:\*\*\s*(.+)/),education_level:pick(/\*\*Education:\*\*\s*(.+)/)};
  Object.keys(basic).forEach(function(k){if(!basic[k])delete basic[k];});
  var nameMatch=text.match(/##\s*PERSONA\s*\d*:?\s*([A-Za-zÀ-ÿ\s\-]+)/);
  var detectedName=nameMatch?nameMatch[1].trim():null;
  var domainContent={}, backgroundParts=[], unmatched=[];
  sections.forEach(function(section){
    if(!section.content) return;
    var dest=classify(section.title);
    if(dest==='skip') return;
    if(dest==='background'){backgroundParts.push('## '+section.title+'\n'+section.content);return;}
    if(dest==='unmatched'){unmatched.push(section.title);return;}
    if(domainContent[dest]) domainContent[dest]+='\n\n---\n\n## '+section.title+'\n'+section.content;
    else                    domainContent[dest]='## '+section.title+'\n'+section.content;
  });
  if(backgroundParts.length) basic.background=backgroundParts.join('\n\n');
  return {systemPrompt,basic,domainContent,unmatched,detectedName};
}

function showImportPreview(parsed) {
  var sel=document.getElementById('import-persona-select');
  var opts='<option value="">— select persona —</option>';
  Object.values(personaData).forEach(function(p){ opts+='<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>'; });
  sel.innerHTML=opts;
  if(parsed.detectedName){
    document.getElementById('import-detected-name').textContent='Detected: '+parsed.detectedName;
    Object.values(personaData).forEach(function(p){
      if(p.name.toLowerCase().includes(parsed.detectedName.toLowerCase().split(' ')[0].toLowerCase())) sel.value=p.id;
    });
  } else { document.getElementById('import-detected-name').textContent=''; }
  var DOMAINS=['health','family','economic','institutional','religious','education','language_profile'];
  var html='<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#040710;border:1px solid #0F2040;border-radius:7px;">'+
    '<div style="width:8px;height:8px;border-radius:50%;background:'+(parsed.systemPrompt?'#22C55E':'#3A5A70')+';"></div>'+
    '<div style="font-size:11.5px;color:#CBD5E1;flex:1;">System Prompt</div>'+
    '<div style="font-size:10.5px;color:'+(parsed.systemPrompt?'#22C55E':'#3A5A70')+';">'+(parsed.systemPrompt?parsed.systemPrompt.length+' chars':'not found')+'</div>'+
  '</div>';
  DOMAINS.forEach(function(d){
    var has=!!parsed.domainContent[d], label=DOMAIN_INFO[d]?DOMAIN_INFO[d].label:d;
    html+='<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:#040710;border:1px solid #0F2040;border-radius:7px;">'+
      '<div style="width:8px;height:8px;border-radius:50%;background:'+(has?'#F59E0B':'#1E2A3A')+';"></div>'+
      '<div style="font-size:11.5px;color:'+(has?'#CBD5E1':'#3A5A70')+';flex:1;">'+esc(label)+'</div>'+
      '<div style="font-size:10.5px;color:'+(has?'#F59E0B':'#2A50')+';">'+(has?'✓ found':'—')+'</div>'+
    '</div>';
  });
  var bkeys=Object.keys(parsed.basic).filter(function(k){return k!=='background';});
  if(bkeys.length) html+='<div style="padding:7px 10px;background:#040710;border:1px solid #0F2040;border-radius:7px;font-size:11px;color:#3A5A70;">Basic: '+bkeys.map(function(k){return parsed.basic[k];}).join(' · ')+'</div>';
  document.getElementById('import-preview').innerHTML=html;
  if(parsed.unmatched.length){
    document.getElementById('import-unmatched').style.display='block';
    document.getElementById('import-unmatched-list').textContent=parsed.unmatched.join(', ');
  } else { document.getElementById('import-unmatched').style.display='none'; }
  document.getElementById('import-modal').style.display='flex';
}

async function confirmImport() {
  if(!_importParsed) return;
  var personaId=document.getElementById('import-persona-select').value;
  if(!personaId){ showToast('Select a persona to apply to'); return; }
  var btn=document.getElementById('import-confirm-btn');
  btn.textContent='Applying…'; btn.disabled=true;
  var existing=personaData[personaId]||makeDefaultPersona(personaId);
  var DOMAINS=['health','family','economic','institutional','religious','education','language_profile'];
  if(_importParsed.systemPrompt) existing.system_prompt=_importParsed.systemPrompt;
  existing.basic=Object.assign(existing.basic||{},_importParsed.basic);
  DOMAINS.forEach(function(d){
    if(_importParsed.domainContent[d]){
      if(!existing.domains[d]) existing.domains[d]={content:'',source:'ai_generated',confidence:'low',notes:''};
      existing.domains[d].content = _importParsed.domainContent[d];
      existing.domains[d].source='cultural_edit'; existing.domains[d].confidence='medium';
    }
  });
  existing.version=(existing.version||1)+1; existing.updated_at=new Date().toISOString();
  try {
    var res=await adminFetch('/api/personas/'+encodeURIComponent(personaId), {
      method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(existing)
    });
    if(res.ok){ personaData[personaId]=existing; closeImportModal(); selectPersona(personaId); renderHealthDashboard(); showToast('✓ Persona updated from markdown'); }
    else showToast('Save failed — check connection');
  } catch(e){ showToast('Save failed'); }
  btn.textContent='Apply to Persona'; btn.disabled=false;
}

function closeImportModal()    { document.getElementById('import-modal').style.display='none'; _importParsed=null; }
function closeImportModalBg(e) { if(e.target===document.getElementById('import-modal')) closeImportModal(); }

/* ════════════════════════════════════════════
   CULTURAL NOTES (Partner)
   ════════════════════════════════════════════ */
var _cnConf='certain';

function openCulturalNoteModal() {
  var sel=document.getElementById('cn-persona');
  var opts='<option value="">Jeneral (tout persona)</option>';
  Object.values(partnerPersonaContext).forEach(function(p){ opts+='<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>'; });
  sel.innerHTML=opts;
  document.getElementById('cn-content').value='';
  document.getElementById('cn-domain').value='general';
  _cnConf='certain';
  document.querySelectorAll('.cn-conf-btn').forEach(function(b){
    var isThis=b.dataset.conf==='certain';
    b.style.background=isThis?'#0C2B3A':'#0A1628'; b.style.borderColor=isThis?'#22D3EE':'#1E3A5F'; b.style.color=isThis?'#22D3EE':'#64748B';
  });
  document.getElementById('cultural-note-modal').style.display='flex';
  setTimeout(function(){document.getElementById('cn-content').focus();},100);
}

function setCnConf(val) {
  _cnConf=val;
  document.querySelectorAll('.cn-conf-btn').forEach(function(b){
    var isThis=b.dataset.conf===val;
    b.style.background=isThis?'#0C2B3A':'#0A1628'; b.style.borderColor=isThis?'#22D3EE':'#1E3A5F'; b.style.color=isThis?'#22D3EE':'#64748B';
  });
}

function closeCulturalNoteModal()    { document.getElementById('cultural-note-modal').style.display='none'; }
function closeCulturalNoteModalBg(e) { if(e.target===document.getElementById('cultural-note-modal')) closeCulturalNoteModal(); }

async function submitCulturalNote() {
  var content=document.getElementById('cn-content').value.trim();
  if(!content){ showToast('Pa bliye ekri nòt ou a'); return; }
  var btn=document.getElementById('cn-submit-btn');
  btn.textContent='Ap voye…'; btn.disabled=true;
  var personaSel=document.getElementById('cn-persona');
  var personaId=personaSel.value||null;
  var personaName=personaId?(personaSel.options[personaSel.selectedIndex].text):null;
  try {
    var res=await adminFetch('/api/partner/notes', {
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({persona_id:personaId,persona_name:personaName,domain:document.getElementById('cn-domain').value||'general',content:content,confidence:_cnConf})
    });
    if(res.ok){ closeCulturalNoteModal(); showToast('✓ Nòt ou a voye bay ekip la — mèsi!'); }
    else showToast('Pa kapab voye — eseye ankò');
  } catch(e){ showToast('Pa kapab voye — eseye ankò'); }
  btn.textContent='Soumèt nòt'; btn.disabled=false;
}

/* ════════════════════════════════════════════
   CORPUS
   ════════════════════════════════════════════ */
var corpusData = [];
var selectedCorpusId = null;

var SOURCE_LABELS = {
  field_interview:    '🎙 Field interview',
  partner_correction: '✓ Partner correction',
  flag_correction:    '⚑ Flag correction',
  cultural_edit:      '✎ Cultural edit',
  manual:             '✍ Manual'
};

async function loadCorpus() {
  document.getElementById('corpus-list').innerHTML = '<div style="padding:12px;color:#2A3A50;font-size:11.5px;">Loading…</div>';
  try {
    var res = await adminFetch('/api/corpus');
    if (res.ok) corpusData = await res.json();
    else corpusData = [];
  } catch(e) { corpusData = []; }
  buildCorpusPersonaFilter();
  renderCorpusList();
  updateCorpusBadge();
  renderCorpusCoverage();
}

function buildCorpusPersonaFilter() {
  var sel = document.getElementById('corpus-filter-persona');
  if (!sel) return;
  var cur = sel.value;
  var seen = {};
  var opts = '<option value="">All personas</option>';
  corpusData.forEach(function(e) {
    if (e.persona_id && !seen[e.persona_id]) {
      seen[e.persona_id] = true;
      opts += '<option value="'+esc(e.persona_id)+'">'+esc(e.persona_name||e.persona_id)+'</option>';
    }
  });
  opts += '<option value="general">General (no persona)</option>';
  sel.innerHTML = opts;
  if (cur) sel.value = cur;
}

function updateCorpusBadge() {
  var badge = document.getElementById('corpus-badge');
  if (badge) { badge.textContent = corpusData.length; badge.style.display = corpusData.length > 0 ? 'inline' : 'none'; }
}

function renderCorpusList() {
  var list = document.getElementById('corpus-list');
  var pf = document.getElementById('corpus-filter-persona') ? document.getElementById('corpus-filter-persona').value : '';
  var df = document.getElementById('corpus-filter-domain')  ? document.getElementById('corpus-filter-domain').value  : '';
  var sf = document.getElementById('corpus-filter-source')  ? document.getElementById('corpus-filter-source').value  : '';
  var cf = document.getElementById('corpus-filter-confidence') ? document.getElementById('corpus-filter-confidence').value : '';
  var qEl = document.getElementById('corpus-search');
  var q = qEl ? qEl.value.trim().toLowerCase() : '';
  var filtered = corpusData.filter(function(e) {
    if (pf && pf !== 'general' && e.persona_id !== pf) return false;
    if (pf === 'general' && e.persona_id) return false;
    if (df && e.domain !== df) return false;
    if (sf && e.source !== sf) return false;
    if (cf && (e.confidence||'general') !== cf) return false;
    if (q) {
      var hay = ((e.title||'')+' '+(e.content||'')+' '+(e.reference||'')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
  if (!filtered.length) {
    list.innerHTML = '<div style="padding:12px;color:#2A3A50;font-size:11.5px;">'+(corpusData.length ? 'No entries match filters.' : 'No entries yet. Add your first one.')+'</div>';
    return;
  }
  var html = '';
  filtered.forEach(function(e) {
    var color = personaColor(e.persona_id) || '#3A5A70';
    var dt = e.created_at ? new Date(e.created_at).toLocaleDateString([], {month:'short', day:'numeric', year:'2-digit'}) : '';
    var srcLabel = (SOURCE_LABELS[e.source] || e.source || '').replace(/^[^ ]+ /, '');
    var isPending = e.status === 'pending_review';
    var confMark = {confirmed:'✅',general:'📚',mixed:'◑',corrected:'⚠'}[e.confidence||'general']||'📚';
    html += '<div class="s-item'+(e.id===selectedCorpusId?' active':'')+'" onclick="selectCorpusEntry(\''+esc(e.id)+'\')" style="border-left:3px solid '+color+'">' +
      '<div style="font-size:11.5px;font-weight:600;color:#CBD5E1;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+
        (isPending?'<span class="pending-badge" style="margin-right:5px;">Pending</span>':'')+
        '<span title="'+(e.confidence||'general')+'" style="margin-right:4px;">'+confMark+'</span>'+
        esc(e.title||e.content.slice(0,50))+
        (e.has_gaps?' <span style="color:#A78BFA;font-size:9px;">🔲</span>':'')+
      '</div>'+
      '<div style="font-size:10px;color:#3A5A70;">'+esc(e.persona_name||'General')+' · '+(DOMAIN_INFO[e.domain] ? DOMAIN_INFO[e.domain].label : esc(e.domain||'General'))+'</div>'+
      '<div style="font-size:10px;color:#2A3A50;margin-top:1px;">'+esc(srcLabel)+' · '+esc(dt)+'</div>'+
    '</div>';
  });
  list.innerHTML = html;
}

function selectCorpusEntry(id) {
  selectedCorpusId = id;
  renderCorpusList();
  var e = corpusData.find(function(x){ return x.id===id; });
  if (!e) return;
  var color = personaColor(e.persona_id) || '#3A5A70';
  var dt = e.created_at ? new Date(e.created_at).toLocaleString() : '';
  var domainLabel = DOMAIN_INFO[e.domain] ? DOMAIN_INFO[e.domain].label : (e.domain || 'General');
  var html = '<div class="anim">'+
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #0F2040;">'+
      '<div style="flex:1;">'+
        '<div style="font-size:14px;font-weight:600;color:#E2E8F0;line-height:1.3;">'+
          (e.status==='pending_review'?'<span class="pending-badge" style="margin-right:8px;">Pending review</span>':'')+
          esc(e.title||'Untitled entry')+
        '</div>'+
        '<div style="font-size:10.5px;color:#3A5A70;margin-top:3px;">'+
          esc(e.persona_name||'General')+' · '+esc(domainLabel)+' · '+(SOURCE_LABELS[e.source]||e.source)+' · '+esc(dt)+
        '</div>'+
      '</div>'+
      (e.status==='pending_review'?'<button class="btn btn-success" onclick="approveCorpusEntry(\''+esc(e.id)+'\')" style="flex-shrink:0;">✓ Approve</button>':'')+
      '<button class="btn" onclick="openCorpusForm(\''+esc(e.id)+'\')" style="flex-shrink:0;">✎ Edit</button>'+
      '<button class="btn" onclick="archiveCorpusEntry(\''+esc(e.id)+'\')" style="flex-shrink:0;color:#EF4444;border-color:#3A1A1A;">Archive</button>'+
    '</div>'+
    '<div style="background:#0A1628;border:1px solid #0F2040;border-left:3px solid '+color+';border-radius:8px;padding:12px 14px;font-size:12.5px;color:#CBD5E1;line-height:1.7;white-space:pre-wrap;margin-bottom:12px;">'+esc(e.content)+'</div>'+
    (e.notes ? '<div style="font-size:11.5px;color:#64748B;line-height:1.6;font-style:italic;">'+esc(e.notes)+'</div>' : '')+
    (e.reference ? '<div style="margin-top:10px;font-size:10.5px;color:#3A5A70;">Reference: '+esc(e.reference)+'</div>' : '')+
    '<div style="margin-top:14px;">'+
      '<button class="btn" onclick="downloadCorpusEntry(\''+esc(e.id)+'\')" style="font-size:11px;">⬇ Download as .md snippet</button>'+
    '</div>'+
  '</div>';
  document.getElementById('corpus-detail').innerHTML = html;
}

function openCorpusForm(id) {
  var e = id ? corpusData.find(function(x){ return x.id===id; }) : null;
  document.getElementById('corpus-modal-title').textContent = e ? 'Edit Corpus Entry' : 'Add Corpus Entry';
  document.getElementById('cf-id').value      = e ? e.id : '';
  document.getElementById('cf-title').value   = e ? (e.title||'') : '';
  document.getElementById('cf-content').value = e ? (e.content||'') : '';
  document.getElementById('cf-notes').value   = e ? (e.notes||'') : '';
  document.getElementById('cf-ref').value     = e ? (e.reference||'') : '';
  document.getElementById('cf-domain').value  = e ? (e.domain||'general') : 'general';
  document.getElementById('cf-source').value  = e ? (e.source||'manual') : 'manual';
  var sel = document.getElementById('cf-persona');
  var opts = '<option value="">General (all personas)</option>';
  Object.values(personaData).forEach(function(p) {
    opts += '<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>';
  });
  sel.innerHTML = opts;
  if (e && e.persona_id) sel.value = e.persona_id;
  document.getElementById('corpus-modal').style.display = 'flex';
  setTimeout(function(){ document.getElementById('cf-title').focus(); }, 100);
}

function closeCorpusModal() { document.getElementById('corpus-modal').style.display = 'none'; }
function closeCorpusModalBg(e) { if (e.target===document.getElementById('corpus-modal')) closeCorpusModal(); }

async function saveCorpusEntry() {
  var btn = document.getElementById('cf-save-btn');
  var content = document.getElementById('cf-content').value.trim();
  if (!content) { showToast('Content is required'); return; }
  btn.textContent = 'Saving…'; btn.disabled = true;
  var id = document.getElementById('cf-id').value || ('corpus-'+Date.now()+'-'+Math.random().toString(36).slice(2,6));
  var personaSel = document.getElementById('cf-persona');
  var entry = {
    id: id,
    title:        document.getElementById('cf-title').value.trim() || null,
    persona_id:   personaSel.value || null,
    persona_name: personaSel.value ? (personaSel.options[personaSel.selectedIndex].text) : null,
    domain:       document.getElementById('cf-domain').value || 'general',
    source:       document.getElementById('cf-source').value || 'manual',
    reference:    document.getElementById('cf-ref').value.trim() || null,
    content:      content,
    notes:        document.getElementById('cf-notes').value.trim() || null,
    updated_at:   new Date().toISOString(),
  };
  var isNew = !document.getElementById('cf-id').value;
  if (isNew) entry.created_at = entry.updated_at;
  try {
    var res = await adminFetch('/api/corpus' + (isNew ? '' : '/'+id), {
      method: isNew ? 'POST' : 'PUT',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(entry)
    });
    if (res.ok) {
      closeCorpusModal();
      await loadCorpus();
      selectCorpusEntry(id);
      showToast(isNew ? 'Entry added ✓' : 'Entry updated ✓');
    } else {
      showToast('Save failed — check connection');
    }
  } catch(e) {
    showToast('Save failed — check connection');
  }
  btn.textContent = 'Save Entry'; btn.disabled = false;
}

async function approveCorpusEntry(id) {
  try {
    await adminFetch('/api/corpus/'+encodeURIComponent(id), {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({status:'active', updated_at: new Date().toISOString()})
    });
    corpusData = corpusData.map(function(e){ return e.id===id ? Object.assign({},e,{status:'active'}) : e; });
    renderCorpusList(); selectCorpusEntry(id); updateCorpusBadge(); showToast('Entry approved ✓');
  } catch(e) { showToast('Could not approve — check connection'); }
}

async function archiveCorpusEntry(id) {
  if (!confirm('Archive this entry? It will be hidden but not deleted.')) return;
  try {
    await adminFetch('/api/corpus/'+encodeURIComponent(id), {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({status:'archived', updated_at: new Date().toISOString()})
    });
    corpusData = corpusData.filter(function(e){ return e.id !== id; });
    selectedCorpusId = null;
    renderCorpusList();
    document.getElementById('corpus-detail').innerHTML = '<div style="color:#2A3A50;font-size:12px;padding-top:40px;text-align:center;">Entry archived.</div>';
    updateCorpusBadge(); showToast('Entry archived');
  } catch(e) { showToast('Could not archive — check connection'); }
}

function downloadCorpusEntry(id) {
  var e = corpusData.find(function(x){ return x.id===id; });
  if (!e) return;
  var dt = new Date().toISOString().slice(0,10);
  var md = ['---',
    'id: '+e.id,
    'persona: '+(e.persona_name||'general'),
    'domain: '+(e.domain||'general'),
    'source: '+(e.source||'manual'),
    (e.reference ? 'reference: '+e.reference : null),
    'date: '+dt,
    '---', '',
    '## '+(e.title || (e.persona_name||'General')+' — '+(DOMAIN_INFO[e.domain]?DOMAIN_INFO[e.domain].label:e.domain||'General')),
    '', e.content,
    (e.notes ? '\n---\n*Notes: '+e.notes+'*' : ''), ''
  ].filter(function(l){ return l!==null; }).join('\n');
  var blob = new Blob([md], {type:'text/markdown'});
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url; a.download = 'corpus-'+(e.persona_id||'general')+'-'+dt+'.md'; a.click();
  URL.revokeObjectURL(url);
  showToast('Downloaded .md snippet ✓');
}

function exportCorpusMarkdown() {
  if (!corpusData.length) { showToast('No entries to export'); return; }
  var dt = new Date().toISOString().slice(0,10);
  var sections = {};
  corpusData.forEach(function(e) {
    var key = e.persona_id || 'general';
    if (!sections[key]) sections[key] = { name: e.persona_name || 'General', entries: [] };
    sections[key].entries.push(e);
  });
  var md = ['# JUMO Master Corpus', 'Exported: '+dt, ''];
  Object.keys(sections).forEach(function(k) {
    var sec = sections[k];
    md.push('## '+sec.name);
    sec.entries.forEach(function(e) {
      md.push('### '+(e.title || (DOMAIN_INFO[e.domain]?DOMAIN_INFO[e.domain].label:e.domain||'General')));
      md.push('*Source: '+(SOURCE_LABELS[e.source]||e.source)+(e.reference?' · '+e.reference:'')+'*');
      md.push(''); md.push(e.content); md.push('');
    });
  });
  var blob = new Blob([md.join('\n')], {type:'text/markdown'});
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement('a');
  a.href = url; a.download = 'jumo-corpus-'+dt+'.md'; a.click();
  URL.revokeObjectURL(url);
  showToast('Exported master-corpus.md ✓');
}

/* ════════════════════════════════════════════
   PERSONA HEALTH DASHBOARD
   ════════════════════════════════════════════ */
function renderHealthDashboard() {
  var container = document.getElementById('health-dashboard');
  if (!container) return;
  var personas = Object.values(personaData);
  if (!personas.length) { container.innerHTML = ''; return; }
  var DOMAINS = ['health','family','economic','institutional','religious','education','language_profile'];
  var html = '<div style="padding:10px 12px;border-bottom:1px solid #0F2040;">' +
    '<div style="font-size:9.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#3A5A70;margin-bottom:8px;">Persona Health</div>' +
    '<div style="display:flex;flex-direction:column;gap:5px;">';
  personas.forEach(function(p) {
    var color = p.color || '#3A5A70';
    var domains = p.domains || {};
    var filled = DOMAINS.filter(function(d) { return domains[d] && domains[d].content && domains[d].content.trim(); }).length;
    var validated = DOMAINS.filter(function(d) { return domains[d] && domains[d].source === 'partner_validated'; }).length;
    var hasPrompt = !!(p.system_prompt || p.system_prompt_fragment);
    var pct = Math.round((filled / DOMAINS.length) * 100);
    var openFlags = flagsData.filter(function(f){ return f.persona_id === p.id && f.status !== 'resolved'; }).length;
    var statusColor = '#EF4444';
    var statusLabel = 'Empty';
    if (hasPrompt || filled === DOMAINS.length) { statusColor = '#22C55E'; statusLabel = 'Ready'; }
    else if (filled >= 4) { statusColor = '#F59E0B'; statusLabel = 'Partial'; }
    else if (filled > 0)  { statusColor = '#EF4444'; statusLabel = 'Sparse'; }
    html += '<div onclick="selectPersona(\''+esc(p.id)+'\')" style="cursor:pointer;background:#040710;border:1px solid #0F2040;border-left:3px solid '+color+';border-radius:7px;padding:8px 10px;transition:background .12s;" onmouseover="this.style.background=\'#0A1628\'" onmouseout="this.style.background=\'#040710\'">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">' +
        '<div style="font-size:11.5px;font-weight:600;color:#CBD5E1;flex:1;">'+esc(p.name)+'</div>' +
        (openFlags ? '<div style="font-size:10px;color:#EF4444;background:#3A1A1A;border-radius:4px;padding:1px 6px;">⚑ '+openFlags+'</div>' : '')+
        '<div style="font-size:10px;font-weight:600;color:'+statusColor+';background:'+statusColor+'22;border-radius:4px;padding:1px 6px;">'+statusLabel+'</div>'+
      '</div>'+
      '<div style="display:flex;gap:3px;margin-bottom:4px;">' +
        DOMAINS.map(function(d) {
          var dom = domains[d] || {};
          var hasCont = dom.content && dom.content.trim();
          var src = dom.source || '';
          var dotColor = !hasCont ? '#1E2A3A'
            : src === 'partner_validated' ? '#34D399'
            : src === 'field_interview'   ? '#22D3EE'
            : src === 'cultural_edit'     ? '#F59E0B'
            : '#3A5A70';
          return '<div title="'+esc((DOMAIN_INFO[d]?DOMAIN_INFO[d].label:d))+'" style="width:14px;height:14px;border-radius:3px;background:'+dotColor+';flex-shrink:0;"></div>';
        }).join('') +
        '<div style="flex:1;text-align:right;font-size:9.5px;color:#3A5A70;">'+filled+'/'+DOMAINS.length+(validated?' · '+validated+' validated':'')+'</div>'+
      '</div>'+
      '<div style="height:3px;background:#0A1628;border-radius:2px;overflow:hidden;">' +
        '<div style="height:100%;width:'+pct+'%;background:'+color+';border-radius:2px;transition:width .3s;"></div>' +
      '</div>'+
    '</div>';
  });
  html += '</div>';
  html += '<div style="display:flex;gap:10px;flex-wrap:wrap;padding-top:8px;padding-bottom:2px;">' +
    [['#34D399','Partner validated'],['#22D3EE','Field interview'],['#F59E0B','Cultural edit'],['#3A5A70','AI/other'],['#1E2A3A','Empty']].map(function(pair){
      return '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:#3A5A70;"><div style="width:10px;height:10px;border-radius:2px;background:'+pair[0]+';"></div>'+pair[1]+'</div>';
    }).join('') +
  '</div>';
  html += '</div>';
  container.innerHTML = html;
}

/* ═══ VOICE_EDITOR ═══ */

(function(){
  function exRow(q, a) {
    var wrap = document.createElement('div');
    wrap.className = 've-ex-row';
    wrap.style.cssText = 'display:grid;grid-template-columns:1fr 1fr auto;gap:5px;align-items:start;margin-bottom:4px;';
    var qs = (q||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var as = (a||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    wrap.innerHTML =
      '<textarea rows="2" class="ve-ex-q field-textarea" placeholder="Kesyon (question)…" style="font-size:11px;min-height:44px;">'+qs+'</textarea>'+
      '<textarea rows="2" class="ve-ex-a field-textarea" placeholder="Repons (answer)…" style="font-size:11px;min-height:44px;">'+as+'</textarea>'+
      '<button type="button" class="ve-ex-del btn" title="Remove" style="padding:3px 8px;align-self:start;margin-top:0;">✕</button>';
    wrap.querySelector('.ve-ex-del').onclick = function(){ wrap.remove(); if(typeof markDirty==='function') markDirty(); };
    return wrap;
  }

  window.veRenderExamples = function(examples) {
    var list = document.getElementById('ve_examples_list');
    if (!list) return;
    list.innerHTML = '';
    (examples || []).forEach(function(e){
      list.appendChild(exRow(e.q || e.question || '', e.a || e.answer || ''));
    });
    if (!examples || !examples.length) list.appendChild(exRow('',''));
  };

  window.veCollect = function() {
    var examples = [];
    document.querySelectorAll('#ve_examples_list .ve-ex-row').forEach(function(row){
      var q = (row.querySelector('.ve-ex-q')||{}).value||'';
      var a = (row.querySelector('.ve-ex-a')||{}).value||'';
      if (q.trim() && a.trim()) examples.push({ q: q.trim(), a: a.trim() });
    });
    function lines(id) {
      var el = document.getElementById(id);
      return el ? el.value.split('\n').map(function(s){return s.trim();}).filter(Boolean) : [];
    }
    return {
      voice_anchor:     (document.getElementById('ve_voice_anchor')||{}).value||'',
      voice_examples:   examples,
      refusal_patterns: lines('ve_refusal_patterns'),
      contradictions:   lines('ve_contradictions'),
    };
  };

  window.vePopulate = function(p) {
    var anchor  = document.getElementById('ve_voice_anchor');
    var refusal = document.getElementById('ve_refusal_patterns');
    var contra  = document.getElementById('ve_contradictions');
    if (anchor)  anchor.value  = p.voice_anchor || '';
    if (refusal) refusal.value = Array.isArray(p.refusal_patterns) ? p.refusal_patterns.join('\n') : (p.refusal_patterns || '');
    if (contra)  contra.value  = Array.isArray(p.contradictions)   ? p.contradictions.join('\n')   : (p.contradictions   || '');
    window.veRenderExamples(p.voice_examples || []);
  };

  document.addEventListener('click', function(ev){
    if (ev.target && ev.target.id === 've_add_example') {
      var list = document.getElementById('ve_examples_list');
      if (list) {
        list.appendChild(exRow('',''));
        if(typeof markDirty==='function') markDirty();
      }
    }
  });
})();

/* ═══ FLAG_PROMOTE ═══ */

/* Read the inline correction textarea for a flag, if present */
function getFlagCorrection(flagId) {
  var el = document.getElementById('flag-correction-'+flagId);
  return el ? el.value.trim() : '';
}
var flagCorrectionDirty = false;

async function jumoPromoteFlag(flagId) {
  var f = (typeof flagsData !== 'undefined') ? flagsData.find(function(x){ return x.id===flagId; }) : null;

  var q = f ? (f.question_text || '') : '';
  var a = getFlagCorrection(flagId) || (f ? (f.partner_correction || '') : '');

  if (!q) { q = prompt('Question that prompted this response:', ''); if (q === null) return; }
  if (!a) { showToast('Type the correct response in the field above first'); 
    var ta = document.getElementById('flag-correction-'+flagId); if (ta) ta.focus(); return; }
  if (!q.trim() || !a.trim()) { showToast('Need both a question and a corrected answer'); return; }

  var btn = document.getElementById('promote-btn-'+flagId);
  if (btn) { btn.textContent = 'Promoting…'; btn.disabled = true; }

  try {
    // Persist the correction onto the flag first so it isn't lost
    await adminFetch('/api/flags/'+encodeURIComponent(flagId), {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ partner_correction: a.trim() })
    });
    var res = await adminFetch('/api/flags/'+flagId+'/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: q.trim(), a: a.trim() })
    });
    var d = await res.json();
    if (d.success) {
      showToast('✓ Voice example added. Persona now has '+d.example_count+' examples. Live immediately.');
      flagCorrectionDirty = false;
      loadFlags();
    } else {
      showToast('Error: '+(d.error||'unknown'));
      if (btn) { btn.textContent = '⬆ Promote correction to voice example'; btn.disabled = false; }
    }
  } catch(e) {
    showToast('Network error: '+e.message);
    if (btn) { btn.textContent = '⬆ Promote correction to voice example'; btn.disabled = false; }
  }
}

/* ════════════════════════════════════════════════════════════
   CORPUS BULK IMPORT — parser + modal + preview + commit
   ════════════════════════════════════════════════════════════ */

var CORPUS_PERSONA_NAMES = [
  { id:'marie-ange', match:['marie-ange','marie ange'] },
  { id:'lisette',    match:['granmoun lisette','lisette'] },
  { id:'jefte',      match:['jèftè','jefte','jèfte'] },
  { id:'nadege',     match:['nadège','nadege'] },
  { id:'dieunel',    match:['dieunel'] },
  { id:'sophonie',   match:['sophonie'] },
  { id:'kenzy',      match:['kenzy'] },
  { id:'jonas',      match:['pastè jonas','jonas michelet','jonas'] },
  { id:'roseline',   match:['roseline'] },
  { id:'marilene',   match:['marilène','marilene'] },
];

var CORPUS_DOMAIN_KEYWORDS = {
  health:           ['health','illness','sick','doktè','klinik','limye','houngan','medic','disease','care','spiritual diagnos'],
  family:           ['family','fanmi','children','household','marriage','kinship','solidarity','mother','father','community network'],
  economic:         ['economic','madan sara','sòl','money','lajan','market','income','business','moto','trade','financial','employment','microfinance'],
  institutional:    ['ngo','institution','trust','government','leta','organization','aid','world bank','state','authority','program','stakeholder'],
  religious:        ['vodou','catholic','evangelical','church','legliz','lwa','spiritual','vèvè','houngan','ginen','pastè','faith','religion'],
  education:        ['education','school','literacy','learning','lekòl'],
  language_profile: ['proverb','pwovèb','vocabulary','term','voice','tone','tire pwen','communication','language','saying','food','manje','music','mizik','dish'],
};

function corpusGuessDomain(title, content) {
  var hay = (title + ' ' + content.slice(0,400)).toLowerCase();
  var best='general', bestScore=0;
  for (var d in CORPUS_DOMAIN_KEYWORDS) {
    var s=0; CORPUS_DOMAIN_KEYWORDS[d].forEach(function(k){ if(hay.indexOf(k)!==-1) s++; });
    if (s>bestScore){ bestScore=s; best=d; }
  }
  return bestScore>0 ? best : 'general';
}
function corpusPersonaFromLine(line){
  var low=line.toLowerCase();
  for(var i=0;i<CORPUS_PERSONA_NAMES.length;i++)
    if(CORPUS_PERSONA_NAMES[i].match.some(function(m){return low.indexOf(m)!==-1;})) return CORPUS_PERSONA_NAMES[i].id;
  return null;
}
function corpusDetectPersona(title, content){
  var hay=(title+' '+content).toLowerCase();
  var pm=content.match(/([A-Za-zÀ-ÿ\s'-]+?)\s*\(primary/i);
  if(pm){ var t=pm[1].toLowerCase();
    for(var i=0;i<CORPUS_PERSONA_NAMES.length;i++)
      if(CORPUS_PERSONA_NAMES[i].match.some(function(m){return t.indexOf(m)!==-1;})) return {id:CORPUS_PERSONA_NAMES[i].id,multi:true};
  }
  if(/substrate|all personas|all female personas/i.test(hay)) return {id:'general',multi:true};
  var found=[];
  CORPUS_PERSONA_NAMES.forEach(function(p){ if(p.match.some(function(m){return hay.indexOf(m)!==-1;})) found.push(p.id); });
  if(found.length===1) return {id:found[0],multi:false};
  if(found.length>1)   return {id:found[0],multi:true};
  return {id:'general',multi:false};
}
function corpusDetectConfidence(body){
  var c=(body.match(/✅/g)||[]).length, g=(body.match(/📚/g)||[]).length,
      w=(body.match(/⚠️/g)||[]).length;
  if(w>0 && w>=c) return 'corrected';
  if(c>0 && g>0)  return 'mixed';
  if(c>0)         return 'confirmed';
  return 'general';
}
function corpusIsGapSection(title, body){
  if(/validation gaps|needs validation|still needs validation/i.test(title)) return true;
  var gaps=(body.match(/🔲/g)||[]).length;
  var lines=body.split('\n').filter(function(l){return l.trim();}).length;
  return gaps>=3 && gaps>=lines*0.5;
}
function corpusExtractGaps(body){
  var out=[];
  body.split('\n').forEach(function(line){
    var m=line.match(/🔲\s*(.+)/); if(!m) return;
    var q=m[1].trim().replace(/^\*+|\*+$/g,'').trim();
    if(q.length<12) return;
    if(/^[—\-:]/.test(q)) return;
    if(/^(require|requires|need|needs|all)\b/i.test(q) && q.length<40) return;
    if(/^validate\b/i.test(q) && q.length<30) return;
    out.push({question:q, persona_id:corpusPersonaFromLine(q)});
  });
  return out;
}
function corpusIsVocab(title, body){
  if(/vocabulary|vocab|new terms|term\b/i.test(title)){ return (body.match(/\|/g)||[]).length>6; }
  return false;
}

function parseCorpusText(text){
  var lines=text.split('\n'), sections=[], current=null, cat='';
  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    var catM=line.match(/^#\s+SECTION\s+(.+)/i);
    var h2=line.match(/^##\s+(.+)/);
    if(catM){ if(current){sections.push(current);current=null;} cat=catM[1].trim(); continue; }
    if(h2){ if(current) sections.push(current); current={heading:h2[1].trim(),category:cat,lines:[]}; continue; }
    if(current) current.lines.push(line);
  }
  if(current) sections.push(current);

  var entries=[], gaps=[];
  sections.forEach(function(s){
    var body=s.lines.join('\n').trim();
    if(!body) return;
    var refM=s.heading.match(/^(\d+(?:\.\d+)?)\s*[—\-:.]*\s*(.*)$/);
    var reference=refM?refM[1]:null;
    var title=refM?refM[2].trim():s.heading;
    if(!title) title=s.heading;

    if(corpusIsGapSection(title,body)){
      var gd=corpusGuessDomain(title,body);
      corpusExtractGaps(body).forEach(function(g){
        gaps.push({reference:reference,question:g.question,persona_id:g.persona_id,domain:gd});
      });
      return;
    }
    var persona=corpusDetectPersona(title,body);
    var confidence=corpusDetectConfidence(body);
    var hasGaps=/🔲/.test(body);
    var domain=corpusIsVocab(title,body)?'language_profile':corpusGuessDomain(title,body);
    if(hasGaps){
      corpusExtractGaps(body).forEach(function(g){
        gaps.push({reference:reference,question:g.question,persona_id:g.persona_id||(persona.id==='general'?null:persona.id),domain:domain});
      });
    }
    entries.push({
      reference:reference, title:title, content:body, domain:domain,
      persona_id:persona.id==='general'?null:persona.id, persona_multi:persona.multi,
      confidence:confidence, has_gaps:hasGaps, category:s.category,
      char_count:body.length, type:corpusIsVocab(title,body)?'vocab':'entry', include:true
    });
  });
  return {entries:entries, gaps:gaps};
}

/* ── Bulk import UI state ── */
var _bulkParsed = null;

function openBulkImport(){
  document.getElementById('bulk-paste').value='';
  document.getElementById('bulk-preview-wrap').style.display='none';
  document.getElementById('bulk-parse-btn').style.display='';
  document.getElementById('bulk-commit-btn').style.display='none';
  document.getElementById('bulk-modal').style.display='flex';
  _bulkParsed=null;
}
function closeBulkImport(){ document.getElementById('bulk-modal').style.display='none'; _bulkParsed=null; }
function closeBulkImportBg(e){ if(e.target===document.getElementById('bulk-modal')) closeBulkImport(); }

function runBulkParse(){
  var text=document.getElementById('bulk-paste').value;
  if(!text.trim()){ showToast('Paste corpus text first'); return; }
  _bulkParsed=parseCorpusText(text);
  renderBulkPreview();
}

var CONF_BADGE = {
  confirmed: {bg:'#022C22',bd:'#065F46',fg:'#34D399',label:'✅ confirmed'},
  general:   {bg:'#0A1628',bd:'#1E3A5F',fg:'#7EC8E3',label:'📚 general'},
  mixed:     {bg:'#2D1B00',bd:'#78350F',fg:'#FCD34D',label:'◑ mixed'},
  corrected: {bg:'#431407',bd:'#7C2D12',fg:'#FB923C',label:'⚠ corrected'},
};
var CORPUS_DOMAINS = ['general','health','family','economic','institutional','religious','education','language_profile'];
var CORPUS_PERSONA_OPTS = ['general','marie-ange','lisette','jefte','nadege','dieunel','sophonie','kenzy','jonas','roseline','marilene'];

function renderBulkPreview(){
  var p=_bulkParsed; if(!p) return;
  var wrap=document.getElementById('bulk-preview-wrap');
  var conf={confirmed:0,general:0,mixed:0,corrected:0};
  p.entries.forEach(function(e){ conf[e.confidence]=(conf[e.confidence]||0)+1; });

  var summary='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;font-size:11px;">'+
    '<span style="color:#CBD5E1;font-weight:600;">'+p.entries.length+' entries</span>'+
    '<span style="color:#3A5A70;">·</span>'+
    Object.keys(conf).filter(function(k){return conf[k];}).map(function(k){
      return '<span style="color:'+CONF_BADGE[k].fg+';">'+conf[k]+' '+k+'</span>';
    }).join(' ')+
    '<span style="color:#3A5A70;">·</span>'+
    '<span style="color:#A78BFA;">'+p.gaps.length+' gaps → worklist</span>'+
  '</div>';

  var rows=p.entries.map(function(e,i){
    var cb=CONF_BADGE[e.confidence]||CONF_BADGE.general;
    var domOpts=CORPUS_DOMAINS.map(function(d){return '<option value="'+d+'"'+(d===e.domain?' selected':'')+'>'+d+'</option>';}).join('');
    var perOpts=CORPUS_PERSONA_OPTS.map(function(pp){var v=pp==='general'?'':pp;return '<option value="'+v+'"'+((e.persona_id||'')===v?' selected':'')+'>'+pp+'</option>';}).join('');
    return '<tr style="border-bottom:1px solid #0F2040;'+(e.include?'':'opacity:.4;')+'" id="brow-'+i+'">'+
      '<td style="padding:5px 6px;text-align:center;"><input type="checkbox" '+(e.include?'checked':'')+' onchange="bulkToggle('+i+',this.checked)"></td>'+
      '<td style="padding:5px 6px;color:#3A5A70;font-size:10px;white-space:nowrap;">'+esc(e.reference||'—')+'</td>'+
      '<td style="padding:5px 6px;color:#CBD5E1;font-size:11px;max-width:260px;">'+esc(e.title.slice(0,70))+(e.type==='vocab'?' <span style="color:#7EC8E3;font-size:9px;">[vocab]</span>':'')+(e.has_gaps?' <span style="color:#A78BFA;font-size:9px;">🔲</span>':'')+'</td>'+
      '<td style="padding:5px 6px;"><select onchange="bulkSetField('+i+',\'domain\',this.value)" style="background:#040710;border:1px solid #0F2040;border-radius:4px;color:#94A3B8;font-size:10px;padding:2px 4px;">'+domOpts+'</select></td>'+
      '<td style="padding:5px 6px;"><select onchange="bulkSetField('+i+',\'persona_id\',this.value)" style="background:#040710;border:1px solid #0F2040;border-radius:4px;color:#94A3B8;font-size:10px;padding:2px 4px;">'+perOpts+'</select>'+(e.persona_multi?'<span title="multiple personas named" style="color:#F59E0B;font-size:9px;"> *</span>':'')+'</td>'+
      '<td style="padding:5px 6px;"><span style="background:'+cb.bg+';border:1px solid '+cb.bd+';color:'+cb.fg+';border-radius:4px;padding:1px 6px;font-size:9.5px;white-space:nowrap;">'+cb.label+'</span></td>'+
      '<td style="padding:5px 6px;color:#3A5A70;font-size:10px;text-align:right;">'+e.char_count+'</td>'+
    '</tr>';
  }).join('');

  var table='<div style="max-height:340px;overflow-y:auto;border:1px solid #0F2040;border-radius:7px;">'+
    '<table style="width:100%;border-collapse:collapse;">'+
    '<thead style="position:sticky;top:0;background:#0A1628;"><tr style="font-size:9px;color:#3A5A70;text-transform:uppercase;letter-spacing:.06em;">'+
      '<th style="padding:6px;">✓</th><th style="padding:6px;text-align:left;">Ref</th><th style="padding:6px;text-align:left;">Title</th>'+
      '<th style="padding:6px;text-align:left;">Domain</th><th style="padding:6px;text-align:left;">Persona</th>'+
      '<th style="padding:6px;text-align:left;">Confidence</th><th style="padding:6px;text-align:right;">Chars</th>'+
    '</tr></thead><tbody>'+rows+'</tbody></table></div>';

  var gapsBlock='';
  if(p.gaps.length){
    gapsBlock='<div style="margin-top:10px;background:#130D2A;border:1px solid #2D1B6E;border-radius:7px;padding:10px 12px;">'+
      '<div style="font-size:10px;font-weight:600;color:#A78BFA;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">'+p.gaps.length+' gaps → validation worklist</div>'+
      '<div style="max-height:120px;overflow-y:auto;font-size:11px;color:#94A3B8;line-height:1.7;">'+
        p.gaps.map(function(g){return '🔲 '+esc(g.question.slice(0,80))+(g.persona_id?' <span style="color:#7C3AED;">['+g.persona_id+']</span>':'');}).join('<br>')+
      '</div></div>';
  }

  document.getElementById('bulk-preview-content').innerHTML=summary+table+gapsBlock;
  wrap.style.display='block';
  document.getElementById('bulk-parse-btn').style.display='none';
  document.getElementById('bulk-commit-btn').style.display='';
  var checked=p.entries.filter(function(e){return e.include;}).length;
  document.getElementById('bulk-commit-btn').textContent='Import '+checked+' entries + '+p.gaps.length+' gaps';
}

function bulkToggle(i,val){ if(_bulkParsed&&_bulkParsed.entries[i]){ _bulkParsed.entries[i].include=val;
  var row=document.getElementById('brow-'+i); if(row) row.style.opacity=val?'1':'.4';
  var n=_bulkParsed.entries.filter(function(e){return e.include;}).length;
  document.getElementById('bulk-commit-btn').textContent='Import '+n+' entries + '+_bulkParsed.gaps.length+' gaps';
}}
function bulkSetField(i,field,val){ if(_bulkParsed&&_bulkParsed.entries[i]) _bulkParsed.entries[i][field]=val||null; }

async function commitBulkImport(){
  if(!_bulkParsed) return;
  var btn=document.getElementById('bulk-commit-btn');
  btn.textContent='Importing…'; btn.disabled=true;

  var toImport=_bulkParsed.entries.filter(function(e){return e.include;}).map(function(e){
    return { reference:e.reference, title:e.title, content:e.content, domain:e.domain,
      persona_id:e.persona_id||null,
      persona_name:e.persona_id?(CORPUS_PERSONA_OPTS.indexOf(e.persona_id)>=0?e.persona_id:null):null,
      confidence:e.confidence, has_gaps:e.has_gaps, source:'corpus_import' };
  });

  // Batch in chunks of 25 to stay well under any payload limits
  var batchId='import-'+Date.now();
  var totals={entries_new:0,entries_updated:0,gaps_added:0,failed:0};
  var CHUNK=25;
  try {
    for(var i=0;i<toImport.length;i+=CHUNK){
      var slice=toImport.slice(i,i+CHUNK);
      var payload={entries:slice, batch:batchId};
      // attach all gaps only on the first chunk
      if(i===0) payload.gaps=_bulkParsed.gaps;
      var res=await adminFetch('/api/corpus/bulk',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      var d=await res.json();
      if(d.success){ totals.entries_new+=d.entries_new||0; totals.entries_updated+=d.entries_updated||0; totals.gaps_added+=d.gaps_added||0; totals.failed+=d.failed||0; }
      btn.textContent='Importing… '+Math.min(i+CHUNK,toImport.length)+'/'+toImport.length;
    }
    closeBulkImport();
    await loadCorpus();
    showToast('✓ '+totals.entries_new+' new, '+totals.entries_updated+' updated, '+totals.gaps_added+' gaps'+(totals.failed?', '+totals.failed+' failed':''));
  } catch(e){
    showToast('Import error: '+e.message);
    btn.textContent='Retry import'; btn.disabled=false;
  }
}

/* ════════════════════════════════════════════════════════════
   CORPUS COVERAGE VIEW — thickness by domain / persona / confidence
   ════════════════════════════════════════════════════════════ */
var _coverageOpen = false;
function toggleCoverage(){ _coverageOpen = !_coverageOpen; renderCorpusCoverage(); }

function renderCorpusCoverage(){
  var el=document.getElementById('corpus-coverage');
  if(!el) return;
  if(!corpusData.length){ el.innerHTML=''; return; }

  var byDomain={}, byPersona={}, byConf={confirmed:0,general:0,mixed:0,corrected:0};
  corpusData.forEach(function(e){
    var d=e.domain||'general'; byDomain[d]=(byDomain[d]||0)+1;
    var p=e.persona_name||e.persona_id||'general'; byPersona[p]=(byPersona[p]||0)+1;
    var c=e.confidence||'general'; byConf[c]=(byConf[c]||0)+1;
  });
  var total=corpusData.length;

  // ── Compact header — always visible, one line ──
  var chips = Object.keys(byConf).filter(function(k){return byConf[k];}).map(function(k){
    var c=CONF_BADGE[k];
    return '<span title="'+k+'" style="color:'+c.fg+';font-size:10px;">'+byConf[k]+'</span>';
  }).join('<span style="color:#1E2A3A;">/</span>');

  var header='<div onclick="toggleCoverage()" style="padding:9px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;" '+
    'onmouseover="this.style.background=\'#0A1628\'" onmouseout="this.style.background=\'transparent\'">'+
    '<span style="font-size:9.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#3A5A70;">Coverage</span>'+
    '<span style="font-size:10px;color:#CBD5E1;font-weight:600;">'+total+'</span>'+
    '<span style="margin-left:auto;">'+chips+'</span>'+
    '<span style="font-size:9px;color:#3A5A70;transition:transform .15s;'+(_coverageOpen?'transform:rotate(90deg);':'')+'">▶</span>'+
  '</div>';

  if(!_coverageOpen){ el.innerHTML=header; return; }

  // ── Expanded detail ──
  function bar(label,count,max,color){
    var pct=max?Math.round(count/max*100):0;
    return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">'+
      '<div style="width:82px;font-size:10px;color:#94A3B8;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(label)+'</div>'+
      '<div style="flex:1;height:11px;background:#0A1628;border-radius:3px;overflow:hidden;"><div style="height:100%;width:'+pct+'%;background:'+color+';"></div></div>'+
      '<div style="width:22px;font-size:10px;color:#3A5A70;">'+count+'</div></div>';
  }
  var maxD=Math.max.apply(null,Object.values(byDomain).concat([1]));
  var maxP=Math.max.apply(null,Object.values(byPersona).concat([1]));

  var detail='<div style="padding:0 12px 12px;">'+
    '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px;">'+
      Object.keys(byConf).filter(function(k){return byConf[k];}).map(function(k){var c=CONF_BADGE[k];return '<span style="background:'+c.bg+';border:1px solid '+c.bd+';color:'+c.fg+';border-radius:4px;padding:2px 7px;font-size:10px;">'+byConf[k]+' '+k+'</span>';}).join('')+
    '</div>'+
    '<div style="font-size:9px;color:#3A5A70;text-transform:uppercase;margin-bottom:4px;">By domain</div>'+
    CORPUS_DOMAINS.filter(function(d){return byDomain[d];}).map(function(d){return bar(d,byDomain[d],maxD,'#2D5F8A');}).join('')+
    '<div style="font-size:9px;color:#3A5A70;text-transform:uppercase;margin:10px 0 4px;">By persona</div>'+
    Object.keys(byPersona).sort(function(a,b){return byPersona[b]-byPersona[a];}).map(function(p){return bar(p,byPersona[p],maxP,'#7C3AED');}).join('')+
  '</div>';

  el.innerHTML=header+detail;
}

/* ════════════════════════════════════════════════════════════
   GAPS VIEW — validation worklist
   ════════════════════════════════════════════════════════════ */
var gapsData=[];
async function loadGaps(){
  var list=document.getElementById('gaps-list');
  if(list) list.innerHTML='<div style="padding:12px;color:#2A3A50;font-size:11.5px;">Loading…</div>';
  try{
    var status=document.getElementById('gaps-filter-status');
    var url='/api/gaps'; if(status&&status.value) url+='?status='+encodeURIComponent(status.value);
    var res=await adminFetch(url);
    gapsData=res.ok?await res.json():[];
  }catch(e){ gapsData=[]; }
  buildGapsPersonaFilter();
  renderGapsList();
  updateGapsBadge();
}
function updateGapsBadge(){
  var open=gapsData.filter(function(g){return g.status==='open';}).length;
  var b=document.getElementById('gaps-badge');
  if(b){ b.textContent=open; b.style.display=open>0?'inline':'none'; }
}
function renderGapsList(){
  var list=document.getElementById('gaps-list');
  if(!list) return;
  var pf=document.getElementById('gaps-filter-persona');
  var persona=pf?pf.value:'';
  var rows=gapsData.filter(function(g){return !persona || (g.persona_id||'')===persona;});
  if(!rows.length){ list.innerHTML='<div style="padding:12px;color:#2A3A50;font-size:11.5px;">No gaps'+(persona?' for this persona':'')+'.</div>'; return; }
  var html=rows.map(function(g){
    var statusColor=g.status==='resolved'?'#34D399':g.status==='wont_fix'?'#64748B':'#F59E0B';
    return '<div style="padding:10px 12px;border-bottom:1px solid #0F2040;'+(g.status==='resolved'?'opacity:.55;':'')+'">'+
      '<div style="display:flex;align-items:flex-start;gap:8px;">'+
        '<div style="flex:1;font-size:12px;color:#CBD5E1;line-height:1.5;">'+esc(g.question)+'</div>'+
        '<div style="width:7px;height:7px;border-radius:50%;background:'+statusColor+';flex-shrink:0;margin-top:5px;"></div>'+
      '</div>'+
      '<div style="font-size:10px;color:#3A5A70;margin-top:3px;">'+esc(g.persona_name||g.persona_id||'general')+' · '+esc(g.domain||'general')+(g.reference?' · '+esc(g.reference):'')+'</div>'+
      (g.status!=='resolved'?
        '<div style="display:flex;gap:5px;margin-top:6px;">'+
          '<button class="btn" onclick="resolveGap(\''+esc(g.id)+'\')" style="font-size:10px;color:#34D399;border-color:#065F46;padding:3px 10px;">✓ Resolved</button>'+
          '<button class="btn" onclick="dismissGap(\''+esc(g.id)+'\')" style="font-size:10px;padding:3px 10px;">Dismiss</button>'+
        '</div>'
        :(g.resolution?'<div style="font-size:11px;color:#6EE7B7;margin-top:4px;">✓ '+esc(g.resolution)+'</div>':''))+
    '</div>';
  }).join('');
  list.innerHTML=html;
}
async function resolveGap(id){
  var note=prompt('How was this validated? (optional resolution note)','');
  if(note===null) return;
  try{
    await adminFetch('/api/gaps/'+encodeURIComponent(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'resolved',resolution:note})});
    gapsData=gapsData.map(function(g){return g.id===id?Object.assign({},g,{status:'resolved',resolution:note}):g;});
    renderGapsList(); updateGapsBadge(); showToast('Gap resolved ✓');
  }catch(e){ showToast('Could not update'); }
}
async function dismissGap(id){
  try{
    await adminFetch('/api/gaps/'+encodeURIComponent(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'wont_fix'})});
    gapsData=gapsData.map(function(g){return g.id===id?Object.assign({},g,{status:'wont_fix'}):g;});
    renderGapsList(); updateGapsBadge(); showToast('Gap dismissed');
  }catch(e){ showToast('Could not update'); }
}
function buildGapsPersonaFilter(){
  var sel=document.getElementById('gaps-filter-persona');
  if(!sel) return;
  var cur=sel.value, seen={}, opts='<option value="">All personas</option>';
  gapsData.forEach(function(g){ if(g.persona_id&&!seen[g.persona_id]){seen[g.persona_id]=true;opts+='<option value="'+esc(g.persona_id)+'">'+esc(g.persona_name||g.persona_id)+'</option>';}});
  sel.innerHTML=opts; if(cur) sel.value=cur;
}

/* ════════════════════════════════════════════════════════════
   PERSONA TEST — live test the selected persona in-panel
   ════════════════════════════════════════════════════════════ */
var _ptestThread = [];

async function openPersonaTest(){
  if(!selectedPersonaId){ showToast('Select a persona first'); return; }
  if(isDirty){ var ok=await savePersonaQuiet(); if(!ok){ showToast('Save failed — cannot test'); return; } }
  var p=personaData[selectedPersonaId]||{};
  document.getElementById('ptest-name').textContent=p.name||selectedPersonaId;
  _ptestThread=[];
  renderPersonaTestThread();
  document.getElementById('ptest-modal').style.display='flex';
  setTimeout(function(){ document.getElementById('ptest-input').focus(); },100);
}
function closePersonaTest(){ document.getElementById('ptest-modal').style.display='none'; }
function closePersonaTestBg(e){ if(e.target===document.getElementById('ptest-modal')) closePersonaTest(); }
function clearPersonaTest(){ _ptestThread=[]; renderPersonaTestThread(); }

function renderPersonaTestThread(){
  var el=document.getElementById('ptest-thread');
  if(!_ptestThread.length){ el.innerHTML='<div style="color:#2A3A50;font-size:11.5px;text-align:center;padding:30px 0;">Ask a question to see how this persona responds.</div>'; return; }
  el.innerHTML=_ptestThread.map(function(m){
    var isUser=m.role==='user';
    return '<div style="display:flex;justify-content:'+(isUser?'flex-end':'flex-start')+';">'+
      '<div style="max-width:80%;border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.6;white-space:pre-wrap;'+
        (isUser?'background:#0F2040;border:1px solid #1E3A5F;color:#94A3B8;':'background:#0A1628;border:1px solid #0F2040;border-left:3px solid #34D399;color:#CBD5E1;')+'">'+
        esc(m.content)+'</div></div>';
  }).join('');
  el.scrollTop=el.scrollHeight;
}

async function sendPersonaTest(){
  var input=document.getElementById('ptest-input');
  var q=input.value.trim();
  if(!q||!selectedPersonaId) return;
  input.value='';
  _ptestThread.push({role:'user',content:q});
  renderPersonaTestThread();
  var btn=document.getElementById('ptest-send');
  btn.textContent='…'; btn.disabled=true;

  try{
    var res=await adminFetch('/api/personas/'+encodeURIComponent(selectedPersonaId)+'/test',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({messages:_ptestThread.map(function(m){return {role:m.role,content:m.content};})})
    });
    var data=await res.json();
    var text='';
    if(data.content&&Array.isArray(data.content)) text=data.content.filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('\n');
    else if(data.error) text='[error] '+(data.error.message||JSON.stringify(data.error));
    else text='[no response]';
    _ptestThread.push({role:'assistant',content:text});
    renderPersonaTestThread();
  }catch(e){
    _ptestThread.push({role:'assistant',content:'[network error] '+e.message});
    renderPersonaTestThread();
  }
  btn.textContent='Send'; btn.disabled=false;
  input.focus();
}
