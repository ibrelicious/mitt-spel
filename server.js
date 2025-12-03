// server.js
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const ROOM_WIDTH = 800;
const ROOM_HEIGHT = 600;
const DEFAULT_RADIUS = 20;

let players = {};

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    console.log('En spelare anslöt! ID:', socket.id);

    players[socket.id] = {
        x: Math.floor(Math.random() * (ROOM_WIDTH - 2 * DEFAULT_RADIUS)) + DEFAULT_RADIUS,
        y: Math.floor(Math.random() * (ROOM_HEIGHT - 2 * DEFAULT_RADIUS)) + DEFAULT_RADIUS,
        color: '#' + ('000000' + Math.floor(Math.random() * 16777215).toString(16)).slice(-6),
        radius: DEFAULT_RADIUS,
        name: 'Ny Spelare',
        socketId: socket.id
    };

    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', players[socket.id]);

    socket.on('playerReady', (data) => {
        if (!players[socket.id]) return;
        players[socket.id].name = data.name;

        io.emit('playerReady', players[socket.id]); 
    });

    socket.on('playerMovement', (movementData) => {
        if (!players[socket.id]) return;

        const r = players[socket.id].radius || DEFAULT_RADIUS;

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

        players[socket.id].x = newX;
        players[socket.id].y = newY;

        io.emit('playerMoved', players[socket.id]); 
    });

    socket.on('chatMessage', (message) => {
        const playerName = players[socket.id] ? players[socket.id].name : 'Okänd';
        io.emit('message', { 
            senderId: socket.id, 
            senderName: playerName,
            message: message 
        });
    });

    socket.on('disconnect', () => {
        console.log('En spelare lämnade. ID:', socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log('Servern är igång på port ' + PORT);
});
