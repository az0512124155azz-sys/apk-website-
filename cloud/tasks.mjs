import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import AdmZip from 'adm-zip';
import {java,jadxJar,apktoolJar,projectDir,writeMeta,run,walk,log} from './lib.mjs';
import {startRun,finishRun,setStep,appendStepLog,stepLogFile} from './workflows.mjs';

const shortError = (e) => String(e?.message || e || 'Unknown error').slice(-12000);
const localMode = process.env.LOCAL_PROCESSOR === '1';
const javaXmx = process.env.APK_STUDIO_JAVA_XMX || (localMode ? '4096m' : '352m');
const javaXms = process.env.APK_STUDIO_JAVA_XMS || (localMode ? '256m' : '64m');
const autoThreads = localMode ? Math.max(2,Math.min(8,os.cpus()?.length||4)) : 1;
const workerThreads = String(Number(process.env.APK_STUDIO_THREADS || autoThreads));
const javaBinDir = path.dirname(java);
const isWindows = process.platform === 'win32';
const keytoolBin = path.join(javaBinDir,isWindows?'keytool.exe':'keytool');
const jarsignerBin = path.join(javaBinDir,isWindows?'jarsigner.exe':'jarsigner');
const signingAlias = 'apkstudio';

async function ensureAutomaticSigningConfig(dir){
  const configFile=path.join(dir,'automatic-signing.json');
  let cfg=await fs.readJson(configFile).catch(()=>null);
  if(!cfg?.storePass){
    const secret=crypto.randomBytes(24).toString('base64url');
    cfg={
      alias:signingAlias,
      storePass:secret,
      keyPass:secret,
      createdAt:new Date().toISOString()
    };
    await fs.writeJson(configFile,cfg,{spaces:2});
  }
  return cfg;
}

async function signingConfigFor(dir){
  const customFile=path.join(dir,'signing-config.json');
  const customKey=path.join(dir,'user-signing.keystore');
  if(await fs.pathExists(customFile) && await fs.pathExists(customKey)){
    const cfg=await fs.readJson(customFile);
    const keyHash=crypto.createHash('sha256').update(await fs.readFile(customKey)).digest('hex');
    return {
      type:'custom',
      keystore:customKey,
      alias:String(cfg.alias||''),
      storePass:String(cfg.storePass||''),
      keyPass:String(cfg.keyPass||cfg.storePass||''),
      fingerprint:'custom:'+keyHash+':'+String(cfg.alias||'')
    };
  }
  const auto=await ensureAutomaticSigningConfig(dir);
  return {
    type:'apkstudio',
    keystore:path.join(dir,'apkstudio-signing.jks'),
    alias:auto.alias||signingAlias,
    storePass:auto.storePass,
    keyPass:auto.keyPass||auto.storePass,
    fingerprint:'apkstudio:'+crypto.createHash('sha256').update(auto.storePass).digest('hex')
  };
}

export async function ensureAutomaticSigningKey(id){
  const dir=projectDir(id);
  const signing=await signingConfigFor(dir);
  if(signing.type!=='apkstudio')return signing;

  const keytool=await fs.pathExists(keytoolBin) ? keytoolBin : (isWindows?'keytool.exe':'keytool');

  if(await fs.pathExists(signing.keystore)){
    try{
      await run(id,keytool,[
        '-list','-keystore',signing.keystore,
        '-storepass',signing.storePass,
        '-alias',signing.alias
      ],[0],{timeoutMs:60000});
      return signing;
    }catch{
      await log(id,'Existing automatic signing key is invalid. Recreating it.');
      await fs.remove(signing.keystore).catch(()=>{});
    }
  }

  await log(id,'Preparing automatic APK signing key...');
  await run(id,keytool,[
    '-genkeypair',
    '-storetype','JKS',
    '-keystore',signing.keystore,
    '-storepass',signing.storePass,
    '-keypass',signing.keyPass,
    '-alias',signing.alias,
    '-keyalg','RSA',
    '-keysize','2048',
    '-validity','10000',
    '-dname','CN=APK Studio Automatic Signing,O=APK Studio,C=US',
    '-noprompt'
  ],[0],{timeoutMs:120000});

  await run(id,keytool,[
    '-list','-keystore',signing.keystore,
    '-storepass',signing.storePass,
    '-alias',signing.alias
  ],[0],{timeoutMs:60000});

  await writeMeta(id,{signingType:'Automatic APK Studio key',signingReady:true,signingError:null});
  await log(id,'Automatic APK signing key is ready.');
  return signing;
}

