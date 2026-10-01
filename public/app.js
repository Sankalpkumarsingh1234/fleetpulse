const $=id=>document.getElementById(id);let tok=localStorage.getItem('fp'),cursor=null,hl=null,pts=[];
const api=async(p,o={})=>{const r=await fetch(p,{...o,headers:{'Content-Type':'application/json',Authorization:'Bearer '+tok}});if(r.status===401){logout();throw 0}return r.json()};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const col=r=>r>.9?'var(--bad)':r>.7?'var(--warn)':'var(--ok)';
function logout(){localStorage.removeItem('fp');localStorage.removeItem('fpw');location.reload()}
$('out').onclick=logout;
$('lf').onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',body:JSON.stringify({username:$('u').value,password:$('p').value})}),j=await r.json();
 if(!r.ok){$('err').textContent=j.error;return}tok=j.token;localStorage.setItem('fp',tok);localStorage.setItem('fpw',JSON.stringify([j.role,j.fleet]));start(j.role,j.fleet)};
function start(role,fleet){if(role==='admin')$('erase').hidden=false;$('login').style.display='none';$('who').textContent=role==='admin'?'Admin: all fleets':'Fleet '+fleet+' manager';
 const es=new EventSource('/api/stream?token='+tok);
 es.addEventListener('stats',e=>{const s=JSON.parse(e.data);$('s-v').textContent=s.vehicles.toLocaleString();$('s-eps').textContent=s.eps.toLocaleString();$('s-p95').textContent=Math.round(s.p95_ms);
  $('s-q').textContent=s.backlog.toLocaleString();$('s-d').textContent=s.dups.toLocaleString();$('s-a').textContent=s.alerts.toLocaleString()});
 es.addEventListener('alert',e=>{const a=JSON.parse(e.data),li=document.createElement('li');
  li.innerHTML=`<b>${esc(a.vin)}</b> <span class="pill" style="background:${col(a.risk)}">${Math.round(a.risk*100)}%</span><br><small>${esc(a.reason)}</small>`;
  const l=$('alerts');if(l.firstChild&&l.firstChild.textContent==='No alerts yet.')l.innerHTML='';l.prepend(li);while(l.children.length>50)l.lastChild.remove()});
 loadRisk(true);setInterval(()=>loadRisk(true),4000);model();
 api('/api/alerts?limit=20').then(j=>{if(j.items.length)$('alerts').innerHTML=j.items.map(a=>`<li><b>${esc(a.vin)}</b> <span class="pill" style="background:${col(a.risk)}">${Math.round(a.risk*100)}%</span><br><small>${esc(a.reason)}</small></li>`).join('')})}
async function loadRisk(reset){const j=await api('/api/at-risk?limit=15'+(reset||!cursor?'':'&cursor='+cursor));if(reset){cursor=null;pts=[]}
 if(!j.items.length&&reset){$('rows').innerHTML='<tr><td colspan="4">No vehicle is above 50% risk yet. Give the simulator a few seconds.</td></tr>';return}
 const h=j.items.map(v=>`<tr data-v="${v.vin}"><td>${v.vin}</td><td><span class="pill" style="background:${col(v.risk)}">${Math.round(v.risk*100)}%</span></td><td>${v.temp_c}&deg;C</td><td>${v.soc_pct}%</td></tr>`).join('');
 if(reset||!cursor)$('rows').innerHTML=h;else $('rows').insertAdjacentHTML('beforeend',h);cursor=j.cursor;pts=pts.concat(j.items);draw()}
$('more').onclick=async()=>{if(!cursor)return;const j=await api('/api/at-risk?limit=15&cursor='+cursor);$('rows').insertAdjacentHTML('beforeend',j.items.map(v=>`<tr data-v="${v.vin}"><td>${v.vin}</td><td><span class="pill" style="background:${col(v.risk)}">${Math.round(v.risk*100)}%</span></td><td>${v.temp_c}&deg;C</td><td>${v.soc_pct}%</td></tr>`).join(''));cursor=j.cursor;pts=pts.concat(j.items);draw()};
$('rows').onclick=e=>{const t=e.target.closest('tr[data-v]');if(t){hl=t.dataset.v;draw();showDetail(hl)}};
function draw(){const c=$('map'),r=c.getBoundingClientRect(),d=devicePixelRatio||1;c.width=r.width*d;c.height=r.height*d;const x=c.getContext('2d');x.scale(d,d);
 const px=v=>[(v.lon-79.5)/1.5*r.width,r.height-(v.lat-12.5)/1.5*r.height];x.strokeStyle=getComputedStyle(document.body).getPropertyValue('--line');
 for(let i=1;i<6;i++){x.beginPath();x.moveTo(i*r.width/6,0);x.lineTo(i*r.width/6,r.height);x.moveTo(0,i*r.height/6);x.lineTo(r.width,i*r.height/6);x.stroke()}
 for(const v of pts){const[a,b]=px(v);x.fillStyle=getComputedStyle(document.body).getPropertyValue(v.risk>.9?'--bad':v.risk>.7?'--warn':'--ok');x.beginPath();x.arc(a,b,v.vin===hl?9:5,0,7);x.fill();if(v.vin===hl){x.strokeStyle='#000';x.stroke();x.fillText(v.vin,a+11,b+4)}}}
