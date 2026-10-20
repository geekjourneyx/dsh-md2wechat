import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { historicalCardSeed, retainFixtureAgents, waitForFixtureCancellation } from './support.mjs';
import { pathToFileURL } from 'node:url';
const { LlmAdapter, createUserMessage }=await import(pathToFileURL(process.env.E2E_HOST_ROOT+'/node_modules/@deepseek-ai/dsh-llm/lib/index.js').href);
// Test-only adapter emits a genuine tool call. The real loop owns execution,
// tool/result presentationMeta, durable session events, and the native card.
export const name='md2wechat-e2e-fixture';
export const inject=['llm','agents','agentPresets','loader','tools','sessionPersistence'];
let modelRequests=0,heldSuggestionRequests=0;
class FixtureAdapter extends LlmAdapter {
  async listModels(provider){return [{provider,id:'fixture',name:'Offline creator fixture',inputModalities:['text']}];}
  async resolveModel(provider,id){return {provider,id,name:'Offline creator fixture',inputModalities:['text'],context:{contextWindow:131072}};}
  async *stream(options){
    modelRequests++;
    if(options.provider!=='creator-fixture')throw new Error('Fixture refuses other provider routes');
    const lastUser=options.messages.findLastIndex(m=>m.role==='user');
    const userText=JSON.stringify(options.messages[lastUser]?.content??'');
    if(userText.includes('md2wechat_propose_changes')&&!options.messages.slice(lastUser+1).some(m=>m.role==='tool')){
      const control=JSON.parse(await readFile(process.env.E2E_FIXTURE_CONTROL,'utf8'));
      if(control.holdSuggestions){heldSuggestionRequests++;await waitForFixtureCancellation(options.signal);}
      const blocks=options.messages[lastUser].content;
      const text=typeof blocks==='string'?blocks:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
      const line=text.split('\n').find(line=>line.startsWith('{')&&line.includes('requestId'));
      const request=JSON.parse(line);
      const args=JSON.stringify({articleId:request.articleId,version:request.version,requestId:request.requestId,changes:[{title:'让结尾更清晰',reason:'用具体动作收束段落，保持原意。',before:'保留原文，选择主题后预览。',after:'先保留原文，再选择主题并检查预览。'}]});
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id:'fixture-proposal-'+request.requestId,name:'md2wechat_propose_changes',argumentsDelta:args};
      yield {type:'block-end',index:0,block:{type:'tool-call',id:'fixture-proposal-'+request.requestId,name:'md2wechat_propose_changes',arguments:args}};
      yield {type:'finish',reason:{kind:'tool-calls'}};
      return;
    }
    const complete=options.messages.some(m=>m.role==='tool');
    if(!complete){
      const id='creator-fixture-open',name=process.env.E2E_TOOL||'md2wechat_open_workspace';
      const args=JSON.stringify({sourcePath:process.env.E2E_SOURCE,title:'离线验收文章'});
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:args};
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}};
      yield {type:'finish',reason:{kind:'tool-calls'}};
    }else{
      const text='离线测试已打开原生文章工作区。';
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text};
      yield {type:'block-end',index:0,block:{type:'text',text}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
}
export function apply(ctx){
 ctx.llm.registerAdapter(['creator-fixture'],new FixtureAdapter());
 // Approval remains real and audited; only this explicit isolated fixture answers.
 ctx.on('approval/request',async(req,next)=>['md2wechat_preview','md2wechat_prepare_delivery','md2wechat_export','md2wechat_create_draft'].includes(req.toolName)?'allowed-once':next());
 void ctx.loader.await().then(async()=>{
  const target=[...ctx.loader.entries()].find(e=>e.options.id==='dsh-md2wechat');
  if(!target)throw new Error('Installed plugin row missing');
  await ctx.loader.await();
  let saved;
  try { saved=JSON.parse(await readFile(process.env.E2E_FIXTURE_STATE,'utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  const resumed=!!saved;
  const handles=await retainFixtureAgents(ctx,saved?.sessions,process.env.E2E_WORKSPACE);
  const agent=handles.primary.agent;
  ctx.effect(()=>()=>Promise.all(Object.values(handles).map(handle=>handle.dispose())));
  let denied=saved?.denied,outside=saved?.outside;
  if(!saved){
    for(const [name,handle] of Object.entries(handles)){
      handle.agent.session.append('model/selection',{provider:'creator-fixture',model:'fixture'});
      handle.agent.session.append('sandbox/mode',{mode:'workspace-write'});
      handle.agent.session.append('session/title',{title:name==='primary'?'离线验收会话':'空白主面板会话',messageSeqs:[],source:{kind:'user'}});
    }
    // Only the primary fixture invokes a model. The panel fixture starts without any tool card.
    agent.followup(createUserMessage({content:[{type:'text',text:'用原生文章工作区打开测试 Markdown。'}],source:{kind:'user'}}));
    await agent.whenIdle();
    const deniedHandle=await ctx.agents.create({sessionId:randomUUID(),agentOptions:{provider:'creator-fixture',model:'fixture'},meta:{cwd:process.env.E2E_WORKSPACE},setup:c=>ctx.agentPresets.mount(c).then(()=>undefined)});
    try{
      deniedHandle.agent.session.append('sandbox/mode',{mode:'read-only'});
      denied=await ctx.tools.execute({callId:'e2e-readonly',name:process.env.E2E_TOOL||'md2wechat_open_workspace',arguments:{sourcePath:process.env.E2E_SOURCE},agent:deniedHandle.agent,signal:new AbortController().signal});
    }finally{await deniedHandle.dispose();}
    outside=await ctx.tools.execute({callId:'e2e-outside',name:process.env.E2E_TOOL||'md2wechat_open_workspace',arguments:{sourcePath:process.env.E2E_OUTSIDE_SOURCE},agent,signal:new AbortController().signal});
    if(!process.env.E2E_TOOL){
      // Explicit historical fixture, not evidence that the main tool trajectory was synthesized.
      handles.legacy=await ctx.agents.create({sessionId:randomUUID(),agentOptions:{provider:'creator-fixture',model:'fixture'},meta:{cwd:process.env.E2E_WORKSPACE},seed:historicalCardSeed(agent.session.snapshotEvents(),'old-card-'+randomUUID()),setup:c=>ctx.agentPresets.mount(c).then(()=>undefined)});
      handles.legacy.agent.session.append('session/title',{title:'历史卡片恢复测试',messageSeqs:[],source:{kind:'user'}});
    }
    saved={schemaVersion:1,sessions:Object.fromEntries(Object.entries(handles).map(([name,handle])=>[name,handle.agent.id])),denied,outside};
    await writeFile(process.env.E2E_FIXTURE_STATE+'.tmp',JSON.stringify(saved),{mode:0o600});
    await rename(process.env.E2E_FIXTURE_STATE+'.tmp',process.env.E2E_FIXTURE_STATE);
  }
  const events=agent.session.snapshotEvents();
  const calls=events.filter(e=>e.type==='tool/call'),results=events.filter(e=>e.type==='tool/result');
  const result=results.find(e=>e.data.meta?.kind==='md2wechat-creator');
  const audit={bootId:process.env.E2E_BOOT_ID,resumed,events:[],denied,outside,sessionId:agent.id,panelSessionId:handles.panel.agent.id,legacySessionId:handles.legacy?.agent.id,historicalFixture:handles.legacy?'seeded genuine fixture events with intentionally obsolete articleId':null,calls,results,articleId:result?.data.meta?.articleId,toolCount:ctx.tools.schemas().length,controlSequence:0};
  const persist=async()=>{
    const control=JSON.parse(await readFile(process.env.E2E_FIXTURE_CONTROL,'utf8'));
    if(control.sequence>audit.controlSequence){
      if(!['workspace-write','read-only'].includes(control.mode))throw new Error('Invalid fixture sandbox mode');
      agent.session.append('sandbox/mode',{mode:control.mode});
      audit.controlSequence=control.sequence;
    }
    audit.events=agent.session.snapshotEvents().filter(e=>['turn/start','turn/end','tool/call','tool/result','approval/asked','approval/decided'].includes(e.type));
    audit.panelEvents=handles.panel.agent.session.snapshotEvents().filter(e=>['turn/start','turn/end','tool/call','tool/result','approval/asked','approval/decided'].includes(e.type));
    audit.modelRequests=modelRequests;audit.heldSuggestionRequests=heldSuggestionRequests;audit.agentStatus=agent.status;audit.sampledAt=Date.now();
    await writeFile(process.env.E2E_FIXTURE_RESULT+'.tmp',JSON.stringify(audit,null,2));
    await rename(process.env.E2E_FIXTURE_RESULT+'.tmp',process.env.E2E_FIXTURE_RESULT);
  };
  await persist();
  let pending=false;const timer=setInterval(()=>{if(!pending){pending=true;persist().catch(error=>console.error('fixture audit failed:',error.message)).finally(()=>pending=false);}},100);
  ctx.effect(()=>()=>clearInterval(timer));
 }).catch(async e=>writeFile(process.env.E2E_FIXTURE_RESULT,JSON.stringify({error:e.stack||String(e)})));
}
