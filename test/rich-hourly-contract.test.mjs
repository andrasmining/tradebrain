import test from"node:test";
import assert from"node:assert/strict";
import fs from"node:fs";
import os from"node:os";
import path from"node:path";
import{spawnSync}from"node:child_process";
import{
  RICH_HOURLY_FORECAST_LIMITS,
  requiresRichHourlyForecast,
  validateStatus
}from"../scripts/lib.mjs";

const PROVIDERS=["chatgpt","claude"];

function currentStatus(provider){return JSON.parse(fs.readFileSync(`providers/${provider}/status.json`,"utf8"))}
function richStatus(provider="chatgpt"){
  const status=structuredClone(currentStatus(provider));
  status.promptVersion="1.3.0";
  status.forecast=status.forecast.map((slot,index)=>({
    ...slot,
    analysis:`Hour ${index+1} remains conditional on the published risk path and evidence known at assessment time.`,
    drivers:[index<6?"Known near-term price-path checkpoint":"Published cross-asset and market-structure baseline"],
    news:index===0?[{title:"Verified report available at assessment time",url:"https://example.com/verified-report",source:"Example News"}]:[]
  }));
  return status;
}
function validationErrors(mutator){
  const status=richStatus();
  mutator(status);
  return validateStatus(status,"chatgpt");
}
function writeJson(root,relative,value){
  const file=path.join(root,relative);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,`${JSON.stringify(value,null,2)}\n`);
}
function copyRuntime(root,provider){
  fs.mkdirSync(path.join(root,"scripts"),{recursive:true});
  for(const file of[`finalize-${provider}.mjs`,"lib.mjs","status-contract.mjs"])fs.copyFileSync(path.join("scripts",file),path.join(root,"scripts",file));
}
function setupFinalizer(root,provider){
  copyRuntime(root,provider);
  const status=currentStatus(provider),signal=JSON.parse(fs.readFileSync(`providers/${provider}/signal.json`,"utf8")),history=JSON.parse(fs.readFileSync(`providers/${provider}/history.json`,"utf8")),latest=history.items.at(-1);
  assert.ok(latest);
  fs.mkdirSync(path.join(root,path.dirname(latest.snapshot)),{recursive:true});
  fs.copyFileSync(latest.snapshot,path.join(root,latest.snapshot));
  writeJson(root,`providers/${provider}/status.json`,status);
  writeJson(root,`providers/${provider}/signal.json`,signal);
  writeJson(root,`providers/${provider}/history.json`,{...history,items:[latest]});
  return status;
}

test("rich hourly contract begins at semantic prompt version 1.3",()=>{
  for(const version of["1.1.0","1.1.1","1.2.0","1.2.1","not-semver"])assert.equal(requiresRichHourlyForecast(version),false,version);
  for(const version of["1.3.0","1.3.0-rc.1","1.4.2","1.10.0","2.0.0","10.1.0"])assert.equal(requiresRichHourlyForecast(version),true,version);
});

test("legacy v1.1 and v1.2 provider publications remain valid without rich fields",()=>{
  for(const provider of PROVIDERS)for(const version of["1.1.0","1.2.0","1.2.1"]){
    const status=currentStatus(provider);
    status.promptVersion=version;
    status.forecast=status.forecast.map(({analysis,drivers,news,...slot})=>slot);
    assert.deepEqual(validateStatus(status,provider),[],`${provider} ${version}`);
  }
});

test("v1.3 accepts complete bounded rich data for all 24 forecast slots",()=>{
  for(const provider of PROVIDERS){
    const status=richStatus(provider);
    assert.equal(status.forecast.length,24);
    assert.deepEqual(validateStatus(status,provider),[]);
  }
  assert.deepEqual(RICH_HOURLY_FORECAST_LIMITS,{
    analysisMaxLength:360,
    driversMinItems:1,
    driversMaxItems:5,
    driverMaxLength:120,
    newsMaxItems:3,
    newsTitleMaxLength:180,
    newsUrlMaxLength:2048,
    newsSourceMaxLength:80
  });
});

test("v1.3 accepts values exactly at every upper bound",()=>{
  const status=richStatus(),slot=status.forecast[0];
  slot.analysis="a".repeat(RICH_HOURLY_FORECAST_LIMITS.analysisMaxLength);
  slot.drivers=Array.from({length:RICH_HOURLY_FORECAST_LIMITS.driversMaxItems},(_,index)=>`${index}${"d".repeat(RICH_HOURLY_FORECAST_LIMITS.driverMaxLength-1)}`);
  slot.news=Array.from({length:RICH_HOURLY_FORECAST_LIMITS.newsMaxItems},(_,index)=>{
    const prefix=`https://example.com/${index}/`;
    return{
      title:`${index}${"t".repeat(RICH_HOURLY_FORECAST_LIMITS.newsTitleMaxLength-1)}`,
      url:`${prefix}${"u".repeat(RICH_HOURLY_FORECAST_LIMITS.newsUrlMaxLength-prefix.length)}`,
      source:"s".repeat(RICH_HOURLY_FORECAST_LIMITS.newsSourceMaxLength)
    };
  });
  assert.deepEqual(validateStatus(status,"chatgpt"),[]);
});

