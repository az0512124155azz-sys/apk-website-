import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { spawn } from 'node:child_process';
import {ROOT,init,projectDir,safeJoin,readMeta,writeMeta,listDir} from './lib.mjs';
import {decompile,rebuild,ensureAutomaticSigningKey} from './tasks.mjs';

await init();
const app=express();
const port=Number(process.env.PORT||10000);
const maxMb=Number(process.env.MAX_APK_MB||150);
const sessionSecret=process.env.SESSION_SECRET||'apk-studio-dev-secret-change-me';
const githubClientId=process.env.GITHUB_CLIENT_ID||'';
const githubClientSecret=process.env.GITHUB_CLIENT_SECRET||'';
const publicOrigin=process.env.PUBLIC_ORIGIN||'https://apk-website-sable.vercel.app';
const AGENT_VERSION='1.2.1';
app.use(cors({origin:true}));
app.use((req,_res,next)=>{ console.log(new Date().toISOString(), req.method, req.url); next(); });
app.use(express.json({limit:'10mb'}));

const upload=multer({
  dest:path.join(os.tmpdir(),'apk-studio-upload'),
  limits:{fileSize:maxMb*1024*1024},
  fileFilter:(_req,file,cb)=>{
    const ok=file.originalname.toLowerCase().endsWith('.apk');
    cb(ok?null:new Error('Only APK files are accepted'),ok);
  }
});

const signingUpload=multer({
  dest:path.join(os.tmpdir(),'apk-studio-signing-upload'),
  limits:{fileSize:20*1024*1024},
  fileFilter:(_req,file,cb)=>{
    const name=file.originalname.toLowerCase();
    const ok=name.endsWith('.jks')||name.endsWith('.keystore');
    cb(ok?null:new Error('Only .jks or .keystore files are accepted'),ok);
  }
});

