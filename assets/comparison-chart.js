const SVG_NS="http://www.w3.org/2000/svg";

export const HOUR_MS=60*60*1000;
export const FORECAST_HOURS=24;
export const DEFAULT_METRIC_ID="tail";
export const DEFAULT_METRIC_IDS=Object.freeze([DEFAULT_METRIC_ID]);
export const WINDOW_DAY_OPTIONS=Object.freeze([1,3,7,14,30]);
export const DEFAULT_WINDOW_DAYS=3;
export const METRIC_OPTIONS=Object.freeze([
  Object.freeze({id:"tail",label:"TAIL / KILL",legendLabel:"Tail",field:"tailRiskPct"}),
  Object.freeze({id:"stress",label:"STRESS / DD",legendLabel:"Stress",field:"stressRiskPct"}),
  Object.freeze({id:"confidence",label:"CONFIDENCE",legendLabel:"Confidence",field:"confidencePct"})
]);

const DEFAULT_STALE_MINUTES=130;
const MAX_CONNECTED_GAP_HOURS=12;
const chartResizeState=new WeakMap();

function metricOption(metric){return METRIC_OPTIONS.find(option=>option.id===metric||option.label===metric||option.field===metric)||null}
export function metricField(metric){return metricOption(metric)?.field??null}
export function isMetricId(metric){return METRIC_OPTIONS.some(option=>option.id===metric)}
export function normalizeMetricIds(metrics=DEFAULT_METRIC_IDS){
  const requested=new Set((Array.isArray(metrics)?metrics:[metrics]).map(metric=>metricOption(metric)?.id).filter(Boolean));
  return METRIC_OPTIONS.map(option=>option.id).filter(id=>requested.has(id));
}
export function toggleMetricId(metrics,metric){
  const selected=normalizeMetricIds(metrics),id=metricOption(metric)?.id;
  if(!id)return selected;
  return selected.includes(id)?selected.filter(selectedId=>selectedId!==id):normalizeMetricIds([...selected,id]);
}
export function normalizeWindowDays(value){
  const days=Number(value);
  return WINDOW_DAY_OPTIONS.includes(days)?days:DEFAULT_WINDOW_DAYS;
}

