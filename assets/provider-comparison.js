const DEFAULT_STALE_MINUTES=130;
const RISK_STATUSES=new Set(["green","yellow","orange","red"]);

const ACTION_LABELS=Object.freeze({
  EA_ON:"EA ON",
  WATCH:"WATCH",
  BLOCK_NEW_BASE_ENTRIES:"BLOCK NEW ENTRIES",
  STRONG_BLOCK_NO_NEW_RISK:"NO NEW RISK",
  EA_OFF_NO_NEW_RISK:"EA OFF / NO NEW RISK"
});

export const PROVIDER_COMPARISON_ROWS=Object.freeze([
  Object.freeze({id:"action",label:"Current state",field:"action",kind:"action"}),
  Object.freeze({id:"tail",label:"Tail / Kill",field:"tailRiskPct",levelField:"tailLevel",kind:"percentage"}),
  Object.freeze({id:"stress",label:"Stress / DD",field:"stressRiskPct",levelField:"stressLevel",kind:"percentage"}),
  Object.freeze({id:"confidence",label:"Confidence",field:"confidencePct",levelField:"confidenceLevel",kind:"percentage"}),
  Object.freeze({id:"mode",label:"Mode",field:"dominantMode",kind:"text"}),
  Object.freeze({id:"generated",label:"Generated",field:"generatedAt",kind:"time"})
]);

const isObject=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const isPercentage=value=>Number.isFinite(value)&&value>=0&&value<=100;
const actionLabel=action=>ACTION_LABELS[action]||action||"—";
const plural=(count,singular,pluralForm=`${singular}s`)=>count===1?singular:pluralForm;

function providerIdentityClass(id){
  const slug=String(id??"").toLowerCase().replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"");
  return`provider-${slug||"unknown"}`;
}

function publicationFor(states,id){
  if(states instanceof Map)return states.get(id)??null;
  if(Array.isArray(states))return states.find(entry=>entry?.provider?.id===id||entry?.id===id||entry?.provider===id)??null;
  return isObject(states)?states[id]??null:null;
}

function unwrapPublication(publication){
  if(!isObject(publication))return{availability:null,status:null};
  const wrappedStatus=isObject(publication.status)?publication.status:null;
  const directStatus=typeof publication.status==="string"&&typeof publication.action==="string"?publication:null;
  return{
    availability:typeof publication.availability==="string"?publication.availability:null,
    status:wrappedStatus||directStatus
  };
}

function validComparableStatus(status){
  return isObject(status)
    &&typeof status.action==="string"&&status.action.length>0
    &&RISK_STATUSES.has(status.status)
    &&isPercentage(status.tailRiskPct)
    &&isPercentage(status.stressRiskPct)
    &&isPercentage(status.confidencePct)
    &&typeof status.dominantMode==="string"&&status.dominantMode.length>0
    &&Number.isFinite(Date.parse(status.generatedAt));
}

function normalizedAvailability(publication,status,{nowMs,staleMinutes}){
  const explicit=publication?.availability;
  if(explicit==="missing")return"missing";
  if(explicit==="invalid")return"invalid";
  if(!validComparableStatus(status))return"invalid";
  const generatedAt=Date.parse(status.generatedAt);
  const ageMinutes=Math.max(0,(nowMs-generatedAt)/60000);
  if(explicit==="stale"||ageMinutes>staleMinutes)return"stale";
  if(explicit&&explicit!=="fresh")return"invalid";
  return"fresh";
}

function availabilityLabel(availability){
  if(availability==="fresh")return"Fresh";
  if(availability==="stale")return"Stale";
  if(availability==="missing")return"Missing";
  return"Unavailable";
}

function defaultGeneratedLabel(value){
  const timestamp=Date.parse(value);
  if(!Number.isFinite(timestamp))return"—";
  return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(timestamp);
}

function metricRange(providers,field){
  const values=providers.filter(provider=>provider.fresh).map(provider=>provider.current?.[field]).filter(isPercentage);
  if(!values.length)return{providerCount:0,min:null,max:null,spread:null};
  const min=Math.min(...values),max=Math.max(...values);
  return{providerCount:values.length,min,max,spread:max-min};
}

