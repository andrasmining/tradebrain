(() => {
  "use strict";
  let lastTrigger = null;
  const $ = (root, sel) => root.querySelector(sel);
  const actionLabel = action => ({EA_ON:"EA ON",WATCH:"WATCH",BLOCK_NEW_BASE_ENTRIES:"BLOCK NEW ENTRIES",STRONG_BLOCK_NO_NEW_RISK:"NO NEW RISK",EA_OFF_NO_NEW_RISK:"EA OFF / NO NEW RISK"})[action] || "Unavailable";
  const tailLevel = v => v <= 19 ? "low" : v <= 24 ? "watch" : v <= 34 ? "elevated" : v <= 49 ? "high" : "critical";
  const stressLevel = v => v <= 24 ? "low" : v <= 44 ? "moderate" : v <= 64 ? "elevated" : v <= 79 ? "high" : "extreme";
  const confidenceLevel = v => v <= 39 ? "low" : v <= 59 ? "medium-low" : v <= 74 ? "solid" : v <= 89 ? "high" : "very-high";

  function providerId(){
    return (document.getElementById("timeline-provider")?.textContent || "").toLowerCase().includes("claude") ? "claude" : "chatgpt";
  }
  function fmtRange(ts){
    const start = new Date(ts), end = new Date(start.getTime()+3600000);
    if(!Number.isFinite(start.getTime())) return "—";
    const d = new Intl.DateTimeFormat(undefined,{weekday:"short",month:"short",day:"numeric"});
    const t = new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit"});
    return `${d.format(start)} · ${t.format(start)}–${t.format(end)}`;
  }
  function fmtTime(ts){
    const d = new Date(ts);
    return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit"}).format(d) : "—";
  }
  async function loadStatus(provider){
    const r = await fetch(`./providers/${provider}/status.json?popup=${Date.now()}`,{cache:"no-store",headers:{Accept:"application/json"}});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }
  function ensureDialog(){
    let d = document.getElementById("timeline-hour-dialog");
    if(d) return d;
    d = document.createElement("dialog");
    d.id = "timeline-hour-dialog";
    d.className = "timeline-hour-dialog";
    d.setAttribute("aria-labelledby","timeline-dialog-title");
    d.innerHTML = `<div class="timeline-dialog-shell"><header class="timeline-dialog-head"><div><div id="timeline-dialog-provider" class="timeline-dialog-provider"></div><h2 id="timeline-dialog-title" class="timeline-dialog-title"></h2></div><button class="timeline-dialog-close" type="button" aria-label="Close hour details">×</button></header><div class="timeline-dialog-action-row"><span id="timeline-dialog-status" class="timeline-dialog-status"></span><span id="timeline-dialog-mode" class="timeline-dialog-mode"></span></div><div class="timeline-dialog-metrics"><div class="timeline-dialog-metric"><span>TAIL / KILL</span><strong id="timeline-dialog-tail">—</strong><small id="timeline-dialog-tail-level">—</small></div><div class="timeline-dialog-metric"><span>STRESS / DD</span><strong id="timeline-dialog-stress">—</strong><small id="timeline-dialog-stress-level">—</small></div><div class="timeline-dialog-metric"><span>CONFIDENCE</span><strong id="timeline-dialog-confidence">—</strong><small id="timeline-dialog-confidence-level">—</small></div></div><section class="timeline-dialog-explanation"><div class="timeline-dialog-label">WHY THIS HOUR</div><p id="timeline-dialog-comment"></p><p id="timeline-dialog-note" class="timeline-dialog-note"></p></section><section id="timeline-dialog-events-wrap" class="timeline-dialog-events-wrap" hidden><div class="timeline-dialog-label">EVENTS IN THIS HOUR</div><div id="timeline-dialog-events" class="timeline-dialog-events"></div></section></div>`;
    document.body.append(d);
    $(d,".timeline-dialog-close").addEventListener("click",()=>d.close());
    d.addEventListener("click",e=>{if(e.target===d)d.close()});
    d.addEventListener("close",()=>{lastTrigger?.focus?.({preventScroll:true});lastTrigger=null});
    return d;
  }
  function fallback(item){
    const t=Number(item.tailRiskPct),s=Number(item.stressRiskPct),c=Number(item.confidencePct),m=item.dominantMode||"unknown";
    if(item.action==="EA_ON") return `This hour is forecast as tradable. Tail/Kill risk is ${t}% (${tailLevel(t)}), below the watch threshold. Stress/Deep-DD risk is ${s}% (${stressLevel(s)}). Confidence is ${c}% and the dominant mode is ${m}.`;
    if(item.action==="WATCH") return `This hour is a watch window. Tail/Kill risk is ${t}% (${tailLevel(t)}), high enough for extra caution but still below the block threshold. Stress is ${s}% (${stressLevel(s)}), confidence is ${c}%, and the dominant mode is ${m}.`;
    return `This hour is forecast as ${actionLabel(item.action)}. Tail/Kill risk is ${t}% (${tailLevel(t)}), Stress/Deep-DD risk is ${s}% (${stressLevel(s)}), confidence is ${c}%, and the dominant mode is ${m}.`;
  }
  function eventsInHour(status,item){
    const start=Date.parse(item.ts);
    return !Number.isFinite(start)||!Array.isArray(status.events)?[]:status.events.filter(e=>{const t=Date.parse(e.ts);return Number.isFinite(t)&&t>=start&&t<start+3600000});
  }
  function fill(d,provider,status,item){
    const detail=Array.isArray(status.forecastDetail)?status.forecastDetail.find(x=>x.ts===item.ts):null;
    const events=eventsInHour(status,item);
    $(d,"#timeline-dialog-provider").textContent=`${provider==="claude"?"Claude":"ChatGPT"} forecast`;
    $(d,"#timeline-dialog-title").textContent=fmtRange(item.ts);
    const statusEl=$(d,"#timeline-dialog-status"); statusEl.textContent=actionLabel(item.action); statusEl.className=`timeline-dialog-status ${item.status||"neutral"}`;
    $(d,"#timeline-dialog-mode").textContent=item.dominantMode||"—";
    $(d,"#timeline-dialog-tail").textContent=`${item.tailRiskPct}%`; $(d,"#timeline-dialog-tail-level").textContent=tailLevel(Number(item.tailRiskPct));
    $(d,"#timeline-dialog-stress").textContent=`${item.stressRiskPct}%`; $(d,"#timeline-dialog-stress-level").textContent=stressLevel(Number(item.stressRiskPct));
    $(d,"#timeline-dialog-confidence").textContent=`${item.confidencePct}%`; $(d,"#timeline-dialog-confidence-level").textContent=confidenceLevel(Number(item.confidencePct));
    $(d,"#timeline-dialog-comment").textContent=detail?.comment||fallback(item);
    $(d,"#timeline-dialog-note").textContent=detail?.comment?"Published provider explanation for this forecast hour.":"No dedicated narrative was published for this hour; this summary uses only the provider's published hourly forecast fields.";
    const wrap=$(d,"#timeline-dialog-events-wrap"),host=$(d,"#timeline-dialog-events"); host.replaceChildren(); wrap.hidden=!events.length;
    events.forEach(e=>{const row=document.createElement("div");row.className="timeline-dialog-event";const left=document.createElement("div"),name=document.createElement("strong"),time=document.createElement("span"),impact=document.createElement("span");name.textContent=e.name||"Scheduled event";time.textContent=fmtTime(e.ts);left.append(name,time);impact.className=`timeline-dialog-impact ${e.impact==="high"?"high":"medium"}`;impact.textContent=(e.impact||"medium").toUpperCase();row.append(left,impact);host.append(row)});
  }
  async function open(card){
    if(!card?.dataset?.ts)return;
    lastTrigger=card; card.classList.add("is-loading");
    try{const provider=providerId(),status=await loadStatus(provider),item=status.forecast?.find(x=>x.ts===card.dataset.ts);if(!item)throw new Error("Forecast hour not found");const d=ensureDialog();fill(d,provider,status,item);if(!d.open)d.showModal()}catch(e){console.error(e)}finally{card.classList.remove("is-loading")}
  }
  function decorate(){document.querySelectorAll("#timeline .hour-card").forEach(c=>{c.tabIndex=0;c.setAttribute("role","button");c.setAttribute("aria-haspopup","dialog");c.title="Open hour details"})}
  document.addEventListener("click",e=>{const c=e.target.closest?.("#timeline .hour-card");if(c)open(c)});
  document.addEventListener("keydown",e=>{const c=e.target.closest?.("#timeline .hour-card");if(c&&(e.key==="Enter"||e.key===" ")){e.preventDefault();open(c)}});
  const start=()=>{const t=document.getElementById("timeline");if(!t)return;decorate();new MutationObserver(decorate).observe(t,{childList:true,subtree:true})};
  document.readyState==="loading"?document.addEventListener("DOMContentLoaded",start,{once:true}):start();
})();
