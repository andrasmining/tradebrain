import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import{
  DEFAULT_METRIC_ID,
  DEFAULT_METRIC_IDS,
  DEFAULT_WINDOW_DAYS,
  FORECAST_HOURS,
  HOUR_MS,
  METRIC_OPTIONS,
  WINDOW_DAY_OPTIONS,
  forecastSlotPathData,
  inspectionBucketAtTime,
  metricField,
  normalizeForecast,
  normalizeHistory,
  normalizeMetricIds,
  normalizeWindowDays,
  prepareComparisonSeries,
  prepareInspectionBuckets,
  splitForecastSegments,
  splitHistorySegments,
  toggleMetricId
}from"../assets/comparison-chart.js";

const BASE=Date.parse("2026-08-16T00:00:00Z");
const point=(hour,value)=>({timestamp:BASE+hour*HOUR_MS,value});
const history=(hour,values={})=>({generatedAt:new Date(BASE+hour*HOUR_MS).toISOString(),tailRiskPct:10,stressRiskPct:50,confidencePct:75,...values});
const forecast=(hour,values={})=>({ts:new Date(BASE+hour*HOUR_MS).toISOString(),tailRiskPct:20,stressRiskPct:60,confidencePct:80,...values});
const forecastDay=(startHour,valuesForHour=()=>({}))=>Array.from({length:24},(_,index)=>forecast(startHour+index,valuesForHour(index)));

