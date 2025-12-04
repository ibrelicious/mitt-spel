// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Statisk frontend + JSON-body
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// ---------- KONSTANTER ----------
const ROOM_WIDTH = 800;
const ROOM_HEIGHT = 600;
const DEFAULT_RADIUS = 20;

const TILE_SIZE = 40;
const ROOM_COLS = ROOM_WIDTH / TILE_SIZE; // 20
const ROOM_ROWS = ROOM_HEIGHT / TILE_SIZE; // 15

const USERS_FILE = path.join(__dirname, 'users.json');
const ROOMS_FILE = path.join(__dirname, 'rooms.json');

const APPEARANCE_DEFAULT = {
  skin: '#f1c27d',
  shirt: '#3498db',
  pants: '#2c3e50'
};

const DEFAULT_COINS = 100;

// ---------- HJÄLPFUNKTIONER FÖR MAP ----------
function createBaseMap() {
  const map = [];
  for (let row = 0; row < ROOM_ROWS; row++) {
    const rowArr = [];
    for (let col = 0; col < ROOM_COLS; col++) {
      // Ytterkanter = väggar (1), insida = golv (0)
      if (row === 0 || row === ROOM_ROWS - 1 || col === 0 || col === ROOM_COLS - 1) {
        rowArr.push(1);
      } else {
        rowArr.push(0);
      }
    }
    map.push(rowArr);
  }
  return map;
}

function canWalk(map, x, y) {
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  if (row < 0 || row >= ROOM_ROWS || col < 0 || col >= ROOM_COLS) return false;
  return map[row][col] === 0;
}

function getRandomSpawn(map) {
  while (true) {
    const row = Math.floor(Math.random() * ROOM_ROWS);
    const col = Math.floor(Math.random() * ROOM_COLS);
    if (map[row][col] === 0) {
      return {
        x: col * TILE_SIZE + TILE_SIZE / 2,
        y: row * TILE_SIZE + TILE_SIZE / 2
      };
    }
  }
}

function randomColor() {
  return '#' + ('000000' + Math.floor(Math.random() * 16777215).toString(16)).slice(-6);
}

// ---------- DATA ----------
const players = {};
const onlineUsers = {}; // username -> socketId

let users = {};
let rooms = {};
let nextRoomId = 1;

// ---------- USERS (konto) ----------
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    users = JSON.parse(raw);
    if (typeof users !== 'object' || users === null) {
      users = {};
    }
  } catch (err) {
    users = {};
  }

  let changed = false;
  for (const [username, user] of Object.entries(users)) {
    if (!user.appearance) {
      user.appearance = { ...APPEARANCE_DEFAULT };
      changed = true;
    }
    if (typeof user.coins !== 'number') {
      user.coins = DEFAULT_COINS;
      changed = true;
    }
  }
  if (changed) saveUsers();
}

function saveUsers() {
  fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), (err) => {
    if (err) console.error('Kunde inte spara users.json:', err);
  });
}

// ---------- ROOMS (sparade rum) ----------
function saveRooms() {
  fs.writeFile(ROOMS_FILE, JSON.stringify(rooms, null, 2), (err) => {
    if (err) console.error('Kunde inte spara rooms.json:', err);
  });
}