const sessionKey=crypto.createHash('sha256').update(sessionSecret).digest();
function parseCookies(req){
  const out={};
  for(const part of String(req.headers.cookie||'').split(';')){
    const i=part.indexOf('='); if(i<0) continue;
    out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function seal(value){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',sessionKey,iv);
  const enc=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return Buffer.concat([iv,tag,enc]).toString('base64url');
}
function unseal(value){
  if(!value) return null;
  try{
    const b=Buffer.from(value,'base64url'),iv=b.subarray(0,12),tag=b.subarray(12,28),enc=b.subarray(28);
    const decipher=crypto.createDecipheriv('aes-256-gcm',sessionKey,iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc),decipher.final()]).toString('utf8');
  }catch{return null;}
}
function setGithubCookie(res,token){
  const secure='Secure; ';
  res.setHeader('Set-Cookie',`apkstudio_gh=${encodeURIComponent(seal(token))}; Path=/; HttpOnly; ${secure}SameSite=Lax; Max-Age=2592000`);
}
function clearGithubCookie(res){
  res.setHeader('Set-Cookie','apkstudio_gh=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
function githubToken(req){return unseal(parseCookies(req).apkstudio_gh);}
async function gh(token,url,{method='GET',body}={}){
  const r=await fetch(url.startsWith('http')?url:'https://api.github.com'+url,{
    method,
    headers:{
      'Authorization':'Bearer '+token,
      'Accept':'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      ...(body?{'Content-Type':'application/json'}:{})
    },
    body:body?JSON.stringify(body):undefined
  });
  const text=await r.text(); let data=null; try{data=text?JSON.parse(text):null}catch{data=text}
  if(!r.ok){const e=new Error(data?.message||('GitHub HTTP '+r.status));e.status=r.status;throw e}
  return data;
}
async function requireGithub(req){
  const token=githubToken(req); if(!token){const e=new Error('GitHub is not connected');e.status=401;throw e}
  return token;
}
function cleanRepoName(name){
  return String(name||'apk-studio-project').replace(/\.apk$/i,'').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'apk-studio-project';
}
async function killProjectJava(id){
  return new Promise(resolve=>{
    const p=spawn('pkill',['-f',String(id)],{shell:false});
    p.on('error',()=>resolve(false));
    p.on('close',code=>resolve(code===0));
  });
}
async function gitRun(cwd,args,token){
  return new Promise((resolve,reject)=>{
    const basic=Buffer.from('x-access-token:'+token).toString('base64');
    const env={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/.extraheader',GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+basic};
    const p=spawn('git',args,{cwd,env,shell:false});
    let out='',err=''; p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
    p.on('error',reject);p.on('close',code=>code===0?resolve({out,err}):reject(new Error('git '+args[0]+' failed: '+(err||out).slice(-4000))));
  });
}
function vscodeToken(id,expires){
  return crypto.createHmac('sha256',sessionSecret).update(id+'.'+expires).digest('base64url');
}
function validVscodeToken(id,expires,token){
  if(!expires||Number(expires)<Date.now()) return false;
  const expected=vscodeToken(id,expires);
  const a=Buffer.from(expected),b=Buffer.from(String(token||''));
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}

function runCapture(cmd,args,{timeoutMs=15000,cwd}={}){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{shell:false,cwd});
    let out='',err='',done=false;
    const t=setTimeout(()=>{if(done)return;done=true;try{p.kill('SIGKILL')}catch{};reject(new Error('Command timeout'))},timeoutMs);
    p.stdout.on('data',d=>out+=d.toString());
    p.stderr.on('data',d=>err+=d.toString());
    p.on('error',e=>{if(done)return;done=true;clearTimeout(t);reject(e)});
    p.on('close',code=>{if(done)return;done=true;clearTimeout(t);code===0?resolve({out,err}):reject(new Error((err||out||('exit '+code)).slice(-4000)))});
  });
}
function sha256Fingerprint(text){
  const m=String(text||'').match(/SHA256:\s*([0-9A-F:]+)/i);
  return m?m[1].replace(/:/g,'').toUpperCase():null;
}
function parseSigningText(text,baseDir){
  const get=(names)=>{
    for(const name of names){
      const re1=new RegExp('^\\s*'+name+'\\s*[=:]\\s*["\\\']?([^"\\\'\\r\\n]+)','mi');
      const m1=String(text).match(re1); if(m1)return m1[1].trim();
      const re2=new RegExp(name+'\\s*[=:]\\s*["\\\']([^"\\\']+)["\\\']','i');
      const m2=String(text).match(re2); if(m2)return m2[1].trim();
    }
    return '';
  };
  let storeFile=get(['storeFile','store.file']);
  const storePass=get(['storePassword','store.password']);
  const keyAlias=get(['keyAlias','key.alias']);
  const keyPass=get(['keyPassword','key.password'])||storePass;
  if(!storeFile||!storePass)return null;
  storeFile=storeFile.replace(/^file\s*\(/i,'').replace(/[()"']/g,'').trim();
  const resolved=path.isAbsolute(storeFile)?storeFile:path.resolve(baseDir,storeFile);
  return {storeFile:resolved,storePass,keyAlias,keyPass};
}
async function collectSigningConfigs(){
  if(process.env.LOCAL_PROCESSOR!=='1')return [];
  const home=os.homedir();
  const roots=[
    path.join(home,'AndroidStudioProjects'),
    path.join(home,'Documents'),
    path.join(home,'OneDrive','Documents'),
    path.join(home,'Desktop')
  ].filter((v,i,a)=>a.indexOf(v)===i);
  const names=new Set(['key.properties','gradle.properties','build.gradle','build.gradle.kts']);
  const results=[];let visited=0;
  async function walkDir(dir,depth){
    if(depth>5||visited>1200||results.length>100)return;
    visited++;
    let entries;try{entries=await fs.readdir(dir,{withFileTypes:true})}catch{return}
    for(const en of entries){
      if(results.length>100)return;
      if(en.name==='node_modules'||en.name==='.gradle'||en.name==='.git'||en.name==='build'||en.name==='AppData')continue;
      const full=path.join(dir,en.name);
      if(en.isDirectory())await walkDir(full,depth+1);
      else if(names.has(en.name)){
        try{
          const text=await fs.readFile(full,'utf8');
          const parsed=parseSigningText(text,path.dirname(full));
          if(parsed&&await fs.pathExists(parsed.storeFile))results.push({...parsed,source:full});
        }catch{}
      }
    }
  }
  for(const root of roots){if(await fs.pathExists(root))await walkDir(root,0)}
  return results;
}
async function findOriginalSigningKey(id){
  if(process.env.LOCAL_PROCESSOR!=='1')return {found:false,reason:'local-only'};
  const dir=projectDir(id),apk=path.join(dir,'original.apk');
  const javaBin=process.env.JAVA_BIN||'java';
  const keytool=path.join(path.dirname(javaBin),process.platform==='win32'?'keytool.exe':'keytool');
  if(!await fs.pathExists(apk)||!await fs.pathExists(keytool))return {found:false,reason:'missing-tools'};
  let apkInfo;try{apkInfo=await runCapture(keytool,['-printcert','-jarfile',apk],{timeoutMs:20000})}catch{return {found:false,reason:'apk-cert-unreadable'}}
  const target=sha256Fingerprint(apkInfo.out+'\n'+apkInfo.err);if(!target)return {found:false,reason:'no-apk-fingerprint'};
  const configs=await collectSigningConfigs();
  for(const cfg of configs){
    try{
      let alias=cfg.keyAlias;
      if(!alias){
        const l=await runCapture(keytool,['-list','-v','-keystore',cfg.storeFile,'-storepass',cfg.storePass],{timeoutMs:12000});
        const m=(l.out+'\n'+l.err).match(/Alias name:\s*([^\r\n]+)/i); alias=m?m[1].trim():'';
      }
      if(!alias)continue;
      const k=await runCapture(keytool,['-list','-v','-keystore',cfg.storeFile,'-storepass',cfg.storePass,'-alias',alias],{timeoutMs:12000});
      const fp=sha256Fingerprint(k.out+'\n'+k.err);
      if(fp&&fp===target){
        const dest=path.join(dir,'user-signing.keystore');
        await fs.copy(cfg.storeFile,dest,{overwrite:true});
        await fs.writeJson(path.join(dir,'signing-config.json'),{
          alias,storePass:cfg.storePass,keyPass:cfg.keyPass||cfg.storePass,
          fileName:path.basename(cfg.storeFile),autoFound:true,source:cfg.source,updatedAt:new Date().toISOString()
        },{spaces:2});
        await writeMeta(id,{signingType:'Original/custom keystore',signingAutoFound:true,buildStatus:'stale',buildArtifact:null,buildError:null});
        return {found:true,alias,fileName:path.basename(cfg.storeFile),source:cfg.source};
      }
    }catch{}
  }
  return {found:false,reason:'no-matching-key',checked:configs.length};
}
async function streamVsCodeZip(id,res,next){
  try{
    const dir=projectDir(id),editable=path.join(dir,'editable'),readable=path.join(dir,'readable');
    if(!await fs.pathExists(editable)) return res.status(409).json({error:'Project is not ready yet'});
    const workspace={folders:[{name:'Rebuildable APK',path:'rebuildable'},...((await fs.pathExists(readable))?[{name:'Readable Source',path:'readable'}]:[])],settings:{'files.exclude':{'**/.DS_Store':true},'editor.tabSize':2}};
    res.attachment('apk-studio-vscode.zip');
    const a=archiver('zip',{zlib:{level:6}});a.on('error',next);a.pipe(res);
    a.directory(editable,'rebuildable');if(await fs.pathExists(readable))a.directory(readable,'readable');
    a.append(JSON.stringify(workspace,null,2),{name:'apk-studio.code-workspace'});
    await a.finalize();
  }catch(e){next(e);}
}

function autoRepoName(id){return 'apk-studio-'+String(id).toLowerCase();}
async function getGithubUser(token){return gh(token,'/user');}
async function ensureAutoRepo(token,id,meta={}){
  const user=await getGithubUser(token);
  const name=autoRepoName(id);
  let repoInfo;
  try{repoInfo=await gh(token,`/repos/${user.login}/${name}`)}
  catch(e){
    if(e.status!==404)throw e;
    repoInfo=await gh(token,'/user/repos',{method:'POST',body:{name,private:true,description:'APK Studio project: '+String(meta.originalName||id)}});
  }
  await gh(token,`/repos/${user.login}/${name}/topics`,{method:'PUT',body:{names:['apk-studio-project']}}).catch(()=>{});
  return repoInfo;
}
async function syncAutoRepo(token,id,{workspace=true}={}){
  const dir=projectDir(id);
  const meta=await readMeta(id);
  const repoInfo=await ensureAutoRepo(token,id,meta);
  const work=path.join(dir,'github-auto');
  await fs.remove(work);await fs.ensureDir(work);
  let cloned=false;
  try{await gitRun(dir,['clone','--depth','1',repoInfo.clone_url,work],token);cloned=true}catch{}
  if(cloned){for(const entry of await fs.readdir(work)){if(entry!=='.git')await fs.remove(path.join(work,entry))}}
  const original=path.join(dir,'original.apk');
  if(await fs.pathExists(original)){
    const st=await fs.stat(original);
    if(st.size<95*1024*1024)await fs.copy(original,path.join(work,'original.apk'));
  }
  if(workspace){
    const editable=path.join(dir,'editable'),readable=path.join(dir,'readable');
    if(await fs.pathExists(editable))await fs.copy(editable,path.join(work,'rebuildable'));
    if(await fs.pathExists(readable))await fs.copy(readable,path.join(work,'readable'));
  }
  const manifest={format:2,projectId:id,originalName:meta.originalName,size:meta.size,status:meta.status,stage:meta.stage,readableAvailable:meta.readableAvailable,readableMode:meta.readableMode,updatedAt:new Date().toISOString()};
  await fs.writeJson(path.join(work,'apk-studio.json'),manifest,{spaces:2});
  await fs.writeJson(path.join(work,'apk-studio.code-workspace'),{folders:[{name:'Rebuildable APK',path:'rebuildable'},...((await fs.pathExists(path.join(work,'readable')))?[{name:'Readable Source',path:'readable'}]:[])]},{spaces:2});
  if(!cloned)await gitRun(work,['init'],token);
  await gitRun(work,['config','user.name','APK Studio'],token);
  await gitRun(work,['config','user.email','apk-studio@users.noreply.github.com'],token);
  await gitRun(work,['add','-A'],token);
  try{await gitRun(work,['commit','-m',workspace?'Sync APK Studio workspace':'Back up APK Studio upload'],token)}catch(e){if(!String(e.message).includes('nothing to commit'))throw e}
  await gitRun(work,['branch','-M','main'],token);
  if(!cloned)await gitRun(work,['remote','add','origin',repoInfo.clone_url],token);
  await gitRun(work,['push','-u','origin','main'],token);
  const next=await writeMeta(id,{githubRepo:repoInfo.full_name,githubUrl:repoInfo.html_url,githubCloneUrl:repoInfo.clone_url,githubSyncedAt:new Date().toISOString(),persistent:true});
  return {repoInfo,project:next};
}
async function ensureProjectAvailable(req,id){
  const dir=projectDir(id),metaFile=path.join(dir,'project.json');
  if(await fs.pathExists(metaFile))return readMeta(id);
  const token=githubToken(req);
  if(!token){const e=new Error('Project workspace expired after a processor restart. Re-upload the APK or reconnect GitHub to restore synced projects.');e.status=410;throw e}
  const user=await getGithubUser(token),repoName=autoRepoName(id);
  let repoInfo;
  try{repoInfo=await gh(token,`/repos/${user.login}/${repoName}`)}
  catch(e){const err=new Error('Project workspace expired and no GitHub backup was found. Please upload the APK again once; future connected projects are backed up automatically.');err.status=410;throw err}
  await fs.ensureDir(dir);
  const clone=path.join(dir,'restore');
  await gitRun(dir,['clone','--depth','1',repoInfo.clone_url,clone],token);
  const manifest=await fs.readJson(path.join(clone,'apk-studio.json')).catch(()=>({}));
  if(await fs.pathExists(path.join(clone,'original.apk')))await fs.copy(path.join(clone,'original.apk'),path.join(dir,'original.apk'));
  if(await fs.pathExists(path.join(clone,'rebuildable')))await fs.copy(path.join(clone,'rebuildable'),path.join(dir,'editable'));
  if(await fs.pathExists(path.join(clone,'readable')))await fs.copy(path.join(clone,'readable'),path.join(dir,'readable'));
  const restored={id,originalName:manifest.originalName||repoName+'.apk',size:manifest.size||0,status:(await fs.pathExists(path.join(dir,'editable')))?'ready':'queued',stage:(await fs.pathExists(path.join(dir,'editable')))?'ready':'queued',readableAvailable:manifest.readableAvailable!==false,readableMode:manifest.readableMode||'github',githubRepo:repoInfo.full_name,githubUrl:repoInfo.html_url,githubCloneUrl:repoInfo.clone_url,persistent:true,restoredAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await fs.writeJson(metaFile,restored,{spaces:2});await fs.writeFile(path.join(dir,'build.log'),'[restored from GitHub]\n');
  if(restored.status==='queued'&&await fs.pathExists(path.join(dir,'original.apk')))void decompile(id);
  return restored;
}

app.get('/',(_req,res)=>res.json({name:'APK Studio Processor',ok:true,version:AGENT_VERSION,local:process.env.LOCAL_PROCESSOR==='1'}));
app.get('/health',async(_req,res)=>{
  res.json({ok:true,version:AGENT_VERSION,local:process.env.LOCAL_PROCESSOR==='1'});
});

app.post('/api/local/update',async(req,res,next)=>{
  try{
    if(process.env.LOCAL_PROCESSOR!=='1')return res.status(403).json({error:'Local update is only available on This computer mode'});
    const cloudDir=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/,m=>m.slice(1)));
    const installDir=path.dirname(cloudDir);
    const updater=path.join(cloudDir,'self-update-windows.ps1');
    if(process.platform!=='win32'||!await fs.pathExists(updater))return res.status(501).json({error:'Local self-update is not available on this platform'});
    const pid=process.pid;
    const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',updater,'-InstallDir',installDir,'-ServerPid',String(pid)],{
      detached:true,stdio:'ignore',windowsHide:true
    });
    p.unref();
    res.status(202).json({ok:true,updating:true,version:AGENT_VERSION});
  }catch(e){next(e);}
});

