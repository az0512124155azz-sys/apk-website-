import fs from 'fs-extra';
import path from 'node:path';
import {java,jadxJar,apktoolJar,projectDir,writeMeta,run,walk,log} from './lib.mjs';

const shortError = (e) => String(e?.message || e || 'Unknown error').slice(-12000);

export async function decompile(id){
  const dir=projectDir(id),apk=path.join(dir,'original.apk'),readable=path.join(dir,'readable'),editable=path.join(dir,'editable');
  await fs.ensureDir(readable);
  await fs.ensureDir(editable);
  await writeMeta(id,{status:'processing',stage:'jadx',error:null,jadxWarnings:false,readableAvailable:true});

  let jadxWarnings=false;
  let readableAvailable=true;
  let jadxExitCode=null;
  let jadxError=null;

  try{
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
    jadxError=shortError(e);
    await log(id,'WARNING: Readable source generation failed; continuing with Apktool/Smali.');
    await log(id,'JADX ERROR: '+jadxError);
    await fs.remove(readable).catch(()=>{});
    await fs.ensureDir(readable);
  }

  await writeMeta(id,{
    stage:'apktool',jadxExitCode,jadxWarnings,readableAvailable,jadxError
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
        ? (jadxWarnings ? 'Readable source contains JADX warnings.' : null)
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