export function summarizeProviderComparison(providers){
  const ordered=Array.isArray(providers)?providers:[];
  const fresh=ordered.filter(provider=>provider?.fresh&&typeof provider.current?.action==="string");
  const groupsByAction=new Map();
  fresh.forEach((provider,index)=>{
    const publishedAction=provider.current.action;
    if(!groupsByAction.has(publishedAction))groupsByAction.set(publishedAction,{publishedAction,label:actionLabel(publishedAction),providerIds:[],providerLabels:[],firstIndex:index});
    const group=groupsByAction.get(publishedAction);
    group.providerIds.push(provider.id);
    group.providerLabels.push(provider.label);
  });
  const actionGroups=[...groupsByAction.values()].map(group=>({...group,count:group.providerIds.length})).sort((a,b)=>b.count-a.count||a.firstIndex-b.firstIndex).map(({firstIndex,...group})=>group);
  const unavailableProviderCount=ordered.length-fresh.length;
  const base={
    totalProviderCount:ordered.length,
    freshProviderCount:fresh.length,
    unavailableProviderCount,
    actionGroupCount:actionGroups.length,
    actionGroups,
    ranges:{
      tail:metricRange(ordered,"tailRiskPct"),
      stress:metricRange(ordered,"stressRiskPct"),
      confidence:metricRange(ordered,"confidencePct")
    }
  };

  if(!fresh.length)return{...base,state:"unavailable",tone:"neutral",text:"No fresh provider assessment available."};
  if(fresh.length===1){
    const only=fresh[0];
    const text=ordered.length===1
      ?`${only.label} is the only enabled fresh provider.`
      :`Comparison: ${only.label} only — ${unavailableProviderCount} ${plural(unavailableProviderCount,"provider")} missing, invalid, or stale.`;
    return{...base,state:"single",tone:"neutral",text};
  }
  if(actionGroups.length===1){
    const subject=fresh.length===2?"both":`all ${fresh.length} fresh providers`;
    return{...base,state:"agreement",tone:"agree",text:`Agreement: ${subject} map to ${actionGroups[0].label}.`};
  }
  if(fresh.length===2){
    const detail=fresh.map(provider=>`${provider.label} ${actionLabel(provider.current.action)}`).join(" · ");
    return{...base,state:"divergence",tone:"diverge",text:`Divergence: ${detail}.`};
  }

  const largest=actionGroups[0],hasStrictMajority=largest.count>fresh.length/2;
  if(hasStrictMajority){
    return{
      ...base,
      state:"divergence",
      tone:"diverge",
      text:`${largest.count}/${fresh.length} fresh providers map to ${largest.label}; ${actionGroups.length} action ${plural(actionGroups.length,"state")} represented.`
    };
  }
  const distribution=actionGroups.map(group=>`${group.count}× ${group.label}`).join(" · ");
  return{...base,state:"dispersion",tone:"diverge",text:`High action dispersion across ${fresh.length} fresh providers: ${distribution}.`};
}

function cellDisplay(row,provider,formatGenerated){
  if(!provider.current){
    if(row.id==="action")return availabilityLabel(provider.availability);
    return"—";
  }
  const value=provider.current[row.field];
  if(row.kind==="action")return actionLabel(value);
  if(row.kind==="percentage"){
    const level=provider.current[row.levelField];
    return`${value}%${typeof level==="string"&&level?` · ${level}`:""}`;
  }
  if(row.kind==="time")return formatGenerated(value);
  return typeof value==="string"&&value?value:"—";
}

export function prepareProviderComparison(manifest,providerStates,{nowMs=Date.now(),staleMinutes=DEFAULT_STALE_MINUTES,formatGenerated=defaultGeneratedLabel}={}){
  const safeNow=Number.isFinite(nowMs)?nowMs:Date.now();
  const safeStaleMinutes=Number.isFinite(staleMinutes)&&staleMinutes>=0?staleMinutes:DEFAULT_STALE_MINUTES;
  const formatter=typeof formatGenerated==="function"?formatGenerated:defaultGeneratedLabel;
  const providers=(Array.isArray(manifest)?manifest:[]).filter(provider=>provider?.enabled===true&&typeof provider.id==="string"&&provider.id).map((provider,index)=>{
    const publication=publicationFor(providerStates,provider.id);
    const unwrapped=unwrapPublication(publication);
    const availability=publication===null||publication===undefined?"missing":normalizedAvailability(unwrapped,unwrapped.status,{nowMs:safeNow,staleMinutes:safeStaleMinutes});
    const current=availability==="missing"||availability==="invalid"?null:{
      action:unwrapped.status.action,
      riskStatus:unwrapped.status.status,
      tailRiskPct:unwrapped.status.tailRiskPct,
      tailLevel:unwrapped.status.tailLevel??null,
      stressRiskPct:unwrapped.status.stressRiskPct,
      stressLevel:unwrapped.status.stressLevel??null,
      confidencePct:unwrapped.status.confidencePct,
      confidenceLevel:unwrapped.status.confidenceLevel??null,
      dominantMode:unwrapped.status.dominantMode,
      generatedAt:unwrapped.status.generatedAt
    };
    return{
      id:provider.id,
      label:typeof provider.label==="string"&&provider.label?provider.label:provider.id,
      order:index,
      identityClass:providerIdentityClass(provider.id),
      availability,
      availabilityLabel:availabilityLabel(availability),
      fresh:availability==="fresh",
      current
    };
  });
  const rows=PROVIDER_COMPARISON_ROWS.map(row=>({
    ...row,
    cells:providers.map(provider=>({
      providerId:provider.id,
      availability:provider.availability,
      fresh:provider.fresh,
      value:provider.current?.[row.field]??null,
      level:row.levelField?provider.current?.[row.levelField]??null:null,
      display:cellDisplay(row,provider,formatter),
      publishedRiskStatus:row.kind==="action"?provider.current?.riskStatus??null:null,
      riskStatus:row.kind==="action"&&provider.fresh?provider.current.riskStatus:"neutral"
    }))
  }));
  return{providers,rows,summary:summarizeProviderComparison(providers)};
}

