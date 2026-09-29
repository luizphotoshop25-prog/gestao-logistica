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
 const sortSelect='document.querySelectorAll(".orders-control select")[1]';
 await evaluate('(()=>{const select='+sortSelect+';Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(select,"session-desc");select.dispatchEvent(new Event("change",{bubbles:true}))})()');await pause();
 const descendingSessions=await evaluate('[...document.querySelectorAll(".orders-table .session-link")].map(element=>element.textContent.trim())');
 const expectedDescending=Array.from({length:50},(_,index)=>'M9999'+(54-index));
 assert.deepEqual(descendingSessions,expectedDescending,'Session descending order is numeric before pagination');
 if(width===1366)await capture('orders-session-desc-'+width+'x'+height);
 await evaluate('(()=>{const select='+sortSelect+';Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(select,"priority");select.dispatchEvent(new Event("change",{bubbles:true}))})()');await pause();
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
 assert.equal(await evaluate('document.querySelectorAll(".detail-nav button").length'),3);
 await capture('detail-summary-'+width+'x'+height);
 await evaluate('document.querySelectorAll(".detail-nav button")[1].click()');
 assert.equal(await evaluate('document.querySelector(".detail-modal").dataset.tab'),'operation');
 assert.equal(await evaluate('!!document.querySelector(".detail-modal .pane-shipping")'),true);
 await capture('detail-operation-'+width+'x'+height);
 await evaluate('document.querySelectorAll(".detail-nav button")[2].click()');
 assert.equal(await evaluate('document.querySelector(".detail-modal").dataset.tab'),'history');
 await evaluate('[...document.querySelectorAll(".detail-modal button")].find(button=>button.getAttribute("aria-label")==="Fechar ficha").click()');await pause();
 assert.equal(await evaluate('document.querySelector(".orders-table .session-link").textContent'),sessionBefore);
 assert.equal(await evaluate('document.activeElement.classList.contains("session-link")'),true,'Full detail did not restore focus');
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
 await evaluate('document.querySelector(".order-preview .ui-button-primary").click()');await wait('.detail-modal');
 await evaluate('document.querySelectorAll(".detail-nav button")[1].click()');
 assert.equal(await evaluate('document.querySelectorAll(".detail-modal .attachment-button").length'),0,'Local-only action shown over HTTP');
 await evaluate('document.querySelectorAll(".detail-nav button")[0].click()');
 await evaluate('[...document.querySelectorAll(".detail-modal button")].find(button=>button.getAttribute("aria-label")==="Fechar ficha")?.click()');
 await win.loadURL(process.env.CENTRAL_ORIGIN+'/tests/central-fixture.html?count=55');await wait('.central-order');
 await evaluate('document.querySelectorAll(".app-navigation>button")[1].click()');await wait('.orders-table .session-link');
 await evaluate('document.querySelector(".orders-table .session-link").focus();document.querySelector(".orders-table .session-link").click()');await wait('.preview-facts');
 await evaluate('document.querySelector(".order-preview .ui-button-primary").click()');await wait('.detail-modal');
 await evaluate('const field=document.querySelector(".detail-modal textarea:not([readonly])");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"Alteração sintética sem salvar");field.dispatchEvent(new Event("input",{bubbles:true}))');await pause();
 assert.equal(await evaluate('document.querySelector(".detail-modal .save-state").textContent.includes("não salvas")'),true,'Dirty state not detected');
 await evaluate('document.querySelectorAll(".app-navigation>button")[0].click()');await wait('.confirmation-modal');
 assert.equal(await evaluate('!!document.querySelector(".detail-modal")'),true);
 await evaluate('document.querySelector(".confirmation-modal .secondary").click()');await pause();
 assert.equal(await evaluate('!!document.querySelector(".detail-modal")'),true,'Cancel lost unsaved form');
 for(const state of ['empty','error','loading','preview-error']){
 await win.loadURL(process.env.CENTRAL_ORIGIN+'/tests/central-fixture.html?state='+state);await wait('.app-navigation');
 await evaluate('document.querySelectorAll(".app-navigation>button")[1].click()');
 if(state==='preview-error'){await wait('.orders-table .session-link');await evaluate('document.querySelector(".orders-table .session-link").focus();document.querySelector(".orders-table .session-link").click()');await wait('.ui-drawer .ui-state-error');}
 else if(state==='loading')await wait('.orders-table tbody');
 else await wait('.orders-screen .ui-state-'+state);
 await capture('orders-'+state);
 }
 assert.deepEqual(errors,[]);console.log('Pedidos e ficha: 13 capturas; preview, paginação, foco, ficha, escopo da busca e estados aprovados. '+output);
 app.exit(0);
 }catch(error){console.error(error);app.exit(1);}
 });
}
