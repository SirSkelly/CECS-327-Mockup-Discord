// public/chat.js

// WebSocket connection
let ws = null;
let clientId = null;
let currentUsername = null;
let currentRoom = null;
let typingTimeout = null;
let isCurrentlyTyping = false;

// DOM Elements
const loginPanel = document.getElementById('login-panel');
const roomPanel = document.getElementById('room-panel');
const chatPanel = document.getElementById('chat-panel');
const connectionStatus = document.getElementById('connection-status');

const usernameInput = document.getElementById('username-input');
const setUsernameBtn = document.getElementById('set-username-btn');
const roomInput = document.getElementById('room-input-name');
const roomCode = document.getElementById('room-input-code');
const joinRoomBtn = document.getElementById('join-room-btn');
const roomNameDisplay = document.getElementById('room-name');
const leaveRoomBtn = document.getElementById('leave-room-btn');
const usersList = document.getElementById('users-list');
const messagesContainer = document.getElementById('messages-container');
const typingIndicator = document.getElementById('typing-indicator');
const messageInputContainer = document.querySelector('.message-input-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');

leaveRoomBtn.disabled = true;
messageInputContainer.classList.add('hidden-input');

// Initialize connection
function connect() {
    // Use wss:// for production with SSL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('Connected to server');
        updateConnectionStatus('connected', 'Connected');
    };

    ws.onclose = () => {
        console.log('Disconnected from server');
        updateConnectionStatus('disconnected', 'Disconnected');

        // Attempt reconnection after 3 seconds
        setTimeout(connect, 3000);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    ws.onmessage = (event) => {
        handleServerMessage(JSON.parse(event.data));
    };
}

// Update connection status display
function updateConnectionStatus(status, text) {
    connectionStatus.className = status;
    connectionStatus.textContent = text;
}

// Handle messages from server
function handleServerMessage(message) {
    console.log('Received:', message);

    switch (message.type) {
        case 'connection':
            clientId = message.clientId;
            break;

        case 'username_set':
            currentUsername = message.username;
            showPanel('room');
            break;

        case 'room_joined':
            currentRoom = message.room;
            roomNameDisplay.textContent = `#${message.room}`;
            leaveRoomBtn.disabled = false;
            messageInputContainer.classList.remove('hidden-input'); 
            showPanel('chat');
            messageInput.focus();
            break;

        case 'room_left':
            currentRoom = null;
            leaveRoomBtn.disabled = true;
            messageInputContainer.classList.add('hidden-input');
            showPanel('room');
            messagesContainer.innerHTML = '';
            break;

        case 'room_users':
            updateUsersList(message.users);
            break;

        case 'room_list':
            console.log(message.rooms);
            roomNameDisplay.textContent = `#${message.rooms}` || '-';
            break;

        case 'message_history':
            // Clear and load history
            messagesContainer.innerHTML = '';
            message.messages.forEach(msg => displayMessage(msg));
            scrollToBottom();
            break;

        case 'message_received':
            displayMessage(message);
            scrollToBottom();
            break;

        case 'user_joined':
            addSystemMessage(`${message.username} joined the room`);
            break;

        case 'user_left':
            addSystemMessage(`${message.username} left the room`);
            break;

        case 'typing_indicator':
            updateTypingIndicator(message);
            break;

        case 'private_message':
            displayPrivateMessage(message, false);
            break;

        case 'private_message_sent':
            displayPrivateMessage(message, true);
            break;

        case 'error':
            alert(message.message);
            break;
    }
}

// Show specific panel
function showPanel(panel) {
    loginPanel.classList.add('hidden');
    roomPanel.classList.add('hidden');
    chatPanel.classList.add('hidden');

    if (panel === 'login') loginPanel.classList.remove('hidden');
    if (panel === 'room') roomPanel.classList.remove('hidden');
    if (panel === 'chat') chatPanel.classList.remove('hidden');
}

// Display a chat message
function displayMessage(message) {
    const div = document.createElement('div');
    const isOwn = message.userId === clientId;
    div.className = `message ${isOwn ? 'own' : ''}`;

    const time = new Date(message.timestamp).toLocaleTimeString();

    div.innerHTML = `
        <div class="message-username">${escapeHtml(message.username)}</div>
        <div class="message-content">${escapeHtml(message.content)}</div>
        <div class="message-time">${time}</div>
    `;

    messagesContainer.appendChild(div);
}

// Display private message
function displayPrivateMessage(message, isSent) {
    const div = document.createElement('div');
    div.className = 'message private';

    const time = new Date(message.timestamp).toLocaleTimeString();
    const label = isSent ? `To ${message.toUsername}` : `From ${message.fromUsername}`;

    div.innerHTML = `
        <div class="message-username">[Private] ${escapeHtml(label)}</div>
        <div class="message-content">${escapeHtml(message.content)}</div>
        <div class="message-time">${time}</div>
    `;

    messagesContainer.appendChild(div);
    scrollToBottom();
}

// Add system message
function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'message system';
    div.textContent = text;
    messagesContainer.appendChild(div);
    scrollToBottom();
}

// Update users list
function updateUsersList(users) {
    const names = users.map(u => u.username).join(', ');
    usersList.textContent = `Online: ${names}`;
}

// Update typing indicator
const typingUsers = new Map();

function updateTypingIndicator(message) {
    if (message.isTyping) {
        typingUsers.set(message.userId, message.username);
    } else {
        typingUsers.delete(message.userId);
    }

    if (typingUsers.size === 0) {
        typingIndicator.classList.add('hidden');
    } else {
        const names = Array.from(typingUsers.values());
        let text;

        if (names.length === 1) {
            text = `${names[0]} is typing...`;
        } else if (names.length === 2) {
            text = `${names[0]} and ${names[1]} are typing...`;
        } else {
            text = 'Several people are typing...';
        }

        typingIndicator.textContent = text;
        typingIndicator.classList.remove('hidden');
    }
}

// Scroll messages to bottom
function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Send message to server
function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

// Handle typing indicator
function handleTyping() {
    if (!isCurrentlyTyping) {
        isCurrentlyTyping = true;
        send({ type: 'typing_start' });
    }

    // Clear existing timeout
    if (typingTimeout) {
        clearTimeout(typingTimeout);
    }

    // Set new timeout to stop typing indicator
    typingTimeout = setTimeout(() => {
        isCurrentlyTyping = false;
        send({ type: 'typing_stop' });
    }, 1000);
}

// Event Listeners
setUsernameBtn.addEventListener('click', () => {
    const username = usernameInput.value.trim();
    if (username) {
        send({ type: 'set_username', username });
    }
});

usernameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') setUsernameBtn.click();
});

joinRoomBtn.addEventListener('click', () => {
    const room = roomInput.value.trim();
    const code = roomCode.value.trim();
    if (room) {
        send({ type: 'join_room', room,  code});
    }
});

roomInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoomBtn.click();
});

roomCode.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoomBtn.click();
});

leaveRoomBtn.addEventListener('click', () => {
    send({ type: 'leave_room' });
});

sendBtn.addEventListener('click', () => {
    const content = messageInput.value.trim();
    if (content) {
        send({ type: 'chat_message', content });
        messageInput.value = '';
        isCurrentlyTyping = false;
    }
});

messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        sendBtn.click();
    } else {
        handleTyping();
    }
});

messageInput.addEventListener('input', handleTyping);

// Start connection
connect();