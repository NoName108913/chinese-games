// 游戏客户端主逻辑
const socket = io();

// 游戏状态
let currentUser = null;
let currentRoom = null;
let myCards = [];
let selectedCards = [];
let isMyTurn = false;
let canPass = false;
let playerSeats = {}; // 记录玩家座位

// DOM 元素
const pages = {
    login: document.getElementById('loginPage'),
    lobby: document.getElementById('lobbyPage'),
    room: document.getElementById('roomPage')
};

// 页面切换
function showPage(pageName) {
    Object.values(pages).forEach(p => p.classList.add('hidden'));
    pages[pageName].classList.remove('hidden');
}

// ========== 注册登录 ==========
document.getElementById('registerBtn').addEventListener('click', () => {
    const username = document.getElementById('usernameInput').value.trim();
    if (!username) {
        alert('请输入用户名');
        return;
    }
    socket.emit('register', username, (response) => {
        if (response.success) {
            currentUser = username;
            document.getElementById('currentUser').textContent = username;
            showPage('lobby');
            refreshRooms();
            refreshOnlineUsers();
        } else {
            alert(response.message);
        }
    });
});

document.getElementById('usernameInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('registerBtn').click();
    }
});

// ========== 大厅功能 ==========
document.getElementById('logoutBtn').addEventListener('click', () => {
    location.reload();
});

// 刷新房间列表
function refreshRooms() {
    socket.emit('getRooms', (rooms) => {
        renderRooms(rooms);
    });
}

// 渲染房间列表
function renderRooms(rooms) {
    const container = document.getElementById('roomsList');
    if (rooms.length === 0) {
        container.innerHTML = '<p class="empty">暂无可用房间，创建一个吧！</p>';
        return;
    }
    
    container.innerHTML = rooms.map(room => `
        <div class="room-item">
            <div class="room-info">
                <h4>${escapeHtml(room.name)}</h4>
                <p>房主: ${escapeHtml(room.host)}</p>
            </div>
            <div class="room-status">
                <div class="player-indicator">
                    ${[0,1,2].map(i => `<div class="player-dot ${i < room.playerCount ? 'active' : ''}"></div>`).join('')}
                </div>
                <button class="btn-primary" onclick="joinRoom('${room.id}')" ${room.playerCount >= 3 ? 'disabled' : ''}>
                    ${room.playerCount >= 3 ? '已满' : '加入'}
                </button>
            </div>
        </div>
    `).join('');
}

// 创建房间
document.getElementById('createRoomBtn').addEventListener('click', () => {
    document.getElementById('createRoomModal').classList.remove('hidden');
    document.getElementById('roomNameInput').value = '';
    document.getElementById('roomNameInput').focus();
});

document.getElementById('confirmCreateRoomBtn').addEventListener('click', () => {
    const roomName = document.getElementById('roomNameInput').value.trim();
    socket.emit('createRoom', roomName, (response) => {
        if (response.success) {
            currentRoom = response.room;
            enterRoom();
            document.getElementById('createRoomModal').classList.add('hidden');
        } else {
            alert(response.message);
        }
    });
});

document.getElementById('cancelCreateRoomBtn').addEventListener('click', () => {
    document.getElementById('createRoomModal').classList.add('hidden');
});

document.getElementById('roomNameInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('confirmCreateRoomBtn').click();
    }
});

// 加入房间
function joinRoom(roomId) {
    socket.emit('joinRoom', roomId, (response) => {
        if (response.success) {
            currentRoom = response.room;
            enterRoom();
        } else {
            alert(response.message);
        }
    });
}

// ========== 在线用户 ==========
function refreshOnlineUsers() {
    socket.emit('getOnlineUsers', (users) => {
        renderOnlineUsers(users);
    });
}

document.getElementById('refreshUsersBtn').addEventListener('click', refreshOnlineUsers);

function renderOnlineUsers(users) {
    const container = document.getElementById('onlineUsersList');
    const otherUsers = users.filter(u => u.username !== currentUser);
    
    if (otherUsers.length === 0) {
        container.innerHTML = '<p class="empty">暂无其他在线用户</p>';
        return;
    }
    
    container.innerHTML = otherUsers.map(user => `
        <div class="user-item">
            <div>
                <span class="user-name">${escapeHtml(user.username)}</span>
                <span class="user-status ${user.status === '空闲' ? 'idle' : 'ingame'}">${user.status}</span>
            </div>
            <button class="invite-btn" onclick="inviteUser('${escapeHtml(user.username)}')" ${user.status !== '空闲' ? 'disabled' : ''}>
                邀请
            </button>
        </div>
    `).join('');
}

// 邀请用户
function inviteUser(username) {
    socket.emit('invitePlayer', username, (response) => {
        if (response.success) {
            alert(`已邀请 ${username}`);
        } else {
            alert(response.message);
        }
    });
}

