// server.js - Complete WebSocket Chat Server
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Data stores
const clients = new Map();
const rooms = new Map();
const messageHistory = [];
const ROOM_NAME = 'global';
const ROOM_PASSWORD = '123'; // prob use a .env file instead
rooms.set(ROOM_NAME, new Set());


// Message types
const MSG = {
    SET_USERNAME: 'set_username',
    JOIN_ROOM: 'join_room',
    LEAVE_ROOM: 'leave_room',
    CHAT_MESSAGE: 'chat_message',
    PRIVATE_MESSAGE: 'private_message',
    TYPING_START: 'typing_start',
    TYPING_STOP: 'typing_stop',
    USERNAME_SET: 'username_set',
    ROOM_LIST: 'room_list',
    ROOM_JOINED: 'room_joined',
    ROOM_LEFT: 'room_left',
    USER_JOINED: 'user_joined',
    USER_LEFT: 'user_left',
    MESSAGE_RECEIVED: 'message_received',
    TYPING_INDICATOR: 'typing_indicator',
    ERROR: 'error',
    ROOM_USERS: 'room_users',
    MESSAGE_HISTORY: 'message_history'
};

// Connection handler
wss.on('connection', (ws) => {
    const clientId = uuidv4();

    clients.set(ws, {
        id: clientId,
        username: null,
        currentRoom: null,
        isTyping: false
    });

    ws.send(JSON.stringify({
        type: 'connection',
        clientId: clientId
    }));

    ws.send(JSON.stringify({
        type: 'room_list',
        rooms: Array.from(rooms.keys())
    }));

    ws.on('message', (data) => handleMessage(ws, data));
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', console.error);
});

function handleMessage(ws, data) {
    let msg;
    try {
        msg = JSON.parse(data);
    } catch {
        return sendError(ws, 'Invalid JSON');
    }

    const client = clients.get(ws);

    switch (msg.type) {
        case MSG.SET_USERNAME:
            setUsername(ws, client, msg.username);
            break;
        case MSG.JOIN_ROOM:
            joinRoom(ws, client, msg.room, msg.code);
            break;
        case MSG.LEAVE_ROOM:
            leaveRoom(ws, client);
            break;
        case MSG.CHAT_MESSAGE:
            chatMessage(ws, client, msg.content);
            break;
        case MSG.PRIVATE_MESSAGE:
            privateMessage(ws, client, msg.targetId, msg.content);
            break;
        case MSG.TYPING_START:
            setTyping(ws, client, true);
            break;
        case MSG.TYPING_STOP:
            setTyping(ws, client, false);
            break;
    }
}

function sendError(ws, message) {
    ws.send(JSON.stringify({ type: MSG.ERROR, message }));
}

function setUsername(ws, client, username) {
    if (!username || username.trim().length < 2) {
        return sendError(ws, 'Username must be at least 2 characters');
    }

    username = username.trim().substring(0, 20);

    for (const [, c] of clients) {
        if (c.username === username && c.id !== client.id) {
            return sendError(ws, 'Username taken');
        }
    }

    client.username = username;
    ws.send(JSON.stringify({ type: MSG.USERNAME_SET, username }));
}

function joinRoom(ws, client, roomName, password) {
    if (!client.username) return sendError(ws, 'Set username first');
    if (!roomName) return sendError(ws, 'Room name required');
    if (!password) return sendError(ws, 'Password required');

    roomName = roomName.trim().toLowerCase().substring(0, 30);

    if (roomName !== ROOM_NAME) return sendError(ws, 'Room not found');
    if (password !== ROOM_PASSWORD) return sendError(ws, 'Password incorrect');

    // if (!rooms.has(roomName)) rooms.set(roomName, new Set());
    
    rooms.get(roomName).add(ws);
    client.currentRoom = roomName;

    ws.send(JSON.stringify({ type: MSG.ROOM_JOINED, room: roomName }));

    const history = messageHistory.filter(m => m.room === roomName).slice(-50);
    ws.send(JSON.stringify({ type: MSG.MESSAGE_HISTORY, messages: history }));

    const users = getUsersInRoom(roomName);
    ws.send(JSON.stringify({ type: MSG.ROOM_USERS, users }));

    broadcastToRoom(roomName, {
        type: MSG.USER_JOINED,
        username: client.username,
        userId: client.id
    }, ws);

}

function leaveRoom(ws, client) {
    if (!client.currentRoom) return;

    const roomName = client.currentRoom;
    const room = rooms.get(roomName);


    ws.send(JSON.stringify({ type: MSG.ROOM_LEFT, room: roomName }));
    client.currentRoom = null;
}

function chatMessage(ws, client, content) {
    if (!client.username || !client.currentRoom) return;
    if (!content || content.trim().length === 0) return;

    content = content.trim().substring(0, 1000);

    const message = {
        id: uuidv4(),
        type: MSG.MESSAGE_RECEIVED,
        room: client.currentRoom,
        userId: client.id,
        username: client.username,
        content,
        timestamp: new Date().toISOString()
    };

    messageHistory.push(message);
    if (messageHistory.length > 1000) messageHistory.shift();

    broadcastToRoom(client.currentRoom, message);
}

function privateMessage(ws, client, targetId, content) {
    if (!client.username) return sendError(ws, 'Set username first');
    if (!content || content.trim().length === 0) return;

    let targetWs, targetClient;
    for (const [w, c] of clients) {
        if (c.id === targetId) {
            targetWs = w;
            targetClient = c;
            break;
        }
    }

    if (!targetWs) return sendError(ws, 'User not found');

    const pm = {
        type: MSG.PRIVATE_MESSAGE,
        fromId: client.id,
        fromUsername: client.username,
        toId: targetId,
        toUsername: targetClient.username,
        content: content.trim().substring(0, 1000),
        timestamp: new Date().toISOString()
    };

    if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(pm));
    }

    ws.send(JSON.stringify({ ...pm, type: 'private_message_sent' }));
}

function setTyping(ws, client, isTyping) {
    if (!client.username || !client.currentRoom) return;

    client.isTyping = isTyping;
    broadcastToRoom(client.currentRoom, {
        type: MSG.TYPING_INDICATOR,
        userId: client.id,
        username: client.username,
        isTyping
    }, ws);
}

function handleDisconnect(ws) {
    const client = clients.get(ws);
    if (client && client.currentRoom) {
        leaveRoom(ws, client);
    }
    clients.delete(ws);
}

function getUsersInRoom(roomName) {
    const room = rooms.get(roomName);
    if (!room) return [];

    return Array.from(room)
        .map(ws => clients.get(ws))
        .filter(c => c && c.username)
        .map(c => ({ id: c.id, username: c.username }));
}

function broadcastToRoom(roomName, message, excludeWs = null) {
    const room = rooms.get(roomName);
    if (!room) return;

    const str = JSON.stringify(message);
    for (const ws of room) {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(str);
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
