const SVG_NS="http://www.w3.org/2000/svg";
export const HOUR_MS=60*60*1000;
export const DEFAULT_METRIC_ID="tail";
export const METRIC_OPTIONS=Object.freeze([
  Object.freeze({id:"tail",label:"TAIL / KILL",legendLabel:"Tail",field:"tailRiskPct"}),
  Object.freeze({id:"stress",label:"STRESS / DD",legendLabel:"Stress",field:"stressRiskPct"}),
  Object.freeze({id:"confidence",label:"CONFIDENCE",legendLabel:"Confidence",field:"confidencePct"})
]);
export const DEFAULT_METRIC_IDS=Object.freeze([DEFAULT_METRIC_ID]);

const DEFAULT_WINDOW_HOURS=72;
const DEFAULT_PROJECTION_HOURS=6;
const DEFAULT_REGRESSION_POINTS=8;
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
const clampPct=value=>Math.min(100,Math.max(0,value));

function orderedUniquePoints(points){
  const byTimestamp=new Map();
  if(!Array.isArray(points))return[];
  for(const point of points){
    if(!point||!Number.isFinite(point.timestamp)||!Number.isFinite(point.value))continue;
    byTimestamp.set(point.timestamp,{...point,timestamp:point.timestamp,value:point.value});
  }
  return[...byTimestamp.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

export function normalizeHistory(items,metric=DEFAULT_METRIC_ID){
  const field=metricField(metric),byTimestamp=new Map();
  if(!field||!Array.isArray(items))return[];
  for(const item of items){
    const timestamp=typeof item?.generatedAt==="string"?Date.parse(item.generatedAt):NaN;
    const value=item?.[field];
    if(!Number.isFinite(timestamp)||!Number.isFinite(value)||value<0||value>100)continue;
    // A valid audit history cannot contain duplicates. If malformed input does,
    // retaining the final row gives the renderer one deterministic point in time.
    byTimestamp.set(timestamp,{timestamp,generatedAt:item.generatedAt,value});
  }
  return[...byTimestamp.values()].sort((a,b)=>a.timestamp-b.timestamp);
}

export function regressionSlope(points,maxPoints=DEFAULT_REGRESSION_POINTS){
  const sample=orderedUniquePoints(points).slice(-Math.max(0,maxPoints));
  if(sample.length<3)return null;
  const origin=sample[0].timestamp;
  const xs=sample.map(point=>(point.timestamp-origin)/HOUR_MS);
  const meanX=xs.reduce((sum,value)=>sum+value,0)/sample.length;
  const meanY=sample.reduce((sum,point)=>sum+point.value,0)/sample.length;
  let numerator=0,denominator=0;
  for(let index=0;index<sample.length;index+=1){
    const dx=xs[index]-meanX;
    numerator+=dx*(sample[index].value-meanY);
    denominator+=dx*dx;
  }
  return denominator>0?numerator/denominator:null;
}

export function buildProjection(points,{horizonHours=DEFAULT_PROJECTION_HOURS,maxPoints=DEFAULT_REGRESSION_POINTS}={}){
  const ordered=orderedUniquePoints(points),slope=regressionSlope(ordered,maxPoints);
  if(ordered.length<3||!Number.isFinite(slope)||!Number.isInteger(horizonHours)||horizonHours<1)return[];
  const last=ordered.at(-1),projection=[{...last,projected:true}];
  for(let hour=1;hour<=horizonHours;hour+=1){
    const timestamp=last.timestamp+hour*HOUR_MS;
    projection.push({timestamp,generatedAt:new Date(timestamp).toISOString(),value:clampPct(last.value+slope*hour),projected:true});
  }
  return projection;
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

export function prepareComparisonSeries(providers,metrics=DEFAULT_METRIC_IDS,{nowMs=Date.now(),windowHours=DEFAULT_WINDOW_HOURS,projectionHours=DEFAULT_PROJECTION_HOURS,staleMinutes=DEFAULT_STALE_MINUTES}={}){
  const selectedMetrics=normalizeMetricIds(metrics).map(id=>metricOption(id));
  const safeNow=Number.isFinite(nowMs)?nowMs:Date.now();
  const windowStart=safeNow-windowHours*HOUR_MS,windowEnd=safeNow+projectionHours*HOUR_MS;
  const series=(Array.isArray(providers)?providers:[]).flatMap((provider,index)=>{
    const id=typeof provider?.id==="string"&&provider.id?provider.id:`provider-${index+1}`;
    const label=typeof provider?.label==="string"&&provider.label?provider.label:id;
    const generatedAt=Date.parse(provider?.generatedAt);
    const fresh=Number.isFinite(generatedAt)&&Math.max(0,safeNow-generatedAt)<=staleMinutes*60*1000;
    return selectedMetrics.map(metric=>{
      const normalized=normalizeHistory(provider?.historyItems,metric.id).filter(point=>point.timestamp<=safeNow);
      const historical=normalized.filter(point=>point.timestamp>=windowStart);
      let projection=[],projectionState="available";
      if(!historical.length)projectionState="no-history";
      else if(!fresh)projectionState="stale";
      else{
        projection=buildProjection(normalized,{horizonHours:projectionHours,maxPoints:DEFAULT_REGRESSION_POINTS});
        if(!projection.length)projectionState="insufficient-data";
      }
      return{id,label,metric,historical,projection,fresh,projectionState,validPointCount:normalized.length};
    });
  });
  return{metrics:selectedMetrics,nowMs:safeNow,windowStart,windowEnd,windowHours,projectionHours,series};
}

const domEl=(tag,className="",text=null)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==null)node.textContent=text;return node};
const svgEl=(tag,attributes={},text=null)=>{const node=document.createElementNS(SVG_NS,tag);for(const[name,value]of Object.entries(attributes))node.setAttribute(name,String(value));if(text!==null)node.textContent=text;return node};
const providerClass=id=>id==="chatgpt"?"provider-chatgpt":id==="claude"?"provider-claude":"provider-neutral";

function pathData(points,xScale,yScale){
  return points.map((point,index)=>`${index?"L":"M"} ${xScale(point.timestamp).toFixed(2)} ${yScale(point.value).toFixed(2)}`).join(" ");
}

function axisTime(timestamp,compact){
  return new Intl.DateTimeFormat(undefined,compact?{month:"short",day:"numeric",hour:"2-digit"}:{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(timestamp));
}

function scheduleToggleFocus(host,metricId){
  const focus=()=>{const next=host.querySelector(`[data-comparison-metric="${metricId}"]`);if(!next)return;try{next.focus({preventScroll:true})}catch{next.focus()}};
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
      const next=toggleMetricId(selectedMetricIds,option.id);
      onMetricsChange(next);
      scheduleToggleFocus(host,option.id);
    });
    controls.append(button);
  }
  return controls;
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

