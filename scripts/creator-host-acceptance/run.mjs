#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,copyFile,chmod,rename} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {assertNoAutomaticEffects,assertPendingSuggestion,assertReadOnlyAccess,assertRestoredArticle} from './support.mjs';
import {exerciseArticlePanel,restoreArticlePanel} from './browser.mjs';
import assert from 'node:assert/strict';
const options={};for(let i=2;i<process.argv.length;i++){const key=process.argv[i].replace(/^--/,'');options[key]=['browser','online','fixture-only','simulate-writes','inspect'].includes(key)?true:process.argv[++i];}
for(const k of ['package','host','cli','root'])assert.ok(typeof options[k]==='string'&&isAbsolute(options[k]),'--'+k+' absolute path required');
const root=options.root;assert.ok(root.split('/').filter(Boolean).length>=3&&root!=='/workspace/shared','dedicated root required');
await mkdir(root,{recursive:true,mode:0o700});
// Each run is append-only; never clean an existing root.
const runRoot=join(root,'run-'+Date.now());for(const d of ['home','tmp','workspace','logs','private'])await mkdir(join(runRoot,d),{recursive:true,mode:0o700});
const logs=join(runRoot,'logs'),workspace=join(runRoot,'workspace'),home=join(runRoot,'home');
const source=join(workspace,'article.md'),outside=join(runRoot,'outside.md');
await writeFile(source,'---\ntitle: 离线验收文章\nauthor: Fixture\ndigest: 仅本地测试。\n---\n\n# 离线验收文章\n\n这一段验证真实 CLI 排版与原生工作区。\n\n## 小结\n\n保留原文，选择主题后预览。\n');await writeFile(outside,'# Outside the session workspace\n');const original=await readFile(source);
const requestLog=[];let mockMode='success';
const mock=createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;assert.equal(req.url,'/api/convert');assert.equal(req.method,'POST');assert.equal(req.headers['x-api-key'],'fixture-local-key');const body=JSON.parse(raw);requestLog.push({path:req.url,body});res.setHeader('content-type','application/json');if(mockMode==='failure'){res.statusCode=400;res.end(JSON.stringify({code:1,msg:'fixture rejected'}));return;}const images=[...(body.markdown||'').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m=>`<img src="${m[1]}" />`).join('');const heading=(/^#\s+(.+)$/mu.exec(body.markdown||'')?.[1]||'离线验收文章').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));const html=`<section data-fixture-theme="${body.theme}"><h1>${heading}</h1><p>真实 CLI 接收的本地排版响应。</p>${images}</section>\n`;res.end(JSON.stringify({code:0,data:{html,theme:body.theme,fontSize:body.fontSize||'medium',backgroundType:body.backgroundType||'none',wordCount:30,estimatedReadTime:1}}));}catch(e){res.statusCode=500;res.end(JSON.stringify({error:String(e)}));}});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));const api=`http://127.0.0.1:${mock.address().port}`;
const bridgeLog=join(logs,'simulated-writes.jsonl'),bridgeControl=join(runRoot,'write-control.json');
await writeFile(bridgeLog,'');await writeFile(bridgeControl,JSON.stringify({failDraft:false}));
let binary=options.cli;
if(options['simulate-writes']){binary=join(runRoot,'write-bridge.mjs');const template=await readFile(join(dirname(fileURLToPath(import.meta.url)),'write-bridge.mjs'),'utf8');await writeFile(binary,template.replace('/* FIXTURE_CONFIG */ null',JSON.stringify({cli:options.cli,log:bridgeLog,control:bridgeControl})));await chmod(binary,0o700);}
const fixture=join(runRoot,'fixture-plugin.mjs');for(const file of ['fixture-plugin.mjs','support.mjs'])await copyFile(join(dirname(fileURLToPath(import.meta.url)),file),join(runRoot,file));
const fixtureControl=join(runRoot,'fixture-control.json');await writeFile(fixtureControl,JSON.stringify({sequence:0,mode:'workspace-write'}));
const fixtureResult=join(logs,'trajectory.json');const patch=join(runRoot,'fixture.patch.yml');await writeFile(patch,`- id: dsh-md2wechat
  config: ${JSON.stringify({binaryPath:binary,layoutBaseUrl:api,stateDir:join(runRoot,'private'),enableWechatWriteTools:!!options['simulate-writes'],enableFallbackImageTool:false,credentialRefs:{MD2WECHAT_API_KEY:'MD2WECHAT_API_KEY',WECHAT_APPID:'WECHAT_APPID',WECHAT_SECRET:'WECHAT_SECRET'}})}
- insert:\n    - id: md2wechat-e2e-fixture\n      name: ${JSON.stringify(pathToFileURL(fixture).href)}\n`);
const baseEnv={PATH:process.env.PATH,HOME:home,DSH_HOME:join(runRoot,'dsh-home'),TMPDIR:join(runRoot,'tmp'),DSH_TELEMETRY_DISABLED:'1',DSH_PERMISSION_MODE:'workspace-write',MD2WECHAT_BINARY_PATH:binary,WECHAT_APPID:'fixture-appid',WECHAT_SECRET:'fixture-secret',MD2WECHAT_API_KEY:'fixture-local-key',MD2WECHAT_BASE_URL:'http://127.0.0.1:1',E2E_HOST_ROOT:options.host,E2E_WORKSPACE:workspace,E2E_SOURCE:source,E2E_OUTSIDE_SOURCE:outside,E2E_FIXTURE_RESULT:fixtureResult,E2E_STATE_DIR:join(runRoot,'private'),E2E_FIXTURE_STATE:join(runRoot,'fixture-state.json'),E2E_FIXTURE_CONTROL:fixtureControl,NO_PROXY:'127.0.0.1,localhost'};
if(options['fixture-only'])baseEnv.E2E_TOOL='md2wechat_start_article';
// Deliberately wrong loopback config must lose to the signed plugin endpoint.
// No real account keys or external endpoints exist in this profile.
await mkdir(join(home,'.config','md2wechat'),{recursive:true});await writeFile(join(home,'.config','md2wechat','config.yaml'),`api:\n  md2wechat_key: fixture-local-key\n  md2wechat_base_url: http://127.0.0.1:1\n`);
await mkdir(join(workspace,'.md2wechat'),{recursive:true});await writeFile(join(workspace,'.md2wechat','config.yaml'),'api:\n  md2wechat_key: fixture-local-key\n  md2wechat_base_url: http://127.0.0.1:1\n');
const cli=join(options.host,'node_modules/@deepseek-ai/dsh/lib/bin.js');
const installEnv={...baseEnv};for(const key of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','NODE_USE_ENV_PROXY','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME'])if(process.env[key])installEnv[key]=process.env[key];
const report={runRoot,externalWrites:options['simulate-writes']?'simulated-no-WeChat-network':'disabled',packageSha256:createHash('sha256').update(await readFile(options.package)).digest('hex'),hostVersion:JSON.parse(await readFile(join(options.host,'node_modules/@deepseek-ai/dsh/package.json'))).version,checks:{},browser:options.browser?'pending':'not-requested'};
let host,browser,page;let stdout='',stderr='';let hostExit;let launch,origin,cookie,bootId;let serial=0;
const redact=text=>text.replace(/token=[^\s&]+/g,'token=[REDACTED]');
function command(args,env,timeout=120000){return new Promise((ok,no)=>{const p=spawn(process.execPath,[cli,...args],{cwd:workspace,env,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);const timer=setTimeout(()=>{p.kill('SIGTERM');no(new Error('command timed out'));},timeout);p.on('error',no);p.on('exit',code=>{clearTimeout(timer);if(code===0)ok({out,err});else no(new Error(`command exit ${code}: ${out}\n${err}`));});});}
async function waitFor(fn,ms=45000){const until=Date.now()+ms;while(Date.now()<until){const value=await fn();if(value)return value;if(hostExit)throw new Error('host exited: '+JSON.stringify(hostExit)+' '+stderr);await new Promise(r=>setTimeout(r,100));}throw new Error('readiness timeout: '+stderr);}
try{
 const args=['plugin','--profile','web','add',options.package,...(options.online?[]:['--offline']),...(options.store?['--store-dir',options.store]:[])];const installation=await command(args,installEnv);await writeFile(join(logs,'install.log'),installation.out+installation.err);report.checks.install=true;
 await startHost();
 const index=await fetch(origin,{headers:{cookie}});const html=await index.text();assert.equal(index.status,200);assert.ok(html.includes('__DSH_BOOT__'));assert.ok(html.includes('@geekjourneyx/dsh-md2wechat'));report.checks.authenticatedHost=true;
 const trajectory=await waitFor(async()=>{try{const audit=JSON.parse(await readFile(fixtureResult,'utf8'));return audit.bootId===bootId?audit:null;}catch{return null;}});assert.ok(!trajectory.error,trajectory.error);assert.ok(trajectory.calls.length>=1,'real loop did not record tool/call');assert.ok(trajectory.results.length>=1,'real loop did not record tool/result');report.checks.realAgentLoop=true;
 if(options['fixture-only']){report.fixtureOnly=true;report.fixtureCallCount=trajectory.calls.length;report.fixtureResultCount=trajectory.results.length;}
 else {
 assert.ok(trajectory.articleId,'tool/result lacks md2wechat-creator presentation metadata');assert.equal(trajectory.denied.isError,true,'read-only workspace unexpectedly writable');assert.equal(trajectory.outside.isError,true,'outside source unexpectedly readable');report.checks.sandboxReadOnly=true;report.checks.sandboxOutsideSource=true;
 const identity={agentId:trajectory.sessionId,articleId:trajectory.articleId};const read=await rpc('md2wechat/get',identity);assert.equal(read.ok,true,JSON.stringify(read));let view=read.value;
 const blankIdentity={agentId:trajectory.panelSessionId};
 const blank=await rpc('md2wechat/list',blankIdentity);assert.equal(blank.ok,true,JSON.stringify(blank));assert.deepEqual(blank.value,[],'blank session inherited another session articles');assert.equal(trajectory.panelEvents.length,0,'blank fixture already has a tool call');report.checks.blankRetainedSession=true;
 for(const method of ['get','resume']){const denied=await rpc('md2wechat/'+method,{...identity,...blankIdentity});assert.equal(denied.ok,false,'cross-session article leaked through '+method);}report.checks.crossSessionDenied=true;
 const articles=await rpc('md2wechat/list',{agentId:identity.agentId});assert.equal(articles.ok,true,JSON.stringify(articles));assert.equal(articles.value.length,1);assert.equal(articles.value[0].articleId,identity.articleId);
 const reopened=await rpc('md2wechat/open',{agentId:identity.agentId,source,title:'离线验收文章',options:{}});assert.equal(reopened.ok,true,JSON.stringify(reopened));assert.equal(reopened.value.articleId,identity.articleId,'same source created a replacement article');report.checks.stableArticleIdentity=true;
 const missing=await rpc('md2wechat/get',{articleId:trajectory.articleId});assert.equal(missing.ok,false);report.checks.missingSessionDenied=true;
 const theme=view.themes.find(t=>t.name!==view.theme)?.name;assert.ok(theme);let result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'select-theme',theme}});assert.equal(result.ok,true,JSON.stringify(result));const oldVersion=view.version;view=result.value;assert.equal(view.theme,theme);report.checks.themeSelection=true;
 result=await rpc('md2wechat/dispatch',{...identity,version:oldVersion,action:{type:'review-current',publicationTitle:view.publicationTitle,previewPath:view.preview.path,previewSha256:view.preview.sha256}});assert.equal(result.ok,false,'stale version accepted');report.checks.staleVersionDenied=true;
 result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'refresh-preview'}});assert.equal(result.ok,true,JSON.stringify(result));view=result.value;assert.equal(view.preview.status,'ready',JSON.stringify(view));assert.ok(requestLog.length>=1,'real CLI did not call loopback renderer');report.checks.realCliPreview=true;report.checks.signedEndpointOverridesAmbient=true;
 const afterPreview=JSON.parse(await readFile(fixtureResult,'utf8'));
 assert.equal(afterPreview.modelRequests,trajectory.modelRequests,'preview unexpectedly requested model');report.checks.previewNoModelRequest=true;
 assert.equal(afterPreview.events.filter(e=>e.type==='approval/asked').length,trajectory.events.filter(e=>e.type==='approval/asked').length,'preview unexpectedly requested approval');
 assert.equal(afterPreview.events.filter(e=>e.type==='turn/start').length,trajectory.events.filter(e=>e.type==='turn/start').length,'preview unexpectedly opened a conversation turn');
 report.checks.previewNoApprovalOrTurn=true;report.modelRequestsBeforePreview=trajectory.modelRequests;report.modelRequestsAfterPreview=afterPreview.modelRequests;await writeFile(join(logs,'preview-audit.json'),JSON.stringify(afterPreview,null,2));

 result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'review-current',publicationTitle:view.publicationTitle,previewPath:view.preview.path,previewSha256:'0'.repeat(64)}});assert.equal(result.ok,false,'wrong displayed preview hash accepted');report.checks.wrongPreviewReviewDenied=true;
 result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'review-current',publicationTitle:view.publicationTitle,previewPath:view.preview.path,previewSha256:view.preview.sha256}});assert.equal(result.ok,true,JSON.stringify(result));view=result.value;assert.equal(view.reviewed,true);report.checks.review=true;
 mockMode='failure';result=await rpc('md2wechat/dispatch',{...identity,version:view.version,action:{type:'refresh-preview'}});assert.equal(result.ok,true);assert.notEqual(result.value.preview.status,'ready');report.checks.failedPreviewVisible=true;mockMode='success';
 assert.deepEqual(await readFile(source),original);report.checks.originalUnchanged=true;
 report.sessionId=trajectory.sessionId;report.articleId=trajectory.articleId;
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
 let panelState;
 if(options.browser){
  assert.ok(options.playwright,'--playwright /absolute/playwright-core/index.mjs required');
  const {chromium}=await import(pathToFileURL(options.playwright).href);
  browser=await chromium.launch({...(options.chromium?{executablePath:options.chromium}:{}),headless:true,args:['--no-sandbox']});
  page=await browser.newPage({viewport:{width:1440,height:1100},deviceScaleFactor:1});
  await page.route('**/*',route=>{const u=new URL(route.request().url());return ['data:','blob:'].includes(u.protocol)||u.origin===origin?route.continue():route.abort();});
  panelState=await exerciseArticlePanel({page,launch,logs,source,trajectory,rpc,waitFor,readAudit,effects,report});
 }
 // Restart the actual installed host, not just the page or a component.
 const beforePending=await readAudit();
 await setFixtureControl({holdSuggestions:true});
 const current=(await rpc('md2wechat/get',identity)).value;assert.ok(current);
 const requested=await rpc('md2wechat/dispatch',{...identity,version:current.version,action:{type:'request-suggestions',kind:'layout'}});assert.equal(requested.ok,true,JSON.stringify(requested));assertPendingSuggestion(requested.value);
 // Wait for the one authorized fixture request to enter its cancellable hold before
 // taking the baseline. It cannot produce a proposal or a second model request.
 await waitFor(async()=>{const audit=await readAudit();return audit.heldSuggestionRequests===beforePending.heldSuggestionRequests+1&&audit.modelRequests===beforePending.modelRequests+1;});
 const saved=(await rpc('md2wechat/get',identity)).value;assert.ok(saved);assertPendingSuggestion(saved);
 const beforeRestart=await effects();await writeFile(join(logs,'before-restart-audit.json'),JSON.stringify(await readAudit(),null,2));
 await stopHost();await startHost();
 const restarted=await readAudit();assert.equal(restarted.resumed,true);assert.equal(restarted.sessionId,identity.agentId);assert.equal(restarted.panelSessionId,trajectory.panelSessionId);assert.equal(restarted.modelRequests,0,'restart requested a model');
 const resumed=await rpc('md2wechat/resume',identity);assert.equal(resumed.ok,true,JSON.stringify(resumed));assertRestoredArticle(saved,resumed.value);report.checks.hostRestartRestoresArticle=true;report.checks.restartPendingSuggestionCleared=true;
 const listed=await rpc('md2wechat/list',{agentId:identity.agentId});assert.equal(listed.ok,true);assert.equal(listed.value.find(item=>item.articleId===identity.articleId)?.theme,saved.theme);
 assertNoAutomaticEffects({...beforeRestart,modelRequests:0},await effects());report.checks.restartNoAutomaticEffects=true;
 if(options['simulate-writes']){
  assert.equal(resumed.value.delivery?.status,'unknown','unknown delivery barrier was not restored');
  const writesBefore=await readFile(bridgeLog,'utf8');
  const refreshed=await rpc('md2wechat/dispatch',{...identity,version:resumed.value.version,action:{type:'refresh-preview'}});assert.equal(refreshed.ok,true,JSON.stringify(refreshed));assert.equal(refreshed.value.preview.status,'ready');
  const reviewed=await rpc('md2wechat/dispatch',{...identity,version:refreshed.value.version,action:{type:'review-current',publicationTitle:refreshed.value.publicationTitle,previewPath:refreshed.value.preview.path,previewSha256:refreshed.value.preview.sha256}});assert.equal(reviewed.ok,true,JSON.stringify(reviewed));assert.equal(reviewed.value.reviewed,true);assert.equal(reviewed.value.delivery?.status,'unknown');
  for(const action of [{type:'prepare-delivery'},{type:'create-draft',confirmed:true}]){const blocked=await rpc('md2wechat/dispatch',{...identity,version:reviewed.value.version,action});assert.equal(blocked.ok,false,'fresh review bypassed unknown delivery barrier');}
  assert.equal(await readFile(bridgeLog,'utf8'),writesBefore,'restart retried unknown external write');report.checks.restartUnknownDraftBlocked=true;
 }
 // Official read-only mode revokes writes, not reads. Assert the actual policy
 // transition without presenting it as filesystem-read revocation coverage.
 await setFixtureControl({mode:'read-only'});
 const beforeReadOnly=await effects();
 const reads={list:await rpc('md2wechat/list',{agentId:identity.agentId}),get:await rpc('md2wechat/get',identity),resume:await rpc('md2wechat/resume',identity)};
 const mutation=await rpc('md2wechat/dispatch',{...identity,version:reads.get.value?.version??resumed.value.version,action:{type:'refresh-preview'}});
 assertReadOnlyAccess({...reads,mutation},identity.articleId);
 assertNoAutomaticEffects(beforeReadOnly,await effects());
 await setFixtureControl({mode:'workspace-write',holdSuggestions:false});report.checks.readOnlyReadsPreservedWritesDenied=true;
 if(page){await restoreArticlePanel({page,launch,logs,panelState,rpc,waitFor,readAudit,effects,report,workspace});await browser.close();browser=undefined;report.browser='passed';}
 assert.deepEqual(await readFile(source),original);report.checks.originalUnchanged=true;
 const imported=await rpc('md2wechat/importSource',{agentId:identity.agentId,input:{name:'对话文章.md',markdown:'# 对话文章\n\n直接在聊天里完成。'}});assert.equal(imported.ok,true,JSON.stringify(imported));
 let conversationView=imported.value;
 const changed=await rpc('md2wechat/dispatch',{agentId:identity.agentId,articleId:conversationView.articleId,version:conversationView.version,action:{type:'set-title',title:'新的公众号标题'}});assert.equal(changed.ok,true,JSON.stringify(changed));assert.equal(changed.value.title,'新的公众号标题');assert.equal(changed.value.reviewed,false);
 const refreshed=await rpc('md2wechat/dispatch',{agentId:identity.agentId,articleId:conversationView.articleId,version:changed.value.version,action:{type:'refresh-preview'}});assert.equal(refreshed.ok,true,JSON.stringify(refreshed));assert.equal(refreshed.value.publicationTitle,'新的公众号标题');assert.equal(refreshed.value.preview.status,'ready');
 const uploaded=await rpc('md2wechat/importImageBytes',{agentId:identity.agentId,input:{name:'封面.png',contentType:'image/png',data:[137,80,78,71,13,10,26,10,0]}});assert.equal(uploaded.ok,true,JSON.stringify(uploaded));
 const offered=await rpc('md2wechat/dispatch',{agentId:identity.agentId,articleId:conversationView.articleId,version:refreshed.value.version,action:{type:'import-local-image',kind:'cover',anchorId:'',sourcePath:uploaded.value.sourcePath,alt:'封面'}});assert.equal(offered.ok,true,JSON.stringify(offered));assert.equal(offered.value.imageCandidates.length,1);
 report.checks.conversationTextImport=true;report.checks.manualTitleMatchesPreview=true;report.checks.pickedImageImport=true;

 const inspectionAuditBefore=JSON.parse(await readFile(fixtureResult,'utf8'));
 const inspection=await rpc('md2wechat/dispatch',{agentId:identity.agentId,articleId:conversationView.articleId,version:refreshed.value.version,action:{type:'check-article'}});
 assert.equal(inspection.ok,true,JSON.stringify(inspection));assert.equal(inspection.value.inspection.ready,false);assert.ok(inspection.value.inspection.checks.some(item=>item.level==='error'));
 const inspectionAuditAfter=JSON.parse(await readFile(fixtureResult,'utf8'));assert.equal(inspectionAuditBefore.modelRequests,inspectionAuditAfter.modelRequests);report.checks.directCliInspection=true;
 if(options.inspect){await writeFile(join(runRoot,'inspect.json'),JSON.stringify({launch,origin,sessionId:identity.agentId,articleId:identity.articleId}));console.log('INSPECT_READY '+runRoot);await waitFor(async()=>{try{await readFile(join(runRoot,'finish-inspection'));return true}catch{return false}},1800000);}

 }
}catch(e){report.error=(e.stack||String(e)).replace(/token=[^\s&]+/g,'token=[REDACTED]');if(page){report.browser='failed';await page.screenshot({path:join(logs,'00-browser-failure.png'),fullPage:true}).catch(()=>{});}process.exitCode=1;}
finally{
 if(browser)await browser.close();if(host){await stopHost();report.exit=hostExit;}mock.close();await writeFile(join(logs,'host.stdout.log'),redact(stdout));await writeFile(join(logs,'host.stderr.log'),redact(stderr));await writeFile(join(logs,'renderer-requests.json'),JSON.stringify(requestLog,null,2));await writeFile(join(logs,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}

async function startHost(){
 hostExit=undefined;bootId=randomUUID();let launchOutput='';
 const processHost=spawn(process.execPath,[cli,'--profile','web','--patch',patch,'--host','127.0.0.1','--port','0','--no-open'],{cwd:workspace,env:{...baseEnv,E2E_BOOT_ID:bootId},stdio:['ignore','pipe','pipe']});host=processHost;
 processHost.stdout.on('data',bytes=>{stdout+=bytes;launchOutput+=bytes;});processHost.stderr.on('data',bytes=>stderr+=bytes);processHost.on('exit',(code,signal)=>{if(host===processHost)hostExit={code,signal};});
 launch=await waitFor(()=>launchOutput.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0]);origin=new URL(launch).origin;
 const exchange=await fetch(launch,{redirect:'manual'});assert.equal(exchange.status,303);cookie=exchange.headers.get('set-cookie').split(';')[0];
 await readAudit();
}
async function stopHost(){
 const processHost=host;if(!processHost)return;
 if(!hostExit){processHost.kill('SIGTERM');await waitFor(()=>hostExit,10000).catch(async()=>{processHost.kill('SIGKILL');await waitFor(()=>hostExit,5000);});}
 host=undefined;
}
async function rpc(method,args){const response=await fetch(origin+'/api/'+method,{method:'POST',headers:{cookie,'content-type':'application/json',origin},body:JSON.stringify({type:'client-request',rpcId:String(++serial),method,payload:{args}})});assert.equal(response.status,200);return (await response.json()).result;}
async function readAudit(){const after=Date.now();return waitFor(async()=>{try{const audit=JSON.parse(await readFile(fixtureResult,'utf8'));assert.ok(!audit.error,audit.error);return audit.bootId===bootId&&audit.sampledAt>=after?audit:null;}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}});}
async function effects(){const audit=await readAudit();return {modelRequests:audit.modelRequests,rendererRequests:requestLog.length,simulatedWrites:(await readFile(bridgeLog,'utf8')).trim().split('\n').filter(Boolean).length};}
async function setFixtureControl(update){const current=JSON.parse(await readFile(fixtureControl,'utf8'));await writeFile(fixtureControl+'.tmp',JSON.stringify({...current,...update,sequence:current.sequence+1}));await rename(fixtureControl+'.tmp',fixtureControl);await waitFor(async()=>{const audit=await readAudit();return audit.controlSequence===current.sequence+1;});}
