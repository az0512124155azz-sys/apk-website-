import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';
import {createRequire} from 'node:module';
import {projectDir,writeMeta,run,walk,log} from './lib.mjs';
import {startRun,finishRun,setStep,appendStepLog,stepLogFile} from './workflows.mjs';

const require=createRequire(import.meta.url);
const sevenZip=require('7zip-bin');
const sevenZipPath=sevenZip.path7za;

const shortError=e=>String(e?.message||e||'Unknown error').slice(-12000);

export function detectPlatform(filename,requested=''){
  if(['android','windows','linux'].includes(requested))return requested;
  const n=String(filename||'').toLowerCase();
  if(n.endsWith('.apk'))return 'android';
  if(/\.(exe|msi|msix|appx|appxbundle|msixbundle)$/i.test(n))return 'windows';
  if(/\.(appimage|deb|rpm|elf|run)$/i.test(n)||/\.(tar|tar\.gz|tgz|tar\.xz|txz)$/i.test(n))return 'linux';
  if(n.endsWith('.zip')){
    if(/linux|ubuntu|debian|fedora|appimage/i.test(n))return 'linux';
    return 'windows';
  }
  return 'windows';
}

export function detectFormat(filename){
  const n=String(filename||'').toLowerCase();
  for(const ext of ['.tar.gz','.tar.xz','.appxbundle','.msixbundle','.appimage','.msix','.appx','.tgz','.txz','.deb','.rpm','.msi','.exe','.elf','.run','.zip','.tar']){
    if(n.endsWith(ext))return ext.slice(1);
  }
  return (path.extname(n).replace(/^\./,'')||'binary');
}

export function storedOriginalName(filename,platform){
  if(platform==='android')return 'original.apk';
  const f=detectFormat(filename);
  const safe=f.replace(/[^a-z0-9.]+/gi,'-')||'bin';
  return 'original.'+safe;
}

function printableStrings(buf,min=5,max=4000){
  const text=buf.toString('latin1');
  const matches=text.match(/[\x20-\x7E]{5,}/g)||[];
  return matches.slice(0,max);
}

function rebuildCapability(platform,format){
  if(platform==='windows'){
    if(['zip','appx','msix','appxbundle','msixbundle'].includes(format)){
      return {supported:true,mode:'zip',signed:false,outputExtension:format};
    }
    return {supported:false,reason:'This Windows binary can be inspected and its resources can be extracted when supported, but rebuilding an equivalent native EXE/MSI from a compiled binary is not lossless.'};
  }
  if(platform==='linux'){
    if(format==='zip')return {supported:true,mode:'zip',outputExtension:'zip'};
    if(format==='tar')return {supported:true,mode:'tar',outputExtension:'tar'};
    if(['tar.gz','tgz'].includes(format))return {supported:true,mode:'tgz',outputExtension:format};
    if(['tar.xz','txz'].includes(format))return {supported:true,mode:'txz',outputExtension:format};
    return {supported:false,reason:'This Linux binary/package is available for inspection and resource extraction. Native ELF/AppImage/RPM/DEB rebuild requires platform-specific source/package metadata that may not exist in the compiled artifact.'};
  }
  return {supported:false,reason:'Unsupported package type'};
}

async function makeZip(sourceDir,outFile){
  await fs.ensureDir(path.dirname(outFile));
  return new Promise((resolve,reject)=>{
    const output=fs.createWriteStream(outFile);
    const archive=archiver('zip',{zlib:{level:9}});
    output.on('close',resolve);
    archive.on('error',reject);
    archive.pipe(output);
    archive.directory(sourceDir,false);
    archive.finalize();
  });
}