app.get('/api/projects',async(_req,res)=>{
  const es=await fs.readdir(ROOT,{withFileTypes:true}).catch(()=>[]);
  const projects=[];
  for(const e of es){if(!e.isDirectory())continue;const m=await fs.readJson(path.join(ROOT,e.name,'project.json')).catch(()=>null);if(m)projects.push(m);}
  projects.sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  res.json({projects});
});

app.post('/api/projects/upload',upload.single('apk'),async(req,res,next)=>{
  try{
    if(!req.file)throw new Error('APK file is required');
    const id=crypto.randomUUID(),dir=projectDir(id);
    await fs.ensureDir(dir);
    await fs.move(req.file.path,path.join(dir,'original.apk'),{overwrite:true});
    const meta={id,originalName:req.file.originalname,size:req.file.size,status:'queued',stage:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await fs.writeJson(path.join(dir,'project.json'),meta,{spaces:2});
    await fs.writeFile(path.join(dir,'build.log'),'');
    const token=githubToken(req);
    if(token){
      try{const backup=await syncAutoRepo(token,id,{workspace:false});Object.assign(meta,backup.project)}
      catch(e){await fs.appendFile(path.join(dir,'build.log'),'[warning] GitHub backup failed: '+String(e.message||e)+'\n')}
    }
    void (async()=>{await decompile(id);if(token){try{await syncAutoRepo(token,id,{workspace:true})}catch(e){await fs.appendFile(path.join(dir,'build.log'),'[warning] GitHub workspace sync failed: '+String(e.message||e)+'\n')}}})();
    res.status(202).json(await readMeta(id));
  }catch(e){next(e);}
});

app.get('/api/projects/:id',async(req,res,next)=>{
  try{
    const m=await ensureProjectAvailable(req,req.params.id);
    const log=await fs.readFile(path.join(projectDir(req.params.id),'build.log'),'utf8').catch(()=> '');
    res.json({...m,log});
  }catch(e){next(e);}
});

app.delete('/api/projects/:id',async(req,res,next)=>{
  try{await fs.remove(projectDir(req.params.id));res.json({ok:true});}catch(e){next(e);}
});

app.get('/api/projects/:id/tree',async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    const root=String(req.query.root||'editable');
    if(!['editable','readable'].includes(root))throw new Error('Invalid root');
    const base=path.join(projectDir(req.params.id),root);
    res.json({items:await listDir(base,String(req.query.path||''))});
  }catch(e){next(e);}
});

