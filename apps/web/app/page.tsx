'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, Box, ChevronDown, ChevronRight, CircleDot, Code2, Download,
  FileCode2, FileText, Folder, FolderOpen, Hammer, LoaderCircle,
  PackageOpen, Plus, RefreshCcw, Save, Search, ShieldCheck, Trash2,
  Upload, X
} from 'lucide-react';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });
const API = '/processor';

type Meta = {
  id:string; originalName:string; size:number; status:string; stage?:string;
  error?:string|null; buildStatus?:string; buildError?:string|null;
  buildArtifact?:string; log?:string; createdAt?:string; updatedAt?:string;
  jadxWarnings?:boolean; jadxExitCode?:number; editableFileCount?:number;
};
type TreeItem={name:string;type:'dir'|'file';size:number;path:string};
type RootName='editable'|'readable';
type Section='code'|'analysis'|'build';
type OpenTab={root:RootName;path:string;label:string};

const rootLabels:Record<RootName,{title:string;hint:string}>={
  editable:{title:'Rebuildable APK',hint:'Manifest, resources and Smali'},
  readable:{title:'Readable source',hint:'JADX Java/Kotlin reconstruction'}
};

function languageFor(filePath:string){
  const ext=filePath.split('.').pop()?.toLowerCase();
  return ({kt:'kotlin',kts:'kotlin',java:'java',smali:'plaintext',xml:'xml',json:'json',js:'javascript',ts:'typescript',tsx:'typescript',css:'css',html:'html',md:'markdown',yml:'yaml',yaml:'yaml',gradle:'kotlin',properties:'ini'} as Record<string,string>)[ext||'']||'plaintext';
}
function formatBytes(bytes=0){if(bytes<1024)return bytes+' B';if(bytes<1024**2)return(bytes/1024).toFixed(1)+' KB';return(bytes/1024**2).toFixed(1)+' MB'}
function timeAgo(date?:string){if(!date)return'—';const diff=Date.now()-new Date(date).getTime();const m=Math.max(0,Math.floor(diff/60000));if(m<1)return'just now';if(m<60)return m+'m ago';const h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago'}
function ProjectStatus({status}:{status:string}){return <span className={'project-status '+status}><CircleDot size={12}/>{status}</span>}

function TreeLevel({projectId,root,folder,depth,activePath,onOpen}:{projectId:string;root:RootName;folder:string;depth:number;activePath:string;onOpen:(path:string)=>void}){
  const[items,setItems]=useState<TreeItem[]>([]);const[loaded,setLoaded]=useState(false);
  useEffect(()=>{let off=false;setLoaded(false);fetch(`${API}/api/projects/${projectId}/tree?root=${root}&path=${encodeURIComponent(folder)}`).then(async r=>r.ok?r.json():{items:[]}).then(d=>{if(!off){setItems(d.items||[]);setLoaded(true)}});return()=>{off=true}},[projectId,root,folder]);
  if(!loaded)return depth===0?<div className="tree-loading"><LoaderCircle className="spin" size={14}/> Loading…</div>:null;
  return <>{items.map(item=>item.type==='dir'?<FolderRow key={item.path} item={item} projectId={projectId} root={root} depth={depth} activePath={activePath} onOpen={onOpen}/>:<button key={item.path} className={'tree-row '+(activePath===item.path?'selected':'')} style={{paddingLeft:12+depth*14}} onClick={()=>onOpen(item.path)}><FileCode2 size={14}/><span>{item.name}</span></button>)}</>;
}
function FolderRow({item,projectId,root,depth,activePath,onOpen}:{item:TreeItem;projectId:string;root:RootName;depth:number;activePath:string;onOpen:(path:string)=>void}){
  const[open,setOpen]=useState(depth===0);
  return <><button className="tree-row folder" style={{paddingLeft:8+depth*14}} onClick={()=>setOpen(v=>!v)}>{open?<ChevronDown size={13}/>:<ChevronRight size={13}/>} {open?<FolderOpen size={14}/>:<Folder size={14}/>}<span>{item.name}</span></button>{open&&<TreeLevel projectId={projectId} root={root} folder={item.path} depth={depth+1} activePath={activePath} onOpen={onOpen}/>}</>;
}

export default function Home(){
  const[projects,setProjects]=useState<Meta[]>([]),[project,setProject]=useState<Meta|null>(null);
  const[section,setSection]=useState<Section>('code'),[root,setRoot]=useState<RootName>('editable');
  const[currentPath,setCurrentPath]=useState(''),[content,setContent]=useState(''),[savedContent,setSavedContent]=useState(''),[binary,setBinary]=useState(false);
  const[tabs,setTabs]=useState<OpenTab[]>([]),[busy,setBusy]=useState(false),[drag,setDrag]=useState(false),[treeVersion,setTreeVersion]=useState(0),[filter,setFilter]=useState(''),[rootMenu,setRootMenu]=useState(false);
  const fileInput=useRef<HTMLInputElement>(null);const dirty=content!==savedContent;

  const loadProjects=useCallback(async()=>{try{const r=await fetch(API+'/api/projects',{cache:'no-store'});if(!r.ok)throw new Error('Processor unavailable');setProjects((await r.json()).projects||[])}catch{}},[]);
  useEffect(()=>{void loadProjects()},[loadProjects]);
  const poll=useCallback(async(id:string)=>{try{const r=await fetch(API+'/api/projects/'+id,{cache:'no-store'});if(!r.ok)return;const d=await r.json();setProject(d);setProjects(prev=>[d,...prev.filter(p=>p.id!==d.id)])}catch{}},[]);
  useEffect(()=>{if(!project?.id)return;const active=!['ready','error'].includes(project.status)||project.buildStatus==='building';if(!active)return;const t=setInterval(()=>void poll(project.id),1200);return()=>clearInterval(t)},[project?.id,project?.status,project?.buildStatus,poll]);

  const resetEditor=()=>{setCurrentPath('');setContent('');setSavedContent('');setBinary(false);setTabs([])};
  const openProject=async(meta:Meta)=>{if(dirty&&!confirm('יש שינויים שלא נשמרו. לעבור פרויקט?'))return;const r=await fetch(API+'/api/projects/'+meta.id,{cache:'no-store'});const d=r.ok?await r.json():meta;setProject(d);setSection('code');setRoot('editable');resetEditor()};
  const goProjects=()=>{if(dirty&&!confirm('יש שינויים שלא נשמרו. לצאת מהפרויקט?'))return;setProject(null);resetEditor();void loadProjects()};
  const uploadApk=async(file:File)=>{
    if(!file.name.toLowerCase().endsWith('.apk'))return alert('בחר קובץ APK');
    setBusy(true);
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),120000);
    try{const body=new FormData();body.append('apk',file);const r=await fetch(API+'/api/projects/upload',{method:'POST',body,signal:controller.signal});const text=await r.text();let d:any;try{d=JSON.parse(text)}catch{d={error:text||'Upload failed'}}if(!r.ok)throw new Error(d.error||'Upload failed');setProjects(p=>[d,...p]);setProject(d);setSection('code');setRoot('editable');resetEditor()}
    catch(e:any){alert(e?.name==='AbortError'?'Upload timed out. The processor did not respond within 2 minutes.':(e?.message||'Upload failed'))}
    finally{clearTimeout(timer);setBusy(false)}
  };
  const deleteProject=async(meta:Meta)=>{if(!confirm('למחוק את הפרויקט '+meta.originalName+'?'))return;const r=await fetch(API+'/api/projects/'+meta.id,{method:'DELETE'});if(r.ok)setProjects(p=>p.filter(x=>x.id!==meta.id))};
  const openFile=async(filePath:string,openRoot=root)=>{if(!project)return;if(dirty&&filePath!==currentPath&&!confirm('יש שינויים שלא נשמרו. לעבור קובץ?'))return;const r=await fetch(`${API}/api/projects/${project.id}/file?root=${openRoot}&path=${encodeURIComponent(filePath)}`);const d=await r.json();if(!r.ok)return alert(d.error||'Cannot open file');setRoot(openRoot);setCurrentPath(filePath);setBinary(!!d.binary);setContent(d.binary?'':d.content||'');setSavedContent(d.binary?'':d.content||'');setTabs(prev=>prev.some(t=>t.root===openRoot&&t.path===filePath)?prev:[...prev,{root:openRoot,path:filePath,label:filePath.split('/').pop()||filePath}])};
  const save=async()=>{if(!project||!currentPath||binary||root!=='editable')return;const r=await fetch(`${API}/api/projects/${project.id}/file?root=${root}&path=${encodeURIComponent(currentPath)}`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content})});const d=await r.json();if(!r.ok)return alert(d.error||'Save failed');setSavedContent(content)};
  const runBuild=async()=>{if(!project)return;const r=await fetch(API+'/api/projects/'+project.id+'/build',{method:'POST'});const d=await r.json();if(!r.ok)return alert(d.error||'Build failed');setSection('build');await poll(project.id)};
  useEffect(()=>{const h=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();void save()}};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h)});

  const filtered=useMemo(()=>projects.filter(p=>p.originalName.toLowerCase().includes(filter.toLowerCase())),[projects,filter]);

  if(!project)return <main className="app-shell">
    <header className="topbar"><button className="brand" onClick={()=>void loadProjects()}><PackageOpen size={22}/><strong>APK Studio</strong></button><div className="topbar-spacer"/></header>
    <div className="projects-page">
      <div className="projects-head"><div><h1>Projects</h1><p>APK workspaces</p></div><button className="button primary" onClick={()=>fileInput.current?.click()}><Plus size={16}/>{busy?'Uploading…':'New project'}</button></div>
      <div className="projects-toolbar"><div className="search-box"><Search size={15}/><input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="Find a project…"/></div><span>{projects.length} projects</span></div>
      <div className={'upload-strip '+(drag?'drag':'')} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files[0];if(f)void uploadApk(f)}}><Upload size={16}/> Drop an APK anywhere on this row to create a project</div>
      <div className="project-list">{filtered.length===0?<div className="empty-list"><PackageOpen size={28}/><strong>{projects.length?'No matching projects':'No projects yet'}</strong><span>Import an APK to create your first workspace.</span>{!projects.length&&<button className="button" disabled={busy} onClick={()=>fileInput.current?.click()}>{busy?<LoaderCircle className="spin" size={15}/>:<Upload size={15}/>} Import APK</button>}</div>:filtered.map(p=><div className="project-row" key={p.id}><button className="project-main" onClick={()=>void openProject(p)}><div className="project-icon"><Box size={17}/></div><div className="project-text"><strong>{p.originalName.replace(/\.apk$/i,'')}</strong><span>{p.originalName} · {formatBytes(p.size)}</span></div></button><ProjectStatus status={p.status}/><span className="updated">Updated {timeAgo(p.updatedAt||p.createdAt)}</span><button className="row-action" onClick={()=>void deleteProject(p)}><Trash2 size={15}/></button></div>)}</div>
      <input ref={fileInput} hidden type="file" accept=".apk,application/vnd.android.package-archive" onChange={e=>{const f=e.target.files?.[0];if(f)void uploadApk(f);e.currentTarget.value=''}}/>
    </div>
  </main>;

  const repoName=project.originalName.replace(/\.apk$/i,'');const ready=project.status==='ready';const pathParts=currentPath.split('/').filter(Boolean);
  return <main className="app-shell workspace-shell">
    <header className="topbar"><button className="brand" onClick={goProjects}><PackageOpen size={22}/><strong>APK Studio</strong></button><span className="top-divider"/><button className="repo-crumb" onClick={goProjects}>Projects</button><ChevronRight size={14} className="muted"/><strong className="repo-current">{repoName}</strong><div className="topbar-spacer"/><a className="button quiet" href={API+'/api/projects/'+project.id+'/download'}><Download size={15}/> ZIP</a><button className="button primary" disabled={!ready||project.buildStatus==='building'} onClick={()=>void runBuild()}><Hammer size={15}/> Build APK</button></header>
    <div className="repo-titlebar"><div className="repo-title"><Box size={17}/><strong>{repoName}</strong><span className="repo-subtle">APK workspace</span></div><ProjectStatus status={project.status}/></div>
    <nav className="repo-nav"><button className={section==='code'?'active':''} onClick={()=>setSection('code')}><Code2 size={16}/> Code</button><button className={section==='analysis'?'active':''} onClick={()=>setSection('analysis')}><ShieldCheck size={16}/> Analysis</button><button className={section==='build'?'active':''} onClick={()=>setSection('build')}><Hammer size={16}/> Build</button></nav>
    {project.status==='error'&&<div className="status-banner error"><strong>Decompile failed</strong><span>{project.error}</span></div>}
    {!ready&&project.status!=='error'&&<div className="status-banner"><LoaderCircle className="spin" size={15}/><strong>Preparing project…</strong><span>{project.stage||'queued'} · JADX and Apktool are running.</span></div>}
    {ready&&project.jadxWarnings&&<div className="status-banner warning"><strong>Readable source has warnings</strong><span>JADX finished with warnings; Smali and resources remain available.</span></div>}
    {section==='code'&&<div className="code-workspace"><aside className="explorer"><div className="explorer-head"><span>EXPLORER</span><button className="icon-button small" onClick={()=>setTreeVersion(v=>v+1)}><RefreshCcw size={14}/></button></div><div className="root-picker-wrap"><button className="root-picker" onClick={()=>setRootMenu(v=>!v)}><div><strong>{rootLabels[root].title}</strong><span>{rootLabels[root].hint}</span></div><ChevronDown size={14}/></button>{rootMenu&&<div className="root-menu">{(Object.keys(rootLabels) as RootName[]).map(r=><button key={r} className={root===r?'selected':''} onClick={()=>{setRoot(r);setRootMenu(false);resetEditor()}}><strong>{rootLabels[r].title}</strong><span>{rootLabels[r].hint}</span></button>)}</div>}</div><div className="tree-area">{ready?<TreeLevel key={project.id+':'+root+':'+treeVersion} projectId={project.id} root={root} folder="" depth={0} activePath={currentPath} onOpen={p=>void openFile(p)}/>:<div className="tree-loading"><LoaderCircle className="spin" size={14}/> Processing…</div>}</div></aside><section className="editor-area"><div className="editor-toolbar"><div className="breadcrumbs"><button onClick={()=>resetEditor()}>{rootLabels[root].title}</button>{pathParts.map((part,i)=><span key={part+i}><ChevronRight size={13}/>{part}</span>)}</div><button className="button small" disabled={!currentPath||binary||!dirty||root!=='editable'} onClick={()=>void save()}><Save size={14}/> Save</button></div><div className="tabs-bar">{tabs.length===0?<span className="tabs-placeholder">No files open</span>:tabs.map(tab=><button key={tab.root+':'+tab.path} className={'file-tab '+(tab.root===root&&tab.path===currentPath?'active':'')} onClick={()=>void openFile(tab.path,tab.root)}><FileText size={13}/><span>{tab.label}</span>{tab.root===root&&tab.path===currentPath&&dirty&&<i/>}<X size={12}/></button>)}</div><div className="editor-frame">{!currentPath?<div className="editor-empty"><FileCode2 size={34}/><strong>Select a file</strong><span>Choose a file from the explorer to view or edit it.</span></div>:binary?<div className="editor-empty"><Archive size={34}/><strong>Binary file</strong><span>This file is preserved but cannot be edited as text.</span></div>:<MonacoEditor height="100%" language={languageFor(currentPath)} value={content} onChange={v=>setContent(v??'')} theme="vs-dark" options={{minimap:{enabled:false},fontSize:13,fontFamily:'Consolas, "SFMono-Regular", monospace',automaticLayout:true,scrollBeyondLastLine:false,padding:{top:12}}}/>}</div><footer className="statusbar"><span>{rootLabels[root].title}</span><span>{currentPath||repoName}</span><span className="status-spacer"/>{dirty&&<span>● Unsaved</span>}<span>UTF-8</span></footer></section></div>}
    {section==='analysis'&&<div className="repository-content"><div className="page-heading"><h2>Analysis</h2><p>Project metadata from the cloud processor.</p></div><div className="details-table"><div><span>File</span><strong>{project.originalName}</strong></div><div><span>Status</span><strong>{project.status}</strong></div><div><span>Stage</span><strong>{project.stage||'—'}</strong></div><div><span>Size</span><strong>{formatBytes(project.size)}</strong></div><div><span>JADX exit code</span><strong>{project.jadxExitCode??'—'}</strong></div><div><span>Decoded files</span><strong>{project.editableFileCount??'—'}</strong></div></div></div>}
    {section==='build'&&<div className="repository-content"><div className="page-heading build-heading"><div><h2>Build</h2><p>Rebuild the editable APK.</p></div><button className="button primary" disabled={!ready||project.buildStatus==='building'} onClick={()=>void runBuild()}><Hammer size={15}/> Build APK</button></div><div className="build-table"><div><span>APK rebuild</span><ProjectStatus status={project.buildStatus||'idle'}/>{project.buildError&&<code>{project.buildError}</code>}</div></div>{project.buildArtifact&&<a className="artifact-row" href={API+'/api/projects/'+project.id+'/apk'}><Download size={17}/><div><strong>app-rebuilt-unsigned.apk</strong><span>Rebuilt APK artifact</span></div></a>}<section className="log-section"><div className="log-head"><strong>Build log</strong><span>latest output</span></div><pre>{project.log||'No build output yet.'}</pre></section></div>}
  </main>;
}