export async function inspectPackage(id){
  const dir=projectDir(id);
  const meta=await fs.readJson(path.join(dir,'project.json'));
  const platform=meta.platform||detectPlatform(meta.originalName);
  const format=meta.format||detectFormat(meta.originalName);
  const source=path.join(dir,meta.sourceFile||storedOriginalName(meta.originalName,platform));
  const editable=path.join(dir,'editable');
  const readable=path.join(dir,'readable');
  await fs.remove(editable).catch(()=>{});
  await fs.remove(readable).catch(()=>{});
  await fs.ensureDir(editable);
  await fs.ensureDir(readable);
  await writeMeta(id,{status:'processing',stage:'extracting',platform,format,error:null});

  const stat=await fs.stat(source);
  const hash=crypto.createHash('sha256');
  await new Promise((resolve,reject)=>{
    const rs=fs.createReadStream(source);
    rs.on('data',d=>hash.update(d));rs.on('end',resolve);rs.on('error',reject);
  });
  const sha256=hash.digest('hex');
  const first=Buffer.alloc(Math.min(stat.size,8*1024*1024));
  const fd=await fs.open(source,'r');
  const read=await fd.read(first,0,first.length,0);
  await fd.close();
  const sample=first.subarray(0,read.bytesRead);
  const strings=printableStrings(sample);
  const magic=sample.subarray(0,16).toString('hex').match(/.{1,2}/g)?.join(' ')||'';
  let archiveList='';
  let extracted=false;
  let extractionError='';

  try{
    await log(id,'Inspecting '+platform+' '+format+' package...');
    const list=await run(id,sevenZipPath,['l','-slt',source],[0,1],{timeoutMs:120000});
    archiveList=(list.out||'')+'\n'+(list.err||'');
    await run(id,sevenZipPath,['x','-y',source,'-o'+editable],[0,1],{timeoutMs:300000});
    const files=await walk(editable,50000);
    extracted=files.length>0;
  }catch(e){
    extractionError=shortError(e);
    await log(id,'Archive extraction not available for this binary: '+extractionError);
  }

  if(!extracted){
    const binaryDir=path.join(editable,'binary');
    await fs.ensureDir(binaryDir);
    await fs.copy(source,path.join(binaryDir,path.basename(meta.originalName||source)));
  }

  const capability=rebuildCapability(platform,format);
  const report=[
    'APK Studio package analysis',
    '===========================',
    '',
    'Platform: '+platform,
    'Format: '+format,
    'Original file: '+meta.originalName,
    'Size: '+stat.size+' bytes',
    'SHA-256: '+sha256,
    'Header: '+magic,
    'Archive/resources extracted: '+(extracted?'yes':'no'),
    'Rebuild supported: '+(capability.supported?'yes':'no'),
    ...(capability.reason?['Reason: '+capability.reason]:[]),
    ...(extractionError?['Extraction note: '+extractionError]:[]),
    '',
    'Important:',
    platform==='windows'
      ? 'Compiled Windows native code cannot be losslessly reconstructed into the original source code. APK Studio exposes package contents, resources, metadata and readable strings where possible.'
      : 'Compiled Linux native code cannot be losslessly reconstructed into the original source code. APK Studio exposes package contents, resources, metadata and readable strings where possible.'
  ].join('\n');
  await fs.writeFile(path.join(readable,'package-info.txt'),report,'utf8');
  await fs.writeFile(path.join(readable,'strings.txt'),strings.join('\n'),'utf8');
  if(archiveList)await fs.writeFile(path.join(readable,'archive-list.txt'),archiveList,'utf8');

  const files=await walk(editable,50000);
  await writeMeta(id,{
    status:'ready',stage:'ready',platform,format,
    editableFileCount:files.length,readableAvailable:true,readableMode:'package-analysis',
    editableRevision:String(Date.now()),
    buildSupported:capability.supported,buildMode:capability.mode||null,
    buildUnsupportedReason:capability.reason||null,
    packageSigned:capability.signed??null,
    buildStatus:null,buildArtifact:null,error:null
  });
}

