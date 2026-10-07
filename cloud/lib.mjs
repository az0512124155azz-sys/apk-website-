import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const ROOT=process.env.WORKSPACE_ROOT||path.join(os.tmpdir(),'apk-studio-cloud');
export const TOOLS=path.resolve('.tools');
export const java=process.env.JAVA_BIN||path.join(TOOLS,'java','bin','java');
export const jadxJar=path.join(TOOLS,'jadx','lib','jadx-1.5.6-all.jar');
export const apktoolJar=path.join(TOOLS,'apktool','apktool.jar');

export async function init(){await fs.ensureDir(ROOT);}
export function projectDir(id){if(!/^[a-f0-9-]{20,}$/i.test(id))throw new Error('Invalid project id');return path.join(ROOT,id);}
export function safeJoin(base,rel=''){const full=path.resolve(base,String(rel).replaceAll('\\','/').replace(/^\/+/,''));const root=path.resolve(base);if(full!==root&&!full.startsWith(root+path.sep))throw new Error('Unsafe path');return full;}
export async function readMeta(id){return fs.readJson(path.join(projectDir(id),'project.json'));}
export async function writeMeta(id,patch){const f=path.join(projectDir(id),'project.json');const prev=await fs.readJson(f).catch(()=>({}));const next={...prev,...patch,updatedAt:new Date().toISOString()};await fs.writeJson(f,next,{spaces:2});return next;}
export async function log(id,msg){const s=new Date().toISOString().slice(11,19);const line=`[${s}] ${msg}`;console.log(`[JOB ${id}] ${line}`);await fs.appendFile(path.join(projectDir(id),'build.log'),line+'\n');}
export async function run(id,cmd,args,accepted=[0],options={}){
  const secretFlags=new Set(['-storepass','-keypass','--storepass','--keypass']);
  const safeArgs=args.map((x,i)=>secretFlags.has(String(args[i-1]||''))?'***':x);
  const commandLine=`$ ${cmd} ${safeArgs.map(x=>JSON.stringify(x)).join(' ')}`;
  await log(id,commandLine);
  if(options.logFile){await fs.ensureDir(path.dirname(options.logFile));await fs.appendFile(options.logFile,commandLine+'\n')}
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{shell:false});
    let out='',err='',settled=false,idleTimer=null,totalTimer=null;
    const finish=(fn,value)=>{if(settled)return;settled=true;if(idleTimer)clearTimeout(idleTimer);if(totalTimer)clearTimeout(totalTimer);fn(value)};
    const armIdle=()=>{
      if(!options.idleTimeoutMs)return;
      if(idleTimer)clearTimeout(idleTimer);
      idleTimer=setTimeout(()=>{
        log(id,`WARNING: ${path.basename(cmd)} produced no output for ${Math.round(options.idleTimeoutMs/1000)}s; terminating.`).catch(()=>{});
        try{p.kill('SIGKILL')}catch{}
        finish(reject,new Error(`${path.basename(cmd)} idle timeout after ${options.idleTimeoutMs}ms`));
      },options.idleTimeoutMs);
    };
    if(options.timeoutMs){
      totalTimer=setTimeout(()=>{
        log(id,`WARNING: ${path.basename(cmd)} exceeded ${Math.round(options.timeoutMs/1000)}s; terminating.`).catch(()=>{});
        try{p.kill('SIGKILL')}catch{}
        finish(reject,new Error(`${path.basename(cmd)} timeout after ${options.timeoutMs}ms`));
      },options.timeoutMs);
    }
    armIdle();
    p.stdout.on('data',async d=>{armIdle();const s=d.toString();out+=s;await log(id,s.trimEnd());if(options.logFile)await fs.appendFile(options.logFile,s)});
    p.stderr.on('data',async d=>{armIdle();const s=d.toString();err+=s;await log(id,s.trimEnd());if(options.logFile)await fs.appendFile(options.logFile,s)});
    p.on('error',e=>finish(reject,e));
    p.on('close',code=>accepted.includes(code)?finish(resolve,{code,out,err}):finish(reject,new Error(`${path.basename(cmd)} exited with ${code}\n${(err||out).slice(-12000)}`)));
  });
}
export async function walk(dir,limit=50000){const out=[];const stack=[dir];while(stack.length&&out.length<limit){const cur=stack.pop();const es=await fs.readdir(cur,{withFileTypes:true}).catch(()=>[]);for(const e of es){const f=path.join(cur,e.name);if(e.isDirectory())stack.push(f);else out.push(f);if(out.length>=limit)break;}}return out;}
export async function listDir(base,rel=''){const dir=safeJoin(base,rel);const es=await fs.readdir(dir,{withFileTypes:true}).catch(()=>[]);return Promise.all(es.map(async e=>{const p=path.join(dir,e.name);const st=await fs.stat(p);return{name:e.name,type:e.isDirectory()?'dir':'file',size:st.size,path:path.relative(base,p).replaceAll('\\','/')};}));}