// 收到邀请
let pendingInvite = null;
socket.on('invited', (data) => {
    pendingInvite = data;
    document.getElementById('inviteMessage').textContent = 
        `${data.from} 邀请您加入房间 "${data.roomName}"`;
    document.getElementById('inviteModal').classList.remove('hidden');
});

document.getElementById('acceptInviteBtn').addEventListener('click', () => {
    if (pendingInvite) {
        joinRoom(pendingInvite.roomId);
        pendingInvite = null;
    }
    document.getElementById('inviteModal').classList.add('hidden');
});

document.getElementById('rejectInviteBtn').addEventListener('click', () => {
    pendingInvite = null;
    document.getElementById('inviteModal').classList.add('hidden');
});

// ========== 房间功能 ==========
function enterRoom() {
    showPage('room');
    document.getElementById('roomName').textContent = currentRoom.name;
    updateRoomStatus();
    renderPlayers();
}

function updateRoomStatus() {
    const statusEl = document.getElementById('roomStatus');
    const statusMap = {
        'waiting': '等待中',
        'bidding': '叫地主中',
        'playing': '游戏中',
        'finished': '已结束'
    };
    statusEl.textContent = statusMap[currentRoom.status] || currentRoom.status;
}

function renderPlayers() {
    // 找到我的位置
    const myIndex = currentRoom.players.findIndex(p => p.username === currentUser);
    
    // 重新排列玩家座位 (我在底部)
    const seats = ['playerBottom', 'playerRight', 'playerLeft'];
    playerSeats = {};
    
    currentRoom.players.forEach((player, index) => {
        const relativeIndex = (index - myIndex + 3) % 3;
        const seatId = seats[relativeIndex];
        playerSeats[player.username] = seatId;
        
        if (seatId !== 'playerBottom') {
            updatePlayerUI(seatId, player);
        }
    });
    
    // 清空空座位
    ['playerTop', 'playerLeft', 'playerRight'].forEach(seatId => {
        if (!Object.values(playerSeats).includes(seatId)) {
            const seat = document.getElementById(seatId);
            if (seat) {
                seat.classList.add('empty');
                seat.querySelector('.player-avatar').textContent = '?';
                seat.querySelector('.player-name').textContent = '等待玩家';
                seat.querySelector('.player-status').textContent = '';
                seat.querySelector('.player-status').className = 'player-status';
                seat.querySelector('.card-count').textContent = '';
            }
        }
    });
    
    // 更新准备按钮
    updateReadyButton();
}

function updatePlayerUI(seatId, player) {
    const seat = document.getElementById(seatId);
    if (!seat) return;
    
    seat.classList.remove('empty');
    seat.querySelector('.player-avatar').textContent = player.username[0].toUpperCase();
    seat.querySelector('.player-name').textContent = player.username;
    
    const statusEl = seat.querySelector('.player-status');
    statusEl.className = 'player-status';
    if (player.ready) statusEl.classList.add('ready');
    if (player.isLandlord) statusEl.classList.add('landlord');
    statusEl.textContent = player.isLandlord ? '地主' : (player.ready ? '已准备' : '');
}

function updateReadyButton() {
    const player = currentRoom.players.find(p => p.username === currentUser);
    const readyBtn = document.getElementById('readyBtn');
    const unreadyBtn = document.getElementById('unreadyBtn');
    
    if (currentRoom.status !== 'waiting') {
        readyBtn.classList.add('hidden');
        unreadyBtn.classList.add('hidden');
        return;
    }
    
    if (player && player.ready) {
        readyBtn.classList.add('hidden');
        unreadyBtn.classList.remove('hidden');
    } else {
        readyBtn.classList.remove('hidden');
        unreadyBtn.classList.add('hidden');
    }
}

// 准备/取消准备
document.getElementById('readyBtn').addEventListener('click', () => {
    socket.emit('ready', () => {});
});

document.getElementById('unreadyBtn').addEventListener('click', () => {
    socket.emit('unready', () => {});
});

// 离开房间
document.getElementById('leaveRoomBtn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    currentRoom = null;
    myCards = [];
    selectedCards = [];
    showPage('lobby');
    refreshRooms();
});

// ========== 游戏逻辑 ==========
// 游戏开始
socket.on('gameStart', (data) => {
    myCards = data.cards;
    selectedCards = [];
    renderMyCards();
    showGameMessage('游戏开始！正在叫地主...');
    
    // 显示底牌
    const landlordCardsEl = document.getElementById('landlordCards');
    landlordCardsEl.classList.remove('hidden');
    landlordCardsEl.querySelector('.cards').innerHTML = 
        data.landlordCards.map(card => renderCardHTML(card)).join('');
});