function loadRooms() {
  try {
    const raw = fs.readFileSync(ROOMS_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      rooms = data;
    } else {
      rooms = {};
    }
  } catch (err) {
    rooms = {};
  }

  if (!rooms || Object.keys(rooms).length === 0 || !rooms['lobby']) {
    rooms = {};
    const lobby = {
      id: 'lobby',
      name: 'Lobby',
      owner: null,
      map: createBaseMap()
    };
    rooms[lobby.id] = lobby;
    saveRooms();
  } else {
    // Se till att alla rum har map
    for (const id of Object.keys(rooms)) {
      if (!rooms[id].map) {
        rooms[id].map = createBaseMap();
      }
    }
  }

  // Sätt nextRoomId baserat på befintliga room_X
  let max = 0;
  for (const id of Object.keys(rooms)) {
    const m = /^room_(\d+)$/.exec(id);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  nextRoomId = max + 1;
}

function getRoomList() {
  return Object.values(rooms).map((r) => ({
    id: r.id,
    name: r.name
  }));
}

function createRoom(name, owner) {
  const id = 'room_' + nextRoomId++;
  rooms[id] = {
    id,
    name,
    owner: owner || null,
    map: createBaseMap()
  };
  saveRooms();
  return rooms[id];
}

// ---------- INIT ----------
loadUsers();
loadRooms();

// ---------- EXPRESS ROUTER ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Skapa konto
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ ok: false, message: 'Användarnamn och lösenord krävs.' });
  }

  const trimmedUser = String(username).trim();

  if (trimmedUser.length < 2) {
    return res.status(400).json({ ok: false, message: 'Användarnamnet måste vara minst 2 tecken.' });
  }
  if (password.length < 4) {
    return res.status(400).json({ ok: false, message: 'Lösenordet måste vara minst 4 tecken.' });
  }

  if (users[trimmedUser]) {
    return res.status(409).json({ ok: false, message: 'Användarnamnet är redan taget.' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    users[trimmedUser] = {
      passwordHash: hash,
      appearance: { ...APPEARANCE_DEFAULT },
      coins: DEFAULT_COINS
    };
    saveUsers();
    return res.json({ ok: true, message: 'Konto skapat.' });
  } catch (err) {
    console.error('Fel vid register:', err);
    return res.status(500).json({ ok: false, message: 'Internt fel. Försök igen.' });
  }
});

// Logga in
app.post('/api/login', async (req, res) => {
  const { username, password, socketId } = req.body || {};
  const trimmedUser = String(username || '').trim();

  if (!socketId) {
    return res.status(400).json({ ok: false, message: 'Ingen socket-id. Ladda om sidan och försök igen.' });
  }

  const user = users[trimmedUser];
  if (!user) {
    return res.status(401).json({ ok: false, message: 'Fel användarnamn eller lösenord.' });
  }

  try {
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return res.status(401).json({ ok: false, message: 'Fel användarnamn eller lösenord.' });
    }

    // Kicka gammal session
    const existingSocketId = onlineUsers[trimmedUser];
    if (existingSocketId && existingSocketId !== socketId) {
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) {
        oldSocket.emit('forceLogout', 'Du loggades ut eftersom du loggade in på ett annat ställe.');
        oldSocket.disconnect(true);
      }
    }

    onlineUsers[trimmedUser] = socketId;

    const appearance = user.appearance || { ...APPEARANCE_DEFAULT };
    const coins = typeof user.coins === 'number' ? user.coins : DEFAULT_COINS;

    return res.json({
      ok: true,
      username: trimmedUser,
      appearance,
      coins
    });
  } catch (err) {
    console.error('Fel vid login:', err);
    return res.status(500).json({ ok: false, message: 'Internt fel. Försök igen.' });
  }
});

// Uppdatera utseende (settings)
app.post('/api/updateAppearance', (req, res) => {
  const { username, socketId, appearance } = req.body || {};
  const trimmedUser = String(username || '').trim();

  if (!trimmedUser || !users[trimmedUser]) {
    return res.status(400).json({ ok: false, message: 'Okänt konto.' });
  }
  if (!appearance || typeof appearance !== 'object') {
    return res.status(400).json({ ok: false, message: 'Ogiltigt utseende.' });
  }
  if (onlineUsers[trimmedUser] !== socketId) {
    return res.status(403).json({ ok: false, message: 'Inte inloggad som denna användare.' });
  }

  const user = users[trimmedUser];
  user.appearance = {
    skin: appearance.skin || APPEARANCE_DEFAULT.skin,
    shirt: appearance.shirt || APPEARANCE_DEFAULT.shirt,
    pants: appearance.pants || APPEARANCE_DEFAULT.pants
  };
  saveUsers();

  const player = players[socketId];
  if (player) {
    player.appearance = user.appearance;
    player.color = user.appearance.shirt;
    if (player.roomId) {
      io.to(player.roomId).emit('appearanceUpdated', {
        socketId,
        appearance: player.appearance
      });
    }
  }

  return res.json({ ok: true, appearance: user.appearance });
});

