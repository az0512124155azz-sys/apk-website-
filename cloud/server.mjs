import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import archiver from 'archiver';
import {ROOT,init,projectDir,safeJoin,readMeta,writeMeta,listDir} from './lib.mjs';
import {decompile,rebuild} from './tasks.mjs';

await init();
const app=express();
const port=Number(process.env.PORT||10000);
const maxMb=Number(process.env.MAX_APK_MB||150);
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

app.get('/',(_req,res)=>res.json({name:'APK Studio Cloud API',ok:true,version:'1.0.0'}));
app.get('/health',async(_req,res)=>{
  res.json({ok:true,version:'1.0.0'});
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
    void decompile(id);
    res.status(202).json(meta);
  }catch(e){next(e);}
});

app.get('/api/projects/:id',async(req,res,next)=>{
  try{
    const m=await readMeta(req.params.id);
    const log=await fs.readFile(path.join(projectDir(req.params.id),'build.log'),'utf8').catch(()=> '');
    res.json({...m,log});
  }catch(e){next(e);}
});

app.delete('/api/projects/:id',async(req,res,next)=>{
  try{await fs.remove(projectDir(req.params.id));res.json({ok:true});}catch(e){next(e);}
});

app.get('/api/projects/:id/tree',async(req,res,next)=>{
  try{
    const root=String(req.query.root||'editable');
    if(!['editable','readable'].includes(root))throw new Error('Invalid root');
    const base=path.join(projectDir(req.params.id),root);
    res.json({items:await listDir(base,String(req.query.path||''))});
  }catch(e){next(e);}
});

app.get('/api/projects/:id/file',async(req,res,next)=>{
  try{
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
    const root=String(req.query.root||'editable');
    if(root!=='editable')throw new Error('Readable source is read-only');
    const file=safeJoin(path.join(projectDir(req.params.id),root),String(req.query.path||''));
    await fs.writeFile(file,String(req.body.content??''),'utf8');
    res.json({ok:true});
  }catch(e){next(e);}
});

app.post('/api/projects/:id/build',async(req,res,next)=>{
  try{void rebuild(req.params.id);res.status(202).json({ok:true});}catch(e){next(e);}
});

app.get('/api/projects/:id/apk',async(req,res,next)=>{
  try{
    const m=await readMeta(req.params.id);
    if(!m.buildArtifact)return res.status(404).json({error:'No rebuilt APK available'});
    res.download(safeJoin(projectDir(req.params.id),m.buildArtifact),'app-rebuilt-unsigned.apk');
  }catch(e){next(e);}
});

app.get('/api/projects/:id/download',async(req,res,next)=>{
  try{
    const dir=projectDir(req.params.id);
    res.attachment('apk-studio-project.zip');
    const a=archiver('zip',{zlib:{level:6}});
    a.on('error',next);a.pipe(res);a.directory(dir,false);await a.finalize();
  }catch(e){next(e);}
});

app.get('/api/projects/:id/vscode',async(req,res,next)=>{
  try{
    const id=req.params.id;
    const dir=projectDir(id);
    const editable=path.join(dir,'editable');
    const readable=path.join(dir,'readable');
    if(!await fs.pathExists(editable)) return res.status(409).json({error:'Project is not ready yet'});

    const workspace={
      folders:[
        {name:'Rebuildable APK',path:'rebuildable'},
        ...((await fs.pathExists(readable)) ? [{name:'Readable Source',path:'readable'}] : [])
      ],
      settings:{
        'files.exclude':{'**/.DS_Store':true},
        'editor.tabSize':2
      }
    };

    res.attachment('apk-studio-vscode.zip');
    const a=archiver('zip',{zlib:{level:6}});
    a.on('error',next);
    a.pipe(res);
    a.directory(editable,'rebuildable');
    if(await fs.pathExists(readable)) a.directory(readable,'readable');
    a.append(JSON.stringify(workspace,null,2),{name:'apk-studio.code-workspace'});
    a.append('Extract this ZIP, then open apk-studio.code-workspace in Visual Studio Code.\n',{name:'OPEN-IN-VSCODE.txt'});
    await a.finalize();
  }catch(e){next(e);}
});

app.use((e,_req,res,_next)=>res.status(e?.code==='LIMIT_FILE_SIZE'?413:400).json({error:e?.message||'Unexpected error'}));
app.listen(port,'0.0.0.0',()=>console.log(`APK Studio Cloud API listening on ${port}`));
