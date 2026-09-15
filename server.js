'use strict';

const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const PROTOCOL = 'pokaduel-v1';

const clients = new Map(); // ws -> {id, room, role}
const rooms = new Map();   // code -> Set<ws>
const queue = [];

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {'content-type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({
      ok: true,
      app: 'POKADUEL',
      version: '19.03',
      rooms: rooms.size,
      clients: clients.size
    }));
    return;
  }

  res.writeHead(200, {'content-type':'text/plain; charset=utf-8'});
  res.end('POKADUEL V19.03 WebSocket server is online.');
});

const wss = new WebSocket.Server({ server: httpServer });

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function normalize(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^POKA/, '')
    .slice(0, 6);
}
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  do {
    out = '';
    for (let i = 0; i < 6; i++) out += chars[(Math.random() * chars.length) | 0];
  } while (rooms.has(out));
  return out;
}
function leave(ws) {
  const c = clients.get(ws);
  if (!c) return;

  const qi = queue.indexOf(ws);
  if (qi >= 0) queue.splice(qi, 1);

  if (c.room && rooms.has(c.room)) {
    const set = rooms.get(c.room);
    set.delete(ws);

    for (const peer of set) {
      send(peer, {
        protocol: PROTOCOL,
        type: 'peer_left',
        room: c.room
      });
    }

    if (!set.size) rooms.delete(c.room);
  }

  c.room = null;
  c.role = null;
}
function announceIfFull(code) {
  const set = rooms.get(code);
  if (!set || set.size !== 2) return;

  const [aWs, bWs] = [...set];
  const a = clients.get(aWs);
  const b = clients.get(bWs);

  send(aWs, {
    protocol: PROTOCOL,
    type: 'peer_joined',
    room: code,
    peerId: b.id,
    peerName: 'JOUEUR 2'
  });
  send(bWs, {
    protocol: PROTOCOL,
    type: 'peer_joined',
    room: code,
    peerId: a.id,
    peerName: 'JOUEUR 1'
  });
}
function joinRoom(ws, code, role='guest') {
  code = normalize(code);

  if (!code || !rooms.has(code)) {
    send(ws, {protocol:PROTOCOL, type:'error', message:'Salon introuvable.'});
    return;
  }

  const set = rooms.get(code);
  if (set.size >= 2) {
    send(ws, {protocol:PROTOCOL, type:'error', message:'Salon complet.'});
    return;
  }

  leave(ws);
  set.add(ws);

  const c = clients.get(ws);
  c.room = code;
  c.role = role;

  send(ws, {
    protocol: PROTOCOL,
    type: 'joined',
    room: code,
    role
  });

  announceIfFull(code);
}

wss.on('connection', (ws) => {
  clients.set(ws, {id:null, room:null, role:null});

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!m || m.protocol !== PROTOCOL) return;

    const c = clients.get(ws);
    if (m.clientId) c.id = String(m.clientId).slice(0, 64);

    if (m.type === 'create_room') {
      leave(ws);

      const code = roomCode();
      rooms.set(code, new Set([ws]));
      c.room = code;
      c.role = 'host';

      send(ws, {
        protocol: PROTOCOL,
        type: 'created',
        room: code,
        role: 'host'
      });
      return;
    }

    if (m.type === 'join_room') {
      joinRoom(ws, m.room, 'guest');
      return;
    }

    if (m.type === 'matchmake') {
      leave(ws);

      while (queue.length && queue[0].readyState !== WebSocket.OPEN) {
        queue.shift();
      }

      if (queue.length) {
        const other = queue.shift();
        const code = roomCode();
        rooms.set(code, new Set([other]));

        const oc = clients.get(other);
        oc.room = code;
        oc.role = 'host';

        send(other, {
          protocol: PROTOCOL,
          type: 'joined',
          room: code,
          role: 'host'
        });

        joinRoom(ws, code, 'guest');
      } else {
        queue.push(ws);
        send(ws, {
          protocol: PROTOCOL,
          type: 'joined',
          room: null,
          role: 'queue'
        });
      }
    }
  });

  ws.on('close', () => {
    leave(ws);
    clients.delete(ws);
  });

  ws.on('error', () => {});
});

httpServer.listen(PORT, HOST, () => {
  console.log(`POKADUEL V19.03 listening on http://${HOST}:${PORT}`);
});
