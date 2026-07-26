const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- إعدادات أوضاع اللعب ----------
// teams : 4 لاعبين / فريقين (2+2) / 7 قطع لكل لاعب / بدون سحب
// solo2 : لاعبان فرديان / 7 قطع لكل لاعب / الباقي (14) يُسحب منه
// solo3 : 3 لاعبين فرديين / 9 قطع لكل لاعب / تُستبعد البلاطة صفر-صفر (27 قطعة بالضبط)
const MODE_CONFIG = {
  teams: { playerCount: 4, handSize: 7, hasBoneyard: false, hasTeams: true, excludeBlank: false, label: 'أربعة لاعبين (فريقين)' },
  solo2: { playerCount: 2, handSize: 7, hasBoneyard: true, hasTeams: false, excludeBlank: false, label: 'لاعبان (فردي + سحب)' },
  solo3: { playerCount: 3, handSize: 9, hasBoneyard: false, hasTeams: false, excludeBlank: true, label: 'ثلاثة لاعبين (فردي)' },
};

// ---------- دومينو: أدوات مساعدة ----------

function buildTileSet() {
  const tiles = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) tiles.push([i, j]);
  }
  return tiles; // 28 قطعة
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function tileValue(t) {
  if (t[0] === 0 && t[1] === 0) return 25; // البلاطة (صفر/صفر) تحسب 25
  return t[0] + t[1];
}

function handValue(hand) {
  return hand.reduce((s, t) => s + tileValue(t), 0);
}

// قيمة يد اللاعب بعد استبعاد "كرت القفلة" الخاص به إن وُجد (يُعتبر أنه لُعب فعليًا رغم بقائه في يده)
function effectiveHandValue(room, seat, lockCard) {
  const base = handValue(room.hands[seat]);
  if (lockCard && lockCard.seat === seat) return base - tileValue(lockCard.tile);
  return base;
}

function dealTiles(room) {
  const cfg = MODE_CONFIG[room.mode];
  let tileSet = buildTileSet();
  if (cfg.excludeBlank) tileSet = tileSet.filter(t => !(t[0] === 0 && t[1] === 0));
  const shuffled = shuffle(tileSet);
  const hands = Array.from({ length: cfg.playerCount }, () => []);
  let idx = 0;
  for (let s = 0; s < cfg.playerCount; s++) {
    for (let k = 0; k < cfg.handSize; k++) hands[s].push(shuffled[idx++]);
  }
  const boneyard = cfg.hasBoneyard ? shuffled.slice(idx) : [];
  return { hands, boneyard };
}

function starterByDouble(hands) {
  // صاحب الدبل الأعلى يبدأ إلزاميًا (أول توزيع بالمباراة، وبعد تعادل القفل)
  for (let d = 6; d >= 0; d--) {
    for (let s = 0; s < hands.length; s++) {
      if (hands[s].some(t => t[0] === d && t[1] === d)) return s;
    }
  }
  return 0;
}

// كل رقم (0-6) يظهر في 7 قطع بالضبط داخل مجموعة الـ28 (ما عدا وضع استبعاد البلاطة صفر-صفر لرقم صفر تحديدًا)
function tilesForDigit(d) {
  const list = [];
  for (let i = 0; i <= 6; i++) {
    const a = Math.min(i, d), b = Math.max(i, d);
    if (!list.some(t => t[0] === a && t[1] === b)) list.push([a, b]);
  }
  return list;
}

// رقم "ميت" = كل القطع التي تحتويه (من ضمن المجموعة الفعلية المستخدمة بهذا الوضع) أصبحت على الطاولة
function isDigitDead(room, digit) {
  if (digit === null) return false;
  let tiles = tilesForDigit(digit);
  if (MODE_CONFIG[room.mode].excludeBlank) {
    tiles = tiles.filter(t => !(t[0] === 0 && t[1] === 0));
  }
  return tiles.every(t => room.board.some(entry => entry.tile[0] === t[0] && entry.tile[1] === t[1]));
}

function isBoardFullyDead(room) {
  return room.board.length > 0 && isDigitDead(room, room.leftEnd) && isDigitDead(room, room.rightEnd);
}

// ---------- تجريد الفرق/الأفراد (وحدات تسجيل النقاط) ----------

function numUnits(room) {
  return MODE_CONFIG[room.mode].hasTeams ? 2 : room.playerCount;
}