app.get('/api/projects/:id/file',async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    const root=String(req.query.root||'editable');
    if(!['editable','readable'].includes(root))throw new Error('Invalid root');
    const file=safeJoin(path.join(projectDir(req.params.id),root),String(req.query.path||''));
    const st=await fs.stat(file);
    if(st.size>2*1024*1024)return res.status(413).json({error:'File too large for browser editor'});
    const buf=await fs.readFile(file);
    const binary=buf.includes(0);
    res.json(binary?{binary:true,size:st.size}:{binary:false,size:st.size,content:buf.toString('utf8')});
  }catch(e){next(e);}
});

app.put('/api/projects/:id/file',async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    const root=String(req.query.root||'editable');
    if(root!=='editable')throw new Error('Readable source is read-only');
    const file=safeJoin(path.join(projectDir(req.params.id),root),String(req.query.path||''));
    await fs.writeFile(file,String(req.body.content??''),'utf8');
    const meta=await writeMeta(req.params.id,{
      editableRevision:String(Date.now()),
      buildStatus:'stale',
      buildStage:null,
      buildArtifact:null,
      buildError:null
    });
    res.json({ok:true,editableRevision:meta.editableRevision});
  }catch(e){next(e);}
});

app.post('/api/projects/:id/signing/auto-find',async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    const result=await findOriginalSigningKey(req.params.id);
    res.json(result);
  }catch(e){next(e);}
});

