const fs=require('node:fs');
const {html}=require('../src/webview');
let page=html('demo');
page=page.replace('</head>', `<style nonce="demo">
html,body{width:1920px;height:1080px;box-sizing:border-box;overflow:hidden;background:#0e0e12!important;color:#f4f4f6!important;font-size:23px!important}
body{max-width:1200px!important;margin:0 auto!important;padding:166px 30px 0!important;background:transparent!important;font-family:Inter,Arial,sans-serif!important}h1{font-size:54px!important}.sub{font-size:22px!important;margin-bottom:27px!important}.search input{font-size:24px!important;padding:19px!important;background:#20222c!important;border-color:#555b6b!important}.search button{font-size:23px!important;padding:16px 26px!important;background:#63d297!important;color:#0e0e12!important}.card{background:#1b1d27!important;border-color:#444855!important;padding:21px 24px!important;margin:15px 0!important}.title{font-size:23px!important}.meta{font-size:18px!important}.snippet{font-size:18px!important;max-height:79px!important;margin:8px 0!important}.open{font-size:18px!important;color:#63d297!important}#status{font-size:18px!important;margin:18px 0!important}.chrome{position:fixed;left:0;right:0;top:0;height:60px;background:#1b1d27;border-bottom:1px solid #383b48;display:flex;align-items:center;padding-left:28px;color:#aeb3c1;font:18px sans-serif;z-index:2}.chrome .dots{color:#ff746c;letter-spacing:4px;margin-right:35px}.brand{position:fixed;bottom:32px;left:50px;color:#63d297;font:20px sans-serif}.badge{position:fixed;bottom:32px;right:50px;color:#aeb3c1;font:20px sans-serif}
</style></head>`);
page=page.replace('<body>','<body><div class="chrome"><span class="dots">● ● ●</span>VS Code　/　Chat Seek</div><div class="brand">CHAT SEEK</div><div class="badge">Claude Code · Codex · OpenCode</div><script nonce="demo">window.acquireVsCodeApi=()=>({postMessage:()=>{}});</script>');
const script=`<script nonce="demo">
const synthetic=[
{key:'Claude Code:jevbench',source:'Claude Code',title:'Implementing JevBench scoring and calibration',matches:[{text:'We built JevBench with a hard tier, calibration checks, and a composite score for decision models.',line:1}]},
{key:'Codex:router',source:'Codex',title:'Trying a Jev-based model router',matches:[{text:'The router uses a fast decision model to classify each request, then chooses a model by capability and cost.',line:1}]},
{key:'OpenCode:ui',source:'OpenCode',title:'Designing the benchmark results page',matches:[{text:'We added a results page, navigation, and a way to compare the measured systems.',line:1}]}];
const query='Where did we implement JevBench scoring?';
window.seekTo=t=>{
const field=document.getElementById('q');field.value=query.slice(0,Math.max(0,Math.min(query.length,Math.floor((t-1.2)*18))));
if(t<5){document.getElementById('results').replaceChildren();document.getElementById('status').textContent=t<1.2?'116,165 local messages indexed':'Describe a conversation, even if you only remember the idea.';}
else {window.dispatchEvent(new MessageEvent('message',{data:{type:'results',items:t<8?[synthetic[1],synthetic[0],synthetic[2]]:synthetic}}));document.getElementById('status').textContent=t<8?'Searching 116,165 local messages…':'Ranked locally with Laya · no chat data uploaded';}
};window.__ready=true;window.seekTo(0);
</script>`;
page=page.replace('</body>',script+'</body>');
fs.writeFileSync('demo/ui.html',page);
