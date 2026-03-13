const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 静态文件服务
app.use(express.static(path.join(__dirname, '../public')));

// 游戏数据存储
const users = new Map();        // 用户列表: socket.id -> {id, username, roomId}
const rooms = new Map();        // 房间列表: roomId -> room对象
const allUsernames = new Set(); // 所有已注册的用户名

// 扑克牌相关
const SUITS = ['♠', '♥', '♣', '♦'];
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SPECIAL = ['小王', '大王'];

// 创建一副牌
function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANKS.indexOf(rank) });
    }
  }
  // 大小王
  deck.push({ suit: '', rank: '小王', value: 13 });
  deck.push({ suit: '', rank: '大王', value: 14 });
  return deck;
}

// 洗牌
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// 发牌
function dealCards() {
  const deck = shuffle(createDeck());
  return {
    players: [
      deck.slice(0, 17),
      deck.slice(17, 34),
      deck.slice(34, 51)
    ],
    landlordCards: deck.slice(51, 54)
  };
}

// 获取房间列表（排除满员和游戏中的房间）
function getAvailableRooms() {
  const list = [];
  for (const [roomId, room] of rooms) {
    if (room.players.length < 3 && room.status === 'waiting') {
      list.push({
        id: roomId,
        name: room.name,
        playerCount: room.players.length,
        host: room.host
      });
    }
  }
  return list;
}

// 获取在线用户列表
function getOnlineUsers() {
  const list = [];
  for (const [socketId, user] of users) {
    list.push({
      username: user.username,
      roomId: user.roomId,
      status: user.roomId ? '游戏中' : '空闲'
    });
  }
  return list;
}