export async function decompile(id,{forceJadxOom=false,skipPerDex=false}={}){
  const dir=projectDir(id),apk=path.join(dir,'original.apk'),readable=path.join(dir,'readable'),editable=path.join(dir,'editable');
  await fs.ensureDir(readable);
  await fs.ensureDir(editable);
  await writeMeta(id,{status:'processing',stage:'jadx',error:null,jadxWarnings:false,readableAvailable:true});

  let jadxWarnings=false;
  let readableAvailable=true;
  let readableMode='full';
  let readableDexCount=0;
  let jadxExitCode=null;
  let jadxError=null;

  try{
    if(forceJadxOom) throw new Error('java exited with 1\njava.lang.OutOfMemoryError: Java heap space (forced self-test)');
    const j=await run(id,java,[
      '-Xms'+javaXms,'-Xmx'+javaXmx,'-XX:+UseSerialGC',
      '-cp',jadxJar,'jadx.cli.JadxCLI',
      '--show-bad-code','-j',workerThreads,
      '-d',readable,apk
    ],[0,3],{idleTimeoutMs:60000,timeoutMs:180000});
    jadxExitCode=j.code;
    jadxWarnings=j.code===3;
    if(j.code===3) await log(id,'WARNING: JADX finished with recoverable decompilation warnings.');
  }catch(e){
    jadxWarnings=true;
    readableAvailable=false;
    readableMode='unavailable';
    jadxError=shortError(e);
    await log(id,'WARNING: Full APK readable source generation failed.');
    await log(id,'JADX ERROR: '+jadxError);
    await fs.remove(readable).catch(()=>{});
    await fs.ensureDir(readable);

    if(!skipPerDex){
      try{
        await log(id,'INFO: Trying memory-safe per-DEX JADX fallback...');
        const zip=new AdmZip(apk);
        const dexEntries=zip.getEntries().filter(en=>/^classes(\d*)?\.dex$/i.test(en.entryName));
        const dexDir=path.join(dir,'dex-fallback');
        await fs.ensureDir(dexDir);
        let success=0;
        for(const en of dexEntries){
          const base=en.entryName.replace(/\.dex$/i,'');
          const dexFile=path.join(dexDir,en.entryName);
          await fs.writeFile(dexFile,en.getData());
          const out=path.join(readable,base);
          await fs.ensureDir(out);
          try{
            await log(id,`INFO: JADX fallback ${en.entryName}...`);
            const r=await run(id,java,[
              '-Xms'+javaXms,'-Xmx'+javaXmx,'-XX:+UseSerialGC',
              '-cp',jadxJar,'jadx.cli.JadxCLI',
              '--show-bad-code','-j',workerThreads,
              '-d',out,dexFile
            ],[0,3]);
            success++;
            if(r.code===3) jadxWarnings=true;
          }catch(inner){
            await log(id,`WARNING: ${en.entryName} readable fallback failed: ${shortError(inner)}`);
          }
        }
        readableDexCount=success;
        if(success>0){
          readableAvailable=true;
          readableMode=success===dexEntries.length?'per-dex':'per-dex-partial';
          await log(id,`INFO: Readable fallback recovered ${success}/${dexEntries.length} DEX files.`);
        }else{
          await log(id,'WARNING: Per-DEX readable fallback could not recover source.');
        }
      }catch(fallbackError){
        await log(id,'WARNING: Per-DEX fallback setup failed: '+shortError(fallbackError));
      }
    }

    if(!readableAvailable){
      await log(id,'WARNING: Continuing with Apktool/Smali only.');
    }
  }

  await writeMeta(id,{
    stage:'apktool',jadxExitCode,jadxWarnings,readableAvailable,readableMode,readableDexCount,jadxError
  });

  try{
    await run(id,java,[
      '-Xms'+javaXms,'-Xmx'+javaXmx,'-XX:+UseSerialGC',
      '-jar',apktoolJar,'d','-f','-j',workerThreads,'-o',editable,apk
    ],[0]);

    const files=await walk(editable);
    try{await ensureAutomaticSigningKey(id)}
    catch(signError){await log(id,'WARNING: Automatic signing key preparation failed: '+shortError(signError))}
    await writeMeta(id,{
      status:'ready',
      stage:'ready',
      editableFileCount:files.length,
      jadxWarnings,
      readableAvailable,
      editableRevision:String(Date.now()),
      buildStatus:null,
      buildArtifact:null,
      warning: readableAvailable
        ? (readableMode==='full'
            ? (jadxWarnings ? 'Readable source contains JADX warnings.' : null)
            : `Readable source recovered with memory-safe per-DEX fallback (${readableDexCount} DEX files).`)
        : 'Readable source unavailable; Smali/resources are fully available in Rebuildable APK.'
    });
  }catch(e){
    const error=shortError(e);
    await log(id,'ERROR: Apktool failed: '+error);
    await writeMeta(id,{status:'error',stage:'failed',error});
  }
}

