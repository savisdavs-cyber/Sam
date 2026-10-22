'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.ADMIN_KEY || '';
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PREVIEWS = path.join(DATA, 'previews');
const MAX_ZIP = 8 * 1024 * 1024;
const MAX_UNPACKED = 50 * 1024 * 1024;
const MAX_FILES = 200;
const TTL = 7 * 24 * 60 * 60 * 1000;
fs.mkdirSync(PREVIEWS, { recursive: true });
const TYPES = {'.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml','.ico':'image/x-icon','.mp3':'audio/mpeg','.mp4':'video/mp4','.webm':'video/webm','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.wasm':'application/wasm','.webmanifest':'application/manifest+json','.txt':'text/plain; charset=utf-8'};
const baseHeaders = {'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};
function send(res,status,body,type='text/plain; charset=utf-8'){res.writeHead(status,{...baseHeaders,'Content-Type':type,'Cache-Control':'no-store'});res.end(body);}
function json(res,status,data){send(res,status,JSON.stringify(data),'application/json; charset=utf-8');}
function authorized(req){if(KEY.length<16)return false;const a=Buffer.from(String(req.headers['x-admin-key']||''));const b=Buffer.from(KEY);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
function cleanup(){
  for(const name of fs.readdirSync(PREVIEWS)){
    if(!/^[a-f0-9]{16}$/.test(name))continue;
    const dir=path.join(PREVIEWS,name);
    try{const m=JSON.parse(fs.readFileSync(path.join(dir,'.preview.json'),'utf8'));if(Date.now()-m.created>=TTL)fs.rmSync(dir,{recursive:true,force:true});}
    catch{fs.rmSync(dir,{recursive:true,force:true});}
  }
}
cleanup();const timer=setInterval(cleanup,3600000);timer.unref?.();
function readBody(req){
  return new Promise((resolve,reject)=>{
    const parts=[];let size=0;let done=false;
    req.on('data',b=>{size+=b.length;if(size>MAX_ZIP){if(!done){done=true;reject(Error('ZIP exceeds 8 MB'));}req.destroy();}else parts.push(b);});
    req.on('end',()=>{if(!done){done=true;resolve(Buffer.concat(parts));}});
    req.on('error',e=>{if(!done){done=true;reject(e);}});
  });
}
function unpack(buffer,directory){
  const zip=new AdmZip(buffer);
  const entries=zip.getEntries().filter(e=>!e.isDirectory);
  if(!entries.length||entries.length>MAX_FILES)throw Error('ZIP must contain 1–200 files');
  let total=0;const names=new Set();
  for(const e of entries){
    const n=e.entryName.replace(/\\/g,'/');
    if(!n||n.startsWith('/')||/^[a-z]:/i.test(n)||n.includes('\0')||n.split('/').some(s=>s==='..'||!s)||n.startsWith('.'))throw Error('Invalid ZIP file path');
    if(names.has(n))throw Error('Duplicate ZIP file path');
    names.add(n);
    if(((e.header.attr>>>16)&0xf000)===0xa000)throw Error('Symlinks are not allowed');
    const size=e.header.size;
    if(size>15*1024*1024)throw Error('A ZIP file is too large');
    total+=size;
    if(total>MAX_UNPACKED)throw Error('The uncompressed ZIP is too large');
  }
  let prefix='';
  if(!names.has('index.html')){
    const candidates=[...names].filter(n=>n.endsWith('/index.html'));
    if(candidates.length!==1)throw Error('ZIP must contain an index.html file');
    prefix=candidates[0].slice(0,-'index.html'.length);
  }
  fs.mkdirSync(directory,{recursive:true});
  let count=0;
  for(const e of entries){
    const n=e.entryName.replace(/\\/g,'/');
    if(!n.startsWith(prefix))continue;
    const relative=n.slice(prefix.length);
    if(!relative||relative.startsWith('.'))continue;
    const dest=path.resolve(directory,relative);
    if(!dest.startsWith(directory+path.sep))throw Error('Invalid ZIP entry');
    const content=e.getData();
    if(content.length!==e.header.size)throw Error('Corrupted ZIP entry');
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,content,{flag:'wx'});
    count++;
  }
  if(!fs.existsSync(path.join(directory,'index.html')))throw Error('Missing index.html');
  return count;
}
function preview(res,id,requestPath){
  const dir=path.join(PREVIEWS,id);
  let meta;
  try{meta=JSON.parse(fs.readFileSync(path.join(dir,'.preview.json'),'utf8'));}catch{return send(res,404,'Preview not found');}
  if(Date.now()-meta.created>=TTL)return send(res,410,'Preview expired');
  let relative;
  try{relative=decodeURIComponent(requestPath||'index.html');}
  catch{return send(res,400,'Invalid address');}
  if(!relative||relative.startsWith('/')||relative.split('/').some(p=>p==='..'||p.startsWith('.')))return send(res,404,'Not found');
  const filename=path.resolve(dir,relative);
  if(!filename.startsWith(dir+path.sep))return send(res,404,'Not found');
  let stat;
  try{stat=fs.statSync(filename);}catch{return send(res,404,'Not found');}
  if(!stat.isFile())return send(res,404,'Not found');
  res.writeHead(200,{...baseHeaders,'Content-Type':TYPES[path.extname(filename).toLowerCase()]||'application/octet-stream','Cache-Control':'public, max-age=120','Content-Length':stat.size});
  fs.createReadStream(filename).pipe(res);
}
const server=http.createServer(async(req,res)=>{
  let url;
  try{url=new URL(req.url||'/', 'http://localhost');}catch{return send(res,400,'Invalid URL');}
  if(req.method==='GET'&&url.pathname==='/')return send(res,200,fs.readFileSync(path.join(__dirname,'index.html')),'text/html; charset=utf-8');
  if(req.method==='GET'&&url.pathname==='/api/health')return json(res,200,{ok:true,uploadsConfigured:KEY.length>=16,storage:'ephemeral',ttlDays:7});
  if(req.method==='POST'&&url.pathname==='/api/upload'){
    if(!authorized(req))return json(res,401,{error:'Incorrect private upload key or server not configured'});
    if(Number(req.headers['content-length']||0)>MAX_ZIP)return json(res,413,{error:'ZIP exceeds 8 MB'});
    if(!['application/zip','application/octet-stream'].includes(String(req.headers['content-type']||'').split(';')[0]))return json(res,415,{error:'Choose a ZIP file'});
    const id=crypto.randomBytes(8).toString('hex'),temp=path.join(PREVIEWS,'.'+id+'.tmp'),dest=path.join(PREVIEWS,id);
    try{
      const buffer=await readBody(req);
      const count=unpack(buffer,temp);
      fs.writeFileSync(path.join(temp,'.preview.json'),JSON.stringify({created:Date.now(),files:count}));
      fs.renameSync(temp,dest);
      const host=String(req.headers.host||'localhost').replace(/[^a-zA-Z0-9.:-]/g,'');
      const proto=host.startsWith('localhost')?'http':'https';
      return json(res,201,{url:proto+'://'+host+'/p/'+id+'/',files:count,expiresInDays:7});
    }catch(e){fs.rmSync(temp,{force:true,recursive:true});return json(res,400,{error:String(e.message||'Invalid ZIP')});}
  }
  const m=url.pathname.match(/^\/p\/([a-f0-9]{16})(?:\/(.*))?$/);
  if(req.method==='GET'&&m)return preview(res,m[1],m[2]||'index.html');
  return send(res,404,'Not found');
});
server.listen(PORT,'0.0.0.0',()=>console.log('FenMovies Preview Studio running on port '+PORT));