// Somente harness visual: não faz parte da entrada de produção e não acessa SQLite.
import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Tooltip from '@radix-ui/react-tooltip';
import '../src/styles.css';
import '../src/foundation.css';
const params = new URLSearchParams(location.search);
const role = params.get('role') || 'coordinator';
let state = params.get('state') || 'data';
const user = { id: role, nome: role === 'employee' ? 'Carlos · teste visual' : 'Henrique · teste visual', usuario: role, role };
const orders = Array.from({length:Number(params.get("count") || 6)}, (_, index) => ({id:'order-'+index, sessao:'M9999' + index, cliente_id:index===3?null:'client-'+(index%3), cliente_nome:['Ana · cliente sintético','Bruno · cliente sintético','Camila · cliente sintético'][index % 3], etapa:'em_tratamento', operacional_bucket:'needs_me', acao_recomendada:'Acompanhar tratamento das fotos', responsavel_atual:'Tratamento', prazo_tratamento_em:'2026-10-08', urgencia_texto:null, fotos_quantidade:30, revisao:1}));
const profiles = [
 {ok:true,linked:true,profile:{nomeCompleto:'Ana Cliente Sintética',documento:'12345678901',email:'ana@example.invalid',telefone:'4133334444',celular:'41999998888',logradouro:'Rua de Teste',numero:'123',complemento:'Sala 2',bairro:'Centro',cidade:'Curitiba',uf:'PR',cep:'80000000'}},
 {ok:true,linked:true,profile:{nomeCompleto:'Bruno Cliente Sintético',documento:'12345678000190',email:null,telefone:null,celular:'00000000000',logradouro:'Av. Sintética',numero:null,complemento:null,bairro:null,cidade:'São Paulo',uf:'SP',cep:null}},
 {ok:true,linked:true,profile:{nomeCompleto:'Camila Cliente Sintética',documento:null,email:'camila@example.invalid',telefone:null,celular:null,logradouro:null,numero:null,complemento:null,bairro:null,cidade:null,uf:null,cep:null}},
];
window.profileCalls=[]; window.profileFailures=0;
const tasks = ['Conferir seleção e separar as imagens prioritárias','Confirmar arquivos recebidos do laboratório','Preparar conferência da próxima remessa'].map((descricao,index) => ({id:'task'+index, revision:1, descricao, observacao:'Solicitação sintética para revisão visual.', responsavel_usuario_id:'employee', responsavel_nome:'Carlos', responsavel_usuario:'carlos', criado_por_nome:'Henrique', sessao_codigo:'M9999'+index, status:index===1?'in_progress':'pending', prazo_em:index===2?null:'2026-10-01T15:00:00Z', atrasada:false, solicitada_em:'2026-09-28T12:00:00Z'}));
const result = async (value) => { if(state==='loading') return new Promise(()=>{}); if(state==='error') return {ok:false,rows:[]}; return value; };
window.gestaoConfig = {dataTransport:params.get('transport') || 'ipc',apiUrl:location.origin};
window.gestaoAPI = {
 listOrders: async options => {window.lastOrderOptions=options; return result({ok:true,rows:state==='empty'?[]:orders});},
 getOrderClientProfile: async orderId => {window.profileCalls.push(orderId); if(window.profileFailures>0){window.profileFailures--;return {ok:false,error:'TEMPORARY',message:'Synthetic profile failure'};} await new Promise(resolve=>setTimeout(resolve,180)); return orders.find(order=>order.id===orderId)?.cliente_id ? profiles[Number(orderId.split('-')[1])%3] : {ok:true,linked:false,profile:null};},
 dashboard: () => result({ok:true,dashboard:{total:6,clientes:3,stages:{},queues:{needsMe:6,waiting:0,alerts:0,newSelections:0,due3:0,readyLabel:0}}}),
 listSolicitations: () => result({ok:true,rows:state==='empty'?[]:tasks}),
 listSolicitationAssignees: async()=>({ok:true,rows:[{id:'employee',nome:'Carlos',usuario:'carlos',role:'employee'}]}),
 getSolicitation: async(id)=>({ok:true,solicitation:tasks.find(item=>item.id===id)}),
 listClients: async()=>result({ok:true,rows:state==='empty'?[]:[{id:'client1',siwin_cad:10001,nome:'Ana · cliente sintético',email:'ana@example.invalid',celular:'00000000000',telefone:null,cidade:'Curitiba',uf:'PR',pedidos_quantidade:2},{id:'client2',siwin_cad:10002,nome:'Bruno · cliente sintético',email:null,celular:null,telefone:'00000000001',cidade:'São Paulo',uf:'SP',pedidos_quantidade:1}]}),
 siwinStatus: async()=>({ok:true,lastSync:null}),
 onSiwinUpdated:()=>()=>{},onThunderbirdUpdated:()=>()=>{},
 getOrder:async(id)=> state==='preview-error' ? {ok:false,message:'Falha sintética'} : ({ok:true,order:{...orders.find(order=>order.id===id),prazo_maximo_em:'2026-11-17',selecao_finalizada_em:'2026-09-18',observacoes:'Observação sintética para revisão do preview.',codigo_rastreio:null},attachments:[],items:[],siwinObservations:[],selectionEmails:[],events:[]})
};
if(params.get('transport')==='http') {
 const fixtureApi={...window.gestaoAPI};
 window.gestaoAPI.getOrderClientProfile=async()=>{throw Error('IPC local indisponível no transporte HTTP.');};
 const fixtureFetch=window.fetch;
 window.fetch=async(url,options)=>{
  const route=new URL(String(url));
  if(!route.pathname.startsWith('/api/'))return fixtureFetch(url,options);
  let payload;
  if(route.pathname==='/api/orders')payload=await window.gestaoAPI.listOrders(Object.fromEntries(route.searchParams));
  else if(route.pathname.startsWith('/api/orders/')&&route.pathname.endsWith('/client-profile'))payload=await fixtureApi.getOrderClientProfile(decodeURIComponent(route.pathname.split('/').at(-2)));
  else if(route.pathname.startsWith('/api/orders/'))payload=await window.gestaoAPI.getOrder(decodeURIComponent(route.pathname.split('/').pop()));
  else if(route.pathname==='/api/dashboard')payload=await window.gestaoAPI.dashboard();
  else if(route.pathname==='/api/solicitations')payload=await window.gestaoAPI.listSolicitations();
  else throw Error('Unexpected fixture route '+route.pathname);
  return new Response(JSON.stringify(payload),{headers:{'content-type':'application/json'}});
 };
}
window.recoverFixture = () => {state='data';};
const {App} = await import('../src/App');
createRoot(document.getElementById('root')).render(<React.StrictMode><Tooltip.Provider><App currentUser={user}/></Tooltip.Provider></React.StrictMode>);