test("v1.3 requires rich fields on every forecast slot",()=>{
  const status=richStatus();
  delete status.forecast[23].analysis;
  delete status.forecast[23].drivers;
  delete status.forecast[23].news;
  const errors=validateStatus(status,"chatgpt");
  assert.ok(errors.includes("forecast[23].analysis must be a non-empty string"));
  assert.ok(errors.includes("forecast[23].drivers must contain 1-5 strings"));
  assert.ok(errors.includes("forecast[23].news must contain at most 3 items"));
});

test("analysis and driver bounds are enforced semantically",()=>{
  assert.ok(validationErrors(status=>{status.forecast[0].analysis="   "}).some(error=>error.includes("analysis must be a non-empty string")));
  assert.ok(validationErrors(status=>{status.forecast[0].analysis="x".repeat(361)}).some(error=>error.includes("analysis must be at most 360")));
  assert.ok(validationErrors(status=>{status.forecast[0].drivers=[]}).some(error=>error.includes("drivers must contain 1-5")));
  assert.ok(validationErrors(status=>{status.forecast[0].drivers=Array.from({length:6},(_,index)=>`Driver ${index}`)}).some(error=>error.includes("drivers must contain 1-5")));
  assert.ok(validationErrors(status=>{status.forecast[0].drivers=["x".repeat(121)]}).some(error=>error.includes("drivers[0] must be at most 120")));
  assert.ok(validationErrors(status=>{status.forecast[0].drivers=["Same","Same"]}).some(error=>error.includes("drivers[1] must be unique")));
});

test("hourly news is bounded to verified-link shape",()=>{
  const uppercaseScheme=richStatus();
  uppercaseScheme.forecast[0].news=[{title:"News",url:"HTTPS://example.com/report"}];
  assert.deepEqual(validateStatus(uppercaseScheme,"chatgpt"),[]);
  assert.ok(validationErrors(status=>{status.forecast[0].news=Array.from({length:4},(_,index)=>({title:`News ${index}`,url:`https://example.com/${index}`}))}).some(error=>error.includes("news must contain at most 3")));
  assert.ok(validationErrors(status=>{status.forecast[0].news=[{title:"   ",url:"https://example.com"}]}).some(error=>error.includes("title must be a non-empty string")));
  assert.ok(validationErrors(status=>{status.forecast[0].news=[{title:"t".repeat(181),url:"https://example.com"}]}).some(error=>error.includes("title must be at most 180")));
  assert.ok(validationErrors(status=>{status.forecast[0].news=[{title:"News",url:"ftp://example.com"}]}).some(error=>error.includes("url must be http/https")));
  assert.ok(validationErrors(status=>{status.forecast[0].news=[{title:"News",url:`https://example.com/${"u".repeat(2049)}`}]}).some(error=>error.includes("url must be at most 2048")));
  assert.ok(validationErrors(status=>{status.forecast[0].news=[{title:"News",url:"https://example.com",prediction:"Tomorrow's headline"}]}).some(error=>error.includes("unsupported property")));
  assert.ok(validationErrors(status=>{status.forecast[0].news=[{title:"News",url:"https://example.com",source:"x".repeat(81)}]}).some(error=>error.includes("source must be at most 80")));
});

test("v1.3 forecast slots reject private fields without rejecting inherited public fields",()=>{
  const inherited=richStatus();
  assert.deepEqual(validateStatus(inherited,"chatgpt"),[]);
  for(const privateField of["privateCalibration","schedulerNotes","api_key","brokerAccount","accountBalance","positionSize","tradingHistory"]){
    const errors=validationErrors(status=>{status.forecast[0][privateField]="must not be public"});
    assert.ok(errors.some(error=>error===`forecast[0].${privateField} is a forbidden private field`),privateField);
  }
  const nestedErrors=validationErrors(status=>{status.forecast[0].news=[{title:"News",url:"https://example.com",privateNotes:{accessToken:"redacted"}}]});
  assert.ok(nestedErrors.some(error=>error.includes("privateNotes is a forbidden private field")));
  assert.ok(nestedErrors.some(error=>error.includes("accessToken is a forbidden private field")));
});

test("v1.3 semantic validation matches the schema's closed forecast shape",()=>{
  const errors=validationErrors(status=>{status.forecast[0].publicContext="unsupported extension"});
  assert.ok(errors.includes("forecast[0] contains an unsupported property"));
});

