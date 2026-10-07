import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import AdmZip from 'adm-zip';
import {java,jadxJar,apktoolJar,projectDir,writeMeta,run,walk,log} from './lib.mjs';

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
const signingPassword = 'apkstudio-local-signing';

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
  return {
    type:'apkstudio',
    keystore:path.join(dir,'apkstudio-signing.jks'),
    alias:signingAlias,
    storePass:signingPassword,
    keyPass:signingPassword,
    fingerprint:'apkstudio-project-key'
  };
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

export async function rebuild(id){
  const dir=projectDir(id),editable=path.join(dir,'editable'),output=path.join(dir,'output');
  await fs.ensureDir(output);
  const meta=await fs.readJson(path.join(dir,'project.json')).catch(()=>({}));
  const artifact=path.join(output,'app-rebuilt-unsigned.apk');
  const signedArtifact=path.join(output,'app-rebuilt-signed.apk');
  const signing=await signingConfigFor(dir);
  const sameRevision=!!meta.editableRevision && meta.buildRevision===meta.editableRevision;
  const sameSigning=meta.buildSigningFingerprint===signing.fingerprint;

  if(sameRevision && sameSigning && await fs.pathExists(signedArtifact)){
    await log(id,'=== BUILD START ===');
    await log(id,'No source changes detected. Reusing existing signed APK.');
    await writeMeta(id,{
      buildStatus:'ready',
      buildArtifact:'output/app-rebuilt-signed.apk',
      buildSigned:true,
      signingType:signing.type==='custom'?'Original/custom keystore':'APK Studio project key',
      buildCached:true
    });
    return;
  }

  await writeMeta(id,{buildStatus:'building',buildError:null,buildCached:false,buildStage:sameRevision?'signing':'rebuild'});
  await log(id,'=== BUILD START ===');
  await log(id,`Build resources: heap=${javaXmx}, threads=${workerThreads}, local=${localMode}`);

  try{
    if(!sameRevision || !await fs.pathExists(artifact)){
      await log(id,'Rebuilding APK from editable workspace...');
      await run(id,java,[
        '-Xms'+javaXms,'-Xmx'+javaXmx,'-XX:+UseSerialGC',
        '-jar',apktoolJar,'b','-j',workerThreads,editable,'-o',artifact
      ],[0],{idleTimeoutMs:180000,timeoutMs:1200000});
    }else{
      await log(id,'Source unchanged. Skipping Apktool rebuild and reusing unsigned APK.');
    }

    if(!await fs.pathExists(keytoolBin) || !await fs.pathExists(jarsignerBin)){
      throw new Error('APK signing tools are missing. Update the APK Studio Local Agent so it installs a full JDK.');
    }

    if(signing.type==='apkstudio' && !await fs.pathExists(signing.keystore)){
      await log(id,'Generating APK Studio project signing key...');
      await run(id,keytoolBin,[
        '-genkeypair','-keystore',signing.keystore,
        '-storepass',signing.storePass,'-keypass',signing.keyPass,
        '-alias',signing.alias,'-keyalg','RSA','-keysize','2048',
        '-validity','10000','-dname','CN=APK Studio,O=APK Studio,C=US','-noprompt'
      ],[0],{timeoutMs:120000});
    }

    if(signing.type==='custom' && (!signing.alias || !signing.storePass)){
      throw new Error('Custom signing key is missing alias or keystore password.');
    }

    await fs.remove(signedArtifact).catch(()=>{});
    await writeMeta(id,{buildStage:'signing'});
    await log(id,`Signing rebuilt APK with ${signing.type==='custom'?'custom/original keystore':'APK Studio project key'}...`);
    await run(id,jarsignerBin,[
      '-keystore',signing.keystore,
      '-storepass',signing.storePass,
      '-keypass',signing.keyPass,
      '-sigalg','SHA256withRSA','-digestalg','SHA-256',
      '-signedjar',signedArtifact,artifact,signing.alias
    ],[0],{timeoutMs:180000});

    await writeMeta(id,{buildStage:'verifying'});
    await log(id,'Verifying APK signature...');
    await run(id,jarsignerBin,['-verify','-strict',signedArtifact],[0],{timeoutMs:120000});

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
  }catch(e){
    const buildError=shortError(e);
    await log(id,'BUILD ERROR: '+buildError);
    await writeMeta(id,{buildStatus:'error',buildStage:'error',buildError});
  }
}
