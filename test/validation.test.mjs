import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {validateStatus,validateSignal,validateHistory,actionForTail,statusForAction,tailLevel,stressLevel,confidenceLevel,compareProviders,compareProviderSet,cacheBust,upcomingEvents} from "../scripts/lib.mjs";
import {validateStatusContract} from "../scripts/status-contract.mjs";

function iso(base,hours){return new Date(Date.parse(base)+hours*3600000).toISOString()}function berlin(utc){const d=new Date(utc),shifted=new Date(d.getTime()+3600000);return shifted.toISOString().replace("Z","+01:00")}
function makeStatus(provider="chatgpt",generatedAt="2026-01-10T12:10:00Z",tail=18){const hour="2026-01-10T12:00:00Z",action=actionForTail(tail),forecast=Array.from({length:24},(_,i)=>{const ts=iso(hour,i),t=i===5?24:tail,a=actionForTail(t);return{ts,timeBerlin:berlin(ts),status:statusForAction(a),action:a,tailRiskPct:t,stressRiskPct:50,confidencePct:75,dominantMode:"mixed"}}),lookback=Array.from({length:24},(_,i)=>{const ts=iso(hour,i-24);return{ts,timeBerlin:berlin(ts),available:false,status:null,action:null,tailRiskPct:null,stressRiskPct:null,confidencePct:null,dominantMode:null}});return{schemaVersion:"1.0.0",provider,engineVersion:"1.0.0",promptVersion:"1.1.0",generatedAt,market:"NASDAQ-100",instruments:["NQ_FUTURES","NAS100_CFD"],status:statusForAction(action),statusText:"Normal",recommendation:"EA on",headline:"Test",body:"Fixture",tailRiskPct:tail,tailLevel:tailLevel(tail),stressRiskPct:50,stressLevel:stressLevel(50),dominantMode:"mixed",confidencePct:75,confidenceLevel:confidenceLevel(75),action,dangerWindow:{start:null,end:null},dangerWindowBerlin:{start:null,end:null},sources:[{title:"BLS",url:"https://www.bls.gov/"}],lookbackSummary:"Fixture lookback",lookback,outlookSummary:"Fixture outlook",forecast,forecastDetail:forecast.slice(0,6).map(x=>({ts:x.ts,timeBerlin:x.timeBerlin,status:x.status,tailRiskPct:x.tailRiskPct,stressRiskPct:x.stressRiskPct,comment:"Fixture"})),events:[{name:"Fixture event",ts:"2026-01-11T13:30:00Z",timeBerlin:"2026-01-11T14:30:00+01:00",impact:"high"}]}}
function makeSignal(status){return{schemaVersion:status.schemaVersion,provider:status.provider,engineVersion:status.engineVersion,promptVersion:status.promptVersion,generatedAt:status.generatedAt,market:status.market,instruments:status.instruments,status:status.status,action:status.action,pause:["STRONG_BLOCK_NO_NEW_RISK","EA_OFF_NO_NEW_RISK"].includes(status.action),caution:["WATCH","BLOCK_NEW_BASE_ENTRIES"].includes(status.action),tailRiskPct:status.tailRiskPct,tailLevel:status.tailLevel,stressRiskPct:status.stressRiskPct,stressLevel:status.stressLevel,confidencePct:status.confidencePct,confidenceLevel:status.confidenceLevel,dominantMode:status.dominantMode,dangerWindow:status.dangerWindow,dangerWindowBerlin:status.dangerWindowBerlin}}