// ---------- RUMSHANTERING ----------
function joinPlayerToRoom(socket, roomId) {
  const player = players[socket.id];
  const room = rooms[roomId];
  if (!player || !room) return;

  const oldRoomId = player.roomId;

  if (oldRoomId) {
    socket.leave(oldRoomId);
  }

  socket.join(roomId);
  player.roomId = roomId;

  const spawn = getRandomSpawn(room.map);
  player.x = spawn.x;
  player.y = spawn.y;

  const roomPlayers = {};
  for (const [sid, p] of Object.entries(players)) {
    if (p.roomId === roomId) {
      roomPlayers[sid] = p;
    }
  }

  socket.emit('currentPlayers', roomPlayers);
  socket.emit('roomJoined', { roomId, roomName: room.name });

  socket.to(roomId).emit('newPlayer', player);

  if (oldRoomId && oldRoomId !== roomId) {
    io.to(oldRoomId).emit('playerDisconnected', socket.id);
  }
}

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
  console.log('En spelare anslöt! ID:', socket.id);

  players[socket.id] = {
    x: 0,
    y: 0,
    color: randomColor(),
    radius: DEFAULT_RADIUS,
    name: 'Ny Spelare',
    socketId: socket.id,
    roomId: null,
    appearance: { ...APPEARANCE_DEFAULT }
  };

  socket.emit('roomList', getRoomList());
  joinPlayerToRoom(socket, 'lobby');

  socket.on('createRoom', (roomNameRaw) => {
    const player = players[socket.id];
    if (!player) return;
    const roomName = String(roomNameRaw || '').trim() || `${player.name || 'Rum'}`;
    const room = createRoom(roomName, player.name || null);

    io.emit('roomList', getRoomList());
    joinPlayerToRoom(socket, room.id);
  });

  socket.on('joinRoom', (roomId) => {
    if (!rooms[roomId]) return;
    joinPlayerToRoom(socket, roomId);
  });

  socket.on('playerReady', (data) => {
    const player = players[socket.id];
    if (!player) return;

    if (data && data.name) {
      player.name = String(data.name);
    }
    if (data && data.appearance) {
      player.appearance = {
        skin: data.appearance.skin || APPEARANCE_DEFAULT.skin,
        shirt: data.appearance.shirt || APPEARANCE_DEFAULT.shirt,
        pants: data.appearance.pants || APPEARANCE_DEFAULT.pants
      };
      player.color = player.appearance.shirt;
    }

    if (player.roomId) {
      io.to(player.roomId).emit('playerReady', player);
    }
  });

  socket.on('playerMovement', (movementData) => {
    const player = players[socket.id];
    if (!player || !player.roomId) return;
    const room = rooms[player.roomId];
    if (!room) return;

    let newX = movementData.x;
    let newY = movementData.y;

    if (!canWalk(room.map, newX, newY)) return;

    player.x = newX;
    player.y = newY;

    io.to(player.roomId).emit('playerMoved', player);
  });

  socket.on('chatMessage', (message) => {
    const player = players[socket.id];
    if (!player || !player.roomId) return;
    const playerName = player ? player.name : 'Okänd';

    io.to(player.roomId).emit('message', {
      senderId: socket.id,
      senderName: playerName,
      message
    });
  });

  socket.on('disconnect', () => {
    console.log('En spelare lämnade. ID:', socket.id);

    const player = players[socket.id];
    if (player && player.roomId) {
      io.to(player.roomId).emit('playerDisconnected', socket.id);
    }

    for (const [username, sid] of Object.entries(onlineUsers)) {
      if (sid === socket.id) {
        delete onlineUsers[username];
        break;
      }
    }

    delete players[socket.id];
  });
});

// ---------- START ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servern är igång på port ${PORT}`);
});
