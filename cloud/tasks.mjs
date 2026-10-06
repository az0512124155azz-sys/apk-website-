import fs from 'fs-extra';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {java,jadxJar,apktoolJar,projectDir,writeMeta,run,walk,log} from './lib.mjs';

const shortError = (e) => String(e?.message || e || 'Unknown error').slice(-12000);
const localMode = process.env.LOCAL_PROCESSOR === '1';
const javaXmx = process.env.APK_STUDIO_JAVA_XMX || (localMode ? '4096m' : '352m');
const javaXms = process.env.APK_STUDIO_JAVA_XMS || (localMode ? '256m' : '64m');
const workerThreads = String(Number(process.env.APK_STUDIO_THREADS || (localMode ? 4 : 1)));
const javaBinDir = path.dirname(java);
const isWindows = process.platform === 'win32';
const keytoolBin = path.join(javaBinDir,isWindows?'keytool.exe':'keytool');
const jarsignerBin = path.join(javaBinDir,isWindows?'jarsigner.exe':'jarsigner');
const signingAlias = 'apkstudio';
const signingPassword = 'apkstudio-local-signing';

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
  await writeMeta(id,{buildStatus:'building',buildError:null});
  await log(id,'=== BUILD START ===');
  await log(id,`Build resources: heap=${javaXmx}, threads=${workerThreads}, local=${localMode}`);
  try{
    const artifact=path.join(output,'app-rebuilt-unsigned.apk');
    const signedArtifact=path.join(output,'app-rebuilt-signed.apk');
    const keystore=path.join(dir,'apkstudio-signing.jks');
    await run(id,java,[
      '-Xms'+javaXms,'-Xmx'+javaXmx,'-XX:+UseSerialGC',
      '-jar',apktoolJar,'b','-j',workerThreads,editable,'-o',artifact
    ],[0],{idleTimeoutMs:180000,timeoutMs:1200000});

    if(!await fs.pathExists(keytoolBin) || !await fs.pathExists(jarsignerBin)){
      throw new Error('APK signing tools are missing. Update the APK Studio Local Agent so it installs a full JDK.');
    }

    if(!await fs.pathExists(keystore)){
      await log(id,'Generating APK Studio project signing key...');
      await run(id,keytoolBin,[
        '-genkeypair',
        '-keystore',keystore,
        '-storepass',signingPassword,
        '-keypass',signingPassword,
        '-alias',signingAlias,
        '-keyalg','RSA',
        '-keysize','2048',
        '-validity','10000',
        '-dname','CN=APK Studio,O=APK Studio,C=US',
        '-noprompt'
      ],[0],{timeoutMs:120000});
    }

    await log(id,'Signing rebuilt APK...');
    await run(id,jarsignerBin,[
      '-keystore',keystore,
      '-storepass',signingPassword,
      '-keypass',signingPassword,
      '-sigalg','SHA256withRSA',
      '-digestalg','SHA-256',
      '-signedjar',signedArtifact,
      artifact,
      signingAlias
    ],[0],{timeoutMs:180000});

    await log(id,'Verifying APK signature...');
    await run(id,jarsignerBin,['-verify','-strict',signedArtifact],[0],{timeoutMs:120000});

    await writeMeta(id,{
      buildStatus:'ready',
      buildArtifact:'output/app-rebuilt-signed.apk',
      buildSigned:true,
      signingType:'APK Studio project key'
    });
  }catch(e){
    const buildError=shortError(e);
    await log(id,'BUILD ERROR: '+buildError);
    await writeMeta(id,{buildStatus:'error',buildError});
  }
}
