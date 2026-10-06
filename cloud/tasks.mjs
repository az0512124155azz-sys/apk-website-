import fs from 'fs-extra';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {java,jadxJar,apktoolJar,projectDir,writeMeta,run,walk,log} from './lib.mjs';

const shortError = (e) => String(e?.message || e || 'Unknown error').slice(-12000);

export async function decompile(id,{forceJadxOom=false}={}){
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
      '-Xms64m','-Xmx352m','-XX:+UseSerialGC',
      '-cp',jadxJar,'jadx.cli.JadxCLI',
      '--show-bad-code','-j','1',
      '-d',readable,apk
    ],[0,3]);
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

    if(!forceJadxOom){
      try{
        await log(id,'INFO: Trying memory-safe per-DEX JADX fallback...');
        const zip=new AdmZip(apk);
        const dexEntries=zip.getEntries().filter(en=>/^classes(\\d*)?\\.dex$/i.test(en.entryName));
        const dexDir=path.join(dir,'dex-fallback');
        await fs.ensureDir(dexDir);
        let success=0;
        for(const en of dexEntries){
          const base=en.entryName.replace(/\\.dex$/i,'');
          const dexFile=path.join(dexDir,en.entryName);
          await fs.writeFile(dexFile,en.getData());
          const out=path.join(readable,base);
          await fs.ensureDir(out);
          try{
            await log(id,`INFO: JADX fallback ${en.entryName}...`);
            const r=await run(id,java,[
              '-Xms48m','-Xmx320m','-XX:+UseSerialGC',
              '-cp',jadxJar,'jadx.cli.JadxCLI',
              '--show-bad-code','-j','1',
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
      '-Xms64m','-Xmx352m','-XX:+UseSerialGC',
      '-jar',apktoolJar,'d','-f','-j','1','-o',editable,apk
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
  try{
    const artifact=path.join(output,'app-rebuilt-unsigned.apk');
    await run(id,java,[
      '-Xms64m','-Xmx352m','-XX:+UseSerialGC',
      '-jar',apktoolJar,'b','-j','1',editable,'-o',artifact
    ],[0]);
    await writeMeta(id,{buildStatus:'ready',buildArtifact:'output/app-rebuilt-unsigned.apk'});
  }catch(e){
    const buildError=shortError(e);
    await log(id,'BUILD ERROR: '+buildError);
    await writeMeta(id,{buildStatus:'error',buildError});
  }
}
