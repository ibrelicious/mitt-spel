// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serva alla filer (index.html m.m.) från samma mapp
app.use(express.static(path.join(__dirname)));

const ROOM_WIDTH = 800;
const ROOM_HEIGHT = 600;
const DEFAULT_RADIUS = 20;

// Alla spelare i minnet
const players = {};

// Root-routen
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Socket.io
io.on('connection', (socket) => {
  console.log('En spelare anslöt! ID:', socket.id);

  // Skapa ny spelare
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

  // Spelaren har valt namn
  socket.on('playerReady', (data) => {
    if (!players[socket.id]) return;
    players[socket.id].name = data.name;
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
    io.emit('playerDisconnected', socket.id);
  });
});

// Port (Render sätter process.env.PORT)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servern är igång på port ${PORT}`);
});