app.get('/api/projects/:id/signing',async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    const dir=projectDir(req.params.id);
    const cfg=await fs.readJson(path.join(dir,'signing-config.json')).catch(()=>null);
    res.json({
      mode:cfg?'custom':'apkstudio',
      configured:!!cfg,
      alias:cfg?.alias||null,
      fileName:cfg?.fileName||null,
      autoFound:false,
      automaticReady:await fs.pathExists(path.join(dir,'apkstudio-signing.jks'))
    });
  }catch(e){next(e);}
});

app.post('/api/projects/:id/signing/prepare',async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    const dir=projectDir(req.params.id);
    const cfg=await fs.readJson(path.join(dir,'signing-config.json')).catch(()=>null);
    if(cfg && await fs.pathExists(path.join(dir,'user-signing.keystore'))){
      return res.json({ok:true,mode:'custom',configured:true,automaticReady:false});
    }
    await ensureAutomaticSigningKey(req.params.id);
    res.json({ok:true,mode:'apkstudio',configured:false,automaticReady:true});
  }catch(e){next(e);}
});

app.post('/api/projects/:id/signing',signingUpload.single('keystore'),async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    if(!req.file)throw new Error('Keystore file is required');
    const alias=String(req.body.alias||'').trim();
    const storePass=String(req.body.storePass||'');
    const keyPass=String(req.body.keyPass||storePass);
    if(!alias)throw new Error('Key alias is required');
    if(!storePass)throw new Error('Keystore password is required');
    const dir=projectDir(req.params.id);
    const dest=path.join(dir,'user-signing.keystore');
    await fs.move(req.file.path,dest,{overwrite:true});
    await fs.writeJson(path.join(dir,'signing-config.json'),{
      alias,storePass,keyPass,fileName:req.file.originalname,updatedAt:new Date().toISOString()
    },{spaces:2});
    await writeMeta(req.params.id,{
      signingType:'Original/custom keystore',
      buildStatus:'stale',
      buildArtifact:null,
      buildError:null
    });
    res.json({ok:true,mode:'custom',alias,fileName:req.file.originalname});
  }catch(e){
    if(req.file?.path)await fs.remove(req.file.path).catch(()=>{});
    next(e);
  }
});

app.delete('/api/projects/:id/signing',async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    const dir=projectDir(req.params.id);
    await fs.remove(path.join(dir,'signing-config.json'));
    await fs.remove(path.join(dir,'user-signing.keystore'));
    await writeMeta(req.params.id,{
      signingType:'APK Studio project key',
      buildStatus:'stale',
      buildArtifact:null,
      buildError:null
    });
    res.json({ok:true,mode:'apkstudio'});
  }catch(e){next(e);}
});

app.post('/api/projects/:id/recover',async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    await killProjectJava(req.params.id);
    await fs.appendFile(path.join(projectDir(req.params.id),'build.log'),'[recovery] Stalled full JADX detected. Switching to per-DEX fallback.\n');
    await writeMeta(req.params.id,{status:'processing',stage:'jadx-fallback',recoveryStartedAt:new Date().toISOString(),error:null});
    void decompile(req.params.id,{forceJadxOom:true});
    res.status(202).json({ok:true,stage:'jadx-fallback'});
  }catch(e){next(e);}
});

app.post('/api/projects/:id/build',async(req,res,next)=>{
  try{
    const meta=await ensureProjectAvailable(req,req.params.id);
    if(meta.buildStatus==='building')return res.status(202).json({ok:true,alreadyBuilding:true,stage:meta.buildStage||'building'});
    const dir=projectDir(req.params.id);
    const cfg=await fs.readJson(path.join(dir,'signing-config.json')).catch(()=>null);
    const customReady=!!cfg && await fs.pathExists(path.join(dir,'user-signing.keystore'));
    const automaticReady=await fs.pathExists(path.join(dir,'apkstudio-signing.jks'));
    if(!customReady && !automaticReady){
      return res.status(409).json({error:'Signing key is not ready yet. Wait for APK Studio to prepare the signing key before building.'});
    }
    await writeMeta(req.params.id,{buildStatus:'building',buildStage:'queued',buildStartedAt:new Date().toISOString(),buildError:null});
    void rebuild(req.params.id);
    res.status(202).json({ok:true,stage:'queued'});
  }catch(e){next(e);}
});