test("schema conditionally requires the exact rich fields and bounds",()=>{
  const schema=JSON.parse(fs.readFileSync("schemas/risk-state.schema.json","utf8")),defs=schema.$defs;
  const gate=schema.allOf[0],versionPattern=new RegExp(defs.richPromptVersion.pattern);
  assert.deepEqual(gate.if.required,["promptVersion"]);
  assert.equal(gate.if.properties.promptVersion.$ref,"#/$defs/richPromptVersion");
  assert.equal(gate.then.properties.forecast.items.$ref,"#/$defs/richForecast");
  assert.equal(versionPattern.test("1.2.99"),false);
  assert.equal(versionPattern.test("1.3.0"),true);
  assert.equal(versionPattern.test("2.0.0"),true);
  assert.match(defs.richPromptVersion.pattern,/1\\\./);
  assert.deepEqual(defs.richForecast.required.slice(-3),["analysis","drivers","news"]);
  assert.equal(defs.richForecast.additionalProperties,false);
  for(const inherited of["ts","timeBerlin","status","action","tailRiskPct","stressRiskPct","confidencePct","dominantMode"])assert.ok(defs.richForecast.properties[inherited],inherited);
  assert.equal(defs.hourlyAnalysis.maxLength,360);
  assert.equal(defs.hourlyDrivers.minItems,1);
  assert.equal(defs.hourlyDrivers.maxItems,5);
  assert.equal(defs.hourlyDrivers.items.maxLength,120);
  assert.equal(defs.hourlyNews.maxItems,3);
  assert.equal(defs.hourlyNews.items.properties.title.maxLength,180);
  assert.equal(defs.hourlyNews.items.properties.url.maxLength,2048);
  assert.equal(new RegExp(defs.hourlyNews.items.properties.url.pattern).test("HTTPS://example.com/report"),true);
  assert.equal(defs.hourlyNews.items.properties.source.maxLength,80);
  assert.equal(defs.hourlyNews.items.additionalProperties,false);
});

test("staged provider prompts inherit the right contract and prohibit predicted news",()=>{
  const expectations={chatgpt:"v1.2.0",claude:"v1.2.1"};
  for(const[provider,parentVersion]of Object.entries(expectations)){
    const prompt=fs.readFileSync(`prompts/${provider}/v1.3.0.md`,"utf8");
    assert.match(prompt,new RegExp(`prompts/${provider}/${parentVersion.replaceAll(".","\\.")}\\.md`));
    assert.match(prompt,/promptVersion = 1\.3\.0/);
    assert.match(prompt,/every one of the 24 hourly forecast entries/i);
    assert.match(prompt,/1-5 unique/);
    assert.match(prompt,/0-3 items/);
    assert.match(prompt,/already published and verified no later than `generatedAt`/i);
    assert.match(prompt,/Never invent a future headline/i);
    assert.match(prompt,/Never present a scheduled future event as news/i);
    assert.match(prompt,/top-level `events` array/);
    assert.match(prompt,/Do not place private calibration/i);
    assert.match(prompt,/Only the current clock-hour slot may describe genuinely observed price-path structure as a current fact/i);
    assert.match(prompt,/Every later slot must frame unobserved price-path structure conditionally/i);
    assert.match(prompt,/Do not publish 24 copies or near-copies of generic boilerplate/i);
    assert.match(prompt,/forecastDetail\[\].*semantically consistent.*forecast\[\]\.analysis/i);
    assert.match(prompt,/must not contradict that hour's analysis/i);
    assert.match(prompt,/does not activate or migrate the external/i);
    assert.match(prompt,new RegExp(`providers/${provider}/snapshots/\\*\\*`));
  }
});

test("both finalizers preserve rich forecast in status while history and signal stay compact",t=>{
  for(const provider of PROVIDERS){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),`tradebrain-rich-${provider}-`));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const current=setupFinalizer(root,provider),next=richStatus(provider);
    next.generatedAt=new Date(Date.parse(current.generatedAt)+1000).toISOString();
    const snapshot=`providers/${provider}/snapshots/2099/01/v1.3-rich.json`;
    writeJson(root,snapshot,next);
    const result=spawnSync(process.execPath,[`scripts/finalize-${provider}.mjs`],{cwd:root,encoding:"utf8"});
    assert.equal(result.status,0,`${provider}: ${result.stdout}\n${result.stderr}`);
    const finalStatus=JSON.parse(fs.readFileSync(path.join(root,`providers/${provider}/status.json`),"utf8"));
    const history=JSON.parse(fs.readFileSync(path.join(root,`providers/${provider}/history.json`),"utf8"));
    const signal=JSON.parse(fs.readFileSync(path.join(root,`providers/${provider}/signal.json`),"utf8"));
    assert.deepEqual(finalStatus.forecast,next.forecast);
    assert.equal(finalStatus.forecast.every(slot=>typeof slot.analysis==="string"&&Array.isArray(slot.drivers)&&Array.isArray(slot.news)),true);
    assert.equal(history.items.at(-1).snapshot,snapshot);
    for(const key of["forecast","analysis","drivers","news"])assert.equal(key in history.items.at(-1),false,`${provider} history ${key}`);
    for(const key of["forecast","analysis","drivers","news"])assert.equal(key in signal,false,`${provider} signal ${key}`);
  }
});
