const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const output = path.resolve('work/orders-review');
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
 for(const [width,height] of [[1366,768],[1920,1080]]){
 win.setContentSize(width,height);
 await win.loadURL(process.env.CENTRAL_ORIGIN+'/tests/central-fixture.html?count=55');await wait('.central-order');
 await evaluate('document.querySelectorAll(".app-navigation>button")[1].click()');await wait('.orders-table tbody .session-link');
 assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'Horizontal overflow');
 assert.equal(await evaluate('!!document.querySelector(".operations-overview, .workspace>aside")'),false,'Legacy layout remains');
 await capture('orders-'+width+'x'+height);
 await evaluate('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="Próxima página").click()');await pause();
 const sessionBefore=await evaluate('document.querySelector(".orders-table .session-link").textContent');
 await evaluate('document.querySelector(".orders-table .session-link").focus();document.querySelector(".orders-table .session-link").click()');await wait('.preview-facts');
 await capture('preview-'+width+'x'+height);
 await evaluate('document.querySelector(".ui-drawer>header button").click()');await pause();
 assert.equal(await evaluate('document.querySelector(".orders-table .session-link").textContent'),sessionBefore,'Page lost');
 assert.equal(await evaluate('document.activeElement.classList.contains("session-link")'),true,'Focus not restored');
 await evaluate('document.querySelector(".orders-table .session-link").focus();document.querySelector(".orders-table .session-link").click()');await wait('.preview-facts');
 await evaluate('document.querySelector(".order-preview .ui-button-primary").click()');await wait('.detail-modal');
 await evaluate('[...document.querySelectorAll(".detail-modal button")].find(button=>button.getAttribute("aria-label")==="Fechar ficha").click()');await pause();
 assert.equal(await evaluate('document.querySelector(".orders-table .session-link").textContent'),sessionBefore);
 await evaluate('Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(document.querySelector(".orders-search input"),"M999");document.querySelector(".orders-search input").dispatchEvent(new Event("input",{bubbles:true}))');await new Promise(r=>setTimeout(r,400));
 assert.equal(await evaluate('window.lastOrderOptions.filter'),'needs_me','Search silently changes scope');
 await evaluate('const select=document.querySelectorAll(".orders-control select")[0];Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(select,"all");select.dispatchEvent(new Event("change",{bubbles:true}))');await new Promise(r=>setTimeout(r,400));
 assert.equal(await evaluate('window.lastOrderOptions.filter'),'all');
 }
 await win.loadURL(process.env.CENTRAL_ORIGIN+'/tests/central-fixture.html?transport=http');await wait('.central-order');
 await evaluate('document.querySelectorAll(".app-navigation>button")[1].click()');await wait('.orders-table .session-link');
 assert.equal(await evaluate('document.body.innerText.includes("Selecionar vários")'),false,'Unsupported bulk shown remotely');
 await evaluate('document.querySelector(".orders-table .session-link").focus();document.querySelector(".orders-table .session-link").click()');await wait('.preview-facts');
 await capture('preview-http');
 for(const state of ['empty','error','loading','preview-error']){
 await win.loadURL(process.env.CENTRAL_ORIGIN+'/tests/central-fixture.html?state='+state);await wait('.app-navigation');
 await evaluate('document.querySelectorAll(".app-navigation>button")[1].click()');
 if(state==='preview-error'){await wait('.orders-table .session-link');await evaluate('document.querySelector(".orders-table .session-link").focus();document.querySelector(".orders-table .session-link").click()');await wait('.ui-drawer .ui-state-error');}
 else if(state==='loading')await wait('.orders-table tbody');
 else await wait('.orders-screen .ui-state-'+state);
 await capture('orders-'+state);
 }
 assert.deepEqual(errors,[]);console.log('Pedidos: 9 capturas; preview, paginação, foco, ficha, escopo da busca e estados aprovados. '+output);
 app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
 });
}
