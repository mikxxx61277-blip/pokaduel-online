'use strict';
const http=require('http'); const WebSocket=require('ws');
const PORT=Number(process.env.PORT||10000), HOST='0.0.0.0', PROTOCOL='pokaduel-v1';
const clients=new Map(), rooms=new Map(), queue=[];
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':req.url==='/health'?'application/json; charset=utf-8':'text/plain; charset=utf-8'});res.end(req.url==='/health'?JSON.stringify({ok:true,app:'POKADUEL',version:'19.05',rooms:rooms.size,clients:clients.size}):'POKADUEL V19.05 WebSocket server is online.');});
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
server.listen(PORT,HOST,()=>console.log(`POKADUEL V19.05 listening on http://${HOST}:${PORT}`));