// Socket.io 连接处理
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);

  // 注册用户
  socket.on('register', (username, callback) => {
    if (!username || username.trim().length === 0) {
      callback({ success: false, message: '用户名不能为空' });
      return;
    }
    if (username.length > 12) {
      callback({ success: false, message: '用户名不能超过12个字符' });
      return;
    }
    if (allUsernames.has(username)) {
      callback({ success: false, message: '该用户名已被注册' });
      return;
    }

    allUsernames.add(username);
    users.set(socket.id, { id: socket.id, username, roomId: null });
    
    console.log(`用户注册成功: ${username}`);
    callback({ success: true, message: '注册成功' });
    
    // 广播在线用户列表更新
    io.emit('onlineUsers', getOnlineUsers());
  });

  // 获取房间列表
  socket.on('getRooms', (callback) => {
    callback(getAvailableRooms());
  });

  // 获取在线用户
  socket.on('getOnlineUsers', (callback) => {
    callback(getOnlineUsers());
  });

  // 创建房间
  socket.on('createRoom', (roomName, callback) => {
    const user = users.get(socket.id);
    if (!user) {
      callback({ success: false, message: '请先注册' });
      return;
    }
    if (user.roomId) {
      callback({ success: false, message: '您已在房间中' });
      return;
    }

    const roomId = crypto.randomUUID().substring(0, 8);
    const room = {
      id: roomId,
      name: roomName || `${user.username}的房间`,
      host: user.username,
      players: [{ id: socket.id, username: user.username, ready: false, isLandlord: false }],
      status: 'waiting',
      currentPlayer: null,
      landlord: null,
      lastPlay: null,
      landlordCards: [],
      scores: {}
    };

    rooms.set(roomId, room);
    user.roomId = roomId;
    socket.join(roomId);

    console.log(`房间创建: ${roomId} by ${user.username}`);
    callback({ success: true, roomId, room });
    io.emit('roomList', getAvailableRooms());
  });

  // 加入房间
  socket.on('joinRoom', (roomId, callback) => {
    const user = users.get(socket.id);
    if (!user) {
      callback({ success: false, message: '请先注册' });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      callback({ success: false, message: '房间不存在' });
      return;
    }
    if (room.players.length >= 3) {
      callback({ success: false, message: '房间已满' });
      return;
    }
    if (room.status !== 'waiting') {
      callback({ success: false, message: '房间正在游戏中' });
      return;
    }
    if (user.roomId) {
      callback({ success: false, message: '您已在其他房间中' });
      return;
    }

    room.players.push({ id: socket.id, username: user.username, ready: false, isLandlord: false });
    user.roomId = roomId;
    socket.join(roomId);

    console.log(`${user.username} 加入房间: ${roomId}`);
    callback({ success: true, room });
    
    // 通知房间其他玩家
    socket.to(roomId).emit('playerJoined', { username: user.username, players: room.players });
    io.emit('roomList', getAvailableRooms());
  });

  // 邀请玩家
  socket.on('invitePlayer', (targetUsername, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) {
      callback({ success: false, message: '您不在房间中' });
      return;
    }

    const room = rooms.get(user.roomId);
    if (!room) {
      callback({ success: false, message: '房间不存在' });
      return;
    }

    // 找到目标用户的socket
    let targetSocket = null;
    for (const [sid, u] of users) {
      if (u.username === targetUsername) {
        targetSocket = sid;
        break;
      }
    }

    if (!targetSocket) {
      callback({ success: false, message: '该用户不在线' });
      return;
    }

    if (users.get(targetSocket).roomId) {
      callback({ success: false, message: '该用户已在其他房间中' });
      return;
    }

    // 发送邀请
    io.to(targetSocket).emit('invited', {
      from: user.username,
      roomId: room.id,
      roomName: room.name
    });

    callback({ success: true, message: '邀请已发送' });
  });

  // 准备游戏
  socket.on('ready', (callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return;

    const room = rooms.get(user.roomId);
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.ready = true;
      io.to(room.id).emit('playerReady', { username: user.username, players: room.players });
      
      // 检查是否所有玩家都准备好了
      if (room.players.length === 3 && room.players.every(p => p.ready)) {
        startGame(room);
      }
    }
    callback({ success: true });
  });

  // 取消准备
  socket.on('unready', (callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return;

    const room = rooms.get(user.roomId);
    const player = room.players.find(p => p.id === socket.id);
    if (player && room.status === 'waiting') {
      player.ready = false;
      io.to(room.id).emit('playerUnready', { username: user.username, players: room.players });
    }
    callback({ success: true });
  });

  // 开始游戏
  function startGame(room) {
    room.status = 'bidding';
    const deal = dealCards();
    room.landlordCards = deal.landlordCards;

    // 给每个玩家发牌
    room.players.forEach((player, index) => {
      player.cards = deal.players[index];
      player.cards.sort((a, b) => a.value - b.value);
      player.cardCount = 17;
      io.to(player.id).emit('gameStart', {
        cards: player.cards,
        landlordCards: room.landlordCards,
        players: room.players.map(p => ({ username: p.username, cardCount: p.cardCount }))
      });
    });

    // 随机选择第一个叫地主的人
    room.currentBidder = Math.floor(Math.random() * 3);
    room.bidRound = 0;
    room.currentBid = 0;
    room.landlordCandidate = null;
    
    const currentPlayer = room.players[room.currentBidder];
    io.to(room.id).emit('bidStart', {
      currentPlayer: currentPlayer.username,
      currentPlayerId: currentPlayer.id,
      minBid: 1
    });
  }

  // 叫地主
  socket.on('bid', (score, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return;

    const room = rooms.get(user.roomId);
    if (room.status !== 'bidding') return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.currentBidder) {
      callback({ success: false, message: '不是您的回合' });
      return;
    }

    if (score > 0) {
      room.currentBid = score;
      room.landlordCandidate = playerIndex;
    }

    room.bidRound++;

    // 检查叫地主是否结束
    if (room.bidRound >= 3) {
      if (room.currentBid > 0) {
        // 确定地主
        finishBidding(room);
      } else {
        // 重新发牌
        io.to(room.id).emit('redeal');
        setTimeout(() => startGame(room), 2000);
      }
    } else {
      // 下一个玩家
      room.currentBidder = (room.currentBidder + 1) % 3;
      const nextPlayer = room.players[room.currentBidder];
      io.to(room.id).emit('bidTurn', {
        currentPlayer: nextPlayer.username,
        currentPlayerId: nextPlayer.id,
        minBid: room.currentBid + 1,
        currentBid: room.currentBid,
        bidder: room.landlordCandidate !== null ? room.players[room.landlordCandidate].username : null
      });
    }

    callback({ success: true });
    io.to(room.id).emit('bidUpdate', { username: user.username, score });
  });

  // 结束叫地主阶段
  function finishBidding(room) {
    room.status = 'playing';
    room.landlord = room.landlordCandidate;
    const landlord = room.players[room.landlord];
    landlord.isLandlord = true;
    
    // 地主获得底牌
    landlord.cards = [...landlord.cards, ...room.landlordCards];
    landlord.cards.sort((a, b) => a.value - b.value);
    landlord.cardCount = 20;

    room.currentPlayer = room.landlord;
    room.lastPlay = null;

    // 通知所有玩家
    room.players.forEach(player => {
      io.to(player.id).emit('biddingEnd', {
        landlord: landlord.username,
        landlordId: landlord.id,
        landlordCards: room.landlordCards,
        players: room.players.map(p => ({
          username: p.username,
          isLandlord: p.isLandlord,
          cardCount: p.cardCount
        }))
      });
    });

    // 通知地主出牌
    io.to(landlord.id).emit('yourTurn', { canPass: false });
    io.to(room.id).emit('turnChange', { currentPlayer: landlord.username, currentPlayerId: landlord.id });
  }

  // 出牌
  socket.on('playCards', (cards, callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return;

    const room = rooms.get(user.roomId);
    if (room.status !== 'playing') return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.currentPlayer) {
      callback({ success: false, message: '不是您的回合' });
      return;
    }

    const player = room.players[playerIndex];

    // 验证牌型
    const validation = validatePlay(cards, room.lastPlay);
    if (!validation.valid) {
      callback({ success: false, message: validation.message });
      return;
    }

    // 从玩家手牌中移除
    for (const card of cards) {
      const idx = player.cards.findIndex(c => 
        c.rank === card.rank && c.suit === card.suit && c.value === card.value
      );
      if (idx === -1) {
        callback({ success: false, message: '手牌中没有这些牌' });
        return;
      }
      player.cards.splice(idx, 1);
    }

    player.cardCount = player.cards.length;
    room.lastPlay = { cards, player: user.username, type: validation.type };

    // 广播出牌
    io.to(room.id).emit('cardsPlayed', {
      username: user.username,
      playerId: socket.id,
      cards: cards,
      cardType: validation.type,
      remainingCards: player.cardCount
    });

    // 检查游戏是否结束
    if (player.cards.length === 0) {
      endGame(room, playerIndex);
      callback({ success: true, gameEnd: true });
      return;
    }

    // 下一个玩家
    room.currentPlayer = (room.currentPlayer + 1) % 3;
    const nextPlayer = room.players[room.currentPlayer];
    const canPass = room.lastPlay.player !== nextPlayer.username;

    io.to(nextPlayer.id).emit('yourTurn', { canPass });
    io.to(room.id).emit('turnChange', { 
      currentPlayer: nextPlayer.username, 
      currentPlayerId: nextPlayer.id 
    });

    callback({ success: true });
  });

  // 不出
  socket.on('pass', (callback) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return;

    const room = rooms.get(user.roomId);
    if (room.status !== 'playing') return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.currentPlayer) {
      callback({ success: false, message: '不是您的回合' });
      return;
    }

    // 检查是否必须出牌（上一轮是自己出的或没有人出过）
    if (!room.lastPlay || room.lastPlay.player === user.username) {
      callback({ success: false, message: '您必须出牌' });
      return;
    }

    io.to(room.id).emit('playerPassed', { username: user.username });

    // 下一个玩家
    room.currentPlayer = (room.currentPlayer + 1) % 3;
    const nextPlayer = room.players[room.currentPlayer];
    
    // 如果所有人都pass了，清空lastPlay
    const lastPlayPlayer = room.players.find(p => p.username === room.lastPlay.player);
    if (room.currentPlayer === room.players.indexOf(lastPlayPlayer)) {
      room.lastPlay = null;
    }

    const canPass = room.lastPlay && room.lastPlay.player !== nextPlayer.username;
    io.to(nextPlayer.id).emit('yourTurn', { canPass: canPass || false });
    io.to(room.id).emit('turnChange', { 
      currentPlayer: nextPlayer.username, 
      currentPlayerId: nextPlayer.id 
    });

    callback({ success: true });
  });

  // 游戏结束
  function endGame(room, winnerIndex) {
    room.status = 'finished';
    const winner = room.players[winnerIndex];
    const isLandlordWin = winner.isLandlord;

    // 计算分数
    const baseScore = room.currentBid || 1;
    const multiplier = room.lastPlay && room.lastPlay.type === 'rocket' ? 2 : 1;
    const finalScore = baseScore * multiplier;

    room.players.forEach(player => {
      if (isLandlordWin) {
        player.score = player.isLandlord ? finalScore * 2 : -finalScore;
      } else {
        player.score = player.isLandlord ? -finalScore * 2 : finalScore;
      }
    });

    io.to(room.id).emit('gameEnd', {
      winner: winner.username,
      isLandlordWin,
      scores: room.players.map(p => ({
        username: p.username,
        isLandlord: p.isLandlord,
        score: p.score,
        remainingCards: p.cards
      }))
    });
  }

  // 再来一局
  socket.on('playAgain', () => {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return;

    const room = rooms.get(user.roomId);
    if (!room) return;

    // 重置房间状态
    room.status = 'waiting';
    room.players.forEach(p => {
      p.ready = false;
      p.isLandlord = false;
      p.cards = [];
      p.cardCount = 0;
    });
    room.currentPlayer = null;
    room.landlord = null;
    room.lastPlay = null;
    room.currentBid = 0;
    room.landlordCandidate = null;

    io.to(room.id).emit('resetRoom', { players: room.players });
    io.emit('roomList', getAvailableRooms());
  });

  // 离开房间
  socket.on('leaveRoom', () => {
    handleLeaveRoom(socket);
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log('用户断开连接:', socket.id);
    handleLeaveRoom(socket);
    
    const user = users.get(socket.id);
    if (user) {
      allUsernames.delete(user.username);
      users.delete(socket.id);
      io.emit('onlineUsers', getOnlineUsers());
    }
  });

  // 处理离开房间
  function handleLeaveRoom(socket) {
    const user = users.get(socket.id);
    if (!user || !user.roomId) return;

    const room = rooms.get(user.roomId);
    if (!room) return;

    // 从房间移除玩家
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(room.id);
    user.roomId = null;

    if (room.players.length === 0) {
      // 房间空了，删除房间
      rooms.delete(room.id);
    } else {
      // 通知其他玩家
      socket.to(room.id).emit('playerLeft', { username: user.username, players: room.players });
      
      // 如果游戏正在进行，结束游戏
      if (room.status !== 'waiting') {
        room.status = 'finished';
        io.to(room.id).emit('gameEnd', {
          reason: 'playerLeft',
          message: `${user.username} 离开了游戏`,
          players: room.players
        });
      }
    }

    io.emit('roomList', getAvailableRooms());
  }
});

