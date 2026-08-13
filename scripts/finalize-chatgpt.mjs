#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { readJson, validateStatus } from "./lib.mjs";

const MODES = new Set(["trend-up", "trend-down", "event/whipsaw", "mixed", "normal"]);
const HOUR_MS = 3600000;
function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function sameInstant(a,b) { return validDate(a) && validDate(b) && Date.parse(a) === Date.parse(b); }
function validateStatusContract(data, now = Date.now()) {
  const errors=[];
  if(!data||typeof data!=="object"||Array.isArray(data)||!validDate(data.generatedAt)) return errors;
  const generatedAt=Date.parse(data.generatedAt),currentHour=Math.floor(generatedAt/HOUR_MS)*HOUR_MS;
  if(generatedAt>now+300000) errors.push("generatedAt is materially in the future");
  if(Array.isArray(data.lookback)&&data.lookback.length===24) data.lookback.forEach((item,index)=>{const expected=currentHour-(24-index)*HOUR_MS;if(!validDate(item?.ts)||Date.parse(item.ts)!==expected)errors.push(`lookback[${index}].ts must be the exact preceding clock-hour slot`);if(!sameInstant(item?.ts,item?.timeBerlin))errors.push(`lookback[${index}].timeBerlin must represent the same instant`);if(item?.available===true&&!MODES.has(item.dominantMode))errors.push(`lookback[${index}].dominantMode invalid`);});
  if(Array.isArray(data.forecast)&&data.forecast.length===24) data.forecast.forEach((item,index)=>{const expected=currentHour+index*HOUR_MS;if(!validDate(item?.ts)||Date.parse(item.ts)!==expected)errors.push(`forecast[${index}].ts must be the exact current/future clock-hour slot`);if(!sameInstant(item?.ts,item?.timeBerlin))errors.push(`forecast[${index}].timeBerlin must represent the same instant`);});
  if(Array.isArray(data.forecastDetail)&&data.forecastDetail.length===6) data.forecastDetail.forEach((item,index)=>{if(!sameInstant(item?.ts,item?.timeBerlin))errors.push(`forecastDetail[${index}].timeBerlin must represent the same instant`);});
  return errors;
}

