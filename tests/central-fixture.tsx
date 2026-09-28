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
const orders = Array.from({length:6}, (_, index) => ({id:String(index), sessao:'M9999' + index, cliente_nome:['Ana · cliente sintético','Bruno · cliente sintético','Camila · cliente sintético'][index % 3], etapa:'em_tratamento', operacional_bucket:'needs_me', acao_recomendada:'Acompanhar tratamento das fotos', responsavel_atual:'Tratamento', prazo_tratamento_em:'2026-10-08', urgencia_texto:null, fotos_quantidade:30, revisao:1}));
const tasks = ['Conferir seleção e separar as imagens prioritárias','Confirmar arquivos recebidos do laboratório','Preparar conferência da próxima remessa'].map((descricao,index) => ({id:'task'+index, revision:1, descricao, responsavel_usuario_id:'employee', responsavel_nome:'Carlos', responsavel_usuario:'carlos', sessao_codigo:'M9999'+index, status:index===1?'in_progress':'pending', prazo_em:index===2?null:'2026-10-01T15:00:00Z', atrasada:false, created_at:'2026-09-28T12:00:00Z'}));
const result = async (value) => { if(state==='loading') return new Promise(()=>{}); if(state==='error') return {ok:false,rows:[]}; return value; };
window.gestaoConfig = {dataTransport:'ipc'};
window.gestaoAPI = {
 listOrders: async options => {window.lastOrderOptions=options; return result({ok:true,rows:state==='empty'?[]:orders});},
 dashboard: () => result({ok:true,dashboard:{total:6,clientes:3,stages:{},queues:{needsMe:6,waiting:0,alerts:0,newSelections:0,due3:0,readyLabel:0}}}),
 listSolicitations: () => result({ok:true,rows:state==='empty'?[]:tasks}),
 listSolicitationAssignees: async()=>({ok:true,rows:[]}),
 siwinStatus: async()=>({ok:true,lastSync:null}),
 onSiwinUpdated:()=>()=>{},onThunderbirdUpdated:()=>()=>{},
 getOrder:async()=>({ok:false,message:'Ficha mantida para a próxima fase; fixture apenas da Central.'})
};
window.recoverFixture = () => {state='data';};
const {App} = await import('../src/App');
createRoot(document.getElementById('root')).render(<Tooltip.Provider><App currentUser={user}/></Tooltip.Provider>);