export async function rebuildPackage(id,{runId}={}){
  const dir=projectDir(id),editable=path.join(dir,'editable'),output=path.join(dir,'output');
  await fs.ensureDir(output);
  const meta=await fs.readJson(path.join(dir,'project.json'));
  const platform=meta.platform||'windows';
  const format=meta.format||'zip';
  const capability=rebuildCapability(platform,format);
  if(!capability.supported)throw new Error(meta.buildUnsupportedReason||'This package is analysis-only.');

  let activeStep='preflight';
  const stepStart=async(stepId,msg)=>{
    activeStep=stepId;
    if(runId)await setStep(id,runId,stepId,'in_progress');
    if(msg){await log(id,msg);if(runId)await appendStepLog(id,runId,stepId,msg)}
  };
  const stepDone=async(stepId,msg)=>{
    if(msg){await log(id,msg);if(runId)await appendStepLog(id,runId,stepId,msg)}
    if(runId)await setStep(id,runId,stepId,'completed');
  };

  if(runId)await startRun(id,runId);
  await log(id,'=== BUILD START ===');
  await stepStart('preflight','Preparing '+platform+' '+format+' package rebuild...');
  await writeMeta(id,{buildStatus:'building',buildStage:'preflight',buildError:null,buildArtifact:null,buildSigned:false});
  await stepDone('preflight','Package workspace is ready.');

  try{
    activeStep='compile';
    await writeMeta(id,{buildStage:'compile'});
    await stepStart('compile','Rebuilding package from editable workspace...');
    const base=(meta.originalName||'package').replace(/\.(tar\.gz|tar\.xz|appxbundle|msixbundle|appimage|msix|appx|tgz|txz|deb|rpm|msi|exe|elf|run|zip|tar)$/i,'');
    const ext=capability.outputExtension||format;
    const artifactName=base+'-rebuilt.'+ext;
    const artifact=path.join(output,artifactName);

    if(capability.mode==='zip'){
      await makeZip(editable,artifact);
      if(runId)await appendStepLog(id,runId,'compile','Created ZIP-compatible package: '+artifactName);
    }else{
      const tarCmd=process.platform==='win32'?'tar.exe':'tar';
      let args=[];
      if(capability.mode==='tar')args=['-cf',artifact,'.'];
      else if(capability.mode==='tgz')args=['-czf',artifact,'.'];
      else if(capability.mode==='txz')args=['-cJf',artifact,'.'];
      await run(id,tarCmd,args,[0],{cwd:editable,timeoutMs:300000,logFile:runId?stepLogFile(id,runId,'compile'):undefined});
    }
    await stepDone('compile','Package rebuild completed.');

    activeStep='verify';
    await writeMeta(id,{buildStage:'verifying'});
    await stepStart('verify','Verifying rebuilt package...');
    if(capability.mode==='zip'){
      await run(id,sevenZipPath,['t',artifact],[0,1],{timeoutMs:120000,logFile:runId?stepLogFile(id,runId,'verify'):undefined});
    }else{
      const tarCmd=process.platform==='win32'?'tar.exe':'tar';
      await run(id,tarCmd,['-tf',artifact],[0],{timeoutMs:120000,logFile:runId?stepLogFile(id,runId,'verify'):undefined});
    }
    await stepDone('verify','Package verification completed.');

    activeStep='artifact';
    await stepStart('artifact','Publishing package artifact...');
    await writeMeta(id,{
      buildStatus:'ready',buildStage:'ready',
      buildArtifact:'output/'+artifactName,
      buildSigned:false,buildFinishedAt:new Date().toISOString(),
      buildRevision:meta.editableRevision||String(Date.now())
    });
    await stepDone('artifact','Artifact is ready to download.');
    if(runId)await finishRun(id,runId,{status:'completed',artifact:'output/'+artifactName});
  }catch(e){
    const err=shortError(e);
    await log(id,'BUILD ERROR: '+err);
    if(runId){
      await appendStepLog(id,runId,activeStep,'ERROR: '+err);
      await setStep(id,runId,activeStep,'failed',{error:err});
      await finishRun(id,runId,{status:'failed',error:err});
    }
    await writeMeta(id,{buildStatus:'error',buildStage:'error',buildError:err,buildArtifact:null,buildSigned:false});
  }
}
