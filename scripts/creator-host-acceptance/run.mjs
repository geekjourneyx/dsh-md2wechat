#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,copyFile,chmod} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const options={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i].replace(/^--/,'');options[key]=['browser','online','fixture-only','simulate-writes'].includes(key)?true:process.argv[++i];}
for(const k of ['package','host','cli','root'])assert.ok(typeof options[k]==='string'&&isAbsolute(options[k]),'--'+k+' absolute path required');
const root=options.root;assert.ok(root.split('/').filter(Boolean).length>=3&&root!=='/workspace/shared','dedicated root required');
await mkdir(root,{recursive:true,mode:0o700});
// Each run is append-only; never clean an existing root.
const runRoot=join(root,'run-'+Date.now());for(const d of ['home','tmp','workspace','logs','private'])await mkdir(join(runRoot,d),{recursive:true,mode:0o700});
const logs=join(runRoot,'logs'),workspace=join(runRoot,'workspace'),home=join(runRoot,'home');
const source=join(workspace,'article.md'),outside=join(runRoot,'outside.md');
await writeFile(source,'---\ntitle: 离线验收文章\nauthor: Fixture\ndigest: 仅本地测试。\n---\n\n# 离线验收文章\n\n这一段验证真实 CLI 排版与原生工作区。\n\n## 小结\n\n保留原文，选择主题后预览。\n');await writeFile(outside,'# Outside the session workspace\n');const original=await readFile(source);
const requestLog=[];let mockMode='success';
const mock=createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;assert.equal(req.url,'/api/convert');assert.equal(req.method,'POST');assert.equal(req.headers['x-api-key'],'fixture-local-key');const body=JSON.parse(raw);requestLog.push({path:req.url,body});res.setHeader('content-type','application/json');if(mockMode==='failure'){res.statusCode=400;res.end(JSON.stringify({code:1,msg:'fixture rejected'}));return;}const images=[...(body.markdown||'').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m=>`<img src="${m[1]}" />`).join('');const html=`<section data-fixture-theme="${body.theme}"><h1>离线验收文章</h1><p>真实 CLI 接收的本地排版响应。</p>${images}</section>\n`;res.end(JSON.stringify({code:0,data:{html,theme:body.theme,fontSize:body.fontSize||'medium',backgroundType:body.backgroundType||'none',wordCount:30,estimatedReadTime:1}}));}catch(e){res.statusCode=500;res.end(JSON.stringify({error:String(e)}));}});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));const api=`http://127.0.0.1:${mock.address().port}`;
const bridgeLog=join(logs,'simulated-writes.jsonl'),bridgeControl=join(runRoot,'write-control.json');
await writeFile(bridgeLog,'');await writeFile(bridgeControl,JSON.stringify({failDraft:false}));
let binary=options.cli;
if(options['simulate-writes']){binary=join(runRoot,'write-bridge.mjs');const template=await readFile(join(dirname(fileURLToPath(import.meta.url)),'write-bridge.mjs'),'utf8');await writeFile(binary,template.replace('/* FIXTURE_CONFIG */ null',JSON.stringify({cli:options.cli,log:bridgeLog,control:bridgeControl})));await chmod(binary,0o700);}
const fixture=join(runRoot,'fixture-plugin.mjs');await copyFile(join(dirname(fileURLToPath(import.meta.url)),'fixture-plugin.mjs'),fixture);
const fixtureResult=join(logs,'trajectory.json');const patch=join(runRoot,'fixture.patch.yml');await writeFile(patch,`- id: dsh-md2wechat
  config: ${JSON.stringify({binaryPath:binary,layoutBaseUrl:api,stateDir:join(runRoot,'private'),enableWechatWriteTools:!!options['simulate-writes'],enableFallbackImageTool:false,credentialRefs:{MD2WECHAT_API_KEY:'MD2WECHAT_API_KEY',WECHAT_APPID:'WECHAT_APPID',WECHAT_SECRET:'WECHAT_SECRET'}})}
- insert:\n    - id: md2wechat-e2e-fixture\n      name: ${JSON.stringify(pathToFileURL(fixture).href)}\n`);
const baseEnv={PATH:process.env.PATH,HOME:home,DSH_HOME:join(runRoot,'dsh-home'),TMPDIR:join(runRoot,'tmp'),DSH_TELEMETRY_DISABLED:'1',DSH_PERMISSION_MODE:'workspace-write',MD2WECHAT_BINARY_PATH:binary,WECHAT_APPID:'fixture-appid',WECHAT_SECRET:'fixture-secret',MD2WECHAT_API_KEY:'fixture-local-key',MD2WECHAT_BASE_URL:'http://127.0.0.1:1',E2E_HOST_ROOT:options.host,E2E_WORKSPACE:workspace,E2E_SOURCE:source,E2E_OUTSIDE_SOURCE:outside,E2E_FIXTURE_RESULT:fixtureResult,E2E_STATE_DIR:join(runRoot,'private'),NO_PROXY:'127.0.0.1,localhost'};
if(options['fixture-only'])baseEnv.E2E_TOOL='md2wechat_start_article';
// Deliberately wrong loopback config must lose to the signed plugin endpoint.
// No real account keys or external endpoints exist in this profile.
await mkdir(join(home,'.config','md2wechat'),{recursive:true});await writeFile(join(home,'.config','md2wechat','config.yaml'),`api:\n  md2wechat_key: fixture-local-key\n  md2wechat_base_url: http://127.0.0.1:1\n`);
await mkdir(join(workspace,'.md2wechat'),{recursive:true});await writeFile(join(workspace,'.md2wechat','config.yaml'),'api:\n  md2wechat_key: fixture-local-key\n  md2wechat_base_url: http://127.0.0.1:1\n');
const cli=join(options.host,'node_modules/@deepseek-ai/dsh/lib/bin.js');
const installEnv={...baseEnv};for(const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','NODE_USE_ENV_PROXY','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME'])if(process.env[key])installEnv[key]=process.env[key];
const report={runRoot,externalWrites:options['simulate-writes']?'simulated-no-WeChat-network':'disabled',packageSha256:createHash('sha256').update(await readFile(options.package)).digest('hex'),hostVersion:JSON.parse(await readFile(join(options.host,'node_modules/@deepseek-ai/dsh/package.json'))).version,checks:{},browser:options.browser?'pending':'not-requested'};
let host,browser,page;let stdout='',stderr='';let hostExit;
function command(args,env,timeout=120000){return new Promise((ok,no)=>{const p=spawn(process.execPath,[cli,...args],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>{p.kill('SIGTERM');no(new Error('command timed out'));},timeout);p.on('error',no);p.on('exit',code=>{clearTimeout(timer);if(code===0)ok({out,err});else no(new Error(`command exit ${code}: ${out}\n${err}`));});});}
async function waitFor(fn,ms=45000){const until=Date.now()+ms;while(Date.now()<until){const value=await fn();if(value)return value;if(hostExit)throw new Error('host exited: '+JSON.stringify(hostExit)+' '+stderr);await new Promise(r=>setTimeout(r,100));}throw new Error('readiness timeout: '+stderr);}
try{
 const args=['plugin','--profile','web','add',options.package,...(options.online?[]:['--offline']),...(options.store?['--store-dir',options.store]:[])];const installation=await command(args,installEnv);await writeFile(join(logs,'install.log'),installation.out+installation.err);report.checks.install=true;
 host=spawn(process.execPath,[cli,'--profile','web','--patch',patch,'--host','127.0.0.1','--port','0','--no-open'],{cwd:workspace,env:baseEnv,stdio:['ignore','pipe','pipe']});host.stdout.on('data',b=>stdout+=b);host.stderr.on('data',b=>stderr+=b);host.on('exit',(code,signal)=>hostExit={code,signal});
 const launch=await waitFor(()=>stdout.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]);const origin=new URL(launch).origin;
 const exchange=await fetch(launch,{redirect:'manual'});assert.equal(exchange.status,303);const cookie=exchange.headers.get('set-cookie').split(';')[0];
 const index=await fetch(origin,{headers:{cookie}});const html=await index.text();assert.equal(index.status,200);assert.ok(html.includes('__DSH_BOOT__'));assert.ok(html.includes('@geekjourneyx/dsh-md2wechat'));report.checks.authenticatedHost=true;
 const trajectory=await waitFor(async()=>{try{return JSON.parse(await readFile(fixtureResult,'utf8'));}catch{return null;}});assert.ok(!trajectory.error,trajectory.error);assert.ok(trajectory.calls.length>=1,'real loop did not record tool/call');assert.ok(trajectory.results.length>=1,'real loop did not record tool/result');report.checks.realAgentLoop=true;
 if(options['fixture-only']){report.fixtureOnly=true;report.fixtureCallCount=trajectory.calls.length;report.fixtureResultCount=trajectory.results.length;}
 else {
 assert.ok(trajectory.articleId,'tool/result lacks md2wechat-creator presentation metadata');assert.equal(trajectory.denied.isError,true,'read-only workspace unexpectedly writable');assert.equal(trajectory.outside.isError,true,'outside source unexpectedly readable');report.checks.sandboxReadOnly=true;report.checks.sandboxOutsideSource=true;
 let serial=0;async function rpc(method,args){const response=await fetch(origin+'/api/'+method,{method:'POST',headers:{cookie,'content-type':'application/json',origin},body:JSON.stringify({type:'client-request',rpcId:String(++serial),method,payload:{args}})});assert.equal(response.status,200);return (await response.json()).result;}
 const identity={agentId:trajectory.sessionId,articleId:trajectory.articleId};const read=await rpc('md2wechat/get',identity);assert.equal(read.ok,true,JSON.stringify(read));let view=read.value;
 const other=await rpc('session/create',{request:{cwd:workspace}});assert.equal(other.ok,true);const denied=await rpc('md2wechat/get',{...identity,agentId:other.value.sessionId});assert.equal(denied.ok,false,'cross-session article leaked');report.checks.crossSessionDenied=true;
 const missing=await rpc('md2wechat/get',{articleId:trajectory.articleId});assert.equal(missing.ok,false);report.checks.missingSessionDenied=true;
 const theme=view.themes.find(t=>t.name!==view.theme)?.name;assert.ok(theme);let result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'select-theme',theme}});assert.equal(result.ok,true,JSON.stringify(result));const oldVersion=view.version;view=result.value;assert.equal(view.theme,theme);report.checks.themeSelection=true;
 result=await rpc('md2wechat/dispatch',{...identity,version:oldVersion,action:{type:'review-current',publicationTitle:view.publicationTitle,previewPath:view.preview.path,previewSha256:view.preview.sha256}});assert.equal(result.ok,false,'stale version accepted');report.checks.staleVersionDenied=true;
 result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'refresh-preview'}});assert.equal(result.ok,true,JSON.stringify(result));view=result.value;assert.equal(view.preview.status,'ready',JSON.stringify(view));assert.ok(requestLog.length>=1,'real CLI did not call loopback renderer');report.checks.realCliPreview=true;report.checks.signedEndpointOverridesAmbient=true;
 const afterPreview=await waitFor(async()=>{const a=JSON.parse(await readFile(fixtureResult,'utf8'));return a.events.filter(e=>e.type==='turn/end').length>trajectory.events.filter(e=>e.type==='turn/end').length?a:null;});
 assert.equal(afterPreview.modelRequests,trajectory.modelRequests,'preview unexpectedly requested model');report.checks.previewNoModelRequest=true;
 const starts=new Map(),ends=new Map();for(const e of afterPreview.events){if(e.type==='turn/start')starts.set(e.data.turn,e.seq);if(e.type==='turn/end')ends.set(e.data.turn,e.seq);}
 const asked=afterPreview.events.filter(e=>e.type==='approval/asked'),decided=afterPreview.events.filter(e=>e.type==='approval/decided');assert.ok(asked.length>0,'preview approval not audited');assert.equal(asked.length,decided.length,'approval pairs unbalanced');for(const a of asked){const matches=decided.filter(d=>d.data.id===a.data.id);assert.equal(matches.length,1,'approval ID pair missing/duplicated');assert.ok(matches[0].seq>a.seq);assert.equal(matches[0].data.outcome,'allowed-once');}
 for(const e of [...asked,...decided])assert.ok([...starts].some(([turn,start])=>start<e.seq&&ends.get(turn)>e.seq),'approval event outside completed official turn: '+JSON.stringify(e));
 assert.equal(starts.size,ends.size,'turn boundaries unbalanced');report.checks.approvalEnclosedBalancedTurns=true;report.modelRequestsBeforePreview=trajectory.modelRequests;report.modelRequestsAfterPreview=afterPreview.modelRequests;await writeFile(join(logs,'preview-audit.json'),JSON.stringify(afterPreview,null,2));

 result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'review-current',publicationTitle:view.publicationTitle,previewPath:view.preview.path,previewSha256:'0'.repeat(64)}});assert.equal(result.ok,false,'wrong displayed preview hash accepted');report.checks.wrongPreviewReviewDenied=true;
 result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'review-current',publicationTitle:view.publicationTitle,previewPath:view.preview.path,previewSha256:view.preview.sha256}});assert.equal(result.ok,true,JSON.stringify(result));view=result.value;assert.equal(view.reviewed,true);report.checks.review=true;
 mockMode='failure';result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'refresh-preview'}});assert.equal(result.ok,true);assert.notEqual(result.value.preview.status,'ready');report.checks.failedPreviewVisible=true;mockMode='success';
 assert.deepEqual(await readFile(source),original);report.checks.originalUnchanged=true;report.sessionId=trajectory.sessionId;report.articleId=trajectory.articleId;
 if(options['simulate-writes']){
  const sha=b=>createHash('sha256').update(b).digest('hex');
  const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cS8AAAAASUVORK5CYII=','base64');
  const files=[];for(let i=0;i<3;i++){const bytes=Buffer.concat([pixel,Buffer.from('fixture-'+i)]),path=join(workspace,'fixture-'+i+'.png');await writeFile(path,bytes);files.push({path,sha256:sha(bytes)});}
  view=(await rpc('md2wechat/get',identity)).value;
  const action=async a=>{const r=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:a});assert.equal(r.ok,true,JSON.stringify(r));view=r.value;return view;};
  await action({type:'import-local-image',kind:'cover',anchorId:'',sourcePath:files[0].path,alt:'selected cover'});const selected=view.imageCandidates.at(-1).id;
  await action({type:'import-local-image',kind:'cover',anchorId:'',sourcePath:files[1].path,alt:'unselected cover'});
  await action({type:'select-cover',candidateId:selected});
  const anchor=view.imagePlacements[0].id;
  await action({type:'import-local-image',kind:'body',anchorId:anchor,sourcePath:files[2].path,alt:'body image'});const bodyId=view.imageCandidates.at(-1).id;
  await action({type:'place-image',candidateId:bodyId,anchorId:anchor});
  await action({type:'refresh-preview'});assert.equal(view.preview.status,'ready',JSON.stringify(view));
  assert.equal(view.preview.assets.length,0,'portable preview should not require external local assets');const portableBytes=await readFile(join(workspace,view.preview.path));assert.ok(portableBytes.toString().includes('data:image/png;base64,'),'local preview image is not portable');
  await action({type:'review-current',publicationTitle:view.publicationTitle,previewPath:view.preview.path,previewSha256:view.preview.sha256});await action({type:'export-html',destination:'exports/local-portable.html'});assert.deepEqual(await readFile(join(workspace,'exports/local-portable.html')),portableBytes);assert.equal((await readFile(bridgeLog,'utf8')).trim(),'','local export unexpectedly uploaded assets');report.checks.localImageExportPortableWithoutUpload=true;
  await action({type:'prepare-delivery'});assert.equal(view.preparedForDraft,true);assert.equal(view.reviewed,false);
  const finalBytes=await readFile(join(workspace,view.preview.path));assert.equal(sha(finalBytes),view.preview.sha256);
  await action({type:'review-current',publicationTitle:view.publicationTitle,previewPath:view.preview.path,previewSha256:view.preview.sha256});await action({type:'export-html',destination:'exports/final.html'});
  assert.deepEqual(await readFile(join(workspace,'exports/final.html')),finalBytes);
  await action({type:'create-draft',confirmed:true});assert.equal(view.delivery.status,'completed');
  const readWrites=async()=> (await readFile(bridgeLog,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
  let writes=await readWrites();const uploads=writes.filter(w=>w.command==='upload_image');assert.deepEqual(uploads.map(w=>w.sha256).sort(),[files[0].sha256,files[2].sha256].sort(),'only selected cover/body may upload');
  const drafts=writes.filter(w=>w.command==='create_draft');assert.equal(drafts.length,1);assert.equal(drafts[0].request.articles[0].content,finalBytes.toString());assert.equal(drafts[0].contentSha256,sha(finalBytes));
  await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'create-draft',confirmed:true}});assert.equal((await readWrites()).filter(w=>w.command==='create_draft').length,1,'duplicate completed draft issued');
  report.checks.simulatedSelectedOnlyUpload=true;report.checks.finalPreviewExportDraftIdentical=true;
  await action({type:'select-theme',theme:view.themes.find(t=>t.name!==view.theme).name});await action({type:'refresh-preview'});await action({type:'prepare-delivery'});await action({type:'review-current',publicationTitle:view.publicationTitle,previewPath:view.preview.path,previewSha256:view.preview.sha256});
  await writeFile(bridgeControl,JSON.stringify({failDraft:true}));await action({type:'create-draft',confirmed:true});assert.equal(view.delivery.status,'unknown');
  const beforeDuplicate=(await readWrites()).filter(w=>w.command==='create_draft').length;
  await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'create-draft',confirmed:true}});assert.equal((await readWrites()).filter(w=>w.command==='create_draft').length,beforeDuplicate,'unknown outcome retried external write');
  report.checks.unknownDraftDuplicateBlocked=true;const deliveryAudit=JSON.parse(await readFile(fixtureResult,'utf8'));assert.equal(deliveryAudit.modelRequests,trajectory.modelRequests,'deterministic delivery requested model');report.checks.deliveryNoModelRequest=true;report.deliveryApprovalTools=deliveryAudit.events.filter(e=>e.type==='approval/asked').map(e=>e.data.toolName);await writeFile(bridgeControl,JSON.stringify({failDraft:false}));assert.deepEqual(await readFile(source),original);
 }
 if(options.browser){
  assert.ok(options.playwright,'--playwright /absolute/playwright-core/index.mjs required');const {chromium}=await import(pathToFileURL(options.playwright).href);browser=await chromium.launch({...(options.chromium?{executablePath:options.chromium}:{}),headless:true,args:['--no-sandbox']});page=await browser.newPage({viewport:{width:1600,height:1100},deviceScaleFactor:1});await page.route('**/*',route=>{const u=new URL(route.request().url());return ['data:','blob:'].includes(u.protocol)||u.origin===origin?route.continue():route.abort();});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(launch);await page.getByText('离线验收会话',{exact:true}).first().click();const card=page.getByRole('region',{name:'文章工作区'});await card.waitFor({timeout:30000});await page.screenshot({path:join(logs,'01-desktop-renderer-error.png'),fullPage:true});await card.getByRole('button',{name:'更新预览',exact:true}).click();await waitFor(async()=>await card.getByRole('button',{name:'审阅当前版本',exact:true}).isEnabled(),30000);await card.getByRole('button',{name:'审阅当前版本',exact:true}).click();await card.getByRole('button',{name:'已审阅当前版本',exact:true}).waitFor();await card.frameLocator('iframe').getByText('真实 CLI 接收的本地排版响应。',{exact:true}).waitFor();await page.screenshot({path:join(logs,'02-desktop-reviewed-preview.png'),fullPage:true});const themeSelect=card.getByLabel('全部主题');const currentTheme=await themeSelect.inputValue();const alternateTheme=await themeSelect.locator('option').evaluateAll((opts,current)=>opts.find(o=>o.value!==current)?.value,currentTheme);assert.ok(alternateTheme);await themeSelect.selectOption(alternateTheme);await waitFor(async()=>await card.getByRole('button',{name:'审阅当前版本',exact:true}).isEnabled(),30000);await card.frameLocator('iframe').locator('section[data-fixture-theme="'+alternateTheme+'"]').waitFor();await page.screenshot({path:join(logs,'03-desktop-theme-selected.png'),fullPage:true});
  await card.getByRole('button',{name:'改进',exact:true}).click();await card.getByRole('button',{name:'检查阅读体验',exact:true}).click();await card.getByText('让结尾更清晰',{exact:true}).waitFor({timeout:30000});await page.screenshot({path:join(logs,'04-desktop-suggestion-review.png'),fullPage:true});
  await page.setViewportSize({width:430,height:932});await page.screenshot({path:join(logs,'05-narrow-suggestion-review.png'),fullPage:true});await card.screenshot({path:join(logs,'06-narrow-workspace.png')});
  assert.equal(errors.length,0,JSON.stringify(errors));report.browser='passed';report.checks.nativeToolCard=true;await browser.close();browser=undefined;
 }
 }
}catch(e){report.error=(e.stack||String(e)).replace(/token=[^\s&]+/g,'token=[REDACTED]');if(page)await page.screenshot({path:join(logs,'00-browser-failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{
 if(browser)await browser.close();if(host){host.kill('SIGTERM');await waitFor(()=>hostExit,10000).catch(()=>host.kill('SIGKILL'));report.exit=hostExit;}mock.close();await writeFile(join(logs,'host.stdout.log'),stdout.replace(/token=\S+/g,'token=[REDACTED]'));await writeFile(join(logs,'host.stderr.log'),stderr);await writeFile(join(logs,'renderer-requests.json'),JSON.stringify(requestLog,null,2));await writeFile(join(logs,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