function unitOfSeat(room, seat) {
  return MODE_CONFIG[room.mode].hasTeams ? seat % 2 : seat;
}

function unitSeats(room, unit) {
  return MODE_CONFIG[room.mode].hasTeams ? [unit, unit + 2] : [unit];
}

function unitHandValue(room, unit, lockCard) {
  return unitSeats(room, unit).reduce((s, seat) => s + effectiveHandValue(room, seat, lockCard), 0);
}

function unitLabel(room, unit) {
  if (MODE_CONFIG[room.mode].hasTeams) return unit === 0 ? 'فريق A' : 'فريق B';
  const p = room.players[unit];
  return p ? p.name : `لاعب ${unit + 1}`;
}

// ---------- إدارة الغرف ----------

const rooms = new Map();

function newRoom(adminSocketId, adminName, mode) {
  mode = MODE_CONFIG[mode] ? mode : 'teams';
  const cfg = MODE_CONFIG[mode];
  const id = nanoid(6).toUpperCase();
  const room = {
    id,
    mode,
    playerCount: cfg.playerCount,
    createdAt: Date.now(),
    admins: new Set([adminSocketId]),
    players: new Array(cfg.playerCount).fill(null),
    spectators: [],
    hands: Array.from({ length: cfg.playerCount }, () => []),
    boneyard: [],
    board: [],
    leftEnd: null,
    rightEnd: null,
    turn: 0,
    passStreak: 0,
    status: 'lobby', // lobby | playing | round_end | match_end | choosing_starter | tie_reveal
    scores: new Array(cfg.hasTeams ? 2 : cfg.playerCount).fill(0),
    matchNumber: 1,
    roundNumber: 0,
    history: [],
    lastRoundInfo: null,
    pendingStarterUnit: null,
    chatLog: [], // {name, text, timestamp} - محادثة نصية فقط، لا تسجيل صوت
  };
  room.players[0] = { socketId: adminSocketId, name: adminName };
  rooms.set(id, room);
  persistRoom(room);
  return room;
}

function persistRoom(room) {
  const file = path.join(DATA_DIR, `room_${room.id}.json`);
  const savable = {
    id: room.id,
    mode: room.mode,
    createdAt: room.createdAt,
    history: room.history,
    scores: room.scores,
    matchNumber: room.matchNumber,
  };
  fs.writeFile(file, JSON.stringify(savable, null, 2), () => {});
}

function findSeatBySocket(room, socketId) {
  return room.players.findIndex(p => p && p.socketId === socketId);
}

function isAdmin(room, socketId) {
  return room.admins.has(socketId);
}

// عرض مخصص لكل مشاهد: اللاعب يرى يده فقط (والباقي كعدد قطع)، المتفرج ولحظات الكشف يرى الكل
function buildViewFor(room, socketId) {
  const seat = findSeatBySocket(room, socketId);
  const isSpectator = seat === -1;
  const revealAll = isSpectator || ['round_end', 'match_end', 'tie_reveal'].includes(room.status);
  const hands = room.hands.map((h, idx) => {
    if (revealAll) return h;
    if (idx === seat) return h;
    return new Array(h.length).fill(null);
  });

  const cfg = MODE_CONFIG[room.mode];
  const unitsCount = numUnits(room);
  const units = [];
  for (let u = 0; u < unitsCount; u++) {
    units.push({ label: unitLabel(room, u), score: room.scores[u], seats: unitSeats(room, u) });
  }

  return {
    id: room.id,
    mode: room.mode,
    modeLabel: cfg.label,
    playerCount: room.playerCount,
    hasTeams: cfg.hasTeams,
    hasBoneyard: cfg.hasBoneyard,
    boneyardCount: room.boneyard.length,
    status: room.status,
    players: room.players.map(p => p ? { name: p.name } : null),
    spectators: room.spectators.map(s => ({ name: s.name })),
    hands,
    handCounts: room.hands.map(h => h.length),
    board: room.board,
    leftEnd: room.leftEnd,
    rightEnd: room.rightEnd,
    turn: room.turn,
    units,
    matchNumber: room.matchNumber,
    roundNumber: room.roundNumber,
    mySeat: seat,
    amAdmin: isAdmin(room, socketId),
    pendingStarterUnit: room.pendingStarterUnit,
    admins: [...room.admins].map(sid => {
      const p = room.players.find(pl => pl && pl.socketId === sid);
      const s = room.spectators.find(sp => sp.socketId === sid);
      return p ? p.name : (s ? s.name : 'مجهول');
    }),
    history: room.history,
    lastRoundInfo: room.lastRoundInfo,
    chatLog: room.chatLog,
  };
}

