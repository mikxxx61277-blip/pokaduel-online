
'use strict';
const http=require('http');
const WebSocket=require('ws');

const PORT=Number(process.env.PORT||10000), HOST='0.0.0.0', PROTOCOL='pokaduel-v1';
const SUPABASE_URL=String(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
const SUPABASE_SERVICE_ROLE_KEY=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
const clients=new Map(), rooms=new Map(), queue=[];

function json(res,status,obj){
  res.writeHead(status,{
    'content-type':'application/json; charset=utf-8',
    'access-control-allow-origin':'*',
    'access-control-allow-methods':'GET,POST,OPTIONS',
    'access-control-allow-headers':'content-type'
  });
  res.end(JSON.stringify(obj));
}
function text(res,status,body){
  res.writeHead(status,{'content-type':'text/plain; charset=utf-8','access-control-allow-origin':'*'});
  res.end(body);
}
function readJson(req,max=131072){
  return new Promise((resolve,reject)=>{
    let n=0,parts=[];
    req.on('data',c=>{n+=c.length;if(n>max){reject(new Error('BODY_TOO_LARGE'));req.destroy();return}parts.push(c)});
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')||'{}'))}catch(e){reject(new Error('INVALID_JSON'))}});
    req.on('error',reject);
  });
}
function todayParis(){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const m=Object.fromEntries(p.map(x=>[x.type,x.value]));
  return `${m.year}-${m.month}-${m.day}`;
}
function hash(s){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
function rng(seed){let a=seed>>>0;return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296}}
const SUITS=['♠','♥','♦','♣'];
const RANKS=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RV={'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
function dailyDeck(day){
  const r=rng(hash('POKADUEL|'+day+'|V22.01'));
  const d=[];for(const s of SUITS)for(const rank of RANKS)d.push({r:rank,s,id:rank+s});
  for(let i=d.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[d[i],d[j]]=[d[j],d[i]]}
  const starter=r()<.5?'h':'a';
  return {deck:d,starter};
}
function cardId(c){return c&&String(c.r||'')+String(c.s||'')}
function validCard(c){return !!c&&RANKS.includes(String(c.r))&&SUITS.includes(String(c.s))}
function eval5(cs){
  const rs=cs.map(c=>RV[c.r]).sort((a,b)=>b-a),cnt={};rs.forEach(r=>cnt[r]=(cnt[r]||0)+1);
  const g=Object.entries(cnt).map(([r,n])=>({r:+r,n})).sort((a,b)=>b.n-a.n||b.r-a.r),flush=cs.every(c=>c.s===cs[0].s),u=[...new Set(rs)].sort((a,b)=>b-a);
  let st=0;if(u.length===5){if(u[0]-u[4]===4)st=u[0];else if(u.join(',')==='14,5,4,3,2')st=5}
  if(flush&&st)return{c:8,t:[st],n:'Quinte flush'};
  if(g[0].n===4)return{c:7,t:[g[0].r,g[1].r],n:'Carré'};
  if(g[0].n===3&&g[1].n===2)return{c:6,t:[g[0].r,g[1].r],n:'Full'};
  if(flush)return{c:5,t:rs,n:'Couleur'};
  if(st)return{c:4,t:[st],n:'Suite'};
  if(g[0].n===3)return{c:3,t:[g[0].r,...g.slice(1).map(x=>x.r).sort((a,b)=>b-a)],n:'Brelan'};
  if(g[0].n===2&&g[1].n===2){const hi=Math.max(g[0].r,g[1].r),lo=Math.min(g[0].r,g[1].r);return{c:2,t:[hi,lo,g[2].r],n:'Deux paires'}}
  if(g[0].n===2)return{c:1,t:[g[0].r,...g.slice(1).map(x=>x.r).sort((a,b)=>b-a)],n:'Paire'};
  return{c:0,t:rs,n:'Carte haute'};
}
function cmp(a,b){if(a.c!==b.c)return a.c>b.c?1:-1;for(let i=0;i<Math.max(a.t.length,b.t.length);i++){const x=a.t[i]||0,y=b.t[i]||0;if(x!==y)return x>y?1:-1}return 0}
function ordinal(h){const v=[Number(h.c)||0];for(let i=0;i<5;i++)v.push(Number(h.t&&h.t[i])||0);let n=0;for(let i=0;i<6;i++)n=n*15+v[i];return n}
function sanitizeName(x){return String(x||'JOUEUR').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,24)||'JOUEUR'}
function validateSnapshot(p){
  if(!p||p.protocol!=='POKADUEL_DAILY_V2')throw new Error('BAD_PROTOCOL');
  const day=String(p.day||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||day!==todayParis())throw new Error('BAD_DUEL_DAY');
  const playerId=String(p.playerId||'').trim();if(!playerId||playerId.length>80)throw new Error('BAD_PLAYER_ID');
  if(p.opponent!=='LILOU'||p.difficulty!=='DIFFICILE')throw new Error('BAD_DAILY_MODE');
  if(!Array.isArray(p.human)||!Array.isArray(p.ai)||p.human.length!==5||p.ai.length!==5)throw new Error('BAD_COLUMNS');
  for(const side of [p.human,p.ai])for(const col of side){if(!Array.isArray(col)||col.length!==5||!col.every(validCard))throw new Error('BAD_HANDS')}
  const hd=p.humanDiscard||null,ad=p.aiDiscard||null,rem=Array.isArray(p.remainingDeck)?p.remainingDeck:[];
  if(hd&&!validCard(hd))throw new Error('BAD_HUMAN_DISCARD');if(ad&&!validCard(ad))throw new Error('BAD_AI_DISCARD');if(!rem.every(validCard))throw new Error('BAD_REMAINING_DECK');
  const all=[...p.human.flat(),...p.ai.flat(),...(hd?[hd]:[]),...(ad?[ad]:[]),...rem];
  if(all.length!==52||new Set(all.map(cardId)).size!==52)throw new Error('BAD_DECK_PARTITION');
  const expected=dailyDeck(day);
  if(String(p.starter||'')!==expected.starter)throw new Error('BAD_STARTER');
  const consumed=52-rem.length;
  const prefixSet=new Set(expected.deck.slice(0,consumed).map(cardId));
  const consumedSet=new Set([...p.human.flat(),...p.ai.flat(),...(hd?[hd]:[]),...(ad?[ad]:[])].map(cardId));
  if(prefixSet.size!==consumedSet.size||[...prefixSet].some(x=>!consumedSet.has(x)))throw new Error('BAD_DAILY_CARD_SET');
  const expectedRem=expected.deck.slice(consumed).map(cardId), gotRem=rem.map(cardId);
  if(expectedRem.length!==gotRem.length||expectedRem.some((x,i)=>x!==gotRem[i]))throw new Error('BAD_DAILY_REMAINDER');
  return {day,playerId,playerName:sanitizeName(p.playerName),expectedSeed:hash('POKADUEL|'+day+'|V22.01')};
}
function scoreSnapshot(p){
  let humanWins=0,aiWins=0,ties=0;const duels=[],non=[],wins=[];
  for(let i=0;i<5;i++){
    const h=eval5(p.human[i]),a=eval5(p.ai[i]),c=cmp(h,a),gap=Math.abs(ordinal(h)-ordinal(a));
    if(c>0){humanWins++;wins.push(gap)}else if(c<0){aiWins++;non.push(gap)}else{ties++;non.push(0)}
    duels.push({column:i+1,result:c>0?'W':c<0?'L':'T',human:h,ai:a,gap});
  }
  non.sort((a,b)=>a-b);wins.sort((a,b)=>b-a);
  const nonWinTotal=non.reduce((a,b)=>a+b,0), nonWinWorst=non.length?Math.max(...non):0, winTotal=wins.reduce((a,b)=>a+b,0);
  return {won:humanWins>aiWins,draw:humanWins===aiWins,humanWins,aiWins,ties,score:`${humanWins}-${aiWins}`,nonWinTotal,nonWinWorst,winTotal,duels};
}
async function sb(path,options={}){
  if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)throw new Error('SUPABASE_SERVER_NOT_CONFIGURED');
  const r=await fetch(SUPABASE_URL+'/rest/v1/'+path,{...options,headers:{apikey:SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json',...(options.headers||{})}});
  const txt=await r.text();let data=null;try{data=txt?JSON.parse(txt):null}catch{data=txt}
  if(!r.ok){const e=new Error('SUPABASE_'+r.status);e.detail=data;throw e}return data;
}
async function postDaily(req,res){
  try{
    const p=await readJson(req),v=validateSnapshot(p),s=scoreSnapshot(p);
    const row={
      duel_day:v.day,daily_seed:String(v.expectedSeed),player_id:v.playerId,player_name:v.playerName,
      opponent:'LILOU',difficulty:'DIFFICILE',won:s.won,columns_won:s.humanWins,
      quality:-s.nonWinTotal,poker_tiebreak:s.winTotal,
      non_win_total:s.nonWinTotal,non_win_worst:s.nonWinWorst,win_total:s.winTotal,
      result_json:{schema:'POKADUEL_DAILY_SERVER_V24.23',verified:true,...s,humanDiscard:p.humanDiscard||null,aiDiscard:p.aiDiscard||null,starter:p.starter},
      client_version:String(p.clientVersion||'24.23').slice(0,32)
    };
    const data=await sb('daily_duel_results',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify(row)});
    return json(res,201,{ok:true,row:Array.isArray(data)?data[0]:data});
  }catch(e){
    const msg=String(e&&e.message||e);
    if(e&&e.detail&&JSON.stringify(e.detail).includes('daily_duel_one_official_per_player'))return json(res,409,{ok:false,error:'ALREADY_RANKED'});
    return json(res,msg.startsWith('BAD_')?400:500,{ok:false,error:msg});
  }
}
async function getRanking(req,res){
  try{
    const u=new URL(req.url,'http://localhost'),day=String(u.searchParams.get('day')||todayParis());
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day))return json(res,400,{ok:false,error:'BAD_DUEL_DAY'});
    const q='daily_duel_results?duel_day=eq.'+encodeURIComponent(day)+
      '&select=player_id,player_name,won,columns_won,non_win_total,non_win_worst,win_total,created_at'+
      '&order=won.desc,columns_won.desc,non_win_total.asc,non_win_worst.asc,win_total.desc,created_at.asc';
    const rows=await sb(q,{method:'GET'});
    return json(res,200,{ok:true,day,rows:(rows||[]).map((r,i)=>({...r,rank:i+1}))});
  }catch(e){return json(res,500,{ok:false,error:String(e&&e.message||e)})}
}