function projectionNote(series){
  const subject=`${series.label} · ${series.metric.legendLabel}`;
  if(series.projectionState==="no-history")return`${subject}: no valid history in the displayed range.`;
  if(series.projectionState==="stale")return`${subject}: projection suppressed because the provider is stale.`;
  if(series.projectionState==="insufficient-data")return`${subject}: projection needs at least 3 valid historical points.`;
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

export function renderComparisonChart(host,providers,{metrics=DEFAULT_METRIC_IDS,nowMs=Date.now(),staleMinutes=DEFAULT_STALE_MINUTES,onMetricsChange=null}={}){
  if(!host||typeof document==="undefined")return null;
  const selectedMetricIds=normalizeMetricIds(metrics);
  const prepared=prepareComparisonSeries(providers,selectedMetricIds,{nowMs,staleMinutes});
  host.replaceChildren();

  const card=domEl("section","comparison-chart-card panel");
  card.setAttribute("aria-labelledby","comparison-chart-heading");
  const head=domEl("div","comparison-chart-head");
  const titleWrap=domEl("div"),heading=domEl("h3","","Historical risk trend");
  heading.id="comparison-chart-heading";
  titleWrap.append(domEl("div","eyebrow","72-HOUR VIEW"),heading);
  head.append(titleWrap,domEl("span","comparison-chart-scale","ACTUAL TIME · 0–100%"));
  card.append(head,renderMetricToggles(host,selectedMetricIds,onMetricsChange));

  const figure=domEl("figure","comparison-chart-figure"),legend=domEl("div","comparison-chart-legend");
  for(const series of prepared.series){
    if(series.historical.length)legend.append(legendSeriesItem(series));
  }
  if(prepared.series.some(series=>series.historical.length))legend.append(legendKindItem("historical","Historical"));
  if(prepared.series.some(series=>series.projection.length>1))legend.append(legendKindItem("projected","Projected"));
  if(legend.childElementCount)figure.append(legend);

  const availableWidth=Math.max(280,(host.clientWidth||956)-36),compact=availableWidth<560;
  const width=Math.round(availableWidth),height=compact?292:336;
  const margin={top:27,right:compact?10:18,bottom:compact?42:46,left:compact?39:48};
  const plotWidth=width-margin.left-margin.right,plotHeight=height-margin.top-margin.bottom;
  const xScale=timestamp=>margin.left+(timestamp-prepared.windowStart)/(prepared.windowEnd-prepared.windowStart)*plotWidth;
  const yScale=value=>margin.top+(100-value)/100*plotHeight;
  const svg=svgEl("svg",{id:"comparison-chart-plot",class:"comparison-chart-svg",viewBox:`0 0 ${width} ${height}`,role:"img","aria-labelledby":"comparison-chart-svg-title comparison-chart-svg-desc"});
  const describedProviders=[...new Set(prepared.series.filter(series=>series.historical.length).map(series=>series.label))];
  const providerDescription=describedProviders.length?describedProviders.join(" and "):"available provider";
  const metricDescription=prepared.metrics.map(metric=>metric.label).join(", ");
  svg.append(svgEl("title",{id:"comparison-chart-svg-title"},metricDescription?`${metricDescription} provider history and visual projection`:"Provider history chart with no metrics selected"));
  svg.append(svgEl("desc",{id:"comparison-chart-svg-desc"},metricDescription?`${providerDescription} ${metricDescription} scores over the trailing 72 hours on a fixed zero to one hundred percent scale. Solid lines are historical assessments. Dashed lines are simple six-hour extrapolations when fresh data is sufficient.`:"No metrics are selected. Use the three toggle buttons above the chart to display provider history."));

  const nowX=xScale(prepared.nowMs);
  svg.append(svgEl("rect",{class:"comparison-chart-future",x:nowX,y:margin.top,width:Math.max(0,width-margin.right-nowX),height:plotHeight}));
  for(const tick of[0,25,50,75,100]){
    const y=yScale(tick);
    svg.append(svgEl("line",{class:"comparison-chart-grid",x1:margin.left,y1:y,x2:width-margin.right,y2:y}));
    svg.append(svgEl("text",{class:"comparison-chart-axis-label",x:margin.left-8,y:y+4,"text-anchor":"end"},`${tick}%`));
  }
  const xTickCount=compact?3:5;
  for(let index=0;index<xTickCount;index+=1){
    const ratio=index/(xTickCount-1),timestamp=prepared.windowStart+(prepared.windowEnd-prepared.windowStart)*ratio,x=xScale(timestamp);
    svg.append(svgEl("line",{class:"comparison-chart-tick",x1:x,y1:height-margin.bottom,x2:x,y2:height-margin.bottom+5}));
    const anchor=index===0?"start":index===xTickCount-1?"end":"middle";
    svg.append(svgEl("text",{class:"comparison-chart-axis-label",x,y:height-margin.bottom+18,"text-anchor":anchor},axisTime(timestamp,compact)));
  }

  for(const series of prepared.series){
    const identityClass=`${providerClass(series.id)} ${metricClass(series.metric.id)}`;
    const className=`comparison-chart-series ${identityClass}`;
    for(const segment of splitHistorySegments(series.historical)){
      if(segment.length>1)svg.append(svgEl("path",{class:`${className} series-historical`,d:pathData(segment,xScale,yScale)}));
      else if(segment.length===1)svg.append(svgEl("circle",{class:`comparison-chart-point ${identityClass}`,cx:xScale(segment[0].timestamp),cy:yScale(segment[0].value),r:3}));
    }
    if(series.historical.length){
      const last=series.historical.at(-1),point=svgEl("circle",{class:`comparison-chart-endpoint ${identityClass}`,cx:xScale(last.timestamp),cy:yScale(last.value),r:3.5});
      point.append(svgEl("title",{},`${series.label} · ${series.metric.legendLabel}: ${last.value}% at ${new Date(last.timestamp).toLocaleString()}`));
      svg.append(point);
    }
    if(series.projection.length>1)svg.append(svgEl("path",{class:`${className} series-projected`,d:pathData(series.projection,xScale,yScale)}));
  }

  svg.append(svgEl("line",{class:"comparison-chart-now",x1:nowX,y1:margin.top,x2:nowX,y2:height-margin.bottom}));
  svg.append(svgEl("text",{class:"comparison-chart-now-label",x:Math.min(width-margin.right-2,nowX+5),y:margin.top+11},"NOW"));
  if(!prepared.series.some(series=>series.historical.length))svg.append(svgEl("text",{class:"comparison-chart-empty",x:margin.left+plotWidth/2,y:margin.top+plotHeight/2,"text-anchor":"middle"},prepared.metrics.length?"No valid selected-metric history in the last 72 hours.":"Select one or more metrics to display."));
  figure.append(svg);

  const caption=domEl("figcaption","comparison-chart-caption");
  caption.append(domEl("p","comparison-chart-range","Rolling 72h history + 6h projection · fixed 0–100% scale."),domEl("p","comparison-chart-disclaimer","Projected = simple extrapolation of recent historical scores, not the providers' published forecast."));
  figure.append(caption);
  const notes=prepared.series.map(projectionNote).filter(Boolean);
  if(notes.length){const noteList=domEl("div","comparison-chart-notes");for(const note of notes)noteList.append(domEl("span","",note));figure.append(noteList)}
  card.append(figure);
  host.append(card);
  watchChartWidth(host,providers,{metrics:selectedMetricIds,nowMs,staleMinutes,onMetricsChange});
  return prepared;
}