// 叫地主开始
socket.on('bidStart', (data) => {
    showGameMessage(`轮到 ${data.currentPlayer} 叫地主`);
    if (data.currentPlayerId === socket.id) {
        document.getElementById('bidPanel').classList.remove('hidden');
    }
});

// 叫地主回合
socket.on('bidTurn', (data) => {
    showGameMessage(`轮到 ${data.currentPlayer} 叫地主` + 
        (data.currentBid > 0 ? ` (当前: ${data.bidder} ${data.currentBid}分)` : ''));
    
    const bidPanel = document.getElementById('bidPanel');
    bidPanel.classList.add('hidden');
    
    if (data.currentPlayerId === socket.id) {
        bidPanel.classList.remove('hidden');
        // 更新按钮状态
        document.querySelectorAll('.bid-btn').forEach(btn => {
            const score = parseInt(btn.dataset.score);
            btn.disabled = score > 0 && score <= data.currentBid;
        });
    }
});

// 叫地主更新
socket.on('bidUpdate', (data) => {
    const msg = data.score > 0 ? `${data.username} 叫了 ${data.score} 分` : `${data.username} 不叫`;
    showGameMessage(msg);
});

// 叫地主按钮
document.querySelectorAll('.bid-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const score = parseInt(btn.dataset.score);
        socket.emit('bid', score, () => {});
        document.getElementById('bidPanel').classList.add('hidden');
    });
});

// 叫地主结束
socket.on('biddingEnd', (data) => {
    showGameMessage(`${data.landlord} 成为地主！`);
    document.getElementById('bidPanel').classList.add('hidden');
    
    // 更新玩家地主状态
    currentRoom.players.forEach(p => {
        p.isLandlord = p.username === data.landlord;
    });
    renderPlayers();
    
    // 如果我是地主，更新手牌
    if (data.landlordId === socket.id) {
        myCards = [...myCards, ...data.landlordCards];
        myCards.sort((a, b) => a.value - b.value);
        renderMyCards();
    }
});

// 轮到我出牌
socket.on('yourTurn', (data) => {
    isMyTurn = true;
    canPass = data.canPass;
    document.getElementById('playPanel').classList.remove('hidden');
    document.getElementById('passBtn').style.display = canPass ? 'inline-block' : 'none';
    showGameMessage('轮到您出牌');
});

// 回合变更
socket.on('turnChange', (data) => {
    isMyTurn = false;
    selectedCards = [];
    renderMyCards();
    document.getElementById('playPanel').classList.add('hidden');
    
    // 更新座位高亮
    document.querySelectorAll('.player-seat').forEach(seat => {
        seat.classList.remove('current-turn');
    });
    
    const seatId = playerSeats[data.currentPlayer];
    if (seatId) {
        document.getElementById(seatId).classList.add('current-turn');
    }
});

// 出牌
socket.on('cardsPlayed', (data) => {
    const playedCardsEl = document.getElementById('playedCards');
    playedCardsEl.innerHTML = data.cards.map(card => renderCardHTML(card)).join('');
    
    // 更新玩家剩余牌数
    const player = currentRoom.players.find(p => p.username === data.username);
    if (player) {
        player.cardCount = data.remainingCards;
        const seatId = playerSeats[data.username];
        if (seatId) {
            document.querySelector(`#${seatId} .card-count`).textContent = 
                `${data.remainingCards}张`;
        }
    }
    
    showGameMessage(`${data.username} 出了 ${getCardTypeName(data.cardType)}`);
});

// 不出
socket.on('playerPassed', (data) => {
    showGameMessage(`${data.username} 不出`);
});

// 出牌按钮
document.getElementById('playCardsBtn').addEventListener('click', () => {
    if (selectedCards.length === 0) {
        alert('请选择要出的牌');
        return;
    }
    socket.emit('playCards', selectedCards, (response) => {
        if (!response.success) {
            alert(response.message);
        } else if (response.gameEnd) {
            document.getElementById('playPanel').classList.add('hidden');
        }
    });
});

// 不出按钮
document.getElementById('passBtn').addEventListener('click', () => {
    socket.emit('pass', (response) => {
        if (!response.success) {
            alert(response.message);
        }
    });
});

// 提示按钮
document.getElementById('hintBtn').addEventListener('click', () => {
    // 简单的提示：选择最小的一张牌
    if (myCards.length > 0) {
        selectedCards = [myCards[0]];
        renderMyCards();
    }
});

