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

const PROVIDER_SERIES_PALETTES=Object.freeze([
  Object.freeze({tail:"#7aa7ff",stress:"#c48cff",confidence:"#63d4f5"}),
  Object.freeze({tail:"#63d49a",stress:"#d8c85f",confidence:"#4ecbc4"}),
  Object.freeze({tail:"#ff9d72",stress:"#f277ad",confidence:"#ffd166"}),
  Object.freeze({tail:"#a98cff",stress:"#ff7a90",confidence:"#8cd7ff"}),
  Object.freeze({tail:"#f2b84b",stress:"#8bd17c",confidence:"#be95ff"}),
  Object.freeze({tail:"#63c7d4",stress:"#e59560",confidence:"#b4db78"}),
  Object.freeze({tail:"#ef7fb5",stress:"#89a7ff",confidence:"#e6c76b"})
]);

const DEFAULT_STALE_MINUTES=130;
const MAX_CONNECTED_GAP_HOURS=12;
const chartResizeState=new WeakMap();

function metricOption(metric){return METRIC_OPTIONS.find(option=>option.id===metric||option.label===metric||option.field===metric)||null}
export function providerSeriesColor(providerId,metricId,providerIndex=0){
  const knownIndex=providerId==="chatgpt"?0:providerId==="claude"?1:null;
  const fallbackCount=PROVIDER_SERIES_PALETTES.length-2;
  const paletteIndex=knownIndex??2+(Math.max(0,Number.isInteger(providerIndex)?providerIndex:0)%fallbackCount);
  return PROVIDER_SERIES_PALETTES[paletteIndex]?.[metricId]??"#778395";
}
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
      return{id,label,providerIndex:index,metric,historical,forecast,fresh,forecastState,validPointCount:normalizedHistory.length};
    });
  });
  return{metrics:selectedMetrics,nowMs:safeNow,forecastStart,windowStart,windowEnd,windowDays:selectedWindowDays,historyHours,forecastHours:FORECAST_HOURS,series};
}

const inspectionBucketKey=(kind,timestamp)=>`${kind}:${timestamp}`;

export function prepareInspectionBuckets(prepared){
  if(!prepared||!Array.isArray(prepared.series)||!prepared.series.length)return[];
  const validPoints=(series,kind)=>{
    const points=kind==="history"?series.historical:series.forecast;
    return(Array.isArray(points)?points:[]).filter(point=>Number.isFinite(point?.timestamp)&&Number.isFinite(point?.value));
  };
  const historyBySeries=prepared.series.map(series=>validPoints(series,"history"));
  const forecastBySeries=prepared.series.map(series=>validPoints(series,"forecast"));
  const historyAnchors=[...new Set(historyBySeries.flat().map(point=>point.timestamp))].sort((a,b)=>a-b);
  const forecastAnchors=[...new Set(forecastBySeries.flat().map(point=>point.timestamp))].sort((a,b)=>a-b);
  const seriesIndexesByProvider=new Map();
  prepared.series.forEach((series,index)=>{
    if(!seriesIndexesByProvider.has(series.id))seriesIndexesByProvider.set(series.id,[]);
    seriesIndexesByProvider.get(series.id).push(index);
  });
  const nearestProviderTimestamp=(indexes,timestamp)=>{
    let nearest=null,distance=Infinity;
    const candidates=new Set(indexes.flatMap(index=>historyBySeries[index].map(point=>point.timestamp)));
    for(const candidate of candidates){
      const nextDistance=Math.abs(candidate-timestamp);
      if(nextDistance<distance){nearest=candidate;distance=nextDistance}
    }
    return distance<=HOUR_MS?nearest:null;
  };
  const historyBuckets=prepared.historyHours?historyAnchors.map(anchorTimestamp=>{
    const selectedTimestampByProvider=new Map([...seriesIndexesByProvider].map(([providerId,indexes])=>[providerId,nearestProviderTimestamp(indexes,anchorTimestamp)]));
    return{
      key:inspectionBucketKey("history",anchorTimestamp),kind:"history",hourStart:Math.floor(anchorTimestamp/HOUR_MS)*HOUR_MS,hourEnd:Math.floor(anchorTimestamp/HOUR_MS)*HOUR_MS+HOUR_MS,anchorTimestamp,hasValues:true,
      rows:prepared.series.map((series,index)=>({series,point:historyBySeries[index].find(point=>point.timestamp===selectedTimestampByProvider.get(series.id))??null}))
    };
  }):[];
  const forecastBuckets=forecastAnchors.map(anchorTimestamp=>({
    key:inspectionBucketKey("forecast",anchorTimestamp),kind:"forecast",hourStart:anchorTimestamp,hourEnd:anchorTimestamp+HOUR_MS,anchorTimestamp,hasValues:true,
    rows:prepared.series.map((series,index)=>({series,point:forecastBySeries[index].find(point=>point.timestamp===anchorTimestamp)??null}))
  }));
  return[...historyBuckets,...forecastBuckets];
}

