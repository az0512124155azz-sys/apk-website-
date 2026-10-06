import fs from 'fs-extra';
import path from 'node:path';
import {java,jadxJar,apktoolJar,projectDir,writeMeta,run,walk,log} from './lib.mjs';

export async function decompile(id){
  const dir=projectDir(id),apk=path.join(dir,'original.apk'),readable=path.join(dir,'readable'),editable=path.join(dir,'editable');
  await fs.ensureDir(readable);await fs.ensureDir(editable);await writeMeta(id,{status:'processing',stage:'jadx',error:null});
  try{
    const j=await run(id,java,['-Xmx320m','-cp',jadxJar,'jadx.cli.JadxCLI','--show-bad-code','--deobf','-j','1','-d',readable,apk],[0,3]);
    await writeMeta(id,{jadxExitCode:j.code,jadxWarnings:j.code===3,stage:'apktool'});
    await run(id,java,['-Xmx320m','-jar',apktoolJar,'d','-f','-j','1','-o',editable,apk],[0]);
    const files=await walk(editable);
    await writeMeta(id,{status:'ready',stage:'ready',editableFileCount:files.length});
  }catch(e){await log(id,`ERROR: ${e.message}`);await writeMeta(id,{status:'error',stage:'failed',error:e.message});}
}

export async function rebuild(id){
  const dir=projectDir(id),editable=path.join(dir,'editable'),output=path.join(dir,'output');
  await fs.ensureDir(output);await writeMeta(id,{buildStatus:'building',buildError:null});
  try{
    const artifact=path.join(output,'app-rebuilt-unsigned.apk');
    await run(id,java,['-Xmx320m','-jar',apktoolJar,'b','-j','1',editable,'-o',artifact],[0]);
    await writeMeta(id,{buildStatus:'ready',buildArtifact:'output/app-rebuilt-unsigned.apk'});
  }catch(e){await log(id,`BUILD ERROR: ${e.message}`);await writeMeta(id,{buildStatus:'error',buildError:e.message});}
}
