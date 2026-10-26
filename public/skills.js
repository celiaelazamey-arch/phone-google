/* سيليا — Find Skills. ملف خارجي متوافق مع سياسة CSP: script-src 'self'. */
let currentCat='all';
const elQ=document.getElementById('q'), elGrid=document.getElementById('grid'), elRaw=document.getElementById('raw');
async function callFind(query, category){
  const body={jsonrpc:'2.0',id:Date.now(),method:'tools/call',params:{name:'find_skills',arguments:{query, category, liveCheck:true}}};
  const r=await fetch('./ui/workspace/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  return j;
}
function render(j){
  const out=j.result?.structuredContent||j; elRaw.textContent=JSON.stringify(out,null,2);
  document.getElementById('count').textContent=(out.matched||0)+' / '+(out.totalSkills||0);
  document.getElementById('s-storage').textContent='التخزين: '+(out.liveStatus?.storage||'—');
  document.getElementById('s-provider').textContent='المحرك: '+(out.liveStatus?.providers?.effectiveDefault||'—');
  document.getElementById('s-tools').textContent='الأدوات: '+(out.liveStatus?.toolsCount||out.totalSkills||'—');
  elGrid.innerHTML=(out.skills||[]).map(s=>`
    <div class="skill-card">
      <h4>${s.name}</h4>
      <div class="meta">${s.description}</div>
      <div style="margin:6px 0"><span class="chip" style="font-size:.7rem">${(s.tags||[]).join(' · ')||'عام'}</span></div>
      <div class="code">${s.invocation}</div>
      <details style="margin-top:6px"><summary style="cursor:pointer;font-size:.82rem">inputSchema</summary><pre class="code" style="margin-top:6px">${JSON.stringify(s.inputSchema,null,2)}</pre></details>
      <div style="margin-top:8px;display:flex;gap:6px"><button class="chip" data-copy-skill="${s.name}">نسخ اسم المهارة</button><button class="chip" data-try-skill="${s.name}">تجربة عبر الاستوديو →</button></div>
    </div>
  `).join('') || '<div class="meta">لا نتائج — جرّب كلمة أخرى.</div>';
}
async function doFind(){
  elRaw.textContent='جارٍ البحث حيًا...';
  try{ const j=await callFind(elQ.value.trim(), currentCat); render(j);}catch(e){ elRaw.textContent=e.message;}
}
document.getElementById('btn-find').onclick=doFind;
document.getElementById('btn-all').onclick=()=>{ elQ.value=''; currentCat='all'; document.querySelectorAll('.chip[data-cat]').forEach(c=>c.classList.toggle('active', c.dataset.cat==='all')); doFind(); };
document.querySelectorAll('.chip[data-cat]').forEach(c=> c.onclick=()=>{ currentCat=c.dataset.cat; document.querySelectorAll('.chip[data-cat]').forEach(x=>x.classList.remove('active')); c.classList.add('active'); doFind(); });
elQ.addEventListener('keydown', e=>{ if(e.key==='Enter') doFind(); });
function quick(q){ elQ.value=q; doFind(); }
document.querySelectorAll('[data-quick]').forEach((btn)=>{ btn.addEventListener('click', ()=> quick(btn.dataset.quick)); });
elGrid.addEventListener('click', (event)=>{
  const copyBtn = event.target.closest('[data-copy-skill]');
  if (copyBtn) { navigator.clipboard.writeText(copyBtn.dataset.copySkill).then(()=> alert('تم نسخ: '+copyBtn.dataset.copySkill)); return; }
  const tryBtn = event.target.closest('[data-try-skill]');
  if (tryBtn) location.href='./#tool='+encodeURIComponent(tryBtn.dataset.trySkill);
});
// init
doFind();
