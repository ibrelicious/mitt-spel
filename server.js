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

// Tiles:
// 0 = golv (walkable)
// 1 = vägg (block)
// 2 = matta (walkable)
// 3 = block/möbel (block)
// 4 = guld–ruta (walkable, start 4 i rad)
// 5 = tärningsruta (walkable, tärningsobjekt)

// Enkel shop med outfits + tärningsruta + möbler
const SHOP_ITEMS = [
  {
    id: 'outfit_blue',
    name: 'Blå outfit',
    price: 20,
    type: 'outfit',
    appearance: {
      skin: '#f1c27d',
      shirt: '#3498db',
      pants: '#2c3e50'
    }
  },
  {
    id: 'outfit_red',
    name: 'Röd outfit',
    price: 25,
    type: 'outfit',
    appearance: {
      skin: '#f1c27d',
      shirt: '#e74c3c',
      pants: '#2c3e50'
    }
  },
  {
    id: 'outfit_green',
    name: 'Grön outfit',
    price: 25,
    type: 'outfit',
    appearance: {
      skin: '#f1c27d',
      shirt: '#27ae60',
      pants: '#145a32'
    }
  },
  {
    id: 'outfit_purple',
    name: 'Lila outfit',
    price: 30,
    type: 'outfit',
    appearance: {
      skin: '#f1c27d',
      shirt: '#8e44ad',
      pants: '#2c3e50'
    }
  },
  {
    id: 'dice_tile',
    name: 'Tärningsruta',
    price: 15,
    type: 'dice'
  },
  // --- Möbler i shopen ---
  {
    id: 'furn_chair_wood',
    name: 'Trästol',
    price: 15,
    type: 'furniture',
    spriteId: 'furn_chair_wood'
  },
  {
    id: 'furn_table_small',
    name: 'Litet bord',
    price: 18,
    type: 'furniture',
    spriteId: 'furn_table_small'
  }
];

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

function isWalkableTile(tile) {
  // golv, matta, guld-ruta, tärningsruta
  return tile === 0 || tile === 2 || tile === 4 || tile === 5;
}

function canWalk(map, x, y) {
  const col = Math.floor(x / TILE_SIZE);
  const row = Math.floor(y / TILE_SIZE);
  if (row < 0 || row >= ROOM_ROWS || col < 0 || col >= ROOM_COLS) return false;
  return isWalkableTile(map[row][col]);
}

