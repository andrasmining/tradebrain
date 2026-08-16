import test from"node:test";
import assert from"node:assert/strict";
import{
  PROVIDER_COMPARISON_ROWS,
  prepareProviderComparison,
  renderProviderComparison,
  summarizeProviderComparison
}from"../assets/provider-comparison.js";

const NOW=Date.parse("2026-08-16T20:00:00Z");
const manifest=(ids,disabled=[])=>[
  ...ids.map(id=>({id,label:id.toUpperCase(),enabled:true,path:`providers/${id}`})),
  ...disabled.map(id=>({id,label:id.toUpperCase(),enabled:false,path:`providers/${id}`}))
];
const status=(id,{action="EA_ON",riskStatus="green",tail=10,stress=40,confidence=80,mode="normal",generatedAt="2026-08-16T19:30:00Z"}={})=>({
  provider:id,
  generatedAt,
  action,
  status:riskStatus,
  tailRiskPct:tail,
  tailLevel:tail<20?"low":"elevated",
  stressRiskPct:stress,
  stressLevel:"moderate",
  confidencePct:confidence,
  confidenceLevel:"high",
  dominantMode:mode
});
const wrapped=(id,options={},availability="fresh")=>({provider:{id},availability,status:status(id,options)});
const compare=(ids,entries,options={})=>prepareProviderComparison(manifest(ids),new Map(entries.map(entry=>[entry.provider.id,entry])),{
  nowMs:NOW,
  formatGenerated:value=>value,
  ...options
});

test("comparison rows are metric-aligned and providers retain enabled manifest order",()=>{
  const model=compare(["zeta","alpha","beta"],[
    wrapped("alpha",{tail:21,stress:42,confidence:71,mode:"mixed"}),
    wrapped("zeta",{tail:11,stress:32,confidence:81,mode:"normal"}),
    wrapped("beta",{tail:31,stress:52,confidence:61,mode:"trend-down"})
  ]);
  assert.deepEqual(model.providers.map(provider=>provider.id),["zeta","alpha","beta"]);
  assert.deepEqual(PROVIDER_COMPARISON_ROWS.map(row=>row.id),["action","tail","stress","confidence","mode","generated"]);
  assert.deepEqual(model.rows.map(row=>row.id),["action","tail","stress","confidence","mode","generated"]);
  assert.deepEqual(model.rows.find(row=>row.id==="tail").cells.map(cell=>cell.value),[11,21,31]);
  assert.deepEqual(model.rows.find(row=>row.id==="stress").cells.map(cell=>cell.value),[32,42,52]);
  assert.deepEqual(model.rows.find(row=>row.id==="mode").cells.map(cell=>cell.value),["normal","mixed","trend-down"]);
});

test("only enabled manifest providers join comparison and direct status objects are accepted",()=>{
  const providers=manifest(["one","two"],["disabled"]);
  const states={one:status("one"),two:status("two",{tail:22}),disabled:status("disabled",{tail:99})};
  const model=prepareProviderComparison(providers,states,{nowMs:NOW,formatGenerated:value=>value});
  assert.deepEqual(model.providers.map(provider=>provider.id),["one","two"]);
  assert.deepEqual(model.rows.find(row=>row.id==="tail").cells.map(cell=>cell.value),[10,22]);
});

test("one provider renders a safe single-provider state",()=>{
  const model=compare(["solo"],[wrapped("solo")]);
  assert.equal(model.providers.length,1);
  assert.equal(model.summary.state,"single");
  assert.equal(model.summary.freshProviderCount,1);
  assert.match(model.summary.text,/only enabled fresh provider/i);
});

test("missing, invalid, and stale states stay visible but never count as fresh agreement",()=>{
  const old="2026-08-16T16:00:00Z";
  const states=new Map([
    ["fresh",wrapped("fresh")],
    ["stale",wrapped("stale",{generatedAt:old},"fresh")],
    ["missing",{provider:{id:"missing"},availability:"missing",status:null}],
    ["invalid",{provider:{id:"invalid"},availability:"fresh",status:{generatedAt:"bad"}}]
  ]);
  const model=prepareProviderComparison(manifest(["fresh","stale","missing","invalid"]),states,{nowMs:NOW,formatGenerated:value=>value});
  assert.deepEqual(model.providers.map(provider=>provider.availability),["fresh","stale","missing","invalid"]);
  assert.equal(model.summary.freshProviderCount,1);
  assert.equal(model.summary.unavailableProviderCount,3);
  assert.equal(model.summary.state,"single");
  const actionCells=model.rows.find(row=>row.id==="action").cells;
  assert.deepEqual(actionCells.map(cell=>cell.riskStatus),["green","neutral","neutral","neutral"]);
  assert.deepEqual(actionCells.map(cell=>cell.display),["EA ON","EA ON","Missing","Unavailable"]);
  assert.equal(model.summary.ranges.tail.providerCount,1);
});

test("an enabled provider absent from loaded state is missing rather than invalid",()=>{
  const model=prepareProviderComparison(manifest(["present","absent"]),{present:status("present")},{nowMs:NOW,formatGenerated:value=>value});
  assert.deepEqual(model.providers.map(provider=>provider.availability),["fresh","missing"]);
  assert.equal(model.rows.find(row=>row.id==="action").cells[1].display,"Missing");
});