const root = process.cwd();
const provider = "chatgpt";
const dir = path.join(root, "providers", provider);
const snapshotsDir = path.join(dir, "snapshots");
const historyFile = path.join(dir, "history.json");
const statusFile = path.join(dir, "status.json");
const signalFile = path.join(dir, "signal.json");
function listJsonFiles(dirPath){if(!fs.existsSync(dirPath))return[];const out=[];for(const entry of fs.readdirSync(dirPath,{withFileTypes:true})){const full=path.join(dirPath,entry.name);if(entry.isDirectory())out.push(...listJsonFiles(full));else if(entry.isFile()&&entry.name.endsWith(".json"))out.push(full)}return out}
function repoPath(filePath){return path.relative(root,filePath).split(path.sep).join("/")}
function sameJson(a,b){return JSON.stringify(a)===JSON.stringify(b)}
function historyItem(snapshot,snapshotPath){return{generatedAt:snapshot.generatedAt,status:snapshot.status,action:snapshot.action,tailRiskPct:snapshot.tailRiskPct,tailLevel:snapshot.tailLevel,stressRiskPct:snapshot.stressRiskPct,stressLevel:snapshot.stressLevel,confidencePct:snapshot.confidencePct,confidenceLevel:snapshot.confidenceLevel,dominantMode:snapshot.dominantMode,snapshot:snapshotPath}}
function signalFrom(snapshot){const pause=["STRONG_BLOCK_NO_NEW_RISK","EA_OFF_NO_NEW_RISK"].includes(snapshot.action),caution=["WATCH","BLOCK_NEW_BASE_ENTRIES"].includes(snapshot.action);return{schemaVersion:snapshot.schemaVersion,provider:snapshot.provider,engineVersion:snapshot.engineVersion,promptVersion:snapshot.promptVersion,generatedAt:snapshot.generatedAt,market:snapshot.market,instruments:snapshot.instruments,status:snapshot.status,action:snapshot.action,pause,caution,tailRiskPct:snapshot.tailRiskPct,tailLevel:snapshot.tailLevel,stressRiskPct:snapshot.stressRiskPct,stressLevel:snapshot.stressLevel,confidencePct:snapshot.confidencePct,confidenceLevel:snapshot.confidenceLevel,dominantMode:snapshot.dominantMode,dangerWindow:snapshot.dangerWindow,dangerWindowBerlin:snapshot.dangerWindowBerlin}}
if(!fs.existsSync(historyFile))throw new Error("providers/chatgpt/history.json is missing");
const history=readJson(historyFile);if(!Array.isArray(history.items))throw new Error("ChatGPT history.items must be an array");
const knownGeneratedAt=new Set(history.items.map(item=>item.generatedAt)),knownSnapshots=new Set(history.items.map(item=>item.snapshot));let changed=false;const rejected=[];
const candidates=listJsonFiles(snapshotsDir).map(file=>({file,repo:repoPath(file)})).sort((a,b)=>a.repo.localeCompare(b.repo));
for(const candidate of candidates){const indexed=knownSnapshots.has(candidate.repo);let snapshot;try{snapshot=readJson(candidate.file)}catch(error){if(indexed)throw new Error(`${candidate.repo} is indexed but contains invalid JSON: ${error.message}`);rejected.push(`${candidate.repo}: invalid JSON: ${error.message}`);continue}const errors=validateStatus(snapshot,provider);if(!indexed)errors.push(...validateStatusContract(snapshot));if(errors.length){if(indexed)throw new Error(`${candidate.repo} is indexed but invalid: ${errors.join("; ")}`);rejected.push(`${candidate.repo}: ${errors.join("; ")}`);continue}if(knownGeneratedAt.has(snapshot.generatedAt)||indexed)continue;history.items.push(historyItem(snapshot,candidate.repo));knownGeneratedAt.add(snapshot.generatedAt);knownSnapshots.add(candidate.repo);changed=true}
if(rejected.length){console.warn(`Rejected ${rejected.length} invalid unindexed ChatGPT snapshot(s); continuing with valid snapshots:`);for(const item of rejected)console.warn(`- ${item}`)}
history.items.sort((a,b)=>Date.parse(a.generatedAt)-Date.parse(b.generatedAt));if(!history.items.length)throw new Error("ChatGPT history contains no items");
const latestItem=history.items.at(-1),latestSnapshotFile=path.join(root,latestItem.snapshot);if(!fs.existsSync(latestSnapshotFile))throw new Error(`Latest snapshot does not exist: ${latestItem.snapshot}`);const latestSnapshot=readJson(latestSnapshotFile),latestErrors=validateStatus(latestSnapshot,provider);if(latestErrors.length)throw new Error(`Latest snapshot invalid: ${latestErrors.join("; ")}`);
const existingStatus=fs.existsSync(statusFile)?readJson(statusFile):null,expectedSignal=signalFrom(latestSnapshot),existingSignal=fs.existsSync(signalFile)?readJson(signalFile):null;
if(changed)fs.writeFileSync(historyFile,`${JSON.stringify(history,null,2)}\n`);if(!sameJson(existingStatus,latestSnapshot)){fs.copyFileSync(latestSnapshotFile,statusFile);changed=true}if(!sameJson(existingSignal,expectedSignal)){fs.writeFileSync(signalFile,`${JSON.stringify(expectedSignal,null,2)}\n`);changed=true}
console.log(changed?`Finalized ChatGPT publication at ${latestSnapshot.generatedAt}.`:`ChatGPT publication already coherent at ${latestSnapshot.generatedAt}.`);