app.get('/api/projects/:id/apk',async(req,res,next)=>{
  try{
    const m=await readMeta(req.params.id);
    if(!m.buildArtifact)return res.status(404).json({error:'No rebuilt APK available'});
    res.download(safeJoin(projectDir(req.params.id),m.buildArtifact),m.buildSigned?'app-rebuilt-signed.apk':'app-rebuilt.apk');
  }catch(e){next(e);}
});

app.get('/api/projects/:id/download',async(req,res,next)=>{
  try{
    await ensureProjectAvailable(req,req.params.id);
    const dir=projectDir(req.params.id);
    res.attachment('apk-studio-project.zip');
    const a=archiver('zip',{zlib:{level:6}});
    a.on('error',next);a.pipe(res);a.directory(dir,false);await a.finalize();
  }catch(e){next(e);}
});

app.get('/api/projects/:id/vscode',async(req,res,next)=>streamVsCodeZip(req.params.id,res,next));

app.get('/api/projects/:id/vscode-link',async(req,res,next)=>{
  try{
    const meta=await ensureProjectAvailable(req,req.params.id);
    const expires=Date.now()+5*60*1000;
    const token=vscodeToken(req.params.id,expires);
    const download=`${publicOrigin}/processor/api/projects/${req.params.id}/vscode-download?expires=${expires}&token=${encodeURIComponent(token)}`;
    const name=cleanRepoName(meta.originalName||req.params.id);
    res.json({url:`apkstudio://open?download=${encodeURIComponent(download)}&name=${encodeURIComponent(name)}`,expires});
  }catch(e){next(e);}
});

app.get('/api/projects/:id/vscode-download',async(req,res,next)=>{
  if(!validVscodeToken(req.params.id,req.query.expires,req.query.token)) return res.status(403).json({error:'VS Code link expired or invalid'});
  return streamVsCodeZip(req.params.id,res,next);
});

app.get('/api/github/config',(_req,res)=>res.json({oauth:!!(githubClientId&&githubClientSecret)}));

app.get('/api/github/oauth/start',(req,res)=>{
  if(!githubClientId||!githubClientSecret) return res.status(501).json({error:'GitHub OAuth is not configured on the server'});
  const requested=String(req.query.returnTo||publicOrigin);
  let returnTo=publicOrigin;
  try{
    const u=new URL(requested);
    const allowed=new URL(publicOrigin);
    if(u.origin===allowed.origin)returnTo=u.origin+u.pathname;
  }catch{}
  const state=seal(JSON.stringify({createdAt:Date.now(),returnTo}));
  res.redirect('https://github.com/login/oauth/authorize?client_id='+encodeURIComponent(githubClientId)+'&scope=repo%20read:user&state='+encodeURIComponent(state));
});

app.get('/api/github/oauth/callback',async(req,res,next)=>{
  try{
    if(!githubClientId||!githubClientSecret) throw new Error('GitHub OAuth is not configured');
    const code=String(req.query.code||''); if(!code) throw new Error('Missing GitHub OAuth code');
    let returnTo=publicOrigin;
    const stateRaw=unseal(String(req.query.state||''));
    if(stateRaw){
      try{
        const st=JSON.parse(stateRaw);
        if(st.returnTo&&Date.now()-Number(st.createdAt||0)<10*60*1000)returnTo=st.returnTo;
      }catch{}
    }
    const r=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:githubClientId,client_secret:githubClientSecret,code})});
    const d=await r.json(); if(!d.access_token) throw new Error(d.error_description||d.error||'GitHub OAuth failed');
    const handoff=seal(JSON.stringify({token:d.access_token,expires:Date.now()+5*60*1000}));
    res.redirect(returnTo+(returnTo.includes('?')?'&':'?')+'github_handoff='+encodeURIComponent(handoff));
  }catch(e){next(e);}
});

app.post('/api/github/oauth/handoff',async(req,res,next)=>{
  try{
    const raw=unseal(String(req.body.handoff||'')); if(!raw) throw new Error('Invalid GitHub handoff');
    const data=JSON.parse(raw); if(!data.token||!data.expires||Number(data.expires)<Date.now()) throw new Error('GitHub handoff expired');
    const user=await gh(data.token,'/user');
    setGithubCookie(res,data.token);
    res.json({connected:true,user:{login:user.login,name:user.name,avatar_url:user.avatar_url}});
  }catch(e){next(e);}
});