export function inspectionBucketAtTime(buckets,kind,timestamp){
  if(!Array.isArray(buckets)||!["history","forecast"].includes(kind)||!Number.isFinite(timestamp))return null;
  const paneBuckets=buckets.filter(bucket=>bucket.kind===kind);
  if(kind==="forecast"){
    for(let index=paneBuckets.length-1;index>=0;index-=1){
      const bucket=paneBuckets[index];
      if(timestamp>=bucket.anchorTimestamp&&timestamp<bucket.hourEnd)return bucket;
    }
    return null;
  }
  let nearest=null,distance=Infinity;
  for(const bucket of paneBuckets){
    const nextDistance=Math.abs(bucket.anchorTimestamp-timestamp);
    if(nextDistance<distance){nearest=bucket;distance=nextDistance}
  }
  return distance<=HOUR_MS?nearest:null;
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

const inspectionMinuteFormatter=new Intl.DateTimeFormat(undefined,{weekday:"short",year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZoneName:"short"});
const inspectionSecondFormatter=new Intl.DateTimeFormat(undefined,{weekday:"short",year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",timeZoneName:"short"});
const inspectionPointFormatter=new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",timeZoneName:"short"});
const inspectionIntervalFormatter=new Intl.DateTimeFormat(undefined,{year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZoneName:"short"});

function inspectionDateTime(timestamp,seconds=false){
  return(seconds?inspectionSecondFormatter:inspectionMinuteFormatter).format(new Date(timestamp));
}

function inspectionPointTime(timestamp){
  return inspectionPointFormatter.format(new Date(timestamp));
}

function inspectionInterval(start,end){
  return typeof inspectionIntervalFormatter.formatRange==="function"?inspectionIntervalFormatter.formatRange(new Date(start),new Date(end)):`${inspectionIntervalFormatter.format(new Date(start))} → ${inspectionIntervalFormatter.format(new Date(end))}`;
}

function inspectionSummary(bucket){
  const kind=bucket.kind==="forecast"?"Published forecast slot":"Historical assessment";
  const missing=bucket.kind==="forecast"?"no published slot":"no data at this assessment";
  const values=bucket.rows.map(({series,point})=>point?`${series.label} ${series.metric.legendLabel}: ${point.value} percent at ${point.sourceTime??new Date(point.timestamp).toISOString()}`:`${series.label} ${series.metric.legendLabel}: ${missing}`);
  const time=bucket.kind==="forecast"?inspectionInterval(bucket.anchorTimestamp,bucket.hourEnd):inspectionDateTime(bucket.anchorTimestamp,true);
  return`${kind}, ${time}. ${values.join("; ")}.`;
}

function inspectionTooltip(bucket){
  const tooltip=domEl("div",`comparison-chart-tooltip is-${bucket.kind}`);
  tooltip.setAttribute("role","tooltip");
  const kicker=bucket.kind==="forecast"?"PUBLISHED FORECAST SLOT":"HISTORICAL ASSESSMENTS";
  const displayedTime=bucket.kind==="forecast"?inspectionInterval(bucket.anchorTimestamp,bucket.hourEnd):inspectionDateTime(bucket.anchorTimestamp,true);
  tooltip.append(domEl("div","comparison-chart-tooltip-kicker",kicker),domEl("div","comparison-chart-tooltip-time",displayedTime));
  const rows=domEl("div","comparison-chart-tooltip-rows");
  const providerGroups=new Map();
  for(const row of bucket.rows){
    const key=row.series.id;
    if(!providerGroups.has(key))providerGroups.set(key,{label:row.series.label,rows:[]});
    providerGroups.get(key).rows.push(row);
  }
  for(const group of providerGroups.values()){
    const provider=domEl("div","comparison-chart-tooltip-provider"),providerName=domEl("span","",group.label);
    const providerPoint=group.rows.find(row=>row.point)?.point;
    const providerTime=domEl("time","",providerPoint?inspectionPointTime(providerPoint.timestamp):bucket.kind==="forecast"?"No published slot":"No assessment");
    if(providerPoint)providerTime.dateTime=providerPoint.sourceTime??new Date(providerPoint.timestamp).toISOString();
    provider.append(providerName,providerTime);
    rows.append(provider);
    for(const{series,point}of group.rows){
      const row=domEl("div",`comparison-chart-tooltip-row ${providerClass(series.id)} ${metricClass(series.metric.id)}`);
      row.style.setProperty("--series-color",providerSeriesColor(series.id,series.metric.id,series.providerIndex));
      const identity=domEl("span","comparison-chart-tooltip-identity"),swatch=domEl("span","comparison-chart-tooltip-swatch");
      swatch.setAttribute("aria-hidden","true");
      identity.append(swatch,document.createTextNode(series.metric.legendLabel));
      const reading=domEl("span",`comparison-chart-tooltip-reading${point?"":" is-missing"}`);
      if(point){
        reading.append(domEl("strong","",`${point.value}%`));
      }else reading.textContent=bucket.kind==="forecast"?"— No slot":"— No data";
      row.append(identity,reading);
      rows.append(row);
    }
  }
  tooltip.append(rows);
  return tooltip;
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
  item.style.setProperty("--series-color",providerSeriesColor(series.id,series.metric.id,series.providerIndex));
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

function installChartInspection({svg,plotWrap,live,prepared,inspectionBuckets,width,margin,plotHeight,dividerX,historyScale,forecastScale,yScale}){
  const buckets=inspectionBuckets??prepareInspectionBuckets(prepared);
  const layer=svgEl("g",{class:"comparison-chart-inspection-layer","aria-hidden":"true"});
  layer.hidden=true;
  svg.append(layer);
  if(!buckets.length)return false;
  let activeKey=null,pinned=false,tooltip=null;
  const plotRight=width-margin.right,plotBottom=margin.top+plotHeight;
  const xForTimestamp=(kind,timestamp)=>(kind==="history"?historyScale:forecastScale)(timestamp);
  const xForBucket=bucket=>Math.max(margin.left,Math.min(plotRight,xForTimestamp(bucket.kind,bucket.anchorTimestamp)));

  const positionTooltip=(bucket)=>{
    if(!tooltip)return;
    const svgRect=svg.getBoundingClientRect(),wrapRect=plotWrap.getBoundingClientRect();
    if(!svgRect.width||!svgRect.height)return;
    const scaleX=svgRect.width/width,scaleY=svgRect.height/Number(svg.getAttribute("viewBox").split(" ")[3]);
    const plotLeftPx=svgRect.left-wrapRect.left+margin.left*scaleX;
    const plotRightPx=svgRect.left-wrapRect.left+plotRight*scaleX;
    const plotTopPx=svgRect.top-wrapRect.top+margin.top*scaleY;
    const plotBottomPx=svgRect.top-wrapRect.top+plotBottom*scaleY;
    const crosshairPx=svgRect.left-wrapRect.left+xForBucket(bucket)*scaleX;
    tooltip.style.maxWidth=`${Math.max(150,plotRightPx-plotLeftPx-8)}px`;
    tooltip.style.maxHeight=`${Math.max(120,plotBottomPx-plotTopPx-8)}px`;
    const tooltipWidth=tooltip.offsetWidth,tooltipHeight=tooltip.offsetHeight;
    let left=crosshairPx+10;
    if(left+tooltipWidth>plotRightPx-4)left=crosshairPx-tooltipWidth-10;
    left=Math.max(plotLeftPx+4,Math.min(left,plotRightPx-tooltipWidth-4));
    const top=Math.max(plotTopPx+4,Math.min(plotTopPx+7,plotBottomPx-tooltipHeight-4));
    tooltip.style.left=`${left}px`;
    tooltip.style.top=`${top}px`;
  };

  const showBucket=(bucket,announce=true)=>{
    if(!bucket)return;
    if(activeKey===bucket.key&&tooltip){
      if(announce)live.textContent=inspectionSummary(bucket);
      return;
    }
    activeKey=bucket.key;
    const crosshairX=xForBucket(bucket);
    const crosshair=svgEl("line",{class:"comparison-chart-crosshair",x1:crosshairX,y1:margin.top,x2:crosshairX,y2:plotBottom});
    const band=bucket.kind==="forecast"?svgEl("rect",{class:"comparison-chart-inspection-band",x:crosshairX,y:margin.top,width:Math.max(1,Math.min(plotRight,forecastScale(bucket.hourEnd))-crosshairX),height:plotHeight}):null;
    const markers=bucket.rows.flatMap(({series,point})=>{
      if(!point)return[];
      const pointX=Math.max(margin.left,Math.min(plotRight,xForTimestamp(bucket.kind,point.timestamp)));
      const identityClass=`${providerClass(series.id)} ${metricClass(series.metric.id)}`;
      return[svgEl("circle",{class:`comparison-chart-inspection-marker ${identityClass}`,style:`--series-color:${providerSeriesColor(series.id,series.metric.id,series.providerIndex)}`,cx:pointX,cy:yScale(point.value),r:4.5})];
    });
    layer.replaceChildren(...(band?[band]:[]),crosshair,...markers);
    layer.hidden=false;
    if(tooltip)tooltip.remove();
    tooltip=inspectionTooltip(bucket);
    plotWrap.append(tooltip);
    positionTooltip(bucket);
    if(announce)live.textContent=inspectionSummary(bucket);
  };

  const clearInspection=(announce=true)=>{
    activeKey=null;
    pinned=false;
    layer.hidden=true;
    layer.replaceChildren();
    if(tooltip)tooltip.remove();
    tooltip=null;
    if(announce)live.textContent="Chart inspection cleared.";
  };

  const bucketAtSvgX=x=>{
    if(x<margin.left||x>plotRight)return null;
    const kind=prepared.historyHours&&x<dividerX?"history":"forecast";
    const start=kind==="history"?prepared.windowStart:prepared.forecastStart;
    const end=kind==="history"?prepared.nowMs+1:prepared.windowEnd;
    const paneStart=kind==="history"?margin.left:dividerX;
    const paneWidth=kind==="history"?dividerX-margin.left:plotRight-dividerX;
    if(!paneWidth||end<=start)return null;
    const timestamp=start+(x-paneStart)/paneWidth*(end-start);
    const bounded=Math.min(end-1,Math.max(start,timestamp));
    return inspectionBucketAtTime(buckets,kind,bounded);
  };

  const bucketFromPointer=event=>{
    const rect=svg.getBoundingClientRect();
    if(!rect.width||!rect.height)return null;
    const x=(event.clientX-rect.left)/rect.width*width;
    const y=(event.clientY-rect.top)/rect.height*Number(svg.getAttribute("viewBox").split(" ")[3]);
    if(y<margin.top||y>plotBottom)return null;
    return bucketAtSvgX(x);
  };

  svg.addEventListener("pointermove",event=>{
    if(event.pointerType&&!["mouse","pen"].includes(event.pointerType)||pinned)return;
    const bucket=bucketFromPointer(event);
    if(bucket)showBucket(bucket,false);else clearInspection(false);
  });
  svg.addEventListener("pointerleave",event=>{
    if((!event.pointerType||["mouse","pen"].includes(event.pointerType))&&!pinned)clearInspection(false);
  });
  svg.addEventListener("click",event=>{
    const bucket=bucketFromPointer(event);
    if(!bucket)return;
    if(pinned&&activeKey===bucket.key){clearInspection();return}
    pinned=true;
    showBucket(bucket,true);
  });
  svg.addEventListener("keydown",event=>{
    if(event.key==="Escape"){
      if(activeKey){event.preventDefault();clearInspection()}
      return;
    }
    if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();
    const navigation=buckets;
    let index=navigation.findIndex(bucket=>bucket.key===activeKey);
    if(event.key==="Home")index=0;
    else if(event.key==="End")index=navigation.length-1;
    else if(event.key==="ArrowLeft")index=index<0?navigation.length-1:Math.max(0,index-1);
    else index=index<0?0:Math.min(navigation.length-1,index+1);
    pinned=true;
    showBucket(navigation[index],true);
  });
  return true;
}

export function renderComparisonChart(host,providers,{metrics=DEFAULT_METRIC_IDS,windowDays=DEFAULT_WINDOW_DAYS,nowMs=Date.now(),staleMinutes=DEFAULT_STALE_MINUTES,onMetricsChange=null,onWindowDaysChange=null}={}){
  if(!host||typeof document==="undefined")return null;
  const selectedMetricIds=normalizeMetricIds(metrics),selectedWindowDays=normalizeWindowDays(windowDays);
  const prepared=prepareComparisonSeries(providers,selectedMetricIds,{nowMs,windowDays:selectedWindowDays,staleMinutes});
  host.replaceChildren();

  const card=domEl("section","comparison-chart-card panel");
  card.setAttribute("aria-labelledby","comparison-chart-heading");
  const head=domEl("div","comparison-chart-head");
  const titleWrap=domEl("div"),heading=domEl("h3","","History + published forecast");
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

  const availableWidth=Math.max(280,(host.clientWidth||956)-36),compact=availableWidth<560,veryCompact=availableWidth<340;
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
  const inspectionBuckets=prepareInspectionBuckets(prepared),hasInspection=Boolean(inspectionBuckets.length);
  const svgAttributes={id:"comparison-chart-plot",class:"comparison-chart-svg",viewBox:`0 0 ${width} ${height}`,role:hasInspection?"group":"img","aria-labelledby":"comparison-chart-svg-title","aria-describedby":hasInspection?"comparison-chart-svg-desc comparison-chart-inspection-help":"comparison-chart-svg-desc"};
  if(hasInspection){svgAttributes.tabindex="0";svgAttributes["aria-roledescription"]="interactive chart";svgAttributes["aria-keyshortcuts"]="ArrowLeft ArrowRight Home End Escape"}
  const svg=svgEl("svg",svgAttributes);
  const describedProviders=[...new Set(prepared.series.filter(series=>series.historical.length||series.forecast.length).map(series=>series.label))];
  const providerDescription=describedProviders.length?describedProviders.join(" and "):"available provider";
  const metricDescription=prepared.metrics.map(metric=>metric.label).join(", ");
  svg.append(svgEl("title",{id:"comparison-chart-svg-title"},metricDescription?`${metricDescription} provider history and published 24-hour forecast`:"Provider chart with no metrics selected"));
  svg.append(svgEl("desc",{id:"comparison-chart-svg-desc"},metricDescription?`${providerDescription} ${metricDescription} scores on a fixed zero to one hundred percent scale. The history and forecast panes each use a linear time scale and meet at the divider. Solid lines are real historical assessments through the actual current time; missing hours are not filled. Dashed step lines are each provider's 24 published hourly slots beginning with that assessment's current clock-hour forecast slot.`:"No metrics are selected. Use the three toggle buttons above the chart to display provider history and forecast."));

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
  const forecastTickCount=veryCompact?1:compact||forecastWidth<240?2:3;
  for(let index=1;index<=forecastTickCount;index+=1){
    const ratio=index/forecastTickCount,timestamp=prepared.forecastStart+(prepared.windowEnd-prepared.forecastStart)*ratio;
    xTicks.push({timestamp,x:forecastScale(timestamp),anchor:index===forecastTickCount?"end":"middle",compactLabel:true});
  }
  for(const tick of xTicks){
    svg.append(svgEl("line",{class:"comparison-chart-tick",x1:tick.x,y1:height-margin.bottom,x2:tick.x,y2:height-margin.bottom+5}));
    svg.append(svgEl("text",{class:"comparison-chart-axis-label",x:tick.x,y:height-margin.bottom+18,"text-anchor":tick.anchor},axisTime(tick.timestamp,compact||tick.compactLabel)));
  }
  if(prepared.historyHours)svg.append(svgEl("text",{class:"comparison-chart-region-label",x:margin.left+5,y:margin.top-10},`HISTORY · ${prepared.historyHours}H`));
  svg.append(svgEl("text",{class:"comparison-chart-region-label comparison-chart-forecast-label",x:width-margin.right-5,y:margin.top-10,"text-anchor":"end"},compact?"FORECAST · 24 EACH":"PUBLISHED FORECAST · 24 SLOTS EACH"));

  for(const series of prepared.series){
    const identityClass=`${providerClass(series.id)} ${metricClass(series.metric.id)}`;
    const className=`comparison-chart-series ${identityClass}`,seriesStyle=`--series-color:${providerSeriesColor(series.id,series.metric.id,series.providerIndex)}`;
    for(const segment of splitHistorySegments(series.historical)){
      if(segment.length>1)svg.append(svgEl("path",{class:`${className} series-historical`,style:seriesStyle,d:pathData(segment,historyScale,yScale)}));
      else if(segment.length===1)svg.append(svgEl("circle",{class:`comparison-chart-point ${identityClass}`,style:seriesStyle,cx:historyScale(segment[0].timestamp),cy:yScale(segment[0].value),r:2.75,"aria-hidden":"true"}));
    }
    for(const segment of splitForecastSegments(series.forecast)){
      const data=forecastSlotPathData(segment,forecastScale,yScale,prepared.windowEnd);
      if(data)svg.append(svgEl("path",{class:`${className} series-forecast`,style:seriesStyle,d:data}));
    }
  }

  svg.append(svgEl("line",{class:"comparison-chart-divider",x1:dividerX,y1:margin.top,x2:dividerX,y2:height-margin.bottom}));
  if(!prepared.series.some(series=>series.historical.length||series.forecast.length))svg.append(svgEl("text",{class:"comparison-chart-empty",x:margin.left+plotWidth/2,y:margin.top+plotHeight/2,"text-anchor":"middle"},prepared.metrics.length?"No valid selected-metric history or forecast in this range.":"Select one or more metrics to display."));
  const plotWrap=domEl("div","comparison-chart-plot-wrap"),live=domEl("p","comparison-chart-inspection-live");
  live.setAttribute("aria-live","polite");
  live.setAttribute("aria-atomic","true");
  plotWrap.append(svg);
  installChartInspection({svg,plotWrap,live,prepared,inspectionBuckets,width,margin,plotHeight,dividerX,historyScale,forecastScale,yScale});
  figure.append(plotWrap,live);

  const caption=domEl("figcaption","comparison-chart-caption");
  const rangeLabel=prepared.historyHours?`${prepared.historyHours}h history + 24 published slots per provider · fixed 0–100% scale.`:"Forecast-only · 24 published slots per provider · fixed 0–100% scale.";
  const help=domEl("p","comparison-chart-disclaimer",hasInspection?"Hover for exact values · tap/click to pin · arrows inspect · Esc clears. History uses published assessments; missing hours stay empty.":"Dashed steps are the providers' published forecasts.");
  help.id="comparison-chart-inspection-help";
  caption.append(domEl("p","comparison-chart-range",rangeLabel),help);
  figure.append(caption);
  const notes=[...new Set(prepared.series.map(forecastNote).filter(Boolean))];
  if(notes.length){const noteList=domEl("div","comparison-chart-notes");for(const note of notes)noteList.append(domEl("span","",note));figure.append(noteList)}
  card.append(figure);
  host.append(card);
  watchChartWidth(host,providers,{metrics:selectedMetricIds,windowDays:selectedWindowDays,nowMs,staleMinutes,onMetricsChange,onWindowDaysChange});
  return prepared;
}
