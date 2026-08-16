import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{
  DEFAULT_METRIC_ID,
  HOUR_MS,
  METRIC_OPTIONS,
  buildProjection,
  metricField,
  normalizeHistory,
  prepareComparisonSeries,
  regressionSlope,
  splitHistorySegments
}from"../assets/comparison-chart.js";

const BASE=Date.parse("2026-08-16T00:00:00Z");
const point=(hour,value)=>({timestamp:BASE+hour*HOUR_MS,value});
const history=(hour,values={})=>({generatedAt:new Date(BASE+hour*HOUR_MS).toISOString(),tailRiskPct:10,stressRiskPct:50,confidencePct:75,...values});
const closeTo=(actual,expected,epsilon=1e-10)=>assert.ok(Math.abs(actual-expected)<=epsilon,`${actual} is not within ${epsilon} of ${expected}`);

test("metric selector exposes exactly the three contracted mappings",()=>{
  assert.equal(DEFAULT_METRIC_ID,"tail");
  assert.deepEqual(METRIC_OPTIONS.map(({label,field})=>[label,field]),[
    ["TAIL / KILL","tailRiskPct"],
    ["STRESS / DD","stressRiskPct"],
    ["CONFIDENCE","confidencePct"]
  ]);
  assert.equal(metricField("TAIL / KILL"),"tailRiskPct");
  assert.equal(metricField("STRESS / DD"),"stressRiskPct");
  assert.equal(metricField("CONFIDENCE"),"confidencePct");
  assert.equal(metricField("unknown"),null);
});

test("history normalization sorts actual timestamps and preserves irregular spacing",()=>{
  const rows=[
    history(5,{tailRiskPct:25}),
    history(0,{tailRiskPct:10}),
    {generatedAt:"not-a-date",tailRiskPct:99},
    history(2,{tailRiskPct:18}),
    history(3,{tailRiskPct:Infinity}),
    history(4,{tailRiskPct:101}),
    null
  ];
  const normalized=normalizeHistory(rows,"tail");
  assert.deepEqual(normalized.map(item=>item.value),[10,18,25]);
  assert.deepEqual(normalized.slice(1).map((item,index)=>(item.timestamp-normalized[index].timestamp)/HOUR_MS),[2,3]);
});

test("history normalization resolves duplicate timestamps deterministically",()=>{
  const duplicateTime=new Date(BASE).toISOString();
  const normalized=normalizeHistory([
    {generatedAt:duplicateTime,tailRiskPct:11},
    {generatedAt:duplicateTime,tailRiskPct:17},
    {},
    {generatedAt:new Date(BASE+HOUR_MS).toISOString(),tailRiskPct:NaN}
  ],"TAIL / KILL");
  assert.deepEqual(normalized.map(item=>item.value),[17]);
  assert.deepEqual(normalizeHistory([],"tail"),[]);
  assert.deepEqual(normalizeHistory(null,"tail"),[]);
});

test("OLS slope uses real elapsed hours",()=>{
  const slope=regressionSlope([point(0,10),point(2,14),point(5,20)]);
  closeTo(slope,2);
});

test("OLS uses at most the latest eight valid points",()=>{
  const points=[point(0,100),...Array.from({length:8},(_,index)=>point(index+1,index+1))];
  closeTo(regressionSlope(points),1);
});

test("projection needs three points, anchors at the final actual, and emits six future hours",()=>{
  assert.deepEqual(buildProjection([point(0,10),point(1,12)]),[]);
  const projection=buildProjection([point(0,10),point(2,14),point(5,20)]);
  assert.equal(projection.length,7);
  assert.deepEqual(projection[0],{...point(5,20),projected:true});
  assert.equal(projection.at(-1).timestamp,BASE+11*HOUR_MS);
  closeTo(projection.at(-1).value,32);
});