export async function rebuild(id,{runId}={}){
  const dir=projectDir(id),editable=path.join(dir,'editable'),output=path.join(dir,'output');
  await fs.ensureDir(output);
  const meta=await fs.readJson(path.join(dir,'project.json')).catch(()=>({}));
  const artifact=path.join(output,'app-rebuilt-unsigned.apk');
  const signedArtifact=path.join(output,'app-rebuilt-signed.apk');
  const signing=await signingConfigFor(dir);
  const sameRevision=!!meta.editableRevision && meta.buildRevision===meta.editableRevision;
  const sameSigning=meta.buildSigningFingerprint===signing.fingerprint;
  let activeStep='preflight';

  const stepLog=async(stepId,message)=>{
    if(runId)await appendStepLog(id,runId,stepId,message);
    await log(id,message);
  };
  const stepStart=async(stepId,message)=>{
    activeStep=stepId;
    if(runId)await setStep(id,runId,stepId,'in_progress');
    if(message)await stepLog(stepId,message);
  };
  const stepDone=async(stepId,message)=>{
    if(message)await stepLog(stepId,message);
    if(runId)await setStep(id,runId,stepId,'completed');
  };
  const stepSkip=async(stepId,message)=>{
    if(message)await stepLog(stepId,message);
    if(runId)await setStep(id,runId,stepId,'skipped');
  };

  if(runId)await startRun(id,runId);
  await log(id,'=== BUILD START ===');
  await stepStart('preflight',`Build resources: heap=${javaXmx}, threads=${workerThreads}, local=${localMode}`);

  if(sameRevision && sameSigning && await fs.pathExists(signedArtifact)){
    await stepDone('preflight','Workspace and signing configuration are unchanged.');
    await stepSkip('compile','No source changes detected. Reusing existing compiled APK.');
    await stepSkip('sign','Existing signed APK is still valid for this signing configuration.');
    await stepSkip('verify','Cached signed APK already passed verification.');
    await stepStart('artifact','Publishing cached signed APK...');
    await writeMeta(id,{
      buildStatus:'ready',
      buildStage:'ready',
      buildArtifact:'output/app-rebuilt-signed.apk',
      buildSigned:true,
      signingType:signing.type==='custom'?'Original/custom keystore':'APK Studio project key',
      buildCached:true,
      buildFinishedAt:new Date().toISOString()
    });
    await stepDone('artifact','Cached APK artifact is ready.');
    if(runId)await finishRun(id,runId,{status:'completed',artifact:'output/app-rebuilt-signed.apk'});
    return;
  }

  await writeMeta(id,{buildStatus:'building',buildError:null,buildCached:false,buildStage:'preflight',buildArtifact:null,buildSigned:false});
  await stepDone('preflight','Build prerequisites are ready.');

  try{
    activeStep='compile';
    if(!sameRevision || !await fs.pathExists(artifact)){
      await writeMeta(id,{buildStage:'compile'});
      await stepStart('compile','Rebuilding APK from editable workspace...');
      await run(id,java,[
        '-Xms'+javaXms,'-Xmx'+javaXmx,'-XX:+UseSerialGC',
        '-jar',apktoolJar,'b','-j',workerThreads,editable,'-o',artifact
      ],[0],{idleTimeoutMs:180000,timeoutMs:1200000,logFile:runId?stepLogFile(id,runId,'compile'):undefined});
      await stepDone('compile','APK compilation completed.');
    }else{
      await stepSkip('compile','Source unchanged. Reusing unsigned APK from the previous build.');
    }

    if(!await fs.pathExists(keytoolBin) || !await fs.pathExists(jarsignerBin)){
      throw new Error('APK signing tools are missing. Update the APK Studio Local Agent so it installs a full JDK.');
    }

    if(signing.type==='apkstudio' && !await fs.pathExists(signing.keystore)){
      await ensureAutomaticSigningKey(id);
    }
    if(signing.type==='custom' && (!signing.alias || !signing.storePass)){
      throw new Error('Custom signing key is missing alias or keystore password.');
    }

    activeStep='sign';
    await fs.remove(signedArtifact).catch(()=>{});
    await writeMeta(id,{buildStage:'signing'});
    await stepStart('sign',`Signing rebuilt APK with ${signing.type==='custom'?'custom/original keystore':'APK Studio project key'}...`);
    await run(id,jarsignerBin,[
      '-keystore',signing.keystore,
      '-storepass',signing.storePass,
      '-keypass',signing.keyPass,
      '-sigalg','SHA256withRSA','-digestalg','SHA-256',
      '-signedjar',signedArtifact,artifact,signing.alias
    ],[0],{timeoutMs:180000,logFile:runId?stepLogFile(id,runId,'sign'):undefined});
    await stepDone('sign','APK signing completed.');

    activeStep='verify';
    await writeMeta(id,{buildStage:'verifying'});
    await stepStart('verify','Verifying APK signature...');
    const verify=await run(id,jarsignerBin,['-verify',signedArtifact],[0],{timeoutMs:120000,logFile:runId?stepLogFile(id,runId,'verify'):undefined});
    const verifyText=(verify.out||'')+'\n'+(verify.err||'');
    if(!/jar verified/i.test(verifyText)){
      throw new Error('APK signature verification did not confirm a valid signature.');
    }
    await stepDone('verify','APK signature verified successfully.');

    activeStep='artifact';
    await stepStart('artifact','Publishing rebuilt APK...');
    await writeMeta(id,{
      buildStatus:'ready',
      buildStage:'ready',
      buildArtifact:'output/app-rebuilt-signed.apk',
      buildSigned:true,
      signingType:signing.type==='custom'?'Original/custom keystore':'APK Studio project key',
      buildRevision:meta.editableRevision||String(Date.now()),
      buildSigningFingerprint:signing.fingerprint,
      buildCached:false,
      buildFinishedAt:new Date().toISOString()
    });
    await stepDone('artifact','Signed APK is ready to download.');
    if(runId)await finishRun(id,runId,{status:'completed',artifact:'output/app-rebuilt-signed.apk'});
  }catch(e){
    const buildError=shortError(e);
    await log(id,'BUILD ERROR: '+buildError);
    if(runId){
      await appendStepLog(id,runId,activeStep,'ERROR: '+buildError);
      await setStep(id,runId,activeStep,'failed',{error:buildError});
      await finishRun(id,runId,{status:'failed',error:buildError});
    }
    await writeMeta(id,{buildStatus:'error',buildStage:'error',buildError,buildArtifact:null,buildSigned:false});
  }
}
