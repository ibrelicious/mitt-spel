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

// Statisk frontend
app.use(express.static(path.join(__dirname)));
app.use(express.json()); // för JSON-body i /api/login och /api/register

const ROOM_WIDTH = 800;
const ROOM_HEIGHT = 600;
const DEFAULT_RADIUS = 20;

// Alla spelare i minnet
const players = {};

// Vilken användare är inloggad på vilken socket
// onlineUsers[username] = socketId
const onlineUsers = {};

// Enkel “databas” av användare
// Format: { "username": { passwordHash: "..." } }
const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};

// Ladda användare från fil vid start
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

// Spara användare till fil
function saveUsers() {
  fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), (err) => {
    if (err) {
      console.error('Kunde inte spara users.json:', err);
    }
  });
}

loadUsers();

// Root-routen
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

// Logga in (kopplar username -> socketId, kickar ev. gammal session)
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

    // Kolla om användaren redan är inloggad någon annanstans
    const existingSocketId = onlineUsers[trimmedUser];
    if (existingSocketId && existingSocketId !== socketId) {
      const oldSocket = io.sockets.sockets.get(existingSocketId);
      if (oldSocket) {
        oldSocket.emit('forceLogout', 'Du loggades ut eftersom du loggade in på ett annat ställe.');
        oldSocket.disconnect(true);
      }
    }

    // Registrera denna socket som aktiv för användaren
    onlineUsers[trimmedUser] = socketId;

    // Inloggningen lyckades
    return res.json({ ok: true, username: trimmedUser });
  } catch (err) {
    console.error('Fel vid login:', err);
    return res.status(500).json({ ok: false, message: 'Internt fel. Försök igen.' });
  }
});

// Socket.io
io.on('connection', (socket) => {
  console.log('En spelare anslöt! ID:', socket.id);

  // Skapa ny spelare (namn uppdateras när klienten loggar in)
  players[socket.id] = {
    x: Math.floor(Math.random() * (ROOM_WIDTH - 2 * DEFAULT_RADIUS)) + DEFAULT_RADIUS,
    y: Math.floor(Math.random() * (ROOM_HEIGHT - 2 * DEFAULT_RADIUS)) + DEFAULT_RADIUS,
    color: '#' + ('000000' + Math.floor(Math.random() * 16777215).toString(16)).slice(-6),
    radius: DEFAULT_RADIUS,
    name: 'Ny Spelare',
    socketId: socket.id
  };

  // Skicka alla spelare till nya klienten
  socket.emit('currentPlayers', players);
  // Berätta för andra att en ny spelare kommit in
  socket.broadcast.emit('newPlayer', players[socket.id]);

  // Spelaren berättar vilket namn den har (efter login)
  socket.on('playerReady', (data) => {
    if (!players[socket.id]) return;
    if (data && data.name) {
      players[socket.id].name = String(data.name);
    }
    io.emit('playerReady', players[socket.id]);
  });

  // Rörelse
  socket.on('playerMovement', (movementData) => {
    const player = players[socket.id];
    if (!player) return;

    const r = player.radius || DEFAULT_RADIUS;

    let newX = movementData.x;
    let newY = movementData.y;

    const minX = r;
    const maxX = ROOM_WIDTH - r;
    const minY = r;
    const maxY = ROOM_HEIGHT - r;

    if (newX < minX) newX = minX;
    if (newX > maxX) newX = maxX;
    if (newY < minY) newY = minY;
    if (newY > maxY) newY = maxY;

    player.x = newX;
    player.y = newY;

    io.emit('playerMoved', player);
  });

  // Chatt
  socket.on('chatMessage', (message) => {
    const player = players[socket.id];
    const playerName = player ? player.name : 'Okänd';

    io.emit('message', {
      senderId: socket.id,
      senderName: playerName,
      message
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('En spelare lämnade. ID:', socket.id);
    delete players[socket.id];

    // Ta bort socketId från onlineUsers om den var kopplad till någon
    for (const [username, sid] of Object.entries(onlineUsers)) {
      if (sid === socket.id) {
        delete onlineUsers[username];
        break;
      }
    }

    io.emit('playerDisconnected', socket.id);
  });
});

// Port (Render sätter process.env.PORT)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servern är igång på port ${PORT}`);
});