// 牌型验证
function validatePlay(cards, lastPlay) {
  if (!cards || cards.length === 0) {
    return { valid: false, message: '请出牌' };
  }

  const type = getCardType(cards);
  if (!type) {
    return { valid: false, message: '无效的牌型' };
  }

  // 如果没有上家出牌，任何有效牌型都可以出
  if (!lastPlay) {
    return { valid: true, type: type.name };
  }

  // 炸弹和火箭可以压任何牌（除了火箭）
  if (type.name === 'rocket') {
    return { valid: true, type: type.name };
  }
  if (type.name === 'bomb' && lastPlay.type !== 'rocket') {
    return { valid: true, type: type.name };
  }

  // 牌型必须相同
  if (type.name !== lastPlay.type && lastPlay.type !== 'rocket' && lastPlay.type !== 'bomb') {
    return { valid: false, message: '牌型不匹配' };
  }

  // 比较大小
  if (type.value > lastPlay.cards[0].value) {
    return { valid: true, type: type.name };
  }

  return { valid: false, message: '牌太小' };
}

// 获取牌型
function getCardType(cards) {
  const count = cards.length;
  const values = cards.map(c => c.value).sort((a, b) => a - b);

  // 单张
  if (count === 1) {
    return { name: 'single', value: values[0] };
  }

  // 火箭（大小王）
  if (count === 2 && values[0] === 13 && values[1] === 14) {
    return { name: 'rocket', value: 100 };
  }

  // 对子
  if (count === 2 && values[0] === values[1]) {
    return { name: 'pair', value: values[0] };
  }

  // 三张
  if (count === 3 && values[0] === values[2]) {
    return { name: 'triple', value: values[0] };
  }

  // 三带一
  if (count === 4) {
    if (values[0] === values[2] || values[1] === values[3]) {
      return { name: 'triple_single', value: values[1] };
    }
  }

  // 炸弹
  if (count === 4 && values[0] === values[3]) {
    return { name: 'bomb', value: values[0] };
  }

  // 顺子（5张以上连续）
  if (count >= 5) {
    let isStraight = true;
    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i-1] + 1) {
        isStraight = false;
        break;
      }
    }
    if (isStraight && values[values.length - 1] < 12) { // 2不能参与顺子
      return { name: 'straight', value: values[0] };
    }
  }

  // 连对
  if (count >= 6 && count % 2 === 0) {
    let isDoubleStraight = true;
    for (let i = 0; i < values.length; i += 2) {
      if (values[i] !== values[i+1] || (i > 0 && values[i] !== values[i-1] + 1)) {
        isDoubleStraight = false;
        break;
      }
    }
    if (isDoubleStraight && values[values.length - 1] < 12) {
      return { name: 'double_straight', value: values[0] };
    }
  }

  // 飞机 (三带一的连续)
  if (count >= 6 && count % 4 === 0) {
    // 简化处理，暂不实现完整飞机检测
  }

  return null;
}

const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`斗地主服务器运行在 http://${HOST}:${PORT}`);
});
