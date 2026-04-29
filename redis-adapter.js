// redis-adapter.js
const Redis = require('ioredis');

const pub = new Redis();
const sub = new Redis();

function initRedisAdapter(serverId, broadcastToRoom) {
    sub.subscribe('chat:events');

    sub.on('message', (channel, message) => {
        const data = JSON.parse(message);
        if (data.serverId === serverId) return;
        broadcastToRoom(data.room, data.payload);
    });
}

function publishMessage(serverId, room, payload) {
    pub.publish('chat:events', JSON.stringify({ serverId, room, payload }));
}

module.exports = {
    initRedisAdapter,
    publishMessage
};