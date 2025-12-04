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

// ---------- KONSTANTER / MAP ----------
const ROOM_WIDTH = 800;
const ROOM_HEIGHT = 600;
const DEFAULT_RADIUS = 20;

const TILE_SIZE = 40;
const ROOM_COLS = ROOM_WIDTH / TILE_SIZE; // 20
const ROOM_ROWS = ROOM_HEIGHT / TILE_SIZE; // 15

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

// Alla spelare i minnet
const players = {};

// Vilken användare är inloggad på vilken socket
// onlineUsers[username] = socketId
const onlineUsers = {};

// Rum
const rooms = {};
let nextRoomId = 1;

function getRoomList() {
  return Object.values(rooms).map(r => ({ id: r.id, name: r.name }));
}

function createRoom(name, owner) {
  const id = 'room_' + nextRoomId++;
  rooms[id] = {
    id,
    name,
    owner: owner || null,
    map: createBaseMap()
  };
  return rooms[id];
}

// Skapa default-lobby
rooms['lobby'] = {
  id: 'lobby',
  name: 'Lobby',
  owner: null,
  map: createBaseMap()
};

// Enkel “databas” av användare
// Format: { "username": { passwordHash: "..." } }
const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};

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
}

function saveUsers() {
  fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), (err) => {
    if (err) console.error('Kunde inte spara users.json:', err);
  });
}

loadUsers();

// ---------- EXPRESS SETUP ----------
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Root
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
      passwordHash: hash
    };
    saveUsers();
    return res.json({ ok: true, message: 'Konto skapat.' });
  } catch (err) {
    console.error('Fel vid register:', err);
    return res.status(500).json({ ok: false, message: 'Internt fel. Försök igen.' });
  }
});

// Logga in (single login per konto)
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

    // Kicka gammal session om den finns
    const existingSocketId = onlineUsers[trimmedUser];
    if (existingSocketId && existingSocketId !== socketId) {
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) {
        oldSocket.emit('forceLogout', 'Du loggades ut eftersom du loggade in på ett annat ställe.');
        oldSocket.disconnect(true);
      }
    }

    onlineUsers[trimmedUser] = socketId;

    return res.json({ ok: true, username: trimmedUser });
  } catch (err) {
    console.error('Fel vid login:', err);
    return res.status(500).json({ ok: false, message: 'Internt fel. Försök igen.' });
  }
});

// ---------- HJÄLPFUNKTION FÖR RUM ----------
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

  // Bygg lista över spelare i detta rum
  const roomPlayers = {};
  for (const [sid, p] of Object.entries(players)) {
    if (p.roomId === roomId) {
      roomPlayers[sid] = p;
    }
  }

  // Skicka till denna spelare
  socket.emit('currentPlayers', roomPlayers);
  socket.emit('roomJoined', { roomId, roomName: room.name });

  // Tala om för andra i rummet
  socket.to(roomId).emit('newPlayer', player);

  // Tala om för gamla rummet att spelaren försvann
  if (oldRoomId && oldRoomId !== roomId) {
    io.to(oldRoomId).emit('playerDisconnected', socket.id);
  }
}

// ---------- SOCKET.IO ----------
io.on('connection', (socket) => {
  console.log('En spelare anslöt! ID:', socket.id);

  // Skapa spelare
  players[socket.id] = {
    x: 0,
    y: 0,
    color: randomColor(),
    radius: DEFAULT_RADIUS,
    name: 'Ny Spelare',
    socketId: socket.id,
    roomId: null
  };

  // Skicka rumslista + lägg spelaren i lobbyn
  socket.emit('roomList', getRoomList());
  joinPlayerToRoom(socket, 'lobby');

  // Skapa nytt rum
  socket.on('createRoom', (roomNameRaw) => {
    const player = players[socket.id];
    if (!player) return;
    const roomName = String(roomNameRaw || '').trim() || `${player.name || 'Rum'}`;
    const room = createRoom(roomName, player.name || null);

    // uppdatera rumslista för alla
    io.emit('roomList', getRoomList());

    // flytta skaparen till nya rummet
    joinPlayerToRoom(socket, room.id);
  });

  // Byt rum
  socket.on('joinRoom', (roomId) => {
    if (!rooms[roomId]) return;
    joinPlayerToRoom(socket, roomId);
  });

  // Uppdatera namn efter login
  socket.on('playerReady', (data) => {
    if (!players[socket.id]) return;
    if (data && data.name) {
      players[socket.id].name = String(data.name);
    }
    const player = players[socket.id];
    if (player.roomId) {
      io.to(player.roomId).emit('playerReady', player);
    }
  });

  // Rörelse
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

  // Chatt
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

  // Disconnect
  socket.on('disconnect', () => {
    console.log('En spelare lämnade. ID:', socket.id);

    const player = players[socket.id];
    if (player && player.roomId) {
      io.to(player.roomId).emit('playerDisconnected', socket.id);
    }

    // Ta bort ev. onlineUser-koppling
    for (const [username, sid] of Object.entries(onlineUsers)) {
      if (sid === socket.id) {
        delete onlineUsers[username];
        break;
      }
    }

    delete players[socket.id];
  });
});

// ---------- STARTA ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servern är igång på port ${PORT}`);
});