const server=http.createServer(async(req,res)=>{
  if(req.method==='OPTIONS'){res.writeHead(204,{'access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type'});return res.end()}
  if(req.url==='/health')return json(res,200,{ok:true,app:'POKADUEL',version:'19.06',rooms:rooms.size,clients:clients.size,dailyServer:!!(SUPABASE_URL&&SUPABASE_SERVICE_ROLE_KEY)});
  if(req.method==='POST'&&req.url==='/daily-duel/result')return postDaily(req,res);
  if(req.method==='GET'&&req.url.startsWith('/daily-duel/ranking'))return getRanking(req,res);
  return text(res,200,'POKADUEL V19.06 WebSocket + Daily Duel server is online.');
});

const wss=new WebSocket.Server({server});
function send(ws,o){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(o))}
function norm(c){return String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^POKA/,'').slice(0,6)}
function code(){const ch='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let o='';do{o='';for(let i=0;i<6;i++)o+=ch[(Math.random()*ch.length)|0]}while(rooms.has(o));return o}
function leave(ws){const c=clients.get(ws);if(!c)return;const qi=queue.indexOf(ws);if(qi>=0)queue.splice(qi,1);if(c.room&&rooms.has(c.room)){const set=rooms.get(c.room);set.delete(ws);for(const p of set)send(p,{protocol:PROTOCOL,type:'peer_left',room:c.room});if(!set.size)rooms.delete(c.room)}c.room=null;c.role=null}
function announce(c){const set=rooms.get(c);if(!set||set.size!==2)return;const [a,b]=[...set],ca=clients.get(a),cb=clients.get(b);send(a,{protocol:PROTOCOL,type:'peer_joined',room:c,peerId:cb.id,peerName:'JOUEUR 2'});send(b,{protocol:PROTOCOL,type:'peer_joined',room:c,peerId:ca.id,peerName:'JOUEUR 1'})}
function join(ws,c,role='guest'){c=norm(c);if(!c||!rooms.has(c))return send(ws,{protocol:PROTOCOL,type:'error',message:'Salon introuvable.'});const set=rooms.get(c);if(set.size>=2)return send(ws,{protocol:PROTOCOL,type:'error',message:'Salon complet.'});leave(ws);set.add(ws);const x=clients.get(ws);x.room=c;x.role=role;send(ws,{protocol:PROTOCOL,type:'joined',room:c,role});announce(c)}
function relay(ws,m){const c=clients.get(ws);if(!c||!c.room||!rooms.has(c.room))return;for(const p of rooms.get(c.room)){if(p!==ws)send(p,Object.assign({},m,{protocol:PROTOCOL,room:c.room,clientId:c.id}))}}
wss.on('connection',ws=>{clients.set(ws,{id:null,room:null,role:null});ws.on('message',raw=>{let m;try{m=JSON.parse(raw.toString())}catch{return}if(!m||m.protocol!==PROTOCOL)return;const c=clients.get(ws);if(m.clientId)c.id=String(m.clientId).slice(0,64);
if(m.type==='create_room'){leave(ws);const r=code();rooms.set(r,new Set([ws]));c.room=r;c.role='host';send(ws,{protocol:PROTOCOL,type:'created',room:r,role:'host'});return}
if(m.type==='join_room'){join(ws,m.room,'guest');return}
if(m.type==='matchmake'){leave(ws);while(queue.length&&queue[0].readyState!==WebSocket.OPEN)queue.shift();if(queue.length){const other=queue.shift(),r=code();rooms.set(r,new Set([other]));const oc=clients.get(other);oc.room=r;oc.role='host';send(other,{protocol:PROTOCOL,type:'joined',room:r,role:'host'});join(ws,r,'guest')}else{queue.push(ws);send(ws,{protocol:PROTOCOL,type:'joined',room:null,role:'queue'})}return}
if(m.type==='game_start'||m.type==='game_state'||m.type==='game_rematch'){relay(ws,m);return}
});ws.on('close',()=>{leave(ws);clients.delete(ws)});ws.on('error',()=>{})});
server.listen(PORT,HOST,()=>console.log(`POKADUEL V19.06 listening on http://${HOST}:${PORT}`));