app.post('/api/github/connect',async(req,res,next)=>{
  try{
    const token=String(req.body.token||'').trim(); if(!token) throw new Error('GitHub token is required');
    const user=await gh(token,'/user'); setGithubCookie(res,token);
    res.json({connected:true,user:{login:user.login,name:user.name,avatar_url:user.avatar_url}});
  }catch(e){next(e);}
});
app.post('/api/github/disconnect',(_req,res)=>{clearGithubCookie(res);res.json({connected:false})});
app.get('/api/github/me',async(req,res,next)=>{
  try{const token=githubToken(req);if(!token)return res.json({connected:false});const user=await gh(token,'/user');res.json({connected:true,user:{login:user.login,name:user.name,avatar_url:user.avatar_url}})}catch(e){clearGithubCookie(res);res.json({connected:false})}
});
app.get('/api/github/projects',async(req,res,next)=>{
  try{
    const token=await requireGithub(req);const repos=await gh(token,'/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator');
    const projects=repos.filter(r=>Array.isArray(r.topics)&&r.topics.includes('apk-studio-project')).map(r=>({full_name:r.full_name,name:r.name,private:r.private,html_url:r.html_url,clone_url:r.clone_url,updated_at:r.updated_at,description:r.description}));
    res.json({projects});
  }catch(e){next(e);}
});
app.post('/api/projects/:id/github/push',async(req,res,next)=>{
  try{
    const token=await requireGithub(req);const user=await gh(token,'/user');const meta=await readMeta(req.params.id);
    const repoName=cleanRepoName(req.body.repoName||meta.originalName||req.params.id);const privateRepo=req.body.private!==false;
    let repoInfo;try{repoInfo=await gh(token,`/repos/${user.login}/${repoName}`)}catch(e){if(e.status!==404)throw e;repoInfo=await gh(token,'/user/repos',{method:'POST',body:{name:repoName,private:privateRepo,description:'APK Studio project'}})}
    await gh(token,`/repos/${user.login}/${repoName}/topics`,{method:'PUT',body:{names:['apk-studio-project']}}).catch(()=>{});

    const dir=projectDir(req.params.id),work=path.join(dir,'github-work');
    await fs.remove(work);await fs.ensureDir(work);
    let cloned=false;
    try{await gitRun(dir,['clone','--depth','1',repoInfo.clone_url,work],token);cloned=true}catch{}
    if(cloned){
      for(const entry of await fs.readdir(work)){if(entry!=='.git')await fs.remove(path.join(work,entry))}
    }
    const editable=path.join(dir,'editable'),readable=path.join(dir,'readable');
    if(await fs.pathExists(editable))await fs.copy(editable,path.join(work,'rebuildable'));
    if(await fs.pathExists(readable))await fs.copy(readable,path.join(work,'readable'));
    const original=path.join(dir,'original.apk');if(await fs.pathExists(original)){const st=await fs.stat(original);if(st.size<95*1024*1024)await fs.copy(original,path.join(work,'original.apk'))}
    const manifest={format:1,projectId:req.params.id,originalName:meta.originalName,size:meta.size,readableAvailable:meta.readableAvailable,readableMode:meta.readableMode,updatedAt:new Date().toISOString()};
    await fs.writeJson(path.join(work,'apk-studio.json'),manifest,{spaces:2});
    await fs.writeJson(path.join(work,'apk-studio.code-workspace'),{folders:[{name:'Rebuildable APK',path:'rebuildable'},...((await fs.pathExists(path.join(work,'readable')))?[{name:'Readable Source',path:'readable'}]:[])]},{spaces:2});
    if(!cloned)await gitRun(work,['init'],token);
    await gitRun(work,['config','user.name','APK Studio'],token);await gitRun(work,['config','user.email','apk-studio@users.noreply.github.com'],token);
    await gitRun(work,['add','-A'],token);
    try{await gitRun(work,['commit','-m',String(req.body.message||'Sync APK Studio project')],token)}catch(e){if(!String(e.message).includes('nothing to commit'))throw e}
    await gitRun(work,['branch','-M','main'],token);
    if(!cloned)await gitRun(work,['remote','add','origin',repoInfo.clone_url],token);
    await gitRun(work,['push','-u','origin','main'],token);
    const next=await writeMeta(req.params.id,{githubRepo:repoInfo.full_name,githubUrl:repoInfo.html_url,githubCloneUrl:repoInfo.clone_url,githubSyncedAt:new Date().toISOString()});
    res.json({ok:true,repo:{full_name:repoInfo.full_name,html_url:repoInfo.html_url,clone_url:repoInfo.clone_url},project:next});
  }catch(e){next(e);}
});
app.post('/api/github/import',async(req,res,next)=>{
  try{
    const token=await requireGithub(req),fullName=String(req.body.fullName||'');if(!/^[^/]+\/[^/]+$/.test(fullName))throw new Error('Invalid repository name');
    const repoInfo=await gh(token,'/repos/'+fullName);const id=crypto.randomUUID(),dir=projectDir(id),clone=path.join(dir,'repo');
    await fs.ensureDir(dir);await gitRun(dir,['clone','--depth','1',repoInfo.clone_url,clone],token);
    const manifest=await fs.readJson(path.join(clone,'apk-studio.json')).catch(()=>({}));
    if(await fs.pathExists(path.join(clone,'rebuildable')))await fs.copy(path.join(clone,'rebuildable'),path.join(dir,'editable'));
    if(await fs.pathExists(path.join(clone,'readable')))await fs.copy(path.join(clone,'readable'),path.join(dir,'readable'));
    if(await fs.pathExists(path.join(clone,'original.apk')))await fs.copy(path.join(clone,'original.apk'),path.join(dir,'original.apk'));
    const meta={id,originalName:manifest.originalName||repoInfo.name+'.apk',size:manifest.size||0,status:'ready',stage:'ready',readableAvailable:manifest.readableAvailable!==false,readableMode:manifest.readableMode||'github',githubRepo:repoInfo.full_name,githubUrl:repoInfo.html_url,githubCloneUrl:repoInfo.clone_url,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await fs.writeJson(path.join(dir,'project.json'),meta,{spaces:2});await fs.writeFile(path.join(dir,'build.log'),'');
    res.status(201).json(meta);
  }catch(e){next(e);}
});


app.get('/api/selftest/start',async(req,res,next)=>{
  try{
    const id=crypto.randomUUID();
    const dir=projectDir(id);
    await fs.ensureDir(dir);
    const selftestFile=path.join(dir,'selftest.json');
    await fs.writeJson(selftestFile,{id,status:'starting',checks:{},startedAt:new Date().toISOString()},{spaces:2});

    void (async()=>{
      const update=async patch=>{
        const prev=await fs.readJson(selftestFile).catch(()=>({id,checks:{}}));
        const next={...prev,...patch,checks:{...(prev.checks||{}),...(patch.checks||{})}};await fs.writeJson(selftestFile,next,{spaces:2});console.log('[SELFTEST] STATE',JSON.stringify(next));
      };
      try{
        const sample='https://raw.githubusercontent.com/wuyr/HexagramDecoder/master/app-debug.apk';
        await update({status:'downloading'});
        const response=await fetch(sample);
        if(!response.ok) throw new Error('Sample APK download failed: HTTP '+response.status);
        const buf=Buffer.from(await response.arrayBuffer());
        await fs.writeFile(path.join(dir,'original.apk'),buf);
        const meta={id,originalName:'sentry-demo-app-debug.apk',size:buf.length,status:'queued',stage:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        await fs.writeJson(path.join(dir,'project.json'),meta,{spaces:2});
        await fs.writeFile(path.join(dir,'build.log'),'');
        await update({status:'decompiling',checks:{download:true,apkBytes:buf.length}});

        await decompile(id,{forceJadxOom:true});
        const after=await readMeta(id);
        const fallbackPass=after.status==='ready' && after.readableAvailable===true && String(after.readableMode||'').startsWith('per-dex') && after.readableDexCount>0 && after.jadxWarnings===true;
        await update({status:'tree',checks:{oomFallback:fallbackPass,decompileStatus:after.status}});

        if(after.status!=='ready') throw new Error('Fallback decompile did not reach ready: '+(after.error||after.status));
        const editable=path.join(dir,'editable');
        const rootItems=await listDir(editable,'');
        const treePass=rootItems.length>0;
        const yaml=path.join(editable,'apktool.yml');
        const before=await fs.readFile(yaml,'utf8');
        await fs.writeFile(yaml,before+'\n# apk-studio-selftest\n','utf8');
        const afterWrite=await fs.readFile(yaml,'utf8');
        const writePass=afterWrite.includes('# apk-studio-selftest');
        await update({status:'building',checks:{tree:treePass,fileRead:before.length>0,fileWrite:writePass}});

        await rebuild(id);
        const built=await readMeta(id);
        const artifact=built.buildArtifact ? safeJoin(dir,built.buildArtifact) : '';
        const buildPass=built.buildStatus==='ready' && artifact && await fs.pathExists(artifact);
        await update({
          status:buildPass?'passed':'failed',
          finishedAt:new Date().toISOString(),
          checks:{build:!!buildPass,buildStatus:built.buildStatus},
          projectId:id,
          error:buildPass?null:(built.buildError||'Build artifact missing')
        });
      }catch(e){
        await update({status:'failed',finishedAt:new Date().toISOString(),error:String(e?.message||e)});
      }
    })();

    res.json({ok:true,selftestId:id,statusUrl:'/api/selftest/status/'+id});
  }catch(e){next(e);}
});

app.get('/api/selftest/status/:id',async(req,res,next)=>{
  try{
    const file=path.join(projectDir(req.params.id),'selftest.json');
    res.json(await fs.readJson(file));
  }catch(e){next(e);}
});

app.use((e,_req,res,_next)=>res.status(e?.status|| (e?.code==='LIMIT_FILE_SIZE'?413:400)).json({error:e?.message||'Unexpected error'}));
app.listen(port,'0.0.0.0',async()=>{
  console.log(`APK Studio Cloud API listening on ${port}`);
  if(process.env.SELFTEST_ON_BOOT==='1'){
    try{
      console.log('[SELFTEST] starting');
      const start=await fetch(`http://127.0.0.1:${port}/api/selftest/start`).then(r=>r.json());
      console.log('[SELFTEST] id',start.selftestId);
      for(let i=0;i<180;i++){
        await new Promise(r=>setTimeout(r,2000));
        const state=await fetch(`http://127.0.0.1:${port}/api/selftest/status/${start.selftestId}`).then(r=>r.json());
        if(state.status==='passed'||state.status==='failed'){
          console.log('[SELFTEST] RESULT',JSON.stringify(state));
          break;
        }
      }
    }catch(e){
      console.error('[SELFTEST] BOOT ERROR',e);
    }
  }
});