test("metric selector exposes exactly the three contracted mappings",()=>{
  assert.equal(DEFAULT_METRIC_ID,"tail");
  assert.deepEqual(DEFAULT_METRIC_IDS,["tail"]);
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

test("metric selection permits every subset, including all and none",()=>{
  assert.deepEqual(normalizeMetricIds(["confidence","tail","stress","tail"]),["tail","stress","confidence"]);
  assert.deepEqual(normalizeMetricIds([]),[]);
  assert.deepEqual(normalizeMetricIds(["unknown"]),[]);
  assert.deepEqual(normalizeMetricIds("STRESS / DD"),["stress"]);
  let selected=[];
  for(const metric of["tail","stress","confidence"])selected=toggleMetricId(selected,metric);
  assert.deepEqual(selected,["tail","stress","confidence"]);
  for(const metric of["tail","stress","confidence"])selected=toggleMetricId(selected,metric);
  assert.deepEqual(selected,[]);
});

test("chart range accepts only 1, 3, 7, 14, or 30 days and defaults to three",()=>{
  assert.equal(DEFAULT_WINDOW_DAYS,3);
  assert.equal(FORECAST_HOURS,24);
  assert.deepEqual(WINDOW_DAY_OPTIONS,[1,3,7,14,30]);
  for(const days of WINDOW_DAY_OPTIONS)assert.equal(normalizeWindowDays(String(days)),days);
  assert.equal(normalizeWindowDays(2),3);
  assert.equal(normalizeWindowDays(null),3);
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

test("forecast normalization uses published ts and values without deriving replacements",()=>{
  const rows=[
    forecast(2,{tailRiskPct:91}),
    forecast(0,{tailRiskPct:7}),
    forecast(1,{tailRiskPct:43}),
    {ts:"bad",tailRiskPct:22},
    forecast(3,{tailRiskPct:101})
  ];
  const normalized=normalizeForecast(rows,"tail");
  assert.deepEqual(normalized.map(item=>item.timestamp),[BASE,BASE+HOUR_MS,BASE+2*HOUR_MS]);
  assert.deepEqual(normalized.map(item=>item.value),[7,43,91]);
});

test("historical and forecast paths break at real data gaps",()=>{
  assert.deepEqual(splitHistorySegments([point(0,10),point(1,12),point(30,18)]).map(segment=>segment.length),[2,1]);
  assert.deepEqual(splitForecastSegments([point(0,10),point(1,12),point(3,18)]).map(segment=>segment.length),[2,1]);
});

test("forecast path is step-after and covers the complete final hourly slot",()=>{
  const x=timestamp=>(timestamp-BASE)/HOUR_MS,y=value=>value;
  assert.equal(forecastSlotPathData([point(0,10),point(1,30)],x,y,BASE+2*HOUR_MS),"M 0.00 10.00 H 1.00 L 1.00 30.00 H 2.00");
});

test("default three-day range is exactly 48h history plus 24 published forecast slots",()=>{
  const startHour=100,now=BASE+startHour*HOUR_MS+30*60*1000;
  const rows=[history(40),history(51),history(52),history(75),history(99),history(100)];
  const published=forecastDay(startHour,index=>({tailRiskPct:[9,72,13,88][index%4]}));
  const prepared=prepareComparisonSeries([{
    id:"chatgpt",label:"ChatGPT",availability:"fresh",generatedAt:new Date(BASE+startHour*HOUR_MS+10*60*1000).toISOString(),historyItems:rows,forecastItems:published
  }],"tail",{nowMs:now});
  assert.equal(prepared.windowDays,3);
  assert.equal(prepared.historyHours,48);
  assert.equal(prepared.forecastStart,BASE+startHour*HOUR_MS);
  assert.equal(prepared.windowStart,now-48*HOUR_MS);
  assert.equal(prepared.windowEnd,BASE+(startHour+24)*HOUR_MS);
  assert.deepEqual(prepared.series[0].historical.map(item=>item.timestamp),[BASE+75*HOUR_MS,BASE+99*HOUR_MS,BASE+100*HOUR_MS]);
  assert.equal(prepared.series[0].forecast.length,24);
  assert.deepEqual(prepared.series[0].forecast.slice(0,4).map(item=>item.value),[9,72,13,88]);
  assert.equal(prepared.series[0].forecastState,"available");
});

test("range choices change only history while forecast remains one day",()=>{
  const startHour=800,now=BASE+startHour*HOUR_MS;
  const provider={id:"chatgpt",availability:"fresh",generatedAt:new Date(now).toISOString(),historyItems:[history(80),history(104),history(776),history(799)],forecastItems:forecastDay(startHour)};
  const expectedHistoryHours=new Map([[1,0],[3,48],[7,144],[14,312],[30,696]]);
  for(const days of WINDOW_DAY_OPTIONS){
    const prepared=prepareComparisonSeries([provider],"tail",{nowMs:now,windowDays:days});
    assert.equal(prepared.historyHours,expectedHistoryHours.get(days));
    assert.equal(prepared.forecastHours,24);
    assert.equal(prepared.series[0].forecast.length,24);
  }
  assert.deepEqual(prepareComparisonSeries([provider],"tail",{nowMs:now,windowDays:1}).series[0].historical,[]);
});

test("fresh providers keep differing published origins and chart their timestamp union",()=>{
  const now=BASE+100*HOUR_MS;
  const providers=[
    {id:"chatgpt",availability:"fresh",generatedAt:new Date(now).toISOString(),historyItems:[],forecastItems:forecastDay(100)},
    {id:"claude",availability:"fresh",generatedAt:new Date(now).toISOString(),historyItems:[],forecastItems:forecastDay(101)}
  ];
  const prepared=prepareComparisonSeries(providers,"tail",{nowMs:now});
  assert.equal(prepared.forecastStart,BASE+100*HOUR_MS);
  assert.equal(prepared.windowEnd,BASE+125*HOUR_MS);
  assert.equal(prepared.series[0].forecast[0].timestamp,BASE+100*HOUR_MS);
  assert.equal(prepared.series[1].forecast[0].timestamp,BASE+101*HOUR_MS);
  assert.ok(prepared.series.every(series=>series.forecast.length===24));
});

test("missing, invalid, and stale current publications retain history but suppress forecasts",()=>{
  const now=BASE+100*HOUR_MS,rows=[history(98),history(99)],published=forecastDay(100);
  const providers=[
    {id:"missing",availability:"missing",generatedAt:null,historyItems:rows,forecastItems:published},
    {id:"invalid",availability:"invalid",generatedAt:new Date(now).toISOString(),historyItems:rows,forecastItems:published},
    {id:"stale",availability:"stale",generatedAt:new Date(now-3*HOUR_MS).toISOString(),historyItems:rows,forecastItems:published}
  ];
  const prepared=prepareComparisonSeries(providers,"tail",{nowMs:now});
  assert.ok(prepared.series.every(series=>series.historical.length===2&&series.forecast.length===0));
  assert.deepEqual(prepared.series.map(series=>series.forecastState),["current-unavailable","current-unavailable","stale"]);
});

test("fresh complete publication without forecast reports it instead of fabricating data",()=>{
  const now=BASE+100*HOUR_MS;
  const prepared=prepareComparisonSeries([{id:"chatgpt",availability:"fresh",generatedAt:new Date(now).toISOString(),historyItems:[history(99)],forecastItems:[]}],"tail",{nowMs:now});
  assert.equal(prepared.series[0].historical.length,1);
  assert.deepEqual(prepared.series[0].forecast,[]);
  assert.equal(prepared.series[0].forecastState,"no-forecast");
});

test("series preparation overlays every selected metric for every provider",()=>{
  const startHour=100,now=BASE+startHour*HOUR_MS;
  const rows=[history(97),history(98,{tailRiskPct:12,stressRiskPct:55,confidencePct:76}),history(99,{tailRiskPct:14,stressRiskPct:60,confidencePct:77})];
  const providers=["chatgpt","claude"].map(id=>({id,label:id,availability:"fresh",generatedAt:new Date(now).toISOString(),historyItems:rows,forecastItems:forecastDay(startHour)}));
  const prepared=prepareComparisonSeries(providers,["tail","stress","confidence"],{nowMs:now});
  assert.deepEqual(prepared.metrics.map(metric=>metric.id),["tail","stress","confidence"]);
  assert.equal(prepared.series.length,6);
  assert.deepEqual(prepared.series.map(series=>`${series.id}:${series.metric.id}`),[
    "chatgpt:tail","chatgpt:stress","chatgpt:confidence",
    "claude:tail","claude:stress","claude:confidence"
  ]);
  assert.ok(prepared.series.every(series=>series.historical.length===3&&series.forecast.length===24));
  assert.deepEqual(prepareComparisonSeries(providers,[],{nowMs:now}).series,[]);
});

test("inspection anchors preserve exact history records without filling missing provider metrics",()=>{
  const tail=METRIC_OPTIONS[0],stress=METRIC_OPTIONS[1];
  const chatTime=BASE+5*60*1000,chatOtherMetricTime=BASE+25*60*1000,claudeTime=BASE+2*HOUR_MS;
  const prepared={historyHours:48,series:[
    {id:"chatgpt",label:"ChatGPT",metric:tail,historical:[{timestamp:chatTime,sourceTime:new Date(chatTime).toISOString(),value:11}],forecast:[]},
    {id:"chatgpt",label:"ChatGPT",metric:stress,historical:[{timestamp:chatOtherMetricTime,sourceTime:new Date(chatOtherMetricTime).toISOString(),value:55}],forecast:[]},
    {id:"claude",label:"Claude",metric:tail,historical:[{timestamp:claudeTime,sourceTime:new Date(claudeTime).toISOString(),value:22}],forecast:[]}
  ]};
  const buckets=prepareInspectionBuckets(prepared);
  assert.deepEqual(buckets.map(bucket=>bucket.anchorTimestamp),[chatTime,chatOtherMetricTime,claudeTime]);
  assert.equal(buckets[0].rows[0].point.timestamp,chatTime);
  assert.equal(buckets[0].rows[1].point,null,"another metric must not borrow a different assessment timestamp");
  assert.equal(buckets[0].rows[2].point,null,"a provider more than one hour away stays unavailable");
  assert.equal(buckets[1].rows[0].point,null);
  assert.equal(buckets[1].rows[1].point.timestamp,chatOtherMetricTime);
});

test("inspection forecast buckets are exact half-open slots with provider edge gaps",()=>{
  const tail=METRIC_OPTIONS[0];
  const prepared={historyHours:0,series:[
    {id:"chatgpt",label:"ChatGPT",metric:tail,historical:[],forecast:[point(100,10),point(101,11)]},
    {id:"claude",label:"Claude",metric:tail,historical:[],forecast:[point(101,20),point(102,21)]}
  ]};
  const buckets=prepareInspectionBuckets(prepared);
  assert.deepEqual(buckets.map(bucket=>bucket.anchorTimestamp),[BASE+100*HOUR_MS,BASE+101*HOUR_MS,BASE+102*HOUR_MS]);
  assert.ok(buckets.every(bucket=>bucket.hourEnd-bucket.anchorTimestamp===HOUR_MS));
  assert.deepEqual(buckets.map(bucket=>bucket.rows.map(row=>row.point?.value??null)),[[10,null],[11,20],[null,21]]);
  assert.equal(inspectionBucketAtTime(buckets,"forecast",BASE+100*HOUR_MS).anchorTimestamp,BASE+100*HOUR_MS);
  assert.equal(inspectionBucketAtTime(buckets,"forecast",BASE+101*HOUR_MS).anchorTimestamp,BASE+101*HOUR_MS,"a slot end belongs to the next half-open slot");
  assert.equal(inspectionBucketAtTime(buckets,"forecast",BASE+103*HOUR_MS),null);
});

test("history inspection does not snap across gaps larger than one hour",()=>{
  const buckets=[{kind:"history",anchorTimestamp:BASE,key:"history:first"}];
  assert.equal(inspectionBucketAtTime(buckets,"history",BASE+HOUR_MS).key,"history:first");
  assert.equal(inspectionBucketAtTime(buckets,"history",BASE+HOUR_MS+1),null);
  assert.equal(inspectionBucketAtTime(buckets,"forecast",BASE),null);
});

test("combined chart mount sits between provider cards and agreement metadata",()=>{
  const html=fs.readFileSync("index.html","utf8"),cards=html.indexOf('id="provider-cards"'),chart=html.indexOf('id="comparison-chart"'),agreement=html.indexOf('id="agreement-banner"');
  assert.ok(cards>=0&&cards<chart&&chart<agreement);
});

test("dashboard persists metric and range controls without coupling provider switching",()=>{
  const app=fs.readFileSync("assets/app.js","utf8"),chart=fs.readFileSync("assets/comparison-chart.js","utf8"),styles=fs.readFileSync("assets/styles.css","utf8"),responsive=fs.readFileSync("assets/responsive.css","utf8");
  assert.match(app,/tradebrain\.comparisonMetrics/);
  assert.match(app,/tradebrain\.comparisonWindowDays/);
  assert.match(app,/forecastItems:Array\.isArray\(data\?\.status\?\.forecast\)/);
  assert.match(app,/availability:data\?\.availability/);
  assert.match(app,/renderComparisonChart\(\$\("comparison-chart"\),comparisonProviders\(\)/);
  const switchBody=app.match(/function selectProvider\([^\n]+/)?.[0]??"";
  assert.doesNotMatch(switchBody,/renderComparison/);
  assert.doesNotMatch(chart,/regression|projection|extrapolation/i);
  assert.match(chart,/24 published hourly slots/);
  assert.match(chart,/historical assessments through the actual current time/);
  assert.doesNotMatch(chart,/>NOW</);
  assert.match(chart,/CHART RANGE/);
  assert.match(chart,/WINDOW_DAY_OPTIONS=Object\.freeze\(\[1,3,7,14,30\]\)/);
  assert.match(chart,/setAttribute\("aria-pressed",String\(selected\)\)/);
  assert.match(chart,/select\.setAttribute\("aria-label","Chart time range"\)/);
  assert.match(chart,/scheduleFocus\(host,"#comparison-window-days"\)/);
  assert.doesNotMatch(chart,/setAttribute\("role","tab"\)/);
  assert.doesNotMatch(chart,/setAttribute\("aria-selected"/);
  assert.doesNotMatch(chart,/legend\.setAttribute\("aria-label"/);
  assert.match(styles,/\.comparison-window-select\{[^}]*min-height:42px/);
  assert.match(styles,/\.comparison-chart-series\.series-forecast/);
  assert.match(chart,/segment\.length===1\)svg\.append\(svgEl\("circle",\{class:`comparison-chart-point/);
  assert.match(styles,/\.comparison-chart-point\{[^}]*opacity:\.72;pointer-events:none/);
  assert.match(chart,/prepareInspectionBuckets/);
  assert.match(chart,/comparison-chart-crosshair/);
  assert.match(chart,/comparison-chart-inspection-band/);
  assert.match(chart,/setAttribute\("aria-live","polite"\)/);
  assert.match(chart,/\["ArrowLeft","ArrowRight","Home","End"\]/);
  assert.match(chart,/addEventListener\("pointermove"/);
  assert.match(chart,/addEventListener\("click"/);
  assert.match(chart,/if\(bucket\)showBucket\(bucket,false\);else clearInspection\(false\)/);
  assert.match(chart,/PUBLISHED FORECAST SLOT/);
  assert.match(chart,/inspectionInterval\(bucket\.anchorTimestamp,bucket\.hourEnd\)/);
  assert.match(chart,/24 published slots per provider/);
  assert.match(chart,/tap\/click to pin/);
  assert.match(chart,/missing hours stay empty/);
  assert.match(styles,/\.comparison-chart-tooltip\{[^}]*pointer-events:none/);
  assert.match(styles,/touch-action:pan-y pinch-zoom/);
  assert.match(responsive,/\.comparison-chart-tooltip\{width:220px/);
  assert.match(responsive,/\.comparison-chart-controls\{display:grid/);
  assert.match(styles,/\.provider-chatgpt\.metric-stress/);
  assert.match(styles,/\.provider-claude\.metric-confidence/);
});
