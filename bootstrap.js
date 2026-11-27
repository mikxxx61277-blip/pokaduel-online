'use strict';
const http=require('http');
const crypto=require('crypto');
const SUPABASE_URL=String(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
const SUPABASE_SERVICE_ROLE_KEY=String(process.env.SUPABASE_SERVICE_ROLE_KEY||'').trim();
const MAX=5, REGEN=30*60*1000;
const AD_MIN=Math.max(3000,Number(process.env.POKADUEL_AD_MIN_VIEW_MS||15000));
const AD_TTL=10*60*1000;
const SECRET=String(process.env.POKADUEL_ECONOMY_SECRET||SUPABASE_SERVICE_ROLE_KEY||'POKADUEL_DEV_ONLY_CHANGE_ME');
const locks=new Map();
function json(res,status,obj){res.writeHead(status,{'content-type':'application/json; charset=utf-8','access-control-allow-origin':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-allow-headers':'content-type,authorization','cache-control':'no-store'});res.end(JSON.stringify(obj));}
function readJson(req,max=131072){return new Promise((resolve,reject)=>{let n=0,parts=[];req.on('data',c=>{n+=c.length;if(n>max){reject(new Error('BODY_TOO_LARGE'));req.destroy();return}parts.push(c)});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')||'{}'))}catch(e){reject(new Error('INVALID_JSON'))}});req.on('error',reject)});}
async function sb(path,options={}){if(!SUPABASE_URL||!SUPABASE_SERVICE_ROLE_KEY)throw new Error('SUPABASE_SERVER_NOT_CONFIGURED');const r=await fetch(SUPABASE_URL+'/rest/v1/'+path,{...options,headers:{apikey:SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json',...(options.headers||{})}});const txt=await r.text();let data=null;try{data=txt?JSON.parse(txt):null}catch(e){data=txt}if(!r.ok){const rpcError=path==='rpc/pokaduel_consume_life_atomic'&&data&&typeof data.message==='string'&&['NO_LIFE','STATS_PROFILE_NOT_FOUND'].includes(data.message)?data.message:null;const x=new Error(rpcError||'SUPABASE_'+r.status);x.detail=data;throw x}return data;}
function validCode(v){v=String(v||'').trim().toUpperCase();if(!/^[A-Z0-9-]{16,80}$/.test(v))throw new Error('BAD_SYNC_CODE');return v;}
function hash(v){return crypto.createHash('sha256').update(String(v||'')).digest('hex');}
function today(){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Paris',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const m=Object.fromEntries(p.map(x=>[x.type,x.value]));return `${m.year}-${m.month}-${m.day}`;}
function clone(x){return JSON.parse(JSON.stringify(x==null?null:x));}
async function lock(k,fn){const prev=locks.get(k)||Promise.resolve();let release;const mine=new Promise(r=>release=r);locks.set(k,prev.then(()=>mine));await prev;try{return await fn()}finally{release();}}
function freshSharedStats(){
  return{
    ai:{
      played:0,
      wins:0,
      losses:0,
      currentStreak:0,
      bestStreak:0,
      bestWinScore:'—',
      bestMargin:0,

      scoreWins:{
        '5-0':0,
        '4-1':0,
        '3-2':0
      },

      extremeSweeps:0,
      winningStraightFlushCols:0,
      winningQuadCols:0,
      remontadaWins:0,

      byDiff:{
        easy:{p:0,w:0,l:0},
        normal:{p:0,w:0,l:0},
        hard:{p:0,w:0,l:0},
        extreme:{p:0,w:0,l:0}
      }
    },

local:{
  played:0,
  j1Wins:0,
  j2Wins:0
},

online:{
  played:0,
  wins:0,
  losses:0,
  forfeits:0
},

history:[],

    playerState:null
  };
}

function nn(
  v,
  max=1000000
){
  v=Number(v);

  if(
    !Number.isFinite(v)
  ){
    return 0;
  }

  return Math.max(
    0,
    Math.min(
      max,
      Math.floor(v)
    )
  );
}

function normalizeSharedStats(raw){
  const r=
    raw&&
    typeof raw==='object'?
      raw:
      {};

  const a=
    r.ai&&
    typeof r.ai==='object'?
      r.ai:
      {};

  const out=
    freshSharedStats();

  for(const k of [
    'played',
    'wins',
    'losses',
    'currentStreak',
    'bestStreak',
    'bestMargin',
    'extremeSweeps',
    'winningStraightFlushCols',
    'winningQuadCols',
    'remontadaWins'
  ]){
    out.ai[k]=
      nn(a[k]);
  }

  out.ai.bestWinScore=
    String(
      a.bestWinScore||
      '—'
    ).slice(0,16);

  for(const k of [
    '5-0',
    '4-1',
    '3-2'
  ]){
    out.ai.scoreWins[k]=
      nn(
        a.scoreWins&&
        a.scoreWins[k]
      );
  }

  for(const d of [
    'easy',
    'normal',
    'hard',
    'extreme'
  ]){
    const x=
      a.byDiff&&
      a.byDiff[d]||
      {};

    out.ai.byDiff[d]={
      p:nn(x.p),
      w:nn(x.w),
      l:nn(x.l)
    };
  }

  const l=
    r.local&&
    typeof r.local==='object'?
      r.local:
      {};

  out.local={
    played:
      nn(l.played),

    j1Wins:
      nn(l.j1Wins),

    j2Wins:
      nn(l.j2Wins)
  };

const on=
  r.online&&
  typeof r.online==='object'?
    r.online:
    {};

out.online={
  played:
    nn(on.played),

  wins:
    nn(on.wins),

  losses:
    nn(on.losses),

  forfeits:
    nn(on.forfeits)
};


  out.history=
    Array.isArray(r.history)?
      r.history
        .slice(0,20)
        .map(x=>({
          ts:
            Number(
              x&&x.ts
            )||
            Date.now(),

          mode:
  x&&x.mode==='local'?
    'local':
  x&&x.mode==='online'?
    'online':
    'ai',

          diff:
            [
              'easy',
              'normal',
              'hard',
              'extreme'
            ].includes(
              x&&x.diff
            )?
              x.diff:
              undefined,

          result:
            String(
              x&&x.result||
              ''
            ).slice(0,24),

          score:
            String(
              x&&x.score||
              ''
            ).slice(0,16),

          best:
            String(
              x&&x.best||
              ''
            ).slice(0,160)
        })):
      [];
  if(
    r.playerState &&
    typeof r.playerState==='object'
  ){
    try{
      const playerStateText=
        JSON.stringify(
          r.playerState
        );

      if(
        playerStateText.length<=50000
      ){
        out.playerState=
          JSON.parse(
            playerStateText
          );
      }
    }catch(e){}
  }
  return out;
}

function statsWouldRegress(current, next) {
  for (const k of ['played','wins','losses','bestStreak','bestMargin','extremeSweeps','winningStraightFlushCols','winningQuadCols','remontadaWins']) {
    if (next.ai[k] < current.ai[k]) return true;
  }
  for (const d of ['easy','normal','hard','extreme']) {
    for (const k of ['p','w','l']) if (next.ai.byDiff[d][k] < current.ai.byDiff[d][k]) return true;
  }
  for (const k of ['5-0','4-1','3-2']) if (next.ai.scoreWins[k] < current.ai.scoreWins[k]) return true;
  for (const k of ['played','j1Wins','j2Wins']) if (next.local[k] < current.local[k]) return true;
  return false;
}

// Preserve only known cumulative fields; never maximize lives or current streaks.
function preserveProfileProgress(previous, incoming) {
  const obj=v=>v && typeof v==='object' && !Array.isArray(v)?v:{};
  const a=obj(previous), b=obj(incoming);
  const out={...a,...b};
  const max=(x,y)=>Math.max(nn(x),nn(y));
  const union=(x,y)=>[...new Set([...(Array.isArray(x)?x:[]),...(Array.isArray(y)?y:[])].filter(v=>typeof v==='string'))];
  if(a.progression || b.progression){
    const x=obj(a.progression),y=obj(b.progression);
    out.progression={...x,...y,xp:max(x.xp,y.xp),perfectWeeks:{...obj(x.perfectWeeks),...obj(y.perfectWeeks)}};
    for(const k of Object.keys(obj(x.perfectWeeks))) if(x.perfectWeeks[k]===true)out.progression.perfectWeeks[k]=true;
  }
  if(a.dailyHistory || b.dailyHistory){
    const x=obj(a.dailyHistory),y=obj(b.dailyHistory);
    out.dailyHistory={...x,...y,totalStars:max(x.totalStars,y.totalStars)};
    for(const k of ['validatedDays','weeklyRewards','weeklyBonusRewards'])out.dailyHistory[k]=union(x[k],y[k]);
  }
  if(a.regularityDays || b.regularityDays)out.regularityDays=union(a.regularityDays,b.regularityDays);
  if(a.prestigeSync || b.prestigeSync){
    const x=obj(a.prestigeSync),y=obj(b.prestigeSync),p=obj(x.prestige),q=obj(y.prestige);
    const prestige={...p,...q};
    for(const k of ['extremeBest','hardPlusBest','humanDistinctBest','rematchWins','winningHands','royals','comebacks','multiplayerWins','dailyPlayed','dailyWins','dailyBest','perfectNonEasy','totalWins','totalGames','chameleon','overallBest','dominationBest'])prestige[k]=max(p[k],q[k]);
    for(const k of ['uniqueBeaten','uniqueHumanWins','modesWon','difficultiesWon'])prestige[k]=union(p[k],q[k]);
    out.prestigeSync={...x,...y,prestige,days:union(x.days,y.days)};
  }

  if(a.dailyHistoryV3326 || b.dailyHistoryV3326){
    const x=obj(a.dailyHistoryV3326),y=obj(b.dailyHistoryV3326);
    const h={...x,...y};
    for(const k of ['validatedDays','weeklyRewards','weeklyBonusRewards'])h[k]=union(x[k],y[k]).sort();
    h.totalStars=Math.max(max(x.totalStars,y.totalStars),h.validatedDays.length+3*h.weeklyBonusRewards.length);
    h.recoveryV1805=!!(x.recoveryV1805||y.recoveryV1805);
    out.dailyHistoryV3326=h;
  }
  if(a.weeklyEventsV2726 || b.weeklyEventsV2726){
    const x=obj(a.weeklyEventsV2726),y=obj(b.weeklyEventsV2726),monday=max(x.monday,y.monday),events=new Map();
    for(const e of [...(Array.isArray(x.events)?x.events:[]),...(Array.isArray(y.events)?y.events:[])]){
      if(!e||typeof e!=='object'||(monday&&Number(e.ts)<monday))continue;
      const id=String(e.id||[e.ts||0,e.diff||'',e.score||'',e.won?'1':'0'].join('|'));
      if(!events.has(id))events.set(id,e);
    }
    out.weeklyEventsV2726={...x,...y,monday,events:[...events.values()].sort((p,q)=>Number(p.ts)-Number(q.ts)).slice(-300)};
  }
  if(a.dailyChallengesV3326 || b.dailyChallengesV3326){
    const x=obj(a.dailyChallengesV3326),y=obj(b.dailyChallengesV3326);
    const date=[String(x.date||''),String(y.date||'')].sort().pop();
    const p=x.date===date?x:{},q=y.date===date?y:{};
    const tasks=new Map();
    for(const t of [...(Array.isArray(p.tasks)?p.tasks:[]),...(Array.isArray(q.tasks)?q.tasks:[])]){
      if(!t||typeof t!=='object'||t.id==null)continue;
      const old=tasks.get(t.id)||{},goal=Math.max(1,Number(old.goal||t.goal)||1),progress=Math.min(goal,max(old.progress,t.progress));
      tasks.set(t.id,{...t,...old,goal,progress,done:!!(old.done||t.done||progress>=goal)});
    }
    const list=[...tasks.values()];
    out.dailyChallengesV3326={...p,...q,date,tasks:list,validated:!!(p.validated||q.validated||list.filter(t=>t.done).length>=2),rewarded:!!(p.rewarded||q.rewarded),gamesToday:max(p.gamesToday,q.gamesToday),dailyWinsInRow:max(p.dailyWinsInRow,q.dailyWinsInRow),lastGameWon:!!(p.lastGameWon||q.lastGameWon)};
  }
  return Object.keys(out).length?out:null;
}


async function load(h){const rows=await sb('player_stats_profiles?profile_hash=eq.'+encodeURIComponent(h)+'&select=baseline_json,updated_at',{method:'GET'});if(!rows||!rows.length)throw new Error('STATS_PROFILE_NOT_FOUND');const b=rows[0].baseline_json&&typeof rows[0].baseline_json==='object'?clone(rows[0].baseline_json):{};Object.defineProperty(b,'__pdStamp',{value:rows[0].updated_at,enumerable:false});return b;}
async function save(h,b,stamp=b.__pdStamp){if(!stamp)throw new Error('STATS_CONFLICT');const rows=await sb('player_stats_profiles?profile_hash=eq.'+encodeURIComponent(h)+'&updated_at=eq.'+encodeURIComponent(stamp),{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({baseline_json:b,updated_at:new Date(Math.max(Date.now(),(Date.parse(stamp)||0)+1)).toISOString()})});if(!Array.isArray(rows)||rows.length!==1)throw new Error('STATS_CONFLICT');}
function fresh(lang='fr'){return{schema:'POKADUEL_ECONOMY_V1',lives:MAX,regenAnchor:Date.now(),language:/^(fr|en|de|es|it|pt)$/.test(lang)?lang:'fr',dailyDate:today(),dailyFreeUsed:false,recentRewardNonces:[],updatedAt:Date.now()};}
function normalize(x){const now=Date.now();x=x&&typeof x==='object'?clone(x):fresh();x.schema='POKADUEL_ECONOMY_V1';x.lives=Math.max(0,Math.min(MAX,Math.floor(Number(x.lives)||0)));x.regenAnchor=Number(x.regenAnchor)||now;x.language=/^(fr|en|de|es|it|pt)$/.test(String(x.language||''))?String(x.language):'fr';x.dailyDate=/^\d{4}-\d{2}-\d{2}$/.test(String(x.dailyDate||''))?String(x.dailyDate):today();x.dailyFreeUsed=!!x.dailyFreeUsed;x.recentRewardNonces=Array.isArray(x.recentRewardNonces)?x.recentRewardNonces.map(String).slice(-20):[];if(x.dailyDate!==today()){x.dailyDate=today();x.dailyFreeUsed=false;x.updatedAt=now}if(x.lives>=MAX){x.lives=MAX;x.regenAnchor=now}else{const add=Math.floor(Math.max(0,now-x.regenAnchor)/REGEN);if(add>0){x.lives=Math.min(MAX,x.lives+add);x.regenAnchor+=add*REGEN;if(x.lives>=MAX)x.regenAnchor=now;x.updatedAt=now}}x.updatedAt=Number(x.updatedAt)||now;return x;}
function economyOf(b){const ps=b.playerState&&typeof b.playerState==='object'?b.playerState:(b.playerState={});if(!ps.serverEconomy){let lang='fr';try{lang=String(ps.accountSync&&ps.accountSync.language&&ps.accountSync.language.value||'fr')}catch(e){}ps.serverEconomy=fresh(lang)}ps.serverEconomy=normalize(ps.serverEconomy);return ps.serverEconomy;}
function publicState(e){e=normalize(e);return{schema:e.schema,lives:e.lives,maxLives:MAX,regenMinutes:30,nextLifeSeconds:e.lives>=MAX?0:Math.max(0,Math.ceil((REGEN-(Date.now()-e.regenAnchor))/1000)),regenAnchor:e.regenAnchor,language:e.language,dailyDate:e.dailyDate,dailyFreeUsed:e.dailyFreeUsed,updatedAt:e.updatedAt,serverNow:Date.now()};}
function status(m){if(m==='ACCOUNT_AUTH_REQUIRED')return 401;if(m==='ACCOUNT_NOT_LINKED'||m==='ACCOUNT_TEST_ONLY')return 403;if(['ACCOUNT_DEVICE_ACTIVE','ACCOUNT_LEASE_EXPIRED','ACCOUNT_STALE_SNAPSHOT'].includes(m))return 409;if(m==='STATS_PROFILE_NOT_FOUND')return 404;if(['NO_LIFE','STATS_CONFLICT','STATS_REGRESSION','PROFILE_STATE_TOO_LARGE'].includes(m))return 409;if(['BAD_AD_RECEIPT','AD_TOO_SHORT','AD_RECEIPT_REPLAY'].includes(m))return 403;if(String(m).startsWith('BAD_'))return 400;return 500;}
async function mutate(req,body,fn){const h=requestProfileHash(req,body);return await lock(h,async()=>{guardAccountWriter(req,h);const b=await load(h),e=economyOf(b),result=await fn(e,b,h);e.updatedAt=Date.now();await save(h,b);return{economy:publicState(e),result};});}
function b64(x){return Buffer.from(x).toString('base64url');}
function sign(p){return crypto.createHmac('sha256',SECRET).update(p).digest('base64url');}
function makeReceipt(h){const p=b64(JSON.stringify({h,iat:Date.now(),exp:Date.now()+AD_TTL,n:crypto.randomBytes(16).toString('hex')}));return p+'.'+sign(p);}
function verifyReceipt(token,h){const [p,s]=String(token||'').split('.');if(!p||!s)throw new Error('BAD_AD_RECEIPT');const expected=sign(p),a=Buffer.from(s),b=Buffer.from(expected);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))throw new Error('BAD_AD_RECEIPT');let d;try{d=JSON.parse(Buffer.from(p,'base64url').toString('utf8'))}catch(e){throw new Error('BAD_AD_RECEIPT')}const now=Date.now();if(d.h!==h||now>Number(d.exp)||now<Number(d.iat))throw new Error('BAD_AD_RECEIPT');if(now-Number(d.iat)<AD_MIN)throw new Error('AD_TOO_SHORT');return d;}
async function handleEconomy(req,res){try{const body=await readJson(req);if(req.url==='/economy/state'){const h=requestProfileHash(req,body);const out=await lock(h,async()=>{if(req.pdAccount)guardAccountWriter(req,h);const b=await load(h);return{economy:publicState(economyOf(b)),result:{type:'state'}}});return json(res,200,{ok:true,...out})}if(req.url==='/economy/consume'){const kind=body.kind==='daily'?'daily':'standard';if(req.pdAccount&&kind!=='standard')return json(res,403,{ok:false,error:'ACCOUNT_ROUTE_DISABLED'});const h=requestProfileHash(req,body);const started=process.hrtime.bigint();let rpcMs=0;const out=await lock(h,async()=>{guardAccountWriter(req,h);const rpcStart=process.hrtime.bigint();const data=await sb('rpc/pokaduel_consume_life_atomic',{method:'POST',body:JSON.stringify({p_profile_hash:h,p_kind:kind})});rpcMs=Number(process.hrtime.bigint()-rpcStart)/1e6;const e=normalize(data.economy);return{economy:publicState(e),result:data.result}});const totalMs=Number(process.hrtime.bigint()-started)/1e6;console.info('[ECONOMY_CONSUME_TIMING]',JSON.stringify({rpcMs:Math.round(rpcMs),totalMs:Math.round(totalMs),kind,ok:true}));res.setHeader('Server-Timing','supabase;dur='+rpcMs.toFixed(1)+', economy;dur='+totalMs.toFixed(1));return json(res,200,{ok:true,...out})}if(req.url==='/economy/language'){const lang=String(body.language||'');if(!/^(fr|en|de|es|it|pt)$/.test(lang))throw new Error('BAD_LANGUAGE');const out=await mutate(req,body,async e=>{e.language=lang;return{language:lang}});return json(res,200,{ok:true,...out})}if(req.url==='/economy/ad-start'){const h=requestProfileHash(req,body);await load(h);return json(res,200,{ok:true,receipt:makeReceipt(h),minimumViewSeconds:Math.ceil(AD_MIN/1000)})}if(req.url==='/economy/reward'){const h=requestProfileHash(req,body),r=verifyReceipt(body.receipt,h);const out=await lock(h,async()=>{guardAccountWriter(req,h);const b=await load(h),e=economyOf(b);if(e.recentRewardNonces.includes(String(r.n)))throw new Error('AD_RECEIPT_REPLAY');e.recentRewardNonces.push(String(r.n));e.recentRewardNonces=e.recentRewardNonces.slice(-20);if(e.lives<MAX)e.lives++;if(e.lives>=MAX)e.regenAnchor=Date.now();e.updatedAt=Date.now();await save(h,b);return{economy:publicState(e),result:{rewarded:true,amount:1}}});return json(res,200,{ok:true,...out})}return json(res,404,{ok:false,error:'NOT_FOUND'})}catch(e){const m=String(e&&e.message||e);return json(res,status(m),{ok:false,error:m})}}
async function recordSoloResult(req,res){
try{
 const p=await readJson(req),h=requestProfileHash(req,p),id=String(p.eventId||''),result=p.result;
 if(!/^[a-f0-9-]{36}$/i.test(id)||!['win','loss','tie'].includes(result))return json(res,400,{ok:false,error:'BAD_RESULT_EVENT'});
 return await lock(h,async()=>{guardAccountWriter(req,h);
 for(let attempt=0;attempt<5;attempt++){
 const b=await load(h),ledger=b.soloResultLedgerV3365||{};
 if(Object.prototype.hasOwnProperty.call(ledger,id))return json(res,ledger[id]===result?200:409,{ok:ledger[id]===result,duplicate:true,stats:b});
 if(Object.keys(ledger).length>=10000)return json(res,409,{ok:false,error:'RESULT_LEDGER_FULL'});
 const a=b.ai||(b.ai={});a.played=nn(a.played)+1;
 if(result==='win'){a.wins=nn(a.wins)+1;a.currentStreak=nn(a.currentStreak)+1;a.bestStreak=Math.max(nn(a.bestStreak),a.currentStreak);}
 else if(result==='loss'){a.losses=nn(a.losses)+1;a.currentStreak=0;}
 else a.ties=nn(a.ties)+1;
 b.soloResultLedgerV3365={...ledger,[id]:result};
 try{await save(h,b);return json(res,200,{ok:true,duplicate:false,stats:b});}catch(e){if(e.message!=='STATS_CONFLICT')throw e;}
 }
 return json(res,409,{ok:false,error:'STATS_CONFLICT'});
 });
}catch(e){return json(res,status(e.message),{ok:false,error:e.message});}
}
async function authoritativeStatsSave(req,res){try{const p=await readJson(req),h=requestProfileHash(req,p);return await lock(h,async()=>{guardAccountWriter(req,h);const cur=await load(h);if(req.pdAccount&&p.expectedRevision!==accountRevision(cur))return json(res,409,{ok:false,error:'ACCOUNT_STALE_SNAPSHOT'});const incoming=p.stats&&typeof p.stats==='object'?clone(p.stats):{};if(statsWouldRegress(normalizeSharedStats(cur),normalizeSharedStats(incoming)))return json(res,409,{ok:false,error:'STATS_REGRESSION',stats:cur});if(cur.soloResultLedgerV3365){return json(res,409,{ok:false,error:'EVENT_PROTOCOL_REQUIRED',stats:cur});}if(cur.online)incoming.online=clone(cur.online);incoming.playerState=preserveProfileProgress(cur.playerState,incoming.playerState);const cps=cur.playerState&&typeof cur.playerState==='object'?cur.playerState:{},ips=incoming.playerState&&typeof incoming.playerState==='object'?incoming.playerState:(incoming.playerState={});ips.serverEconomy=cps.serverEconomy?normalize(cps.serverEconomy):fresh(String(ips.accountSync&&ips.accountSync.language&&ips.accountSync.language.value||'fr'));if(JSON.stringify(incoming.playerState).length>50000)throw new Error('PROFILE_STATE_TOO_LARGE');await save(h,incoming,cur.__pdStamp);return json(res,200,{ok:true,stats:incoming,...(req.pdAccount?{revision:accountRevision(incoming)}:{})})})}catch(e){const m=String(e&&e.message||e);return json(res,status(m),{ok:false,error:m})}}
async function authoritativeStatsInit(req,res){try{const p=await readJson(req),h=requestProfileHash(req,p);return await lock(h,async()=>{guardAccountWriter(req,h);const rows=await sb('player_stats_profiles?profile_hash=eq.'+encodeURIComponent(h)+'&select=profile_hash,baseline_json',{method:'GET'});if(!rows||!rows.length){const b=p.stats&&typeof p.stats==='object'?clone(p.stats):{},ps=b.playerState&&typeof b.playerState==='object'?b.playerState:(b.playerState={});delete ps.serverEconomy;economyOf(b);await sb('player_stats_profiles',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({profile_hash:h,baseline_json:b})})}const b=await load(h);return json(res,200,{ok:true,stats:b})})}catch(e){const m=String(e&&e.message||e);return json(res,status(m),{ok:false,error:m})}}

/* V34.08: authenticated solo gameplay, TEST only. */
const ACCOUNT_TEST_URL='https://gakktyuxsmliblhvikej.supabase.co';
const ACCOUNT_PUBLIC_KEY='sb_publishable_JpaCISipn-i1tR_ICuUsEg_vqCxm5V-';
const ACCOUNT_LEASE_MS=180000;
const accountLeases=new Map();
const accountPaths=new Set(['/stats/load','/stats/init','/stats/save','/economy/state','/economy/consume','/economy/language']);
function activeAccountLease(h){const l=accountLeases.get(h);if(l&&l.until>Date.now())return l;if(l)accountLeases.delete(h);return null;}
function guardAccountWriter(req,h){const l=activeAccountLease(h);if(req.pdAccount){if(!l||l.owner!==req.pdAccount.owner)throw Error('ACCOUNT_LEASE_EXPIRED');l.until=Date.now()+ACCOUNT_LEASE_MS;}else if(l)throw Error('ACCOUNT_DEVICE_ACTIVE');}
function requestProfileHash(req,p){return req.pdAccount?req.pdAccount.h:hash(validCode(p.syncCode));}
function accountRevision(b){const x=clone(b);if(x&&x.playerState)delete x.playerState.serverEconomy;function stable(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(stable).join(',')+']';return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';}return hash(stable(x));}
async function verifyAccount(req){
 if(SUPABASE_URL!==ACCOUNT_TEST_URL)throw Error('ACCOUNT_TEST_ONLY');
 const bearer=String(req.headers.authorization||'');
 if(!/^Bearer [A-Za-z0-9_.-]{40,8192}$/.test(bearer))throw Error('ACCOUNT_AUTH_REQUIRED');
 const rr=await fetch(ACCOUNT_TEST_URL+'/auth/v1/user',{headers:{apikey:ACCOUNT_PUBLIC_KEY,Authorization:bearer},signal:AbortSignal.timeout(10000)});
 if(rr.status===401||rr.status===403)throw Error('ACCOUNT_AUTH_REQUIRED');if(!rr.ok)throw Error('ACCOUNT_AUTH_UNAVAILABLE');
 const u=await rr.json();if(!u.id||!u.email_confirmed_at||u.is_anonymous||!/^[a-f0-9-]{36}$/i.test(u.id))throw Error('ACCOUNT_AUTH_REQUIRED');
 const link=await sb('pd_account_profile_links?user_id=eq.'+encodeURIComponent(u.id)+'&select=profile_hash');
 if(!Array.isArray(link)||link.length!==1||!/^[a-f0-9]{64}$/.test(link[0].profile_hash))throw Error('ACCOUNT_NOT_LINKED');
 return {h:link[0].profile_hash,owner:hash(bearer)};
}
async function handleAccount(req,res){
 const path=req.url.slice('/account'.length);
 if(!accountPaths.has(path)&&!['/session/open','/session/close'].includes(path))return json(res,404,{ok:false,error:'ACCOUNT_ROUTE_DISABLED'});
 try{
  req.pdAccount=await verifyAccount(req);const h=req.pdAccount.h;
  if(path==='/session/open')return await lock(h,async()=>{const l=activeAccountLease(h);if(l&&l.owner!==req.pdAccount.owner)throw Error('ACCOUNT_DEVICE_ACTIVE');const b=await load(h);accountLeases.set(h,{owner:req.pdAccount.owner,until:Date.now()+ACCOUNT_LEASE_MS});return json(res,200,{ok:true,stats:b,revision:accountRevision(b),leaseSeconds:ACCOUNT_LEASE_MS/1000});});
  if(path==='/session/close')return await lock(h,async()=>{const l=activeAccountLease(h);if(l&&l.owner===req.pdAccount.owner)accountLeases.delete(h);return json(res,200,{ok:true});});
  if(path==='/stats/load'||path==='/stats/init')return await lock(h,async()=>{guardAccountWriter(req,h);const b=await load(h);return json(res,200,{ok:true,stats:b,revision:accountRevision(b)});});
  req.url=path;
  if(path==='/stats/save')return authoritativeStatsSave(req,res);
  return handleEconomy(req,res);
 }catch(e){const m=String(e&&e.message||e);return json(res,status(m),{ok:false,error:m.startsWith('ACCOUNT_')?m:'ACCOUNT_SERVICE_UNAVAILABLE'});}
}

const original=http.createServer.bind(http);
http.createServer=function(listener){return original(async(req,res)=>{if(req.method==='OPTIONS'&&req.url.startsWith('/account/'))return json(res,204,{});if(req.method==='POST'&&req.url.startsWith('/account/'))return handleAccount(req,res);if(req.method==='GET'&&req.url==='/health')return json(res,200,{ok:true,app:'POKADUEL',version:'20.00',accountSoloTest:SUPABASE_URL===ACCOUNT_TEST_URL,economyServer:true,economyAuthority:'server',maxLives:MAX,regenMinutes:30,dailyFreeServer:true,languageServer:true,rewardedReceipt:true,adMinimumViewSeconds:Math.ceil(AD_MIN/1000)});if(req.method==='POST'&&req.url.startsWith('/economy/'))return handleEconomy(req,res);if(req.method==='POST'&&req.url==='/stats/solo-result')return recordSoloResult(req,res);if(req.method==='POST'&&req.url==='/stats/save')return authoritativeStatsSave(req,res);if(req.method==='POST'&&req.url==='/stats/init')return authoritativeStatsInit(req,res);return listener(req,res)});};
require('./server.js');