function broadcastRoom(room) {
  const allSockets = [
    ...room.players.filter(Boolean).map(p => p.socketId),
    ...room.spectators.map(s => s.socketId),
  ];
  allSockets.forEach(sid => {
    io.to(sid).emit('room_state', buildViewFor(room, sid));
  });
}

// ---------- منطق اللعب ----------

function validMoves(hand, leftEnd, rightEnd, boardEmpty) {
  if (boardEmpty) return hand.map((_, i) => ({ index: i, side: 'any' }));
  const moves = [];
  hand.forEach((t, i) => {
    if (t[0] === leftEnd || t[1] === leftEnd) moves.push({ index: i, side: 'left' });
    if (t[0] === rightEnd || t[1] === rightEnd) moves.push({ index: i, side: 'right' });
  });
  return moves;
}

function applyMove(room, seat, tileIndex, side) {
  const hand = room.hands[seat];
  const tile = hand[tileIndex];
  if (!tile) return false;
  const boardEmpty = room.board.length === 0;

  if (boardEmpty) {
    room.board.push({ tile, seat });
    room.leftEnd = tile[0];
    room.rightEnd = tile[1];
  } else if (side === 'left') {
    if (tile[0] === room.leftEnd) { room.leftEnd = tile[1]; }
    else if (tile[1] === room.leftEnd) { room.leftEnd = tile[0]; }
    else return false;
    room.board.unshift({ tile, seat });
  } else if (side === 'right') {
    if (tile[0] === room.rightEnd) { room.rightEnd = tile[1]; }
    else if (tile[1] === room.rightEnd) { room.rightEnd = tile[0]; }
    else return false;
    room.board.push({ tile, seat });
  } else {
    return false;
  }
  hand.splice(tileIndex, 1);
  room.passStreak = 0;
  return true;
}

function endRound(room, winningUnit, reason, lockCard) {
  const total = numUnits(room);
  let points = 0;
  for (let u = 0; u < total; u++) {
    if (u === winningUnit) continue;
    points += unitHandValue(room, u, lockCard);
  }

  room.scores[winningUnit] += points;
  room.roundNumber += 1;

  const info = {
    match: room.matchNumber,
    round: room.roundNumber,
    winningTeam: winningUnit, // اسم الحقل قديم لأسباب التوافق، لكنه يمثل "الوحدة الفائزة" (فريق أو فرد)
    winnerLabel: unitLabel(room, winningUnit),
    points,
    reason,
    scoreAfter: [...room.scores],
    timestamp: Date.now(),
  };
  if (lockCard) info.lockCard = lockCard;

  const othersAllZero = Array.from({ length: total }, (_, u) => u)
    .filter(u => u !== winningUnit)
    .every(u => room.scores[u] === 0);
  if (room.scores[winningUnit] >= 101 && othersAllZero) {
    info.label = 'صايمة / كرتا';
  }

  room.history.push(info);
  room.lastRoundInfo = info;
  room.status = 'round_end';

  if (room.scores[winningUnit] >= 101) {
    room.status = 'match_end';
    info.matchWinner = winningUnit;
  }

  persistRoom(room);
  return info;
}

function redealSameMatch(room) {
  // إعادة توزيع بعد تعادل عند القفل: صاحب الدبل الأعلى يبدأ إلزاميًا دائمًا هنا
  const { hands, boneyard } = dealTiles(room);
  room.hands = hands;
  room.boneyard = boneyard;
  room.board = [];
  room.leftEnd = null;
  room.rightEnd = null;
  room.turn = starterByDouble(hands);
  room.passStreak = 0;
  room.status = 'playing';
  room.pendingStarterUnit = null;
}

function handleBlockedTable(room, lockCard) {
  const total = numUnits(room);
  const values = [];
  for (let u = 0; u < total; u++) values.push(unitHandValue(room, u, lockCard));
  const minVal = Math.min(...values);
  const winners = [];
  for (let u = 0; u < total; u++) if (values[u] === minVal) winners.push(u);

  if (winners.length > 1) {
    // تعادل بين وحدتين أو أكثر: يُلغى الدور، لا نقاط لأحد، تُكشف الأوراق لحظيًا ثم تُعاد القسمة
    room.roundNumber += 1;
    const info = {
      match: room.matchNumber,
      round: room.roundNumber,
      winningTeam: null,
      points: 0,
      reason: 'تعادل عند القفل - يُلغى الدور',
      scoreAfter: [...room.scores],
      timestamp: Date.now(),
    };
    if (lockCard) info.lockCard = lockCard;
    room.history.push(info);
    room.lastRoundInfo = info;
    room.status = 'tie_reveal';
    persistRoom(room);
    broadcastRoom(room);
    setTimeout(() => {
      if (rooms.get(room.id) === room && room.status === 'tie_reveal') {
        redealSameMatch(room);
        broadcastRoom(room);
      }
    }, 4000);
    return;
  }

  endRound(room, winners[0], lockCard ? 'قفلة' : 'الطاولة مقفولة', lockCard);
}

function checkAutoPassOrEnd(room) {
  // هذه السلسلة التلقائية تُستخدم فقط في الأوضاع التي لا تحتوي على "حوض سحب"
  // (في وضع السحب solo2 يجب على اللاعب التفاعل يدويًا: سحب أو تمرير)
  if (MODE_CONFIG[room.mode].hasBoneyard) return;
  let guard = 0;
  while (guard < 12) {
    guard++;
    const seat = room.turn;
    const boardEmpty = room.board.length === 0;
    const moves = validMoves(room.hands[seat], room.leftEnd, room.rightEnd, boardEmpty);
    if (moves.length > 0) return;
    room.passStreak += 1;
    if (room.passStreak >= room.playerCount) {
      handleBlockedTable(room);
      return;
    }
    room.turn = (room.turn + 1) % room.playerCount;
  }
}

// ---------- Socket.IO ----------

