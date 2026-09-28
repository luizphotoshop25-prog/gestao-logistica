const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const output = path.resolve('work/central-review');
if (!process.versions.electron) {
 (async()=>{
 const server=await (await import('vite')).createServer({server:{host:'127.0.0.1',port:0}});
 await server.listen();
 const env={...process.env,CENTRAL_ORIGIN:'http://127.0.0.1:'+server.httpServer.address().port}; delete env.ELECTRON_RUN_AS_NODE;
 try { await new Promise((resolve,reject)=>{ const child=spawn(require('electron'),[__filename],{env,stdio:'inherit',windowsHide:true});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Capture exit '+code))); }); }
 finally {await server.close();}
 })().catch(error=>{console.error(error);process.exitCode=1;});
} else {
 const {app,BrowserWindow}=require('electron');
 fs.mkdirSync(output,{recursive:true});app.setPath('userData',path.join(output,'profile'));
 app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,width:1366,height:768,useContentSize:true,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',details=>{if(details.level===3)errors.push(details.message);});
 const evaluate=code=>win.webContents.executeJavaScript(code);
 const pause=()=>new Promise(resolve=>setTimeout(resolve,250));
 async function wait(selector){for(let i=0;i<80;i++){if(await evaluate('!!document.querySelector('+JSON.stringify(selector)+')'))return;await pause();}throw Error('Missing '+selector);}
 async function capture(name){await evaluate('document.fonts.ready');await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await new Promise(resolve=>setTimeout(resolve,700));fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());}
 try {
 for(const [width,height,scale] of [[1366,768,1],[1920,1080,1],[1366,768,1.25]]){
 win.setContentSize(width,height);win.webContents.setZoomFactor(scale);
 for(const role of ['coordinator','employee']){
 await win.loadURL(process.env.CENTRAL_ORIGIN+'/tests/central-fixture.html?role='+role); await wait('.central-order');
 assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'Horizontal overflow');
 assert.equal(await evaluate('document.querySelectorAll(".central-signals button").length'),4);
 if(role==='employee')assert.equal(await evaluate('document.querySelector(".central-columns").firstElementChild.classList.contains("central-tasks")'),true);
 await capture(role+'-'+width+'x'+height+(scale>1?'-zoom125':''));
 await evaluate('document.querySelector(".central-task").click()');await wait('.solicitation-detail-grid');
 await evaluate('document.querySelector(".solicitation-modal .icon-button").click();document.querySelectorAll(".app-navigation>button")[0].click()');await wait('.central-order');
 await evaluate('document.querySelector(".central-signal").click()');await wait('.orders-panel');
 assert.equal(await evaluate('document.querySelector(".app-navigation [aria-current]").textContent'),'Pedidos');
 await evaluate('document.querySelectorAll(".app-navigation>button")[2].click()');await wait('.solicitations-page');
 assert.equal(await evaluate('!!document.querySelector(".app-navigation")'),true);
 }
 }
 win.setContentSize(1366,768);win.webContents.setZoomFactor(1);
 for(const state of ['empty','error','loading']){
 await win.loadURL(process.env.CENTRAL_ORIGIN+'/tests/central-fixture.html?state='+state);await wait('.ui-state-'+state);await capture(state+'-1366x768');
 if(state==='error'){
 assert.equal(await evaluate('document.querySelectorAll(".ui-state-empty").length'),0);
 await evaluate('window.recoverFixture();document.querySelector(".ui-state-error button").click()');await wait('.central-order');
 }
 }
 assert.deepEqual(errors,[]);console.log('Central: 9 capturas; navegação, perfis, estados, recuperação e overflow aprovados. '+output);
 app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
 });
}
