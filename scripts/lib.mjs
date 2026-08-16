import fs from "node:fs";
import path from "node:path";

export function tailLevel(n) { if (n <= 19) return "low"; if (n <= 24) return "watch"; if (n <= 34) return "elevated"; if (n <= 49) return "high"; return "critical"; }
export function stressLevel(n) { if (n <= 24) return "low"; if (n <= 44) return "moderate"; if (n <= 64) return "elevated"; if (n <= 79) return "high"; return "extreme"; }
export function confidenceLevel(n) { if (n <= 39) return "low"; if (n <= 59) return "medium-low"; if (n <= 74) return "solid"; if (n <= 89) return "high"; return "very-high"; }
export function actionForTail(n) { if (n <= 19) return "EA_ON"; if (n <= 24) return "WATCH"; if (n <= 34) return "BLOCK_NEW_BASE_ENTRIES"; if (n <= 49) return "STRONG_BLOCK_NO_NEW_RISK"; return "EA_OFF_NO_NEW_RISK"; }
export function statusForAction(action) { if (action === "EA_ON") return "green"; if (action === "WATCH") return "yellow"; if (action === "BLOCK_NEW_BASE_ENTRIES") return "orange"; if (action === "STRONG_BLOCK_NO_NEW_RISK" || action === "EA_OFF_NO_NEW_RISK") return "red"; return null; }
export function pauseForAction(action) { return action === "STRONG_BLOCK_NO_NEW_RISK" || action === "EA_OFF_NO_NEW_RISK"; }
export function cautionForAction(action) { return action === "WATCH" || action === "BLOCK_NEW_BASE_ENTRIES"; }
export function isScore(n) { return Number.isInteger(n) && n >= 0 && n <= 100; }
export function isDateTime(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
export function isHttpUrl(value) { try { const u = new URL(value); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; } }
function exactInstruments(value) { return Array.isArray(value) && value.length === 2 && value[0] === "NQ_FUTURES" && value[1] === "NAS100_CFD"; }
function assert(errors, condition, message) { if (!condition) errors.push(message); }
function validateScoreSet(errors, obj, prefix = "") { assert(errors, isScore(obj.tailRiskPct), `${prefix}tailRiskPct must be an integer 0-100`); assert(errors, isScore(obj.stressRiskPct), `${prefix}stressRiskPct must be an integer 0-100`); assert(errors, isScore(obj.confidencePct), `${prefix}confidencePct must be an integer 0-100`); }
function validateWindow(errors, window, prefix) { assert(errors, window && typeof window === "object", `${prefix} must be an object`); if (!window || typeof window !== "object") return; const { start, end } = window; assert(errors, start === null || isDateTime(start), `${prefix}.start must be null or ISO date-time`); assert(errors, end === null || isDateTime(end), `${prefix}.end must be null or ISO date-time`); assert(errors, (start === null) === (end === null), `${prefix} must have both endpoints or neither`); if (start !== null && end !== null && isDateTime(start) && isDateTime(end)) assert(errors, Date.parse(start) <= Date.parse(end), `${prefix}.start must be <= end`); }

export function validateStatus(data, expectedProvider) {
  const errors = [];
  assert(errors, data && typeof data === "object" && !Array.isArray(data), "status must be an object");
  if (!data || typeof data !== "object" || Array.isArray(data)) return errors;
  assert(errors, data.schemaVersion === "1.0.0", "schemaVersion must be 1.0.0");
  assert(errors, data.provider === expectedProvider, `provider must be ${expectedProvider}`);
  assert(errors, data.market === "NASDAQ-100", "market must be NASDAQ-100");
  assert(errors, exactInstruments(data.instruments), "instruments must be exactly [NQ_FUTURES, NAS100_CFD]");
  assert(errors, isDateTime(data.generatedAt), "generatedAt must be a valid date-time");
  assert(errors, typeof data.engineVersion === "string" && data.engineVersion.length > 0, "engineVersion required");
  assert(errors, typeof data.promptVersion === "string" && data.promptVersion.length > 0, "promptVersion required");
  validateScoreSet(errors, data);
  if (isScore(data.tailRiskPct)) { const expectedAction = actionForTail(data.tailRiskPct); assert(errors, data.tailLevel === tailLevel(data.tailRiskPct), "tailLevel does not match tailRiskPct"); assert(errors, data.action === expectedAction, `action must be ${expectedAction} for Tail ${data.tailRiskPct}`); assert(errors, data.status === statusForAction(expectedAction), "status does not match action"); }
  if (isScore(data.stressRiskPct)) assert(errors, data.stressLevel === stressLevel(data.stressRiskPct), "stressLevel does not match stressRiskPct");
  if (isScore(data.confidencePct)) assert(errors, data.confidenceLevel === confidenceLevel(data.confidencePct), "confidenceLevel does not match confidencePct");
  assert(errors, ["trend-up","trend-down","event/whipsaw","mixed","normal"].includes(data.dominantMode), "invalid dominantMode");
  validateWindow(errors, data.dangerWindow, "dangerWindow"); validateWindow(errors, data.dangerWindowBerlin, "dangerWindowBerlin");
  if (data.dangerWindow?.start && data.dangerWindowBerlin?.start) { assert(errors, Date.parse(data.dangerWindow.start) === Date.parse(data.dangerWindowBerlin.start), "dangerWindow and dangerWindowBerlin start must represent same instant"); assert(errors, Date.parse(data.dangerWindow.end) === Date.parse(data.dangerWindowBerlin.end), "dangerWindow and dangerWindowBerlin end must represent same instant"); }
  assert(errors, Array.isArray(data.sources) && data.sources.length >= 1, "sources must contain at least one source");
  if (Array.isArray(data.sources)) data.sources.forEach((s,i) => { assert(errors, s && typeof s.title === "string" && s.title.length > 0, `sources[${i}].title required`); assert(errors, s && isHttpUrl(s.url), `sources[${i}].url must be http/https`); });
  assert(errors, Array.isArray(data.lookback) && data.lookback.length === 24, "lookback must contain exactly 24 entries");
  if (Array.isArray(data.lookback) && data.lookback.length === 24) for (let i=0;i<data.lookback.length;i++) { const item=data.lookback[i]; assert(errors,isDateTime(item.ts),`lookback[${i}].ts invalid`); assert(errors,isDateTime(item.timeBerlin),`lookback[${i}].timeBerlin invalid`); assert(errors,typeof item.available === "boolean",`lookback[${i}].available must be boolean`); if(i>0 && isDateTime(item.ts)&&isDateTime(data.lookback[i-1].ts)) assert(errors,Date.parse(item.ts)-Date.parse(data.lookback[i-1].ts)===3600000,`lookback[${i}] must be exactly one hour after previous`); if(item.available){ validateScoreSet(errors,item,`lookback[${i}].`); if(isScore(item.tailRiskPct)){ assert(errors,item.action===actionForTail(item.tailRiskPct),`lookback[${i}].action mismatch`); assert(errors,item.status===statusForAction(item.action),`lookback[${i}].status mismatch`); }} else for(const key of ["status","action","tailRiskPct","stressRiskPct","confidencePct","dominantMode"]) assert(errors,item[key]===null,`lookback[${i}].${key} must be null when unavailable`); }
  assert(errors, Array.isArray(data.forecast) && data.forecast.length === 24, "forecast must contain exactly 24 entries");
  if (Array.isArray(data.forecast) && data.forecast.length === 24) for(let i=0;i<data.forecast.length;i++){ const item=data.forecast[i]; assert(errors,isDateTime(item.ts),`forecast[${i}].ts invalid`); assert(errors,isDateTime(item.timeBerlin),`forecast[${i}].timeBerlin invalid`); validateScoreSet(errors,item,`forecast[${i}].`); if(i>0 && isDateTime(item.ts)&&isDateTime(data.forecast[i-1].ts)) assert(errors,Date.parse(item.ts)-Date.parse(data.forecast[i-1].ts)===3600000,`forecast[${i}] must be exactly one hour after previous`); if(isScore(item.tailRiskPct)){ const a=actionForTail(item.tailRiskPct); assert(errors,item.action===a,`forecast[${i}].action mismatch`); assert(errors,item.status===statusForAction(a),`forecast[${i}].status mismatch`); } assert(errors,["trend-up","trend-down","event/whipsaw","mixed","normal"].includes(item.dominantMode),`forecast[${i}].dominantMode invalid`); }
  assert(errors, Array.isArray(data.forecastDetail) && data.forecastDetail.length === 6, "forecastDetail must contain exactly 6 entries");
  if(Array.isArray(data.forecastDetail)&&data.forecastDetail.length===6&&Array.isArray(data.forecast)&&data.forecast.length>=6) for(let i=0;i<6;i++){ const detail=data.forecastDetail[i], forecast=data.forecast[i]; assert(errors,detail.ts===forecast.ts,`forecastDetail[${i}].ts must match forecast[${i}]`); assert(errors,detail.timeBerlin===forecast.timeBerlin,`forecastDetail[${i}].timeBerlin must match forecast[${i}]`); assert(errors,detail.status===forecast.status,`forecastDetail[${i}].status must match forecast[${i}]`); assert(errors,detail.tailRiskPct===forecast.tailRiskPct,`forecastDetail[${i}].tailRiskPct must match forecast[${i}]`); assert(errors,detail.stressRiskPct===forecast.stressRiskPct,`forecastDetail[${i}].stressRiskPct must match forecast[${i}]`); assert(errors,typeof detail.comment==="string"&&detail.comment.length>0,`forecastDetail[${i}].comment required`); }
  assert(errors,Array.isArray(data.events),"events must be an array");
  if(Array.isArray(data.events)) data.events.forEach((e,i)=>{ assert(errors,typeof e.name==="string"&&e.name.length>0,`events[${i}].name required`); assert(errors,isDateTime(e.ts),`events[${i}].ts invalid`); assert(errors,isDateTime(e.timeBerlin),`events[${i}].timeBerlin invalid`); assert(errors,["high","medium"].includes(e.impact),`events[${i}].impact invalid`); if(isDateTime(e.ts)&&isDateTime(e.timeBerlin)) assert(errors,Date.parse(e.ts)===Date.parse(e.timeBerlin),`events[${i}] UTC/Berlin timestamps differ`); });
  return errors;
}

const SIGNAL_OVERLAP=["schemaVersion","provider","engineVersion","promptVersion","generatedAt","market","instruments","status","action","tailRiskPct","tailLevel","stressRiskPct","stressLevel","confidencePct","confidenceLevel","dominantMode","dangerWindow","dangerWindowBerlin"];
export function validateSignal(signal,status,expectedProvider){ const errors=[]; assert(errors,signal&&typeof signal==="object"&&!Array.isArray(signal),"signal must be an object"); if(!signal||typeof signal!=="object"||Array.isArray(signal)) return errors; assert(errors,signal.provider===expectedProvider,`signal provider must be ${expectedProvider}`); validateScoreSet(errors,signal,"signal."); if(isScore(signal.tailRiskPct)){ assert(errors,signal.tailLevel===tailLevel(signal.tailRiskPct),"signal tailLevel mismatch"); assert(errors,signal.action===actionForTail(signal.tailRiskPct),"signal action mismatch"); assert(errors,signal.status===statusForAction(signal.action),"signal status mismatch"); } if(isScore(signal.stressRiskPct)) assert(errors,signal.stressLevel===stressLevel(signal.stressRiskPct),"signal stressLevel mismatch"); if(isScore(signal.confidencePct)) assert(errors,signal.confidenceLevel===confidenceLevel(signal.confidencePct),"signal confidenceLevel mismatch"); assert(errors,signal.pause===pauseForAction(signal.action),"signal pause mismatch"); assert(errors,signal.caution===cautionForAction(signal.action),"signal caution mismatch"); validateWindow(errors,signal.dangerWindow,"signal.dangerWindow"); validateWindow(errors,signal.dangerWindowBerlin,"signal.dangerWindowBerlin"); if(status) for(const key of SIGNAL_OVERLAP) assert(errors,JSON.stringify(signal[key])===JSON.stringify(status[key]),`signal.${key} must match status`); return errors; }

export function validateHistory(history,expectedProvider,repoRoot=null){ const errors=[]; assert(errors,history&&typeof history==="object"&&!Array.isArray(history),"history must be an object"); if(!history||typeof history!=="object"||Array.isArray(history)) return errors; assert(errors,history.schemaVersion==="1.0.0","history schemaVersion must be 1.0.0"); assert(errors,history.provider===expectedProvider,`history provider must be ${expectedProvider}`); assert(errors,history.retentionPolicy==="unlimited","history retentionPolicy must be unlimited"); assert(errors,Array.isArray(history.items),"history.items must be an array"); if(!Array.isArray(history.items)) return errors; const generated=new Set(), snapshots=new Set(); let previous=-Infinity; history.items.forEach((item,i)=>{ assert(errors,isDateTime(item.generatedAt),`history.items[${i}].generatedAt invalid`); if(isDateTime(item.generatedAt)){ const time=Date.parse(item.generatedAt); assert(errors,time>=previous,`history.items[${i}] is not chronological`); previous=time; } assert(errors,!generated.has(item.generatedAt),`duplicate history generatedAt ${item.generatedAt}`); generated.add(item.generatedAt); assert(errors,typeof item.snapshot==="string"&&item.snapshot.startsWith(`providers/${expectedProvider}/snapshots/`),`history.items[${i}].snapshot path invalid`); assert(errors,!snapshots.has(item.snapshot),`duplicate history snapshot ${item.snapshot}`); snapshots.add(item.snapshot); validateScoreSet(errors,item,`history.items[${i}].`); if(isScore(item.tailRiskPct)){ assert(errors,item.tailLevel===tailLevel(item.tailRiskPct),`history.items[${i}].tailLevel mismatch`); assert(errors,item.action===actionForTail(item.tailRiskPct),`history.items[${i}].action mismatch`); assert(errors,item.status===statusForAction(item.action),`history.items[${i}].status mismatch`); } if(isScore(item.stressRiskPct)) assert(errors,item.stressLevel===stressLevel(item.stressRiskPct),`history.items[${i}].stressLevel mismatch`); if(isScore(item.confidencePct)) assert(errors,item.confidenceLevel===confidenceLevel(item.confidencePct),`history.items[${i}].confidenceLevel mismatch`); if(repoRoot&&typeof item.snapshot==="string") assert(errors,fs.existsSync(path.join(repoRoot,item.snapshot)),`history snapshot missing: ${item.snapshot}`); }); return errors; }

export function readJson(file){ return JSON.parse(fs.readFileSync(file,"utf8")); }
export function ageMinutes(generatedAt,now=Date.now()){ if(!isDateTime(generatedAt)) return Infinity; return Math.max(0,(now-Date.parse(generatedAt))/60000); }
export function providerState(status,now=Date.now(),staleMinutes=180){ if(!status) return {availability:"missing",fresh:false,ageMinutes:Infinity}; const age=ageMinutes(status.generatedAt,now); return {availability:age>staleMinutes?"stale":"fresh",fresh:age<=staleMinutes,ageMinutes:age}; }
function providerStatusFrom(states,id){ if(states instanceof Map) return states.get(id)??null; return states&&typeof states==="object"&&!Array.isArray(states)?states[id]??null:null; }
function providerOnlyComparison(id){ const token=String(id??"").toUpperCase().replace(/[^A-Z0-9]+/g,"_").replace(/^_+|_+$/g,""); return `${token||"PROVIDER"}_ONLY`; }
function providerScoreRange(entries,field){ const values=entries.map(entry=>entry.status?.[field]).filter(isScore); if(!values.length) return {providerCount:0,min:null,max:null,spread:null}; const min=Math.min(...values),max=Math.max(...values); return {providerCount:values.length,min,max,spread:max-min}; }
export function compareProviderSet(providerManifest,states,now=Date.now(),staleMinutes=180){
  const enabled=(Array.isArray(providerManifest)?providerManifest:[]).filter(provider=>provider?.enabled===true&&typeof provider.id==="string"&&provider.id);
  const entries=enabled.map(provider=>{ const status=providerStatusFrom(states,provider.id),freshness=providerState(status,now,staleMinutes); return {id:provider.id,status,freshness}; });
  const providerStates=Object.fromEntries(entries.map(entry=>[entry.id,entry.freshness]));
  const fresh=entries.filter(entry=>entry.freshness.fresh);
  const groups=new Map();
  fresh.forEach((entry,index)=>{ const action=entry.status?.action; if(typeof action!=="string"||!action) return; if(!groups.has(action)) groups.set(action,{action,providerIds:[],firstIndex:index}); groups.get(action).providerIds.push(entry.id); });
  const actionGroups=[...groups.values()].map(group=>({...group,count:group.providerIds.length})).sort((a,b)=>b.count-a.count||a.firstIndex-b.firstIndex).map(({firstIndex,...group})=>group);
  const comparedProviderCount=actionGroups.reduce((total,group)=>total+group.count,0);
  let comparison;
  if(!fresh.length) comparison="NO_FRESH_PROVIDER";
  else if(comparedProviderCount!==fresh.length) comparison="INCOMPLETE_COMPARISON";
  else if(fresh.length===1) comparison=providerOnlyComparison(fresh[0].id);
  else comparison=actionGroups.length===1?"AGREE":"DIVERGE";
  const largestGroup=actionGroups[0]?.count??0;
  const actionDispersion=comparedProviderCount!==fresh.length?"UNAVAILABLE":actionGroups.length<=1?"NONE":actionGroups.length>=3||largestGroup<=fresh.length/2?"HIGH":"MIXED";
  const scoreRanges={
    tailRiskPct:providerScoreRange(fresh,"tailRiskPct"),
    stressRiskPct:providerScoreRange(fresh,"stressRiskPct"),
    confidencePct:providerScoreRange(fresh,"confidencePct")
  };
  return{
    comparison,
    enabledProviderCount:enabled.length,
    freshProviderCount:fresh.length,
    enabledProviderIds:enabled.map(provider=>provider.id),
    freshProviderIds:fresh.map(entry=>entry.id),
    unavailableProviderIds:entries.filter(entry=>!entry.freshness.fresh).map(entry=>entry.id),
    providerStates,
    actionGroups,
    actionDispersion,
    scoreRanges,
    tailDifference:fresh.length===2&&scoreRanges.tailRiskPct.providerCount===2?scoreRanges.tailRiskPct.spread:null,
    stressDifference:fresh.length===2&&scoreRanges.stressRiskPct.providerCount===2?scoreRanges.stressRiskPct.spread:null
  };
}
export function compareProviders(a,b,now=Date.now(),staleMinutes=180){ const as=providerState(a,now,staleMinutes), bs=providerState(b,now,staleMinutes); if(!as.fresh&&!bs.fresh) return {comparison:"NO_FRESH_PROVIDER",a:as,b:bs}; if(as.fresh&&!bs.fresh) return {comparison:"CHATGPT_ONLY",a:as,b:bs}; if(!as.fresh&&bs.fresh) return {comparison:"CLAUDE_ONLY",a:as,b:bs}; return {comparison:a.action===b.action&&a.dominantMode===b.dominantMode?"AGREE":"DIVERGE",a:as,b:bs,tailDifference:Math.abs(a.tailRiskPct-b.tailRiskPct),stressDifference:Math.abs(a.stressRiskPct-b.stressRiskPct)}; }
export function cacheBust(url,now=Date.now()){ const sep=url.includes("?")?"&":"?"; return `${url}${sep}v=${now}`; }
export function upcomingEvents(events,now=Date.now()){ return (Array.isArray(events)?events:[]).filter(e=>isDateTime(e.ts)&&Date.parse(e.ts)>=now).sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts)); }