function element(doc,tag,className,text){
  const node=doc.createElement(tag);
  if(className)node.className=className;
  if(text!==undefined)node.textContent=text;
  return node;
}

export function renderProviderComparison(host,manifest,providerStates,options={}){
  if(!host||typeof host.replaceChildren!=="function")throw new TypeError("A comparison host element is required.");
  const doc=host.ownerDocument??globalThis.document;
  if(!doc||typeof doc.createElement!=="function")throw new TypeError("A document is required to render provider comparison.");
  const model=prepareProviderComparison(manifest,providerStates,options);
  const root=element(doc,"div",`provider-comparison is-${model.summary.state}`);
  root.setAttribute("data-provider-count",String(model.providers.length));
  root.style?.setProperty("--comparison-provider-count",String(Math.max(1,model.providers.length)));

  if(model.providers.length){
    const scroll=element(doc,"div","provider-comparison-scroll");
    scroll.setAttribute("role","region");
    scroll.setAttribute("aria-label","Risk metrics by provider");
    scroll.tabIndex=0;
    const table=element(doc,"table","provider-comparison-table");
    const caption=element(doc,"caption","provider-comparison-caption","Current provider risk comparison");
    const head=element(doc,"thead"),headRow=element(doc,"tr","provider-comparison-header-row");
    const metricHead=element(doc,"th","provider-comparison-metric-heading","Metric");
    metricHead.setAttribute("scope","col");
    headRow.append(metricHead);
    for(const provider of model.providers){
      const cell=element(doc,"th",`provider-comparison-provider ${provider.identityClass} is-${provider.availability}`);
      cell.setAttribute("scope","col");
      cell.setAttribute("data-provider-id",provider.id);
      const identity=element(doc,"span","provider-comparison-provider-identity");
      const accent=element(doc,"span","provider-comparison-provider-accent");
      accent.setAttribute("aria-hidden","true");
      identity.append(accent,element(doc,"span","provider-comparison-provider-name",provider.label));
      const state=element(doc,"span",`provider-comparison-provider-state is-${provider.availability}`,provider.availabilityLabel);
      cell.append(identity,state);
      headRow.append(cell);
    }
    head.append(headRow);
    const body=element(doc,"tbody");
    for(const row of model.rows){
      const tr=element(doc,"tr",`provider-comparison-row metric-${row.id}`);
      tr.setAttribute("data-comparison-row",row.id);
      const label=element(doc,"th","provider-comparison-metric",row.label);
      label.setAttribute("scope","row");
      tr.append(label);
      for(const cell of row.cells){
        const td=element(doc,"td",`provider-comparison-value is-${cell.availability}`);
        td.setAttribute("data-provider-id",cell.providerId);
        td.setAttribute("data-fresh",String(cell.fresh));
        if(row.kind==="action"){
          const risk=element(doc,"span",`provider-comparison-risk risk-${cell.riskStatus}${cell.fresh?"":" is-unavailable"}`,cell.display);
          if(cell.publishedRiskStatus)risk.setAttribute("data-published-risk-status",cell.publishedRiskStatus);
          td.append(risk);
        }else if(row.kind==="time"&&typeof cell.value==="string"){
          const time=element(doc,"time","provider-comparison-time",cell.display);
          time.setAttribute("datetime",cell.value);
          td.append(time);
        }else td.textContent=cell.display;
        tr.append(td);
      }
      body.append(tr);
    }
    table.append(caption,head,body);
    scroll.append(table);
    root.append(scroll);
  }else root.append(element(doc,"div","provider-comparison-empty","No enabled providers are configured."));

  const summary=element(doc,"div",`provider-comparison-summary ${model.summary.tone} is-${model.summary.state}`,model.summary.text);
  summary.setAttribute("role","status");
  root.append(summary);
  host.replaceChildren(root);
  return model;
}