function orderedUniquePoints(points){
  const byTimestamp=new Map();
  if(!Array.isArray(points))return[];
  for(const point of points){
    if(!point||!Number.isFinite(point.timestamp)||!Number.isFinite(point.value))continue;
    byTimestamp.set(point.timestamp,{...point,timestamp:point.timestamp,value:point.value});
  }
  return[...byTimestamp.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

function normalizeTimedValues(items,metric,timeField){
  const field=metricField(metric),byTimestamp=new Map();
  if(!field||!Array.isArray(items))return[];
  for(const item of items){
    const timestamp=typeof item?.[timeField]==="string"?Date.parse(item[timeField]):NaN;
    const value=item?.[field];
    if(!Number.isFinite(timestamp)||!Number.isFinite(value)||value<0||value>100)continue;
    byTimestamp.set(timestamp,{timestamp,sourceTime:item[timeField],value});
  }
  return[...byTimestamp.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

export function normalizeHistory(items,metric=DEFAULT_METRIC_ID){
  return normalizeTimedValues(items,metric,"generatedAt").map(point=>({...point,generatedAt:point.sourceTime}));
}

export function normalizeForecast(items,metric=DEFAULT_METRIC_ID){
  return normalizeTimedValues(items,metric,"ts").map(point=>({...point,ts:point.sourceTime}));
}

export function splitHistorySegments(points){
  const ordered=orderedUniquePoints(points);
  if(ordered.length<2)return ordered.length?[ordered]:[];
  const gaps=ordered.slice(1).map((point,index)=>point.timestamp-ordered[index].timestamp).filter(gap=>gap>0).sort((a,b)=>a-b);
  const middle=Math.floor(gaps.length/2);
  const medianGap=gaps.length%2?gaps[middle]:(gaps[middle-1]+gaps[middle])/2;
  const breakAfter=Math.min(MAX_CONNECTED_GAP_HOURS*HOUR_MS,Math.max(6*HOUR_MS,medianGap*4));
  const segments=[[ordered[0]]];
  for(let index=1;index<ordered.length;index+=1){
    if(ordered[index].timestamp-ordered[index-1].timestamp>breakAfter)segments.push([]);
    segments.at(-1).push(ordered[index]);
  }
  return segments;
}

export function splitForecastSegments(points){
  const ordered=orderedUniquePoints(points),segments=[];
  for(const point of ordered){
    if(!segments.length||point.timestamp-segments.at(-1).at(-1).timestamp>HOUR_MS)segments.push([]);
    segments.at(-1).push(point);
  }
  return segments;
}

export function prepareComparisonSeries(providers,metrics=DEFAULT_METRIC_IDS,{nowMs=Date.now(),windowDays=DEFAULT_WINDOW_DAYS,staleMinutes=DEFAULT_STALE_MINUTES}={}){
  const selectedMetrics=normalizeMetricIds(metrics).map(id=>metricOption(id));
  const safeNow=Number.isFinite(nowMs)?nowMs:Date.now();
  const selectedWindowDays=normalizeWindowDays(windowDays);
  const eligibleProviders=(Array.isArray(providers)?providers:[]).filter(provider=>{
    const generatedAt=Date.parse(provider?.generatedAt);
    return provider?.availability==="fresh"&&Number.isFinite(generatedAt)&&Math.max(0,safeNow-generatedAt)<=staleMinutes*60*1000;
  });
  const publishedForecastTimes=eligibleProviders.flatMap(provider=>(Array.isArray(provider?.forecastItems)?provider.forecastItems:[]).map(item=>Date.parse(item?.ts)).filter(Number.isFinite));
  const forecastStart=publishedForecastTimes.length?Math.min(...publishedForecastTimes):Math.floor(safeNow/HOUR_MS)*HOUR_MS;
  const latestPublishedSlot=publishedForecastTimes.length?Math.max(...publishedForecastTimes):forecastStart+(FORECAST_HOURS-1)*HOUR_MS;
  const historyHours=(selectedWindowDays*24)-FORECAST_HOURS;
  const windowStart=safeNow-historyHours*HOUR_MS;
  // Both providers normally publish the same 24 UTC slots. If their exact
  // origins differ, show the union rather than shifting either forecast.
  const windowEnd=Math.max(forecastStart+FORECAST_HOURS*HOUR_MS,latestPublishedSlot+HOUR_MS);
  const series=(Array.isArray(providers)?providers:[]).flatMap((provider,index)=>{
    const id=typeof provider?.id==="string"&&provider.id?provider.id:`provider-${index+1}`;
    const label=typeof provider?.label==="string"&&provider.label?provider.label:id;
    const generatedAt=Date.parse(provider?.generatedAt);
    const fresh=Number.isFinite(generatedAt)&&Math.max(0,safeNow-generatedAt)<=staleMinutes*60*1000;
    return selectedMetrics.map(metric=>{
      const normalizedHistory=normalizeHistory(provider?.historyItems,metric.id);
      const historical=normalizedHistory.filter(point=>point.timestamp>=windowStart&&point.timestamp<=safeNow);
      const normalizedPublishedForecast=normalizeForecast(provider?.forecastItems,metric.id);
      const currentAvailable=provider?.availability==="fresh"&&fresh;
      const forecast=currentAvailable?normalizedPublishedForecast.filter(point=>point.timestamp>=forecastStart&&point.timestamp<windowEnd):[];
      const forecastState=provider?.availability==="stale"||provider?.availability==="fresh"&&!fresh?"stale":provider?.availability!=="fresh"?"current-unavailable":!normalizedPublishedForecast.length?"no-forecast":!forecast.length?"outside-window":"available";
      return{id,label,metric,historical,forecast,fresh,forecastState,validPointCount:normalizedHistory.length};
    });
  });
  return{metrics:selectedMetrics,nowMs:safeNow,forecastStart,windowStart,windowEnd,windowDays:selectedWindowDays,historyHours,forecastHours:FORECAST_HOURS,series};
}

const domEl=(tag,className="",text=null)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==null)node.textContent=text;return node};
const svgEl=(tag,attributes={},text=null)=>{const node=document.createElementNS(SVG_NS,tag);for(const[name,value]of Object.entries(attributes))node.setAttribute(name,String(value));if(text!==null)node.textContent=text;return node};
const providerClass=id=>id==="chatgpt"?"provider-chatgpt":id==="claude"?"provider-claude":"provider-neutral";

function pathData(points,xScale,yScale){
  return points.map((point,index)=>`${index?"L":"M"} ${xScale(point.timestamp).toFixed(2)} ${yScale(point.value).toFixed(2)}`).join(" ");
}

export function forecastSlotPathData(points,xScale,yScale,windowEnd){
  if(!points.length)return"";
  let data=`M ${xScale(points[0].timestamp).toFixed(2)} ${yScale(points[0].value).toFixed(2)}`;
  for(let index=0;index<points.length;index+=1){
    const point=points[index];
    if(index)data+=` L ${xScale(point.timestamp).toFixed(2)} ${yScale(point.value).toFixed(2)}`;
    data+=` H ${xScale(Math.min(windowEnd,point.timestamp+HOUR_MS)).toFixed(2)}`;
  }
  return data;
}

function axisTime(timestamp,compact){
  return new Intl.DateTimeFormat(undefined,compact?{month:"short",day:"numeric",hour:"2-digit"}:{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(timestamp));
}

function scheduleFocus(host,selector){
  const focus=()=>{const next=host.querySelector(selector);if(!next)return;try{next.focus({preventScroll:true})}catch{next.focus()}};
  if(typeof requestAnimationFrame==="function")requestAnimationFrame(focus);else queueMicrotask(focus);
}

function renderMetricToggles(host,selectedMetricIds,onMetricsChange){
  const controls=domEl("div","comparison-metric-controls");
  controls.setAttribute("role","group");
  controls.setAttribute("aria-label","Displayed comparison metrics");
  for(const option of METRIC_OPTIONS){
    const selected=selectedMetricIds.includes(option.id),button=domEl("button",`tab comparison-metric-toggle metric-${option.id}`,option.label);
    button.type="button";
    button.id=`comparison-metric-${option.id}`;
    button.dataset.comparisonMetric=option.id;
    button.setAttribute("aria-pressed",String(selected));
    button.setAttribute("aria-controls","comparison-chart-plot");
    button.addEventListener("click",()=>{
      if(typeof onMetricsChange!=="function")return;
      onMetricsChange(toggleMetricId(selectedMetricIds,option.id));
      scheduleFocus(host,`[data-comparison-metric="${option.id}"]`);
    });
    controls.append(button);
  }
  return controls;
}

function renderWindowSelect(host,windowDays,onWindowDaysChange){
  const label=domEl("label","comparison-window-control"),caption=domEl("span","","CHART RANGE"),select=domEl("select","comparison-window-select");
  label.htmlFor="comparison-window-days";
  select.id="comparison-window-days";
  select.setAttribute("aria-label","Chart time range");
  select.setAttribute("aria-controls","comparison-chart-plot");
  for(const days of WINDOW_DAY_OPTIONS){
    const option=domEl("option","",`${days} ${days===1?"day":"days"}`);
    option.value=String(days);
    option.selected=days===windowDays;
    select.append(option);
  }
  select.addEventListener("change",()=>{
    if(typeof onWindowDaysChange!=="function")return;
    onWindowDaysChange(normalizeWindowDays(select.value));
    scheduleFocus(host,"#comparison-window-days");
  });
  label.append(caption,select);
  return label;
}

function metricClass(id){return`metric-${id}`}

function legendSeriesItem(series){
  const item=domEl("span",`comparison-legend-item ${providerClass(series.id)} ${metricClass(series.metric.id)}`);
  const swatch=domEl("span","comparison-legend-line series-historical");
  swatch.setAttribute("aria-hidden","true");
  item.append(swatch,document.createTextNode(`${series.label} · ${series.metric.legendLabel}`));
  return item;
}

function legendKindItem(kind,label){
  const item=domEl("span","comparison-legend-kind");
  const swatch=domEl("span",`comparison-legend-line series-${kind}`);
  swatch.setAttribute("aria-hidden","true");
  item.append(swatch,document.createTextNode(label));
  return item;
}

function forecastNote(series){
  if(series.forecastState==="no-forecast")return`${series.label}: published 24-hour forecast unavailable.`;
  if(series.forecastState==="outside-window")return`${series.label}: published forecast does not cover the current forecast window.`;
  if(series.forecastState==="stale")return`${series.label}: forecast hidden because the current provider assessment is stale.`;
  if(series.forecastState==="current-unavailable")return`${series.label}: forecast hidden because the complete current publication is unavailable.`;
  return null;
}

function watchChartWidth(host,providers,options){
  if(typeof ResizeObserver!=="function")return;
  const width=Math.round(host.clientWidth),existing=chartResizeState.get(host);
  if(existing){existing.width=width;existing.providers=providers;existing.options=options;return}
  const state={width,providers,options,observer:null};
  state.observer=new ResizeObserver(entries=>{
    const nextWidth=Math.round(entries[0]?.contentRect?.width??host.clientWidth);
    if(!nextWidth||Math.abs(nextWidth-state.width)<2)return;
    state.width=nextWidth;
    renderComparisonChart(host,state.providers,state.options);
  });
  chartResizeState.set(host,state);
  state.observer.observe(host);
}

export function renderComparisonChart(host,providers,{metrics=DEFAULT_METRIC_IDS,windowDays=DEFAULT_WINDOW_DAYS,nowMs=Date.now(),staleMinutes=DEFAULT_STALE_MINUTES,onMetricsChange=null,onWindowDaysChange=null}={}){
  if(!host||typeof document==="undefined")return null;
  const selectedMetricIds=normalizeMetricIds(metrics),selectedWindowDays=normalizeWindowDays(windowDays);
  const prepared=prepareComparisonSeries(providers,selectedMetricIds,{nowMs,windowDays:selectedWindowDays,staleMinutes});
  host.replaceChildren();

  const card=domEl("section","comparison-chart-card panel");
  card.setAttribute("aria-labelledby","comparison-chart-heading");
  const head=domEl("div","comparison-chart-head");
  const titleWrap=domEl("div"),heading=domEl("h3","","Risk history + provider forecast");
  heading.id="comparison-chart-heading";
  titleWrap.append(domEl("div","eyebrow",`${prepared.windowDays}-DAY VIEW`),heading);
  head.append(titleWrap,domEl("span","comparison-chart-scale","0–100% · ACTUAL TIME WITH SPLIT SCALE"));
  const controls=domEl("div","comparison-chart-controls");
  controls.append(renderMetricToggles(host,selectedMetricIds,onMetricsChange),renderWindowSelect(host,selectedWindowDays,onWindowDaysChange));
  card.append(head,controls);

  const figure=domEl("figure","comparison-chart-figure"),legend=domEl("div","comparison-chart-legend");
  for(const series of prepared.series){
    if(series.historical.length||series.forecast.length)legend.append(legendSeriesItem(series));
  }
  if(prepared.series.some(series=>series.historical.length))legend.append(legendKindItem("historical","History"));
  if(prepared.series.some(series=>series.forecast.length))legend.append(legendKindItem("forecast","Published forecast"));
  if(legend.childElementCount)figure.append(legend);

  const availableWidth=Math.max(280,(host.clientWidth||956)-36),compact=availableWidth<560;
  const width=Math.round(availableWidth),height=compact?292:336;
  const margin={top:35,right:compact?10:18,bottom:compact?42:46,left:compact?39:48};
  const plotWidth=width-margin.left-margin.right,plotHeight=height-margin.top-margin.bottom;
  // Forecast always owns a readable third of the plot. The history pane uses
  // its own linear time scale, so 14/30-day history cannot crush the 24h forecast.
  const forecastWidth=prepared.historyHours?plotWidth/3:plotWidth;
  const historyWidth=plotWidth-forecastWidth;
  const dividerX=margin.left+historyWidth;
  const historyScale=timestamp=>prepared.historyHours?margin.left+(timestamp-prepared.windowStart)/(prepared.nowMs-prepared.windowStart)*historyWidth:margin.left;
  const forecastScale=timestamp=>dividerX+(timestamp-prepared.forecastStart)/(prepared.windowEnd-prepared.forecastStart)*forecastWidth;
  const yScale=value=>margin.top+(100-value)/100*plotHeight;
  const svg=svgEl("svg",{id:"comparison-chart-plot",class:"comparison-chart-svg",viewBox:`0 0 ${width} ${height}`,role:"img","aria-labelledby":"comparison-chart-svg-title comparison-chart-svg-desc"});
  const describedProviders=[...new Set(prepared.series.filter(series=>series.historical.length||series.forecast.length).map(series=>series.label))];
  const providerDescription=describedProviders.length?describedProviders.join(" and "):"available provider";
  const metricDescription=prepared.metrics.map(metric=>metric.label).join(", ");
  svg.append(svgEl("title",{id:"comparison-chart-svg-title"},metricDescription?`${metricDescription} provider history and published 24-hour forecast`:"Provider chart with no metrics selected"));
  svg.append(svgEl("desc",{id:"comparison-chart-svg-desc"},metricDescription?`${providerDescription} ${metricDescription} scores on a fixed zero to one hundred percent scale. The history and forecast panes each use a linear time scale and meet at the divider. Solid lines are historical assessments through the actual current time. Dashed step lines are each provider's 24 published hourly slots beginning with that assessment's current clock-hour forecast slot.`:"No metrics are selected. Use the three toggle buttons above the chart to display provider history and forecast."));

  svg.append(svgEl("rect",{class:"comparison-chart-future",x:dividerX,y:margin.top,width:forecastWidth,height:plotHeight}));
  for(const tick of[0,25,50,75,100]){
    const y=yScale(tick);
    svg.append(svgEl("line",{class:"comparison-chart-grid",x1:margin.left,y1:y,x2:width-margin.right,y2:y}));
    svg.append(svgEl("text",{class:"comparison-chart-axis-label",x:margin.left-8,y:y+4,"text-anchor":"end"},`${tick}%`));
  }
  const xTicks=[];
  if(prepared.historyHours){
    const count=compact?2:3;
    for(let index=0;index<count;index+=1){
      const ratio=index/count,timestamp=prepared.windowStart+(prepared.nowMs-prepared.windowStart)*ratio;
      xTicks.push({timestamp,x:historyScale(timestamp),anchor:index===0?"start":"middle"});
    }
  }
  const forecastTickCount=compact?2:3;
  for(let index=1;index<=forecastTickCount;index+=1){
    const ratio=index/forecastTickCount,timestamp=prepared.forecastStart+(prepared.windowEnd-prepared.forecastStart)*ratio;
    xTicks.push({timestamp,x:forecastScale(timestamp),anchor:index===forecastTickCount?"end":"middle"});
  }
  for(const tick of xTicks){
    svg.append(svgEl("line",{class:"comparison-chart-tick",x1:tick.x,y1:height-margin.bottom,x2:tick.x,y2:height-margin.bottom+5}));
    svg.append(svgEl("text",{class:"comparison-chart-axis-label",x:tick.x,y:height-margin.bottom+18,"text-anchor":tick.anchor},axisTime(tick.timestamp,compact)));
  }
  if(prepared.historyHours)svg.append(svgEl("text",{class:"comparison-chart-region-label",x:margin.left+5,y:margin.top-10},`HISTORY · ${prepared.historyHours}H`));
  svg.append(svgEl("text",{class:"comparison-chart-region-label comparison-chart-forecast-label",x:width-margin.right-5,y:margin.top-10,"text-anchor":"end"},compact?"FORECAST · 24H":"PUBLISHED FORECAST · 24H"));

  for(const series of prepared.series){
    const identityClass=`${providerClass(series.id)} ${metricClass(series.metric.id)}`;
    const className=`comparison-chart-series ${identityClass}`;
    for(const segment of splitHistorySegments(series.historical)){
      if(segment.length>1)svg.append(svgEl("path",{class:`${className} series-historical`,d:pathData(segment,historyScale,yScale)}));
      else if(segment.length===1)svg.append(svgEl("circle",{class:`comparison-chart-point ${identityClass}`,cx:historyScale(segment[0].timestamp),cy:yScale(segment[0].value),r:3}));
    }
    if(series.historical.length){
      const last=series.historical.at(-1),point=svgEl("circle",{class:`comparison-chart-endpoint ${identityClass}`,cx:historyScale(last.timestamp),cy:yScale(last.value),r:3.5});
      point.append(svgEl("title",{},`${series.label} · ${series.metric.legendLabel}: ${last.value}% at ${new Date(last.timestamp).toLocaleString()}`));
      svg.append(point);
    }
    for(const segment of splitForecastSegments(series.forecast)){
      const data=forecastSlotPathData(segment,forecastScale,yScale,prepared.windowEnd);
      if(data)svg.append(svgEl("path",{class:`${className} series-forecast`,d:data}));
    }
  }

  svg.append(svgEl("line",{class:"comparison-chart-divider",x1:dividerX,y1:margin.top,x2:dividerX,y2:height-margin.bottom}));
  if(!prepared.series.some(series=>series.historical.length||series.forecast.length))svg.append(svgEl("text",{class:"comparison-chart-empty",x:margin.left+plotWidth/2,y:margin.top+plotHeight/2,"text-anchor":"middle"},prepared.metrics.length?"No valid selected-metric history or forecast in this range.":"Select one or more metrics to display."));
  figure.append(svg);

  const caption=domEl("figcaption","comparison-chart-caption");
  const rangeLabel=prepared.historyHours?`${prepared.historyHours}h history + 24h published forecast · fixed 0–100% scale.`:"Forecast-only 24h view · fixed 0–100% scale.";
  caption.append(domEl("p","comparison-chart-range",rangeLabel),domEl("p","comparison-chart-disclaimer","Dashed step lines show each provider's published hourly forecast."));
  figure.append(caption);
  const notes=[...new Set(prepared.series.map(forecastNote).filter(Boolean))];
  if(notes.length){const noteList=domEl("div","comparison-chart-notes");for(const note of notes)noteList.append(domEl("span","",note));figure.append(noteList)}
  card.append(figure);
  host.append(card);
  watchChartWidth(host,providers,{metrics:selectedMetricIds,windowDays:selectedWindowDays,nowMs,staleMinutes,onMetricsChange,onWindowDaysChange});
  return prepared;
}
