#!/usr/bin/env node
// TEST ONLY. This intercepts external writes; it is not md2wechat implementation proof.
import { readFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const config = /* FIXTURE_CONFIG */ null;
const args=process.argv.slice(2),command=args[0];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
if(['upload_image','create_draft'].includes(command)){
 const bytes=await readFile(args[1]);const hash=digest(bytes);
 const request=command==='create_draft'?JSON.parse(bytes):null;
 await appendFile(config.log,JSON.stringify({command,sha256:hash,...(request?{request,contentSha256:digest(request.articles[0].content)}:{byteSize:bytes.length})})+'\n');
 const control=JSON.parse(await readFile(config.control,'utf8'));
 if(command==='create_draft'&&control.failDraft){process.stderr.write('simulated uncertain external write\n');process.exit(1);}
 const data=command==='upload_image'?{media_id:'fixture-'+hash,wechat_url:'https://mmbiz.qpic.cn/fixture/'+hash,width:1,height:1}:{media_id:'fixture-draft-'+hash};
 console.log(JSON.stringify({success:true,code:'OK',message:'Success',schema_version:'v1',status:'completed',retryable:false,data}));
}else{
 if(['download_and_upload','generate_image','generate_cover','generate_infographic'].includes(command))throw new Error('External write denied by acceptance fixture');
 const child=spawn(config.cli,args,{stdio:'inherit',env:process.env});child.on('error',()=>process.exit(1));child.on('exit',(code)=>process.exit(code??1));
}