io.on('connection', (socket) => {

  socket.on('create_room', ({ name, mode }) => {
    const room = newRoom(socket.id, name || 'الأدمن', mode);
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.emit('room_created', { roomId: room.id });
    broadcastRoom(room);
  });

  socket.on('join_room', ({ roomId, name, asSpectator }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) { socket.emit('error_msg', 'الغرفة غير موجودة'); return; }
    socket.join(room.id);
    socket.data.roomId = room.id;

    if (!asSpectator) {
      const emptySeat = room.players.findIndex(p => !p);
      if (emptySeat === -1) {
        room.spectators.push({ socketId: socket.id, name: name || 'مشاهد' });
      } else {
        room.players[emptySeat] = { socketId: socket.id, name: name || `لاعب ${emptySeat + 1}` };
      }
    } else {
      room.spectators.push({ socketId: socket.id, name: name || 'مشاهد' });
    }
    broadcastRoom(room);
  });

  socket.on('make_admin', ({ targetName }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !isAdmin(room, socket.id)) return;
    const target = [...room.players.filter(Boolean), ...room.spectators]
      .find(p => p.name === targetName);
    if (target) {
      room.admins.add(target.socketId);
      broadcastRoom(room);
    }
  });

  socket.on('start_match', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !isAdmin(room, socket.id)) return;
    if (room.players.filter(Boolean).length < room.playerCount) {
      socket.emit('error_msg', `يجب اكتمال ${room.playerCount} لاعبين قبل البدء`);
      return;
    }
    const { hands, boneyard } = dealTiles(room);
    room.hands = hands;
    room.boneyard = boneyard;
    room.board = [];
    room.leftEnd = null;
    room.rightEnd = null;
    room.turn = starterByDouble(hands);
    room.passStreak = 0;
    room.status = 'playing';
    room.pendingStarterUnit = null;
    broadcastRoom(room);
  });

  socket.on('play_tile', ({ tileIndex, side }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'playing') return;
    const seat = findSeatBySocket(room, socket.id);
    if (seat === -1 || seat !== room.turn) return;

    const ok = applyMove(room, seat, tileIndex, side);
    if (!ok) { socket.emit('error_msg', 'حركة غير صالحة'); return; }

    if (room.hands[seat].length === 0) {
      endRound(room, unitOfSeat(room, seat), 'إنهاء اليد');
      broadcastRoom(room);
      return;
    }

    if (isBoardFullyDead(room)) {
      handleBlockedTable(room);
      broadcastRoom(room);
      return;
    }

    room.turn = (room.turn + 1) % room.playerCount;
    checkAutoPassOrEnd(room);
    broadcastRoom(room);
  });

  socket.on('draw_tile', () => {
    // خاص بوضع اللاعبين الاثنين: من ليس لديه كرت يصلح يسحب من الحوض حتى يجد ما يلعبه
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'playing' || !MODE_CONFIG[room.mode].hasBoneyard) return;
    const seat = findSeatBySocket(room, socket.id);
    if (seat === -1 || seat !== room.turn) return;

    const boardEmpty = room.board.length === 0;
    const currentMoves = validMoves(room.hands[seat], room.leftEnd, room.rightEnd, boardEmpty);
    if (currentMoves.length > 0) { socket.emit('error_msg', 'لديك حركة متاحة، لا يمكنك السحب'); return; }
    if (room.boneyard.length === 0) { socket.emit('error_msg', 'الحوض فارغ، لا يمكن السحب'); return; }

    const drawn = room.boneyard.pop();
    room.hands[seat].push(drawn);
    broadcastRoom(room);
  });

  socket.on('lock_round', ({ tileIndex }) => {
    // اللاعب يختار كرت "قفلة": يُعتبر كأنه لُعب فعليًا (يُستبعد من حساب فريقه/نتيجته)
    // لكنه يبقى ماديًا في يده حتى الكشف عند نهاية الدور
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'playing') return;
    const seat = findSeatBySocket(room, socket.id);
    if (seat === -1 || seat !== room.turn) return;

    const hand = room.hands[seat];
    const tile = hand[tileIndex];
    if (!tile) { socket.emit('error_msg', 'قطعة غير موجودة'); return; }
    if (room.board.length === 0) { socket.emit('error_msg', 'لا يمكن إعلان القفلة على طاولة فارغة'); return; }

    const canLeft = tile[0] === room.leftEnd || tile[1] === room.leftEnd;
    const canRight = tile[0] === room.rightEnd || tile[1] === room.rightEnd;
    if (!canLeft && !canRight) {
      socket.emit('error_msg', 'هذه القطعة لا تناسب طرفي الطاولة، لا يمكن اعتبارها كرت قفلة');
      return;
    }

    const wouldLock = (side) => {
      let newLeft = room.leftEnd, newRight = room.rightEnd;
      if (side === 'left') newLeft = (tile[0] === room.leftEnd) ? tile[1] : tile[0];
      else newRight = (tile[0] === room.rightEnd) ? tile[1] : tile[0];
      const simulatedBoard = room.board.concat([{ tile }]);
      const deadSim = (digit) => {
        let ts = tilesForDigit(digit);
        if (MODE_CONFIG[room.mode].excludeBlank) ts = ts.filter(t => !(t[0] === 0 && t[1] === 0));
        return ts.every(t => simulatedBoard.some(e => e.tile[0] === t[0] && e.tile[1] === t[1]));
      };
      return deadSim(newLeft) && deadSim(newRight);
    };
    const locks = (canLeft && wouldLock('left')) || (canRight && wouldLock('right'));
    if (!locks) {
      socket.emit('error_msg', 'هذه القطعة لا تسبب قفل الطاولة فعليًا، لا يمكن اعتبارها كرت قفلة');
      return;
    }

    handleBlockedTable(room, { seat, tile });
    broadcastRoom(room);
  });

  socket.on('pass_turn', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'playing') return;
    const seat = findSeatBySocket(room, socket.id);
    if (seat === -1 || seat !== room.turn) return;

    const boardEmpty = room.board.length === 0;
    const moves = validMoves(room.hands[seat], room.leftEnd, room.rightEnd, boardEmpty);
    if (moves.length > 0) { socket.emit('error_msg', 'لديك حركة متاحة، لا يمكنك التمرير'); return; }
    if (MODE_CONFIG[room.mode].hasBoneyard && room.boneyard.length > 0) {
      socket.emit('error_msg', 'يجب السحب من الحوض أولًا قبل التمرير'); return;
    }

    room.passStreak += 1;
    if (room.passStreak >= room.playerCount) {
      handleBlockedTable(room);
    } else {
      room.turn = (room.turn + 1) % room.playerCount;
      checkAutoPassOrEnd(room);
    }
    broadcastRoom(room);
  });

  socket.on('next_round', () => {
    // بعد فوز وحدة (فريق أو فرد) باليد السابقة: تُعاد القسمة، والوحدة الفائزة تبدأ (تتشاور إن كانت فريقًا)
    const room = rooms.get(socket.data.roomId);
    if (!room || !isAdmin(room, socket.id)) return;
    if (room.status !== 'round_end') return;
    const winningUnit = room.lastRoundInfo ? room.lastRoundInfo.winningTeam : null;
    const { hands, boneyard } = dealTiles(room);
    room.hands = hands;
    room.boneyard = boneyard;
    room.board = [];
    room.leftEnd = null;
    room.rightEnd = null;
    room.passStreak = 0;
    room.turn = null;

    if (winningUnit === null) {
      room.turn = starterByDouble(hands);
      room.status = 'playing';
      room.pendingStarterUnit = null;
    } else if (MODE_CONFIG[room.mode].hasTeams) {
      room.status = 'choosing_starter';
      room.pendingStarterUnit = winningUnit;
    } else {
      // فردي: الفائز نفسه يبدأ مباشرة بأي كرت، بدون حاجة لتشاور
      room.turn = winningUnit;
      room.status = 'playing';
      room.pendingStarterUnit = null;
    }
    broadcastRoom(room);
  });

  socket.on('choose_starter', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.status !== 'choosing_starter') return;
    const seat = findSeatBySocket(room, socket.id);
    const isPlayerChoice = seat !== -1 && unitOfSeat(room, seat) === room.pendingStarterUnit;
    if (!isPlayerChoice) { socket.emit('error_msg', 'فقط أحد لاعبي الفريق الفائز يمكنه بدء الدور'); return; }
    room.turn = seat;
    room.status = 'playing';
    room.pendingStarterUnit = null;
    broadcastRoom(room);
  });

  socket.on('remove_losing_team', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !isAdmin(room, socket.id)) return;
    if (room.status !== 'match_end') return;
    const winningUnit = room.lastRoundInfo.matchWinner;
    if (MODE_CONFIG[room.mode].hasTeams) {
      const losingUnit = winningUnit === 0 ? 1 : 0;
      unitSeats(room, losingUnit).forEach(seat => { room.players[seat] = null; });
    } else {
      // فردي: يخرج كل من خسر (كل الوحدات عدا الفائزة)
      for (let s = 0; s < room.playerCount; s++) {
        if (s !== winningUnit) room.players[s] = null;
      }
    }
    room.scores = new Array(room.scores.length).fill(0);
    room.matchNumber += 1;
    room.roundNumber = 0;
    room.status = 'lobby';
    room.board = [];
    room.hands = Array.from({ length: room.playerCount }, () => []);
    room.boneyard = [];
    persistRoom(room);
    broadcastRoom(room);
  });

  socket.on('chat_message', ({ text }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const cleanText = (text || '').toString().trim().slice(0, 500);
    if (!cleanText) return;

    const seat = findSeatBySocket(room, socket.id);
    let senderName = 'مجهول';
    if (seat !== -1) senderName = room.players[seat].name;
    else {
      const spec = room.spectators.find(s => s.socketId === socket.id);
      if (spec) senderName = spec.name;
    }

    room.chatLog.push({ name: senderName, text: cleanText, timestamp: Date.now() });
    if (room.chatLog.length > 200) room.chatLog.shift(); // نحتفظ بآخر 200 رسالة فقط
    broadcastRoom(room);
  });

  socket.on('leave_room', () => cleanupSocket(socket));
  socket.on('disconnect', () => cleanupSocket(socket));

  function cleanupSocket(socket) {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const seat = findSeatBySocket(room, socket.id);
    if (seat !== -1) room.players[seat] = null;
    room.spectators = room.spectators.filter(s => s.socketId !== socket.id);
    room.admins.delete(socket.id);
    if (room.admins.size === 0 && room.players.some(Boolean)) {
      const firstSeat = room.players.find(Boolean);
      if (firstSeat) room.admins.add(firstSeat.socketId);
    }
    broadcastRoom(room);
  }
});

server.listen(PORT, () => {
  console.log(`Domino server running on port ${PORT}`);
});
