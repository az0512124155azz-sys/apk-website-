import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import {projectDir} from './lib.mjs';

const MAX_RUNS=50;

const definitions={
  android:[
    ['preflight','Prepare build'],
    ['compile','Compile APK'],
    ['sign','Sign APK'],
    ['verify','Verify signature'],
    ['artifact','Publish artifact']
  ],
  windows:[
    ['preflight','Prepare Windows package'],
    ['compile','Rebuild Windows package'],
    ['verify','Verify package'],
    ['artifact','Publish artifact']
  ],
  linux:[
    ['preflight','Prepare Linux package'],
    ['compile','Rebuild Linux package'],
    ['verify','Verify package'],
    ['artifact','Publish artifact']
  ]
};

function runsFile(id){return path.join(projectDir(id),'build-runs.json')}
function runDir(id,runId){return path.join(projectDir(id),'runs',runId)}
export function stepLogFile(id,runId,stepId){return path.join(runDir(id,runId),stepId+'.log')}

export async function listBuildRuns(id){
  return fs.readJson(runsFile(id)).catch(()=>[]);
}
async function saveRuns(id,runs){
  await fs.writeJson(runsFile(id),runs.slice(0,MAX_RUNS),{spaces:2});
}
export async function createBuildRun(id,{platform='android',title}={}){
  const previous=await listBuildRuns(id);
  const number=(previous.reduce((m,r)=>Math.max(m,Number(r.number)||0),0)||0)+1;
  const runId=crypto.randomUUID();
  const steps=(definitions[platform]||definitions.android).map(([stepId,name])=>({
    id:stepId,name,status:'queued',startedAt:null,finishedAt:null
  }));
  const run={
    id:runId,number,platform,title:title||('Build '+platform),
    status:'queued',createdAt:new Date().toISOString(),startedAt:null,finishedAt:null,
    currentStep:null,artifact:null,steps
  };
  await fs.ensureDir(runDir(id,runId));
  await saveRuns(id,[run,...previous]);
  return run;
}
async function mutateRun(id,runId,mutator){
  const runs=await listBuildRuns(id);
  const index=runs.findIndex(r=>r.id===runId);
  if(index<0)return null;
  const run=runs[index];
  await mutator(run);
  runs[index]=run;
  await saveRuns(id,runs);
  return run;
}
export async function startRun(id,runId){
  return mutateRun(id,runId,run=>{
    run.status='in_progress';run.startedAt=run.startedAt||new Date().toISOString();
  });
}
export async function finishRun(id,runId,{status='completed',artifact,error}={}){
  return mutateRun(id,runId,run=>{
    run.status=status;run.finishedAt=new Date().toISOString();run.currentStep=null;
    if(artifact)run.artifact=artifact;
    if(error)run.error=String(error).slice(-4000);
  });
}
export async function setStep(id,runId,stepId,status,{error}={}){
  return mutateRun(id,runId,run=>{
    const step=run.steps.find(s=>s.id===stepId);
    if(!step)return;
    step.status=status;
    if(status==='in_progress'){
      step.startedAt=step.startedAt||new Date().toISOString();
      run.currentStep=stepId;
      if(run.status==='queued'){run.status='in_progress';run.startedAt=run.startedAt||new Date().toISOString()}
    }
    if(['completed','failed','skipped'].includes(status))step.finishedAt=new Date().toISOString();
    if(error)step.error=String(error).slice(-4000);
    if(status==='failed'){run.status='failed';run.error=String(error||step.name+' failed').slice(-4000)}
  });
}
export async function appendStepLog(id,runId,stepId,message){
  const file=stepLogFile(id,runId,stepId);
  await fs.ensureDir(path.dirname(file));
  const stamp=new Date().toISOString().slice(11,19);
  await fs.appendFile(file,'['+stamp+'] '+String(message||'')+'\n');
}
export async function readStepLog(id,runId,stepId){
  return fs.readFile(stepLogFile(id,runId,stepId),'utf8').catch(()=>'');
}
