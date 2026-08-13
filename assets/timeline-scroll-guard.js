(() => {
  const nativeScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function scrollIntoView(options) {
    const timeline = this.closest?.("#timeline");
    if (timeline && this.classList?.contains("hour-card")) {
      const targetLeft = this.offsetLeft - (timeline.clientWidth - this.clientWidth) / 2;
      timeline.scrollTo({ left: Math.max(0, targetLeft), behavior: options && typeof options === "object" ? options.behavior || "auto" : "auto" });
      return;
    }
    return nativeScrollIntoView.call(this, options);
  };

  const actionLabel = action => ({EA_ON:"EA ON",WATCH:"WATCH",BLOCK_NEW_BASE_ENTRIES:"BLOCK NEW ENTRIES",STRONG_BLOCK_NO_NEW_RISK:"NO NEW RISK",EA_OFF_NO_NEW_RISK:"EA OFF / NO NEW RISK"})[action] || "Unavailable";
  const tailLevel = v => v <= 19 ? "low" : v <= 24 ? "watch" : v <= 34 ? "elevated" : v <= 49 ? "high" : "critical";
  const stressLevel = v => v <= 24 ? "low" : v <= 44 ? "moderate" : v <= 64 ? "elevated" : v <= 79 ? "high" : "extreme";
  const confidenceLevel = v => v <= 39 ? "low" : v <= 59 ? "medium-low" : v <= 74 ? "solid" : v <= 89 ? "high" : "very-high";
  let lastTrigger = null;

  const providerId = () => (document.getElementById("timeline-provider")?.textContent || "").toLowerCase().includes("claude") ? "claude" : "chatgpt";
  const fmtRange = ts => {
    const start = new Date(ts), end = new Date(start.getTime() + 3600000);
    if (!Number.isFinite(start.getTime())) return "—";
    const d = new Intl.DateTimeFormat(undefined,{weekday:"short",month:"short",day:"numeric"});
    const t = new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit"});
    return `${d.format(start)} · ${t.format(start)}–${t.format(end)}`;
  };
  const fmtTime = ts => {
    const d = new Date(ts);
    return Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(undefined,{hour:"2-digit",minute:"2-digit"}).format(d) : "—";
  };

  const css = `
    .hour-card{cursor:pointer}.hour-card:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.hour-card.is-loading{opacity:.62}
    .timeline-hour-dialog{width:min(520px,calc(100vw - 24px));max-height:min(82vh,720px);padding:0;border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,#111823,#0c1118);color:var(--text);box-shadow:0 28px 80px rgba(0,0,0,.55);overflow:auto}
    .timeline-hour-dialog::backdrop{background:rgba(3,6,10,.78);backdrop-filter:blur(6px)}.timeline-dialog-shell{padding:18px}.timeline-dialog-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.timeline-dialog-provider,.timeline-dialog-label{font:600 .64rem/1 var(--mono);letter-spacing:.13em;color:var(--muted);text-transform:uppercase}.timeline-dialog-title{margin:7px 0 0;font-size:1.28rem}.timeline-dialog-close{width:40px;height:40px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2);color:var(--text);font-size:1.6rem;line-height:1;cursor:pointer}
    .timeline-dialog-action-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:16px 0 12px}.timeline-dialog-status,.timeline-dialog-mode{display:inline-flex;align-items:center;min-height:30px;padding:0 10px;border:1px solid var(--line);border-radius:999px;font:600 .68rem var(--mono)}.timeline-dialog-status.green{color:#9ce0b9;border-color:rgba(83,213,138,.35);background:rgba(83,213,138,.07)}.timeline-dialog-status.yellow{color:#f6d985;border-color:rgba(241,199,91,.35);background:rgba(241,199,91,.07)}.timeline-dialog-status.orange{color:#f7b77e;border-color:rgba(239,145,62,.35);background:rgba(239,145,62,.07)}.timeline-dialog-status.red{color:#ffadad;border-color:rgba(240,103,103,.35);background:rgba(240,103,103,.07)}.timeline-dialog-mode{color:var(--muted)}
    .timeline-dialog-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.timeline-dialog-metric{padding:12px 10px;border:1px solid var(--line);border-radius:12px;background:#0b1017}.timeline-dialog-metric>span{display:block;color:var(--muted);font:500 .6rem var(--mono)}.timeline-dialog-metric strong{display:block;margin:7px 0 3px;font:700 1.45rem/1 var(--mono)}.timeline-dialog-metric small{color:var(--muted);font:500 .61rem var(--mono)}
    .timeline-dialog-explanation,.timeline-dialog-events-wrap{margin-top:14px;padding:14px;border:1px solid var(--line);border-radius:13px;background:#0b1017}.timeline-dialog-explanation p{margin:9px 0 0;line-height:1.52;font-size:.9rem}.timeline-dialog-note{color:var(--muted);font-size:.72rem!important}.timeline-dialog-events{display:grid;gap:8px;margin-top:9px}.timeline-dialog-event{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:10px;background:#0f151e}.timeline-dialog-event strong,.timeline-dialog-event span{display:block}.timeline-dialog-event strong{font-size:.82rem}.timeline-dialog-event div>span{margin-top:3px;color:var(--muted);font:500 .66rem var(--mono)}.timeline-dialog-impact{align-self:center;padding:5px 7px;border:1px solid var(--line);border-radius:999px;font:600 .59rem var(--mono)}.timeline-dialog-impact.high{color:#ffb2b2;border-color:rgba(240,103,103,.35)}.timeline-dialog-impact.medium{color:#f1d98b;border-color:rgba(241,199,91,.28)}
    @media(max-width:560px){.timeline-hour-dialog{width:calc(100vw - 16px);max-height:calc(100dvh - 24px);border-radius:16px}.timeline-dialog-shell{padding:14px}.timeline-dialog-title{font-size:1.12rem}.timeline-dialog-metrics{gap:6px}.timeline-dialog-metric{padding:10px 7px}.timeline-dialog-metric strong{font-size:1.28rem}.timeline-dialog-metric>span{font-size:.54rem}.timeline-dialog-explanation,.timeline-dialog-events-wrap{padding:12px}}
  `;
  const style = document.createElement("style"); style.textContent = css; document.head.append(style);

  function dialog(){
    let d = document.getElementById("timeline-hour-dialog");
    if(d) return d;
    d = document.createElement("dialog"); d.id="timeline-hour-dialog"; d.className="timeline-hour-dialog";
    d.innerHTML=`<div class="timeline-dialog-shell"><header class="timeline-dialog-head"><div><div id="td-provider" class="timeline-dialog-provider"></div><h2 id="td-title" class="timeline-dialog-title"></h2></div><button class="timeline-dialog-close" type="button" aria-label="Close">×</button></header><div class="timeline-dialog-action-row"><span id="td-status" class="timeline-dialog-status"></span><span id="td-mode" class="timeline-dialog-mode"></span></div><div class="timeline-dialog-metrics"><div class="timeline-dialog-metric"><span>TAIL / KILL</span><strong id="td-tail">—</strong><small id="td-tail-l">—</small></div><div class="timeline-dialog-metric"><span>STRESS / DD</span><strong id="td-stress">—</strong><small id="td-stress-l">—</small></div><div class="timeline-dialog-metric"><span>CONFIDENCE</span><strong id="td-conf">—</strong><small id="td-conf-l">—</small></div></div><section class="timeline-dialog-explanation"><div class="timeline-dialog-label">WHY THIS HOUR</div><p id="td-comment"></p><p id="td-note" class="timeline-dialog-note"></p></section><section id="td-events-wrap" class="timeline-dialog-events-wrap" hidden><div class="timeline-dialog-label">EVENTS IN THIS HOUR</div><div id="td-events" class="timeline-dialog-events"></div></section></div>`;
    document.body.append(d); d.querySelector(".timeline-dialog-close").onclick=()=>d.close(); d.onclick=e=>{if(e.target===d)d.close()}; d.addEventListener("close",()=>{lastTrigger?.focus?.({preventScroll:true});lastTrigger=null}); return d;
  }
  function fallback(i){const t=+i.tailRiskPct,s=+i.stressRiskPct,c=+i.confidencePct,m=i.dominantMode||"unknown";if(i.action==="EA_ON")return`This hour is forecast as tradable. Tail/Kill risk is ${t}% (${tailLevel(t)}), below the watch threshold. Stress/Deep-DD risk is ${s}% (${stressLevel(s)}). Confidence is ${c}% and the dominant mode is ${m}.`;if(i.action==="WATCH")return`This hour is a watch window. Tail/Kill risk is ${t}% (${tailLevel(t)}), high enough for extra caution but still below the block threshold. Stress is ${s}% (${stressLevel(s)}), confidence is ${c}%, and the dominant mode is ${m}.`;return`This hour is forecast as ${actionLabel(i.action)}. Tail/Kill risk is ${t}% (${tailLevel(t)}), Stress is ${s}% (${stressLevel(s)}), confidence is ${c}%, and the dominant mode is ${m}.`}
  async function open(card){
    if(!card?.dataset?.ts)return; lastTrigger=card; card.classList.add("is-loading");
    try{const p=providerId(),r=await fetch(`./providers/${p}/status.json?popup=${Date.now()}`,{cache:"no-store"});if(!r.ok)throw new Error("Provider data unavailable");const s=await r.json(),i=s.forecast?.find(x=>x.ts===card.dataset.ts);if(!i)throw new Error("Forecast hour unavailable");const d=dialog(),q=id=>d.querySelector(id),detail=s.forecastDetail?.find(x=>x.ts===i.ts),start=Date.parse(i.ts),events=(s.events||[]).filter(e=>{const t=Date.parse(e.ts);return Number.isFinite(t)&&t>=start&&t<start+3600000});q("#td-provider").textContent=`${p==="claude"?"Claude":"ChatGPT"} forecast`;q("#td-title").textContent=fmtRange(i.ts);q("#td-status").textContent=actionLabel(i.action);q("#td-status").className=`timeline-dialog-status ${i.status||"neutral"}`;q("#td-mode").textContent=i.dominantMode||"—";q("#td-tail").textContent=`${i.tailRiskPct}%`;q("#td-tail-l").textContent=tailLevel(+i.tailRiskPct);q("#td-stress").textContent=`${i.stressRiskPct}%`;q("#td-stress-l").textContent=stressLevel(+i.stressRiskPct);q("#td-conf").textContent=`${i.confidencePct}%`;q("#td-conf-l").textContent=confidenceLevel(+i.confidencePct);q("#td-comment").textContent=detail?.comment||fallback(i);q("#td-note").textContent=detail?.comment?"Published provider explanation for this forecast hour.":"No dedicated narrative was published for this hour; this summary uses only the published hourly forecast fields.";const wrap=q("#td-events-wrap"),host=q("#td-events");host.replaceChildren();wrap.hidden=!events.length;events.forEach(e=>{const row=document.createElement("div");row.className="timeline-dialog-event";const left=document.createElement("div"),name=document.createElement("strong"),time=document.createElement("span"),impact=document.createElement("span");name.textContent=e.name||"Scheduled event";time.textContent=fmtTime(e.ts);left.append(name,time);impact.className=`timeline-dialog-impact ${e.impact==="high"?"high":"medium"}`;impact.textContent=(e.impact||"medium").toUpperCase();row.append(left,impact);host.append(row)});if(!d.open)d.showModal()}catch(e){console.error(e)}finally{card.classList.remove("is-loading")}
  }
  function decorate(){document.querySelectorAll("#timeline .hour-card").forEach(c=>{c.tabIndex=0;c.setAttribute("role","button");c.setAttribute("aria-haspopup","dialog");c.title="Open hour details"})}
  document.addEventListener("click",e=>{const c=e.target.closest?.("#timeline .hour-card");if(c)open(c)});document.addEventListener("keydown",e=>{const c=e.target.closest?.("#timeline .hour-card");if(c&&(e.key==="Enter"||e.key===" ")){e.preventDefault();open(c)}});
  const start=()=>{const t=document.getElementById("timeline");if(!t)return;decorate();new MutationObserver(decorate).observe(t,{childList:true,subtree:true})};document.readyState==="loading"?document.addEventListener("DOMContentLoaded",start,{once:true}):start();
})();
