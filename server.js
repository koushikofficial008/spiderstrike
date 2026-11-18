const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const MAX_PLAYERS = 10;
const TICK_MS = 50;
const MAP_RADIUS = 48.5;
const players = new Map();
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, players: players.size }));
  }
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, path: '/multiplayer', maxPayload: 4096 });
const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
function publicPlayer(p) {
  return { id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, hp: p.hp, alive: p.alive, moving: p.moving, sprinting: p.sprinting, firing: p.firing, updatedAt: p.updatedAt };
}
function broadcast(data, except) {
  const payload = JSON.stringify(data);
  for (const p of players.values()) if (p.ws !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(payload);
}
function finite(n, fallback = 0) { return Number.isFinite(n) ? n : fallback; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function hitDistance(origin, dir, center, radius) {
  const ox = origin.x-center.x, oy = origin.y-center.y, oz = origin.z-center.z;
  const b = ox*dir.x + oy*dir.y + oz*dir.z;
  const c = ox*ox + oy*oy + oz*oz - radius*radius;
  const d = b*b-c;
  if (d < 0) return -1;
  const t = -b-Math.sqrt(d);
  return t > 0 ? t : -1;
}
wss.on('connection', (ws) => {
  if (players.size >= MAX_PLAYERS) { send(ws, { type: 'full', maxPlayers: MAX_PLAYERS }); ws.close(1013, 'Match full'); return; }
  const id = crypto.randomUUID();
  const p = { id, ws, x: 0, y: 0, z: 24, yaw: 0, pitch: 0, hp: 100, alive: true, moving: false, sprinting: false, firing: false, lastShot: 0, updatedAt: Date.now() };
  players.set(id, p);
  send(ws, { type: 'welcome', id, players: [...players.values()].filter(x => x !== p).map(publicPlayer), maxPlayers: MAX_PLAYERS });
  broadcast({ type: 'joined', player: publicPlayer(p) }, ws);
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'state') {
      const x = finite(m.x, p.x), z = finite(m.z, p.z), radius = Math.hypot(x,z);
      const scale = radius > MAP_RADIUS ? MAP_RADIUS/radius : 1;
      p.x = x*scale; p.z = z*scale; p.y = clamp(finite(m.y,p.y), -2, 30);
      p.yaw = finite(m.yaw,p.yaw); p.pitch = clamp(finite(m.pitch,p.pitch), -1.55, 1.55);
      p.moving = !!m.moving; p.sprinting = !!m.sprinting; p.firing = !!m.firing; p.updatedAt = Date.now();
    } else if (m.type === 'shoot' && p.alive) {
      const now = Date.now(); if (now-p.lastShot < 75) return; p.lastShot = now;
      const o = m.origin || {}, d = m.direction || {};
      const origin = { x: finite(o.x,p.x), y: finite(o.y,p.y+0.8), z: finite(o.z,p.z) };
      const dir = { x: finite(d.x), y: finite(d.y), z: finite(d.z) };
      const len = Math.hypot(dir.x,dir.y,dir.z); if (len < 0.9 || len > 1.1) return;
      if (Math.hypot(origin.x-p.x, origin.z-p.z) > 10) return;
      dir.x/=len; dir.y/=len; dir.z/=len;
      let target = null, best = 180, headshot = false;
      for (const other of players.values()) {
        if (other === p || !other.alive) continue;
        const body = hitDistance(origin,dir,{x:other.x,y:other.y+0.48,z:other.z},0.66);
        const head = hitDistance(origin,dir,{x:other.x,y:other.y+0.88,z:other.z},0.28);
        if (head > 0 && head < best) { best=head; target=other; headshot=true; }
        if (body > 0 && body < best) { best=body; target=other; headshot=false; }
      }
      if (target) {
        const damage = headshot ? 68 : 34;
        target.hp = Math.max(0,target.hp-damage);
        if (target.hp === 0) target.alive = false;
        broadcast({ type:'playerHit', targetId:target.id, by:p.id, damage, hp:target.hp, alive:target.alive, headshot });
      }
    } else if (m.type === 'respawn') {
      p.hp = 100; p.alive = true; p.x = clamp(finite(m.x,0),-MAP_RADIUS,MAP_RADIUS); p.y = finite(m.y,0); p.z = clamp(finite(m.z,24),-MAP_RADIUS,MAP_RADIUS); p.updatedAt = Date.now();
      broadcast({ type:'respawned', player:publicPlayer(p) });
    }
  });
  ws.on('close', () => { players.delete(id); broadcast({ type: 'left', id }); });
  ws.on('error', () => { players.delete(id); broadcast({ type: 'left', id }); });
});
const ticker = setInterval(() => {
  const now = Date.now();
  for (const [id,p] of players) if (now-p.updatedAt > 15000 || p.ws.readyState !== WebSocket.OPEN) { players.delete(id); broadcast({ type:'left', id }); }
  broadcast({ type:'snapshot', players:[...players.values()].map(publicPlayer), serverTime:now });
}, TICK_MS);
server.listen(PORT, '0.0.0.0', () => console.log('Spider Strike multiplayer server listening on '+PORT));
function shutdown() { clearInterval(ticker); for (const p of players.values()) p.ws.close(1001,'Server restarting'); server.close(() => process.exit(0)); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