async function model(){const m=await api('/api/model'),f=o=>`<td>${o.precision}</td><td>${o.recall}</td><td>${o.f1}</td>`;
 $('mt').innerHTML=`<tr><td>Rule: ${esc(m.baseline_rule)}</td>${f(m.baseline)}</tr><tr><td><b>Logistic model</b></td>${f(m.logistic)}</tr>`;$('mn').textContent=`Tested on ${m.holdout} held-out simulated vehicles.`}
$('cf').onsubmit=async e=>{e.preventDefault();const q=$('qi').value.trim();if(!q)return;$('qi').value='';const c=$('chat');c.insertAdjacentHTML('beforeend',`<p><b>You:</b> ${esc(q)}</p>`);
 const j=await api('/api/copilot',{method:'POST',body:JSON.stringify({q})});c.insertAdjacentHTML('beforeend',`<p><b>Copilot:</b> ${esc(j.answer)}</p>`);c.scrollTop=1e9};
addEventListener('resize',draw);
if(tok)api('/api/stats').then(()=>{const w=JSON.parse(localStorage.getItem('fpw')||'["user",""]');start(w[0],w[1])}).catch(()=>{});
async function showDetail(vin){const[v,s,h]=await Promise.all([api('/api/vehicle/'+vin),api('/api/vehicle/'+vin+'/similar'),api('/api/vehicle/'+vin+'/history')]);
 $('detail').hidden=false;$('dt').textContent='Vehicle '+vin;const c=s.cases[0];
 $('db').innerHTML=`<p><b>Suggested action:</b> ${esc(c.action)}<br><small>Closest past case: ${esc(c.title)} (${Math.round(c.similarity*100)}% match)</small></p>
 <p>Risk ${Math.round(v.risk*100)}% &middot; engine ${v.temp_c}&deg;C &middot; battery ${v.soc_pct}% &middot; ${v.dtc_count} fault codes &middot; ${v.harsh_brakes} harsh brakes</p>
 <p><b>Similar vehicles:</b> ${s.similar_vehicles.map(x=>esc(x.vin)+' ('+Math.round(x.similarity*100)+'%)').join(', ')||'none yet'}</p>
 <p><b>Recent stored events:</b> ${h.events.length?h.events.slice(0,5).map(e=>esc(e.evt!=='NONE'?e.evt:(e.dtc[0]||'sample'))+' at '+new Date(e.ts).toLocaleTimeString()).join('; '):'none stored yet'}</p>`;$('detail').scrollIntoView({behavior:'smooth'})}
$('ba').onclick=async()=>{const j=await api('/api/analytics/batch'),a=j.analytics,s=j.storage;
 $('bo').innerHTML=`<p>${a.events_scanned.toLocaleString()} stored events scanned in ${a.scan_ms} ms across ${a.files_scanned} files. Average engine temperature ${a.avg_temp_c}&deg;C.</p>
 <p><b>Top fault codes:</b> ${a.top_fault_codes.map(x=>esc(x[0])+' ('+x[1]+')').join(', ')||'none'}<br><b>Harsh brakes by fleet:</b> ${a.harsh_brakes_by_fleet.map(x=>'Fleet '+esc(x[0])+' ('+x[1]+')').join(', ')||'none'}</p>
 <p><small>Warm tier ${(s.warm_bytes/1024).toFixed(0)} KB in ${s.warm_files} files &middot; cold tier ${(s.cold_bytes/1024).toFixed(0)} KB in ${s.cold_files} compressed files</small></p>`};
$('eb').onclick=async()=>{const vin=$('ev').value.trim().toUpperCase();if(!vin||!confirm('Permanently erase telemetry, alerts and driver link for '+vin+'?'))return;
 const r=await fetch('/api/erasure',{method:'POST',headers:{Authorization:'Bearer '+tok},body:JSON.stringify({vin})}),j=await r.json();$('em').textContent=r.ok?`Erased ${vin}: ${j.alerts_removed} alerts removed, ${j.files_rewritten} storage files rewritten.`:j.error};