test("risk status colors are provider-neutral, including orange",()=>{
  const model=compare(["chatgpt","claude","future"],[
    wrapped("chatgpt",{action:"BLOCK_NEW_BASE_ENTRIES",riskStatus:"orange",tail:28}),
    wrapped("claude",{action:"BLOCK_NEW_BASE_ENTRIES",riskStatus:"orange",tail:29}),
    wrapped("future",{action:"BLOCK_NEW_BASE_ENTRIES",riskStatus:"orange",tail:30})
  ]);
  const cells=model.rows.find(row=>row.id==="action").cells;
  assert.deepEqual(cells.map(cell=>cell.riskStatus),["orange","orange","orange"]);
  assert.deepEqual(cells.map(cell=>cell.publishedRiskStatus),["orange","orange","orange"]);
  assert.equal(model.summary.state,"agreement");
});

test("agreement metadata generalizes beyond a pair",()=>{
  const model=compare(["a","b","c"],[wrapped("a"),wrapped("b"),wrapped("c")]);
  assert.equal(model.summary.state,"agreement");
  assert.equal(model.summary.freshProviderCount,3);
  assert.equal(model.summary.actionGroups.length,1);
  assert.deepEqual(model.summary.actionGroups[0].providerIds,["a","b","c"]);
  assert.match(model.summary.text,/all 3 fresh providers/i);
});

test("a multi-provider majority is transparent divergence metadata",()=>{
  const watch={action:"WATCH",riskStatus:"yellow",tail:22};
  const model=compare(["a","b","c"],[wrapped("a",watch),wrapped("b",watch),wrapped("c")]);
  assert.equal(model.summary.state,"divergence");
  assert.deepEqual(model.summary.actionGroups.map(group=>[group.publishedAction,group.count]),[["WATCH",2],["EA_ON",1]]);
  assert.match(model.summary.text,/2\/3 fresh providers map to WATCH/);
});

test("five distinct providers produce action dispersion without an averaged action",()=>{
  const model=compare(["a","b","c","d","e"],[
    wrapped("a"),
    wrapped("b",{action:"WATCH",riskStatus:"yellow",tail:22}),
    wrapped("c",{action:"BLOCK_NEW_BASE_ENTRIES",riskStatus:"orange",tail:28}),
    wrapped("d",{action:"STRONG_BLOCK_NO_NEW_RISK",riskStatus:"red",tail:42}),
    wrapped("e",{action:"EA_OFF_NO_NEW_RISK",riskStatus:"red",tail:62})
  ]);
  assert.equal(model.providers.length,5);
  assert.equal(model.summary.state,"dispersion");
  assert.equal(model.summary.actionGroupCount,5);
  assert.deepEqual(model.summary.ranges.tail,{providerCount:5,min:10,max:62,spread:52});
  assert.doesNotMatch(JSON.stringify(model.summary),/average|mean|combinedAction|consensusAction|synthetic/i);
  assert.equal("action"in model.summary,false);
});

test("two-provider divergence names each actual provider action",()=>{
  const model=compare(["chatgpt","claude"],[
    wrapped("chatgpt"),
    wrapped("claude",{action:"WATCH",riskStatus:"yellow",tail:22})
  ]);
  assert.equal(model.summary.state,"divergence");
  assert.equal(model.summary.text,"Divergence: CHATGPT EA ON · CLAUDE WATCH.");
});

test("summary helper reports no fresh state without manufacturing a signal",()=>{
  const summary=summarizeProviderComparison([]);
  assert.equal(summary.state,"unavailable");
  assert.equal(summary.text,"No fresh provider assessment available.");
  assert.equal(summary.actionGroups.length,0);
  assert.equal("action"in summary,false);
});

class FakeElement{
  constructor(tag,doc){this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.children=[];this.attributes=new Map();this.className="";this.textContent="";this.tabIndex=-1}
  append(...nodes){this.children.push(...nodes)}
  replaceChildren(...nodes){this.children=[...nodes]}
  setAttribute(name,value){this.attributes.set(name,String(value))}
}
class FakeDocument{createElement(tag){return new FakeElement(tag,this)}}

test("renderer exposes generic table, provider identity, risk, and state CSS hooks",()=>{
  const doc=new FakeDocument(),host=new FakeElement("div",doc);
  const model=renderProviderComparison(host,manifest(["chatgpt","future"]),new Map([
    ["chatgpt",wrapped("chatgpt",{action:"BLOCK_NEW_BASE_ENTRIES",riskStatus:"orange",tail:28})],
    ["future",{provider:{id:"future"},availability:"missing",status:null}]
  ]),{nowMs:NOW,formatGenerated:value=>value});
  assert.equal(model.providers.length,2);
  assert.equal(host.children[0].className,"provider-comparison is-single");
  const serialized=[];
  const walk=node=>{serialized.push(`${node.tagName}.${node.className}:${node.textContent}`);node.children.forEach(walk)};
  walk(host.children[0]);
  const output=serialized.join("\n");
  assert.match(output,/provider-comparison-provider provider-chatgpt is-fresh/);
  assert.match(output,/provider-comparison-provider provider-future is-missing/);
  assert.match(output,/provider-comparison-risk risk-orange:BLOCK NEW ENTRIES/);
  assert.match(output,/provider-comparison-risk risk-neutral is-unavailable:Missing/);
  assert.doesNotMatch(output,/combined|consensus/i);
});