test("valid status accepted",()=>assert.deepEqual(validateStatus(makeStatus(),"chatgpt"),[]));
test("status contract requires an extended signed Berlin offset",()=>{
  const status=makeStatus();
  assert.deepEqual(validateStatusContract(status),[]);
  status.forecast[0].timeBerlin=status.forecast[0].timeBerlin.replace("+01:00","+0100");
  assert.ok(validateStatusContract(status).some(error=>error.includes("forecast[0].timeBerlin")));
});
test("invalid score rejected",()=>{const s=makeStatus();s.tailRiskPct=101;assert.ok(validateStatus(s,"chatgpt").some(e=>e.includes("tailRiskPct")))});
test("wrong action/Tail mapping rejected",()=>{const s=makeStatus();s.action="WATCH";assert.ok(validateStatus(s,"chatgpt").some(e=>e.includes("action must")))});
test("wrong status/action mapping rejected",()=>{const s=makeStatus();s.status="red";assert.ok(validateStatus(s,"chatgpt").some(e=>e.includes("status does not match")))});
test("bad signal coherence rejected",()=>{const s=makeStatus(),signal=makeSignal(s);signal.tailRiskPct=19;assert.ok(validateSignal(signal,s,"chatgpt").some(e=>e.includes("match status")))});
test("missing forecast slot rejected",()=>{const s=makeStatus();s.forecast.pop();assert.ok(validateStatus(s,"chatgpt").some(e=>e.includes("exactly 24")))});
test("wrong forecast action mapping rejected",()=>{const s=makeStatus();s.forecast[2].action="EA_OFF_NO_NEW_RISK";assert.ok(validateStatus(s,"chatgpt").some(e=>e.includes("forecast[2].action")))});
test("wrong forecastDetail count rejected",()=>{const s=makeStatus();s.forecastDetail.pop();assert.ok(validateStatus(s,"chatgpt").some(e=>e.includes("exactly 6")))});
test("duplicate history item rejected",()=>{const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"tradebrain-")),snapshot="providers/chatgpt/snapshots/2026/01/a.json";fs.mkdirSync(path.join(tmp,path.dirname(snapshot)),{recursive:true});fs.writeFileSync(path.join(tmp,snapshot),"{}");const item={generatedAt:"2026-01-01T00:00:00Z",status:"green",action:"EA_ON",tailRiskPct:18,tailLevel:"low",stressRiskPct:50,stressLevel:"elevated",confidencePct:75,confidenceLevel:"high",dominantMode:"mixed",snapshot},h={schemaVersion:"1.0.0",provider:"chatgpt",historyVersion:"1.0.0",retentionPolicy:"unlimited",items:[item,{...item}]};assert.ok(validateHistory(h,"chatgpt",tmp).some(e=>e.includes("duplicate")))});
test("dual-provider comparison states",()=>{const now=Date.parse("2026-01-10T12:30:00Z"),c=makeStatus("chatgpt","2026-01-10T12:10:00Z",18),d=makeStatus("claude","2026-01-10T12:11:00Z",18);assert.equal(compareProviders(c,null,now).comparison,"CHATGPT_ONLY");assert.equal(compareProviders(null,d,now).comparison,"CLAUDE_ONLY");assert.equal(compareProviders(c,d,now).comparison,"AGREE");d.tailRiskPct=23;d.tailLevel="watch";d.action="WATCH";d.status="yellow";assert.equal(compareProviders(c,d,now).comparison,"DIVERGE");const stale=makeStatus("claude","2026-01-10T01:00:00Z",18);assert.equal(compareProviders(c,stale,now,180).comparison,"CHATGPT_ONLY");assert.equal(compareProviders(null,null,now).comparison,"NO_FRESH_PROVIDER")});
test("enabled-provider comparison keeps one- and two-provider compatibility",()=>{
  const now=Date.parse("2026-01-10T12:30:00Z"),manifest=[{id:"chatgpt",enabled:true},{id:"claude",enabled:true},{id:"disabled",enabled:false}];
  const chatgpt=makeStatus("chatgpt","2026-01-10T12:10:00Z",18),claude=makeStatus("claude","2026-01-10T12:11:00Z",18);
  const solo=compareProviderSet([{id:"alpha",enabled:true}],{alpha:makeStatus("alpha","2026-01-10T12:09:00Z",18)},now,130);
  assert.equal(solo.comparison,"ALPHA_ONLY");
  assert.equal(solo.enabledProviderCount,1);
  assert.equal(solo.freshProviderCount,1);
  const one=compareProviderSet(manifest,{chatgpt,claude:null,disabled:makeStatus("disabled","2026-01-10T12:12:00Z",55)},now,130);
  assert.equal(one.comparison,"CHATGPT_ONLY");
  assert.deepEqual(one.enabledProviderIds,["chatgpt","claude"]);
  assert.deepEqual(one.freshProviderIds,["chatgpt"]);
  const both=compareProviderSet(manifest,{chatgpt,claude},now,130);
  assert.equal(both.comparison,"AGREE");
  assert.equal(both.tailDifference,0);
  assert.equal(both.actionDispersion,"NONE");
});
test("generic freshness tracks every enabled missing or stale provider",()=>{
  const now=Date.parse("2026-01-10T12:30:00Z"),manifest=["alpha","beta","gamma"].map(id=>({id,enabled:true}));
  const comparison=compareProviderSet(manifest,{
    alpha:makeStatus("alpha","2026-01-10T12:10:00Z",18),
    beta:makeStatus("beta","2026-01-10T05:00:00Z",18),
    gamma:null
  },now,130);
  assert.equal(comparison.comparison,"ALPHA_ONLY");
  assert.deepEqual(comparison.freshProviderIds,["alpha"]);
  assert.deepEqual(comparison.unavailableProviderIds,["beta","gamma"]);
  assert.equal(comparison.providerStates.alpha.availability,"fresh");
  assert.equal(comparison.providerStates.beta.availability,"stale");
  assert.equal(comparison.providerStates.gamma.availability,"missing");
});
test("three-provider comparison reports majority divergence and score ranges without averages",()=>{
  const now=Date.parse("2026-01-10T12:30:00Z"),manifest=["alpha","beta","gamma"].map(id=>({id,enabled:true}));
  const states={
    alpha:makeStatus("alpha","2026-01-10T12:10:00Z",18),
    beta:makeStatus("beta","2026-01-10T12:11:00Z",23),
    gamma:makeStatus("gamma","2026-01-10T12:12:00Z",23)
  };
  const comparison=compareProviderSet(manifest,states,now,130);
  assert.equal(comparison.comparison,"DIVERGE");
  assert.equal(comparison.freshProviderCount,3);
  assert.deepEqual(comparison.actionGroups.map(group=>[group.action,group.count,group.providerIds]),[["WATCH",2,["beta","gamma"]],["EA_ON",1,["alpha"]]]);
  assert.equal(comparison.actionDispersion,"MIXED");
  assert.deepEqual(comparison.scoreRanges.tailRiskPct,{providerCount:3,min:18,max:23,spread:5});
  assert.equal(comparison.tailDifference,null);
  assert.equal("action"in comparison,false);
  assert.doesNotMatch(JSON.stringify(comparison),/average|mean|combinedAction|consensusAction/i);
});
test("three distinct fresh actions produce high display-only dispersion",()=>{
  const now=Date.parse("2026-01-10T12:30:00Z"),manifest=["alpha","beta","gamma"].map(id=>({id,enabled:true}));
  const comparison=compareProviderSet(manifest,{
    alpha:makeStatus("alpha","2026-01-10T12:10:00Z",18),
    beta:makeStatus("beta","2026-01-10T12:11:00Z",23),
    gamma:makeStatus("gamma","2026-01-10T12:12:00Z",28)
  },now,130);
  assert.equal(comparison.comparison,"DIVERGE");
  assert.equal(comparison.actionGroups.length,3);
  assert.equal(comparison.actionDispersion,"HIGH");
});
test("overview build derives every enabled provider through the generic comparison",()=>{
  const source=fs.readFileSync("scripts/build-overview.mjs","utf8");
  assert.match(source,/compareProviderSet\(enabledProviders, states,/);
  assert.doesNotMatch(source,/states\.(?:chatgpt|claude)|provider\.id\s*===\s*["'](?:chatgpt|claude)/);
});
test("time helpers advance and filter",()=>{assert.match(cacheBust("/x.json",123),/\?v=123$/);assert.match(cacheBust("/x.json?a=1",123),/&v=123$/);const now=Date.parse("2026-01-10T12:00:00Z"),events=[{ts:"2026-01-10T11:00:00Z"},{ts:"2026-01-10T13:00:00Z"}];assert.equal(upcomingEvents(events,now).length,1)});
