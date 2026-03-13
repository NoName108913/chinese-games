// Vercel Serverless Function - HTTP 轮询版游戏服务器
const { createClient } = require('@vercel/kv');

// 内存存储（Vercel KV 作为持久化备选）
let rooms = new Map();
let users = new Map();

// CORS 头
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

module.exports = async (req, res) => {
  // 处理 CORS
  if (req.method === 'OPTIONS') {
    res.status(200).set(corsHeaders).end();
    return;
  }

  const { action } = req.query;

  try {
    switch (action) {
      case 'createRoom':
        return await createRoom(req, res);
      case 'joinRoom':
        return await joinRoom(req, res);
      case 'getRoom':
        return await getRoom(req, res);
      case 'leaveRoom':
        return await leaveRoom(req, res);
      case 'ready':
        return await playerReady(req, res);
      case 'startGame':
        return await startGame(req, res);
      case 'playCard':
        return await playCard(req, res);
      case 'getGameState':
        return await getGameState(req, res);
      case 'sendMessage':
        return await sendMessage(req, res);
      case 'listRooms':
        return await listRooms(req, res);
      default:
        return res.status(200).set(corsHeaders).json({ 
          status: 'ok', 
          message: 'Chinese Games API - HTTP Polling Version',
          time: new Date().toISOString()
        });
    }
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).set(corsHeaders).json({ 
      error: error.message 
    });
  }
};

// 生成房间ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 创建房间
async function createRoom(req, res) {
  const { roomName, username, isPrivate } = req.body || {};
  
  const roomId = generateRoomId();
  const room = {
    id: roomId,
    name: roomName || `房间 ${roomId}`,
    players: [{
      id: Date.now().toString(),
      username: username || '玩家1',
      ready: false,
      isHost: true,
      cards: [],
      isLandlord: false
    }],
    status: 'waiting',
    isPrivate: isPrivate || false,
    createdAt: Date.now(),
    gameData: null,
    messages: [],
    lastUpdate: Date.now()
  };
  
  rooms.set(roomId, room);
  
  return res.status(200).set(corsHeaders).json({
    success: true,
    roomId,
    room: sanitizeRoom(room)
  });
}

// 加入房间
async function joinRoom(req, res) {
  const { roomId, username } = req.body || {};
  
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '房间不存在'
    });
  }
  
  if (room.players.length >= 3) {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '房间已满'
    });
  }
  
  if (room.status !== 'waiting') {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '游戏已开始'
    });
  }
  
  const player = {
    id: Date.now().toString(),
    username: username || `玩家${room.players.length + 1}`,
    ready: false,
    isHost: false,
    cards: [],
    isLandlord: false
  };
  
  room.players.push(player);
  room.lastUpdate = Date.now();
  
  return res.status(200).set(corsHeaders).json({
    success: true,
    playerId: player.id,
    room: sanitizeRoom(room)
  });
}

// 获取房间信息
async function getRoom(req, res) {
  const { roomId } = req.query;
  
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '房间不存在'
    });
  }
  
  return res.status(200).set(corsHeaders).json({
    success: true,
    room: sanitizeRoom(room)
  });
}

// 离开房间
async function leaveRoom(req, res) {
  const { roomId, playerId } = req.body || {};
  
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(200).set(corsHeaders).json({ success: true });
  }
  
  room.players = room.players.filter(p => p.id !== playerId);
  
  if (room.players.length === 0) {
    rooms.delete(roomId);
  } else {
    // 如果房主离开，转让房主
    if (!room.players.some(p => p.isHost)) {
      room.players[0].isHost = true;
    }
    room.lastUpdate = Date.now();
  }
  
  return res.status(200).set(corsHeaders).json({ success: true });
}

// 玩家准备
async function playerReady(req, res) {
  const { roomId, playerId, ready } = req.body || {};
  
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '房间不存在'
    });
  }
  
  const player = room.players.find(p => p.id === playerId);
  if (player) {
    player.ready = ready;
    room.lastUpdate = Date.now();
  }
  
  return res.status(200).set(corsHeaders).json({
    success: true,
    room: sanitizeRoom(room)
  });
}

// 开始游戏
async function startGame(req, res) {
  const { roomId } = req.body || {};
  
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '房间不存在'
    });
  }
  
  if (room.players.length < 3) {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '需要3人才能开始'
    });
  }
  
  if (!room.players.every(p => p.ready)) {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '所有玩家必须准备'
    });
  }
  
  room.status = 'playing';
  room.gameData = {
    currentPlayer: 0,
    lastPlay: null,
    landlordCards: [],
    multiplier: 1
  };
  room.lastUpdate = Date.now();
  
  return res.status(200).set(corsHeaders).json({
    success: true,
    room: sanitizeRoom(room)
  });
}

// 出牌
async function playCard(req, res) {
  const { roomId, playerId, cards } = req.body || {};
  
  const room = rooms.get(roomId);
  if (!room || room.status !== 'playing') {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '游戏未开始'
    });
  }
  
  // 简化版出牌逻辑
  room.gameData.lastPlay = {
    playerId,
    cards,
    timestamp: Date.now()
  };
  
  // 切换下一个玩家
  room.gameData.currentPlayer = (room.gameData.currentPlayer + 1) % 3;
  room.lastUpdate = Date.now();
  
  return res.status(200).set(corsHeaders).json({
    success: true,
    room: sanitizeRoom(room)
  });
}

// 获取游戏状态
async function getGameState(req, res) {
  const { roomId, lastUpdate } = req.query;
  
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '房间不存在'
    });
  }
  
  // 如果数据有更新，返回完整数据
  if (!lastUpdate || room.lastUpdate > parseInt(lastUpdate)) {
    return res.status(200).set(corsHeaders).json({
      success: true,
      hasUpdate: true,
      room: sanitizeRoom(room)
    });
  }
  
  // 数据未更新，返回空响应（减少流量）
  return res.status(200).set(corsHeaders).json({
    success: true,
    hasUpdate: false
  });
}

// 发送消息
async function sendMessage(req, res) {
  const { roomId, playerId, message } = req.body || {};
  
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(200).set(corsHeaders).json({
      success: false,
      message: '房间不存在'
    });
  }
  
  const player = room.players.find(p => p.id === playerId);
  room.messages.push({
    id: Date.now().toString(),
    username: player?.username || '未知',
    message,
    timestamp: Date.now()
  });
  
  // 只保留最近 50 条消息
  if (room.messages.length > 50) {
    room.messages = room.messages.slice(-50);
  }
  
  room.lastUpdate = Date.now();
  
  return res.status(200).set(corsHeaders).json({
    success: true
  });
}

// 房间列表
async function listRooms(req, res) {
  const roomList = [];
  for (const [id, room] of rooms) {
    if (!room.isPrivate && room.status === 'waiting') {
      roomList.push(sanitizeRoom(room));
    }
  }
  
  return res.status(200).set(corsHeaders).json({
    success: true,
    rooms: roomList
  });
}

// 清理敏感数据
function sanitizeRoom(room) {
  return {
    id: room.id,
    name: room.name,
    players: room.players.map(p => ({
      id: p.id,
      username: p.username,
      ready: p.ready,
      isHost: p.isHost,
      cardCount: p.cards?.length || 0,
      isLandlord: p.isLandlord
    })),
    status: room.status,
    isPrivate: room.isPrivate,
    playerCount: room.players.length,
    gameData: room.status === 'playing' ? {
      currentPlayer: room.gameData?.currentPlayer,
      lastPlay: room.gameData?.lastPlay
    } : null,
    messages: room.messages?.slice(-10) || [],
    lastUpdate: room.lastUpdate
  };
}