// 游戏结束
socket.on('gameEnd', (data) => {
    let content = '';
    
    if (data.reason === 'playerLeft') {
        content = `<p>${data.message}</p>`;
    } else {
        content = `
            <p style="font-size: 20px; margin-bottom: 20px;">
                ${data.isLandlordWin ? '👑 地主获胜！' : '👨‍🌾 农民获胜！'}
            </p>
            <div class="score-board">
                ${data.scores.map(s => `
                    <div class="score-item ${s.score > 0 ? 'winner' : ''} ${s.isLandlord ? 'landlord' : ''}">
                        <span>${escapeHtml(s.username)} ${s.isLandlord ? '(地主)' : '(农民)'}</span>
                        <span class="${s.score > 0 ? 'score-positive' : 'score-negative'}">
                            ${s.score > 0 ? '+' : ''}${s.score}
                        </span>
                    </div>
                `).join('')}
            </div>
        `;
    }
    
    document.getElementById('gameEndContent').innerHTML = content;
    document.getElementById('gameEndModal').classList.remove('hidden');
});

// 再来一局
document.getElementById('playAgainBtn').addEventListener('click', () => {
    socket.emit('playAgain');
    document.getElementById('gameEndModal').classList.add('hidden');
    document.getElementById('playedCards').innerHTML = '';
    document.getElementById('landlordCards').classList.add('hidden');
    showGameMessage('等待其他玩家准备...');
});

// 返回大厅
document.getElementById('backToLobbyBtn').addEventListener('click', () => {
    socket.emit('leaveRoom');
    currentRoom = null;
    myCards = [];
    selectedCards = [];
    document.getElementById('gameEndModal').classList.add('hidden');
    document.getElementById('playedCards').innerHTML = '';
    document.getElementById('landlordCards').classList.add('hidden');
    showPage('lobby');
    refreshRooms();
});

// 重置房间
socket.on('resetRoom', (data) => {
    currentRoom.status = 'waiting';
    currentRoom.players = data.players;
    updateRoomStatus();
    renderPlayers();
    document.getElementById('playedCards').innerHTML = '';
    document.getElementById('landlordCards').classList.add('hidden');
});

// ========== 辅助函数 ==========
function renderMyCards() {
    const container = document.getElementById('myCards');
    container.innerHTML = myCards.map((card, index) => {
        const isSelected = selectedCards.some(c => 
            c.rank === card.rank && c.suit === card.suit && c.value === card.value
        );
        const isRed = card.suit === '♥' || card.suit === '♦';
        return `
            <div class="card ${isRed ? 'red' : 'black'} ${isSelected ? 'selected' : ''}" 
                 onclick="toggleCard(${index})">
                <div class="card-top">${card.suit}${card.rank}</div>
                <div class="card-center">${card.suit || card.rank}</div>
                <div class="card-bottom">${card.suit}${card.rank}</div>
            </div>
        `;
    }).join('');
}

function toggleCard(index) {
    const card = myCards[index];
    const selectedIndex = selectedCards.findIndex(c => 
        c.rank === card.rank && c.suit === card.suit && c.value === card.value
    );
    
    if (selectedIndex === -1) {
        selectedCards.push(card);
    } else {
        selectedCards.splice(selectedIndex, 1);
    }
    renderMyCards();
}

function renderCardHTML(card) {
    const isRed = card.suit === '♥' || card.suit === '♦';
    const display = card.suit ? `${card.suit}${card.rank}` : card.rank;
    return `
        <div class="card ${isRed ? 'red' : 'black'}">
            <div class="card-top">${display}</div>
            <div class="card-center">${card.suit || '王'}</div>
            <div class="card-bottom">${display}</div>
        </div>
    `;
}

function getCardTypeName(type) {
    const names = {
        'single': '单张',
        'pair': '对子',
        'triple': '三张',
        'triple_single': '三带一',
        'bomb': '炸弹',
        'rocket': '火箭',
        'straight': '顺子',
        'double_straight': '连对'
    };
    return names[type] || type;
}

function showGameMessage(msg) {
    document.getElementById('gameMessage').textContent = msg;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ========== Socket 事件 ==========
socket.on('roomList', (rooms) => {
    if (!currentRoom) {
        renderRooms(rooms);
    }
});

socket.on('onlineUsers', (users) => {
    if (!currentRoom) {
        renderOnlineUsers(users);
    }
});

socket.on('playerJoined', (data) => {
    currentRoom.players = data.players;
    renderPlayers();
    showGameMessage(`${data.username} 加入了房间`);
});

socket.on('playerLeft', (data) => {
    currentRoom.players = data.players;
    renderPlayers();
    showGameMessage(`${data.username} 离开了房间`);
});

socket.on('playerReady', (data) => {
    currentRoom.players = data.players;
    renderPlayers();
});

socket.on('playerUnready', (data) => {
    currentRoom.players = data.players;
    renderPlayers();
});

// 重新发牌
socket.on('redeal', () => {
    showGameMessage('无人叫地主，重新发牌...');
});

// 初始加载
setInterval(() => {
    if (!currentRoom) {
        refreshRooms();
        refreshOnlineUsers();
    }
}, 5000);