test("projection clamps rising and falling trends to the fixed percentage scale",()=>{
  const rising=buildProjection([point(0,80),point(1,90),point(2,100)]);
  assert.ok(rising.every(item=>item.value>=0&&item.value<=100));
  assert.equal(rising.at(-1).value,100);
  const falling=buildProjection([point(0,20),point(1,10),point(2,0)]);
  assert.ok(falling.every(item=>item.value>=0&&item.value<=100));
  assert.equal(falling.at(-1).value,0);
});

test("flat history produces a flat anchored projection",()=>{
  const projection=buildProjection([point(0,42),point(3,42),point(7,42)]);
  assert.deepEqual(projection.map(item=>item.value),Array(7).fill(42));
});

test("historical paths break instead of bridging enormous gaps",()=>{
  const segments=splitHistorySegments([point(0,10),point(1,12),point(30,18)]);
  assert.deepEqual(segments.map(segment=>segment.length),[2,1]);
});

test("series preparation handles one provider, malformed rows, and stale projection suppression",()=>{
  const rows=[history(0,{stressRiskPct:40}),history(1,{stressRiskPct:45}),history(3,{stressRiskPct:55}),{generatedAt:"bad",stressRiskPct:90}];
  const fresh=prepareComparisonSeries([{id:"chatgpt",label:"ChatGPT",generatedAt:new Date(BASE+3*HOUR_MS).toISOString(),historyItems:rows}],"stress",{nowMs:BASE+3*HOUR_MS});
  assert.equal(fresh.series.length,1);
  assert.deepEqual(fresh.series[0].historical.map(item=>item.timestamp),[BASE,BASE+HOUR_MS,BASE+3*HOUR_MS]);
  assert.equal(fresh.series[0].projection.length,7);
  const stale=prepareComparisonSeries([{id:"chatgpt",label:"ChatGPT",generatedAt:new Date(BASE).toISOString(),historyItems:rows}],"stress",{nowMs:BASE+3*HOUR_MS});
  assert.equal(stale.series[0].projectionState,"stale");
  assert.deepEqual(stale.series[0].projection,[]);
  const empty=prepareComparisonSeries([{id:"claude",label:"Claude",generatedAt:null,historyItems:[{},null]}],"confidence",{nowMs:BASE});
  assert.deepEqual(empty.series[0].historical,[]);
  assert.equal(empty.series[0].projectionState,"no-history");
});

test("series preparation keeps only the rolling 72-hour historical window",()=>{
  const now=BASE+100*HOUR_MS;
  const rows=[history(20),history(28),history(75),history(100)];
  const prepared=prepareComparisonSeries([{id:"chatgpt",label:"ChatGPT",generatedAt:new Date(now).toISOString(),historyItems:rows}],"tail",{nowMs:now});
  assert.deepEqual(prepared.series[0].historical.map(item=>item.timestamp),[BASE+28*HOUR_MS,BASE+75*HOUR_MS,BASE+100*HOUR_MS]);
});

test("combined chart mount sits between provider cards and agreement metadata",()=>{
  const html=fs.readFileSync("index.html","utf8"),cards=html.indexOf('id="provider-cards"'),chart=html.indexOf('id="comparison-chart"'),agreement=html.indexOf('id="agreement-banner"');
  assert.ok(cards>=0&&cards<chart&&chart<agreement);
});

test("dashboard persists a chart metric and leaves provider switching independent",()=>{
  const app=fs.readFileSync("assets/app.js","utf8"),chart=fs.readFileSync("assets/comparison-chart.js","utf8");
  assert.match(app,/tradebrain\.comparisonMetric/);
  assert.match(app,/renderComparisonChart\(\$\("comparison-chart"\),comparisonProviders\(\)/);
  const switchBody=app.match(/function selectProvider\([^\n]+/)?.[0]??"";
  assert.doesNotMatch(switchBody,/renderComparison/);
  assert.match(chart,/not the providers' published forecast/);
  assert.match(chart,/aria-labelledby/);
  assert.match(chart,/heading\.id="comparison-chart-heading"/);
  assert.match(chart,/onMetricChange\(option\.id\);\s*scheduleTabFocus\(host,option\.id\)/);
});