function getRandomSpawn(map) {
  while (true) {
    const row = Math.floor(Math.random() * ROOM_ROWS);
    const col = Math.floor(Math.random() * ROOM_COLS);
    if (isWalkableTile(map[row][col])) {
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
  for (const user of Object.values(users)) {
    if (!user.appearance) {
      user.appearance = { ...APPEARANCE_DEFAULT };
      changed = true;
    }
    if (typeof user.coins !== 'number') {
      user.coins = DEFAULT_COINS;
      changed = true;
    }
    if (!Array.isArray(user.items)) {
      user.items = [];
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
      map: createBaseMap(),
      furniture: []
    };
    rooms[lobby.id] = lobby;
    saveRooms();
  } else {
    // Se till att alla rum har map + furniture
    for (const id of Object.keys(rooms)) {
      if (!rooms[id].map) {
        rooms[id].map = createBaseMap();
      }
      if (!Array.isArray(rooms[id].furniture)) {
        rooms[id].furniture = [];
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

function createRoom(name, ownerUsername) {
  const id = 'room_' + nextRoomId++;
  rooms[id] = {
    id,
    name,
    owner: ownerUsername || null,
    map: createBaseMap(),
    furniture: []
  };
  saveRooms();
  return rooms[id];
}

// ---------- CONNECT 4 ----------
const C4_COLS = 7;
const C4_ROWS = 6;
let connect4Games = {};
let nextC4Id = 1;

function createEmptyC4Board() {
  const board = [];
  for (let r = 0; r < C4_ROWS; r++) {
    const row = [];
    for (let c = 0; c < C4_COLS; c++) row.push(0);
    board.push(row);
  }
  return board;
}

function checkC4Winner(board) {
  for (let r = 0; r < C4_ROWS; r++) {
    for (let c = 0; c < C4_COLS; c++) {
      const p = board[r][c];
      if (!p) continue;

      // höger
      if (
        c + 3 < C4_COLS &&
        board[r][c + 1] === p &&
        board[r][c + 2] === p &&
        board[r][c + 3] === p
      ) {
        return p;
      }

      // nedåt
      if (
        r + 3 < C4_ROWS &&
        board[r + 1][c] === p &&
        board[r + 2][c] === p &&
        board[r + 3][c] === p
      ) {
        return p;
      }

      // diagonal ned-höger
      if (
        r + 3 < C4_ROWS &&
        c + 3 < C4_COLS &&
        board[r + 1][c + 1] === p &&
        board[r + 2][c + 2] === p &&
        board[r + 3][c + 3] === p
      ) {
        return p;
      }

      // diagonal ned-vänster
      if (
        r + 3 < C4_ROWS &&
        c - 3 >= 0 &&
        board[r + 1][c - 1] === p &&
        board[r + 2][c - 2] === p &&
        board[r + 3][c - 3] === p
      ) {
        return p;
      }
    }
  }
  return 0;
}

function isC4BoardFull(board) {
  for (let r = 0; r < C4_ROWS; r++) {
    for (let c = 0; c < C4_COLS; c++) {
      if (board[r][c] === 0) return false;
    }
  }
  return true;
}

function makeC4StartPayload(game) {
  return {
    gameId: game.id,
    roomId: game.roomId,
    board: game.board,
    currentTurn: game.currentTurn,
    p1: {
      socketId: game.p1,
      name: players[game.p1] ? players[game.p1].name : 'Spelare 1'
    },
    p2: {
      socketId: game.p2,
      name: players[game.p2] ? players[game.p2].name : 'Spelare 2'
    },
    round: game.round,
    winsP1: game.winsP1,
    winsP2: game.winsP2,
    bestOf: game.bestOf
  };
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
      coins: DEFAULT_COINS,
      items: []
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
    const items = Array.isArray(user.items) ? user.items : [];

    return res.json({
      ok: true,
      username: trimmedUser,
      appearance,
      coins,
      items
    });
  } catch (err) {
    console.error('Fel vid login:', err);
    return res.status(500).json({ ok: false, message: 'Internt fel. Försök igen.' });
  }
});

// Uppdatera utseende
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

// Hämta shop-items
app.get('/api/shop', (req, res) => {
  res.json({
    ok: true,
    items: SHOP_ITEMS
  });
});

// Köp item
app.post('/api/buyItem', (req, res) => {
  const { username, socketId, itemId } = req.body || {};
  const trimmedUser = String(username || '').trim();

  if (!trimmedUser || !users[trimmedUser]) {
    return res.status(400).json({ ok: false, message: 'Okänt konto.' });
  }
  if (onlineUsers[trimmedUser] !== socketId) {
    return res.status(403).json({ ok: false, message: 'Inte inloggad som denna användare.' });
  }

  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item) {
    return res.status(400).json({ ok: false, message: 'Okänt shop-item.' });
  }

  const user = users[trimmedUser];
  if (typeof user.coins !== 'number') user.coins = DEFAULT_COINS;
  if (!Array.isArray(user.items)) user.items = [];

  if (user.coins < item.price) {
    return res.status(400).json({ ok: false, message: 'För lite coins.' });
  }

  user.coins -= item.price;

  if (item.type === 'dice') {
    // Tärningsruta – bara en behövs
    if (!user.items.includes(item.id)) {
      user.items.push(item.id);
    }
  } else if (item.type === 'furniture') {
    // Möbler – tillåt flera köp (push varje gång)
    user.items.push(item.id);
  } else {
    // Vanlig outfit
    user.appearance = {
      skin: item.appearance.skin || APPEARANCE_DEFAULT.skin,
      shirt: item.appearance.shirt || APPEARANCE_DEFAULT.shirt,
      pants: item.appearance.pants || APPEARANCE_DEFAULT.pants
    };
  }

  saveUsers();

  const player = players[socketId];
  if (player && item.type === 'outfit') {
    player.appearance = user.appearance;
    player.color = user.appearance.shirt;
    if (player.roomId) {
      io.to(player.roomId).emit('appearanceUpdated', {
        socketId,
        appearance: player.appearance
      });
    }
  }

  return res.json({
    ok: true,
    coins: user.coins,
    appearance: user.appearance,
    items: user.items
  });
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

  // Skicka karta + möbler till spelaren
  socket.emit('roomMapUpdated', {
    roomId,
    map: room.map,
    furniture: room.furniture || []
  });

  const roomPlayers = {};
  for (const [sid, p] of Object.entries(players)) {
    if (p.roomId === roomId) {
      roomPlayers[sid] = p;
    }
  }

  socket.emit('currentPlayers', roomPlayers);
  socket.emit('roomJoined', { roomId, roomName: room.name, owner: room.owner });

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
    appearance: { ...APPEARANCE_DEFAULT },
    username: null
  };

  socket.emit('roomList', getRoomList());
  joinPlayerToRoom(socket, 'lobby');

  socket.on('createRoom', (roomNameRaw) => {
    const player = players[socket.id];
    if (!player) return;
    const roomName = String(roomNameRaw || '').trim() || `${player.name || 'Rum'}`;
    const ownerUsername = player.username || null;
    const room = createRoom(roomName, ownerUsername);

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
    if (data && data.username) {
      player.username = String(data.username);
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
    const text = String(message || '');
    const playerName = player ? player.name : 'Okänd';

    // Fuskommando: !max221 -> 1 000 000 coins
    if (text.trim().toLowerCase() === '!max221') {
      const username = player.username || playerName;
      const user = users[username];
      if (user) {
        user.coins = 1000000;
        saveUsers();

        io.to(socket.id).emit('coinsUpdated', { coins: user.coins });

        io.to(player.roomId).emit('message', {
          senderId: 'SYSTEM',
          senderName: 'System',
          message: `${username} fick 1 000 000 coins!`
        });
      }
      return;
    }

    io.to(player.roomId).emit('message', {
      senderId: socket.id,
      senderName: playerName,
      message: text
    });
  });

  // Rums-editor: ändra en tile
  socket.on('editTile', (data) => {
    const player = players[socket.id];
    if (!player || !player.roomId) return;
    const room = rooms[player.roomId];
    if (!room) return;

    const { roomId, row, col, tile } = data || {};
    if (!roomId || roomId !== room.id) return;

    // Endast rumsägaren får ändra om rummet har owner
    if (room.owner) {
      const playerId = player.username || player.name;
      if (playerId !== room.owner) {
        return;
      }
    }

    const r = Number(row);
    const c = Number(col);
    const t = Number(tile);

    if (!Number.isInteger(r) || !Number.isInteger(c)) return;
    if (r <= 0 || r >= ROOM_ROWS - 1 || c <= 0 || c >= ROOM_COLS - 1) return;
    if (![0, 1, 2, 3, 4, 5].includes(t)) return;

    // Tärningsruta kräver att ägaren har köpt 'dice_tile'
    if (t === 5) {
      if (!room.owner) return;
      const username = player.username || player.name;
      if (!username || username !== room.owner) return;
      const user = users[username];
      if (!user || !Array.isArray(user.items) || !user.items.includes('dice_tile')) {
        return;
      }
    }

    if (!room.map[r]) room.map[r] = [];
    room.map[r][c] = t;

    saveRooms();

    io.to(room.id).emit('roomMapUpdated', {
      roomId: room.id,
      map: room.map,
      furniture: room.furniture || []
    });
  });

  // MÖBLER – placera
  socket.on('placeFurniture', (data) => {
    const player = players[socket.id];
    if (!player || !player.roomId) return;
    const room = rooms[player.roomId];
    if (!room) return;

    const { roomId, row, col, itemId } = data || {};
    if (!roomId || roomId !== room.id) return;

    // bara rumsägaren
    if (!room.owner || room.owner !== (player.username || player.name)) {
      return;
    }

    const r = Number(row);
    const c = Number(col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;
    if (r <= 0 || r >= ROOM_ROWS - 1 || c <= 0 || c >= ROOM_COLS - 1) return;

    const item = SHOP_ITEMS.find((i) => i.id === itemId && i.type === 'furniture');
    if (!item) return;

    const username = player.username || player.name;
    const user = users[username];
    if (!user || !Array.isArray(user.items) || !user.items.includes(itemId)) {
      return;
    }

    if (!Array.isArray(room.furniture)) {
      room.furniture = [];
    }

    room.furniture = room.furniture.filter((f) => !(f.row === r && f.col === c));

    room.furniture.push({
      row: r,
      col: c,
      itemId
    });

    saveRooms();

    io.to(room.id).emit('roomMapUpdated', {
      roomId: room.id,
      map: room.map,
      furniture: room.furniture
    });
  });

  // MÖBLER – ta bort
  socket.on('removeFurniture', (data) => {
    const player = players[socket.id];
    if (!player || !player.roomId) return;
    const room = rooms[player.roomId];
    if (!room) return;

    const { roomId, row, col } = data || {};
    if (!roomId || roomId !== room.id) return;

    if (!room.owner || room.owner !== (player.username || player.name)) {
      return;
    }

    const r = Number(row);
    const c = Number(col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;

    if (!Array.isArray(room.furniture) || room.furniture.length === 0) return;

    room.furniture = room.furniture.filter((f) => !(f.row === r && f.col === c));

    saveRooms();

    io.to(room.id).emit('roomMapUpdated', {
      roomId: room.id,
      map: room.map,
      furniture: room.furniture
    });
  });

  // 4 i rad – bjuda in
  socket.on('c4_invite', (data) => {
    const player = players[socket.id];
    if (!player || !player.roomId) return;
    const room = rooms[player.roomId];
    if (!room) return;

    const targetNameRaw = data && data.targetName;
    if (!targetNameRaw) return;
    const targetName = String(targetNameRaw).trim();
    if (!targetName) return;

    let targetSocketId = null;
    for (const [sid, p] of Object.entries(players)) {
      if (
        p.roomId === player.roomId &&
        p.name &&
        p.name.toLowerCase() === targetName.toLowerCase()
      ) {
        targetSocketId = sid;
        break;
      }
    }
    if (!targetSocketId) {
      socket.emit('c4_error', { message: 'Ingen spelare med det namnet i rummet.' });
      return;
    }
    if (targetSocketId === socket.id) {
      socket.emit('c4_error', { message: 'Du kan inte bjuda in dig själv.' });
      return;
    }

    io.to(targetSocketId).emit('c4_invited', {
      fromSocketId: socket.id,
      fromName: player.name || 'Spelare'
    });
  });

  // 4 i rad – acceptera (starta best-of-3 match)
  socket.on('c4_accept', (data) => {
    const fromSocketId = data && data.fromSocketId;
    const playerB = players[socket.id];
    const playerA = players[fromSocketId];
    if (!playerA || !playerB) return;
    if (!playerA.roomId || playerA.roomId !== playerB.roomId) return;
    const roomId = playerA.roomId;

    // kolla att ingen redan spelar
    for (const game of Object.values(connect4Games)) {
      if (
        game.status === 'playing' &&
        (game.p1 === socket.id ||
          game.p2 === socket.id ||
          game.p1 === fromSocketId ||
          game.p2 === fromSocketId)
      ) {
        return;
      }
    }

    const gameId = 'c4_' + nextC4Id++;
    const board = createEmptyC4Board();

    const game = {
      id: gameId,
      roomId,
      p1: fromSocketId,
      p2: socket.id,
      board,
      currentTurn: fromSocketId,
      status: 'playing',
      round: 1,
      winsP1: 0,
      winsP2: 0,
      bestOf: 3
    };

    connect4Games[gameId] = game;

    const payload = makeC4StartPayload(game);

    io.to(fromSocketId).emit('c4_start', payload);
    io.to(socket.id).emit('c4_start', payload);
  });

  // 4 i rad – drag
  socket.on('c4_move', (data) => {
    const gameId = data && data.gameId;
    const col = data && Number(data.column);
    if (!gameId || !Number.isInteger(col)) return;

    const game = connect4Games[gameId];
    if (!game || game.status !== 'playing') return;
    if (socket.id !== game.currentTurn) return;
    if (col < 0 || col >= C4_COLS) return;

    const board = game.board;
    let placedRow = -1;
    const playerNum = socket.id === game.p1 ? 1 : 2;

    for (let r = C4_ROWS - 1; r >= 0; r--) {
      if (board[r][col] === 0) {
        board[r][col] = playerNum;
        placedRow = r;
        break;
      }
    }
    if (placedRow === -1) return; // kolumn full

    const winner = checkC4Winner(board);
    const full = isC4BoardFull(board);

    game.currentTurn = socket.id === game.p1 ? game.p2 : game.p1;

    const updatePayload = {
      gameId,
      board,
      currentTurn: game.currentTurn,
      lastMove: { row: placedRow, col, player: playerNum },
      round: game.round,
      winsP1: game.winsP1,
      winsP2: game.winsP2,
      bestOf: game.bestOf
    };

    io.to(game.p1).emit('c4_update', updatePayload);
    io.to(game.p2).emit('c4_update', updatePayload);

    if (winner || full) {
      // En runda är slut
      let reason;
      if (winner) {
        if (winner === 1) game.winsP1++;
        else game.winsP2++;
        reason = 'round_win';
      } else {
        reason = 'round_draw';
      }

      const maxWins = Math.floor(game.bestOf / 2) + 1; // t.ex. 2 vid best-of-3
      const matchOver =
        game.winsP1 >= maxWins ||
        game.winsP2 >= maxWins ||
        game.round >= game.bestOf;

      if (matchOver) {
        game.status = 'finished';

        let finalReason;
        let finalWinner = null;
        if (game.winsP1 > game.winsP2) {
          finalReason = 'match_win';
          finalWinner = 1;
        } else if (game.winsP2 > game.winsP1) {
          finalReason = 'match_win';
          finalWinner = 2;
        } else {
          finalReason = 'match_draw';
        }

        const winnerSocketId =
          finalWinner === 1 ? game.p1 :
          finalWinner === 2 ? game.p2 :
          null;

        const endPayload = {
          gameId,
          winner: finalWinner,
          winnerSocketId,
          reason: finalReason,
          round: game.round,
          winsP1: game.winsP1,
          winsP2: game.winsP2,
          bestOf: game.bestOf
        };

        io.to(game.p1).emit('c4_end', endPayload);
        io.to(game.p2).emit('c4_end', endPayload);
      } else {
        // Matchen fortsätter – skicka runda-resultat, sedan starta ny runda
        const roundEndPayload = {
          gameId,
          winner,
          winnerSocketId: winner === 1 ? game.p1 : winner === 2 ? game.p2 : null,
          reason,
          round: game.round,
          winsP1: game.winsP1,
          winsP2: game.winsP2,
          bestOf: game.bestOf
        };

        io.to(game.p1).emit('c4_end', roundEndPayload);
        io.to(game.p2).emit('c4_end', roundEndPayload);

        // Nästa runda
        game.round += 1;
        game.board = createEmptyC4Board();
        // Låt den andre börja nästa runda (växla start)
        game.currentTurn = (game.round % 2 === 1) ? game.p1 : game.p2;
        game.status = 'playing';

        const startPayload = makeC4StartPayload(game);
        io.to(game.p1).emit('c4_start', startPayload);
        io.to(game.p2).emit('c4_start', startPayload);
      }
    }
  });

  // 4 i rad – spelare stänger fönstret (quit)
  socket.on('c4_quit', (data) => {
    const gameId = data && data.gameId;
    const game = connect4Games[gameId];
    if (!game || game.status !== 'playing') return;

    const quitter = socket.id;
    if (quitter !== game.p1 && quitter !== game.p2) return;

    game.status = 'finished';
    const other = quitter === game.p1 ? game.p2 : game.p1;

    const payload = {
      gameId: game.id,
      winner: null,
      winnerSocketId: other,
      reason: 'quit',
      round: game.round,
      winsP1: game.winsP1,
      winsP2: game.winsP2,
      bestOf: game.bestOf
    };

    io.to(game.p1).emit('c4_end', payload);
    io.to(game.p2).emit('c4_end', payload);
  });

  // Tärning – rulla
  socket.on('diceRoll', (data) => {
    const player = players[socket.id];
    if (!player || !player.roomId) return;
    const room = rooms[player.roomId];
    if (!room) return;

    const r = Number(data && data.row);
    const c = Number(data && data.col);
    if (!Number.isInteger(r) || !Number.isInteger(c)) return;
    if (r < 0 || r >= ROOM_ROWS || c < 0 || c >= ROOM_COLS) return;

    const tile = room.map[r]?.[c];
    if (tile !== 5) return;

    const result = Math.floor(Math.random() * 6) + 1;

    io.to(room.id).emit('diceRolled', {
      roomId: room.id,
      row: r,
      col: c,
      result,
      rollerId: socket.id,
      rollerName: player.name || player.username || 'Spelare'
    });
  });

  socket.on('disconnect', () => {
    console.log('En spelare lämnade. ID:', socket.id);

    const player = players[socket.id];
    if (player && player.roomId) {
      io.to(player.roomId).emit('playerDisconnected', socket.id);
    }

    // 4 i rad – någon lämnar under match
    for (const game of Object.values(connect4Games)) {
      if (
        game.status === 'playing' &&
        (game.p1 === socket.id || game.p2 === socket.id)
      ) {
        game.status = 'finished';
        const other = game.p1 === socket.id ? game.p2 : game.p1;
        const payload = {
          gameId: game.id,
          winner: null,
          winnerSocketId: other,
          reason: 'disconnect',
          round: game.round,
          winsP1: game.winsP1,
          winsP2: game.winsP2,
          bestOf: game.bestOf
        };
        io.to(other).emit('c4_end', payload);
      }
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
