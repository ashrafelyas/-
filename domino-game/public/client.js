const socket = io();

let myName = '';
let currentRoomId = null;
let latestState = null;
let lockMode = false;

function getOrCreateToken(roomId) {
  const key = `domino_token_${roomId}`;
  let token = localStorage.getItem(key);
  if (!token) {
    token = (crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2)));
    localStorage.setItem(key, token);
  }
  return token;
}

const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');

// ---------- Lobby actions ----------

document.getElementById('create-room-btn').onclick = () => {
  myName = document.getElementById('name-input').value.trim() || 'الأدمن';
  const mode = document.getElementById('mode-select').value;
  const adminKey = document.getElementById('admin-key-input').value;
  const token = crypto.randomUUID ? crypto.randomUUID() : (Date.now() + '-' + Math.random().toString(36).slice(2));
  window.__pendingToken = token; // نحفظه بعد ما نعرف كود الغرفة من السيرفر
  socket.emit('create_room', { name: myName, mode, adminKey, token });
};

document.getElementById('join-player-btn').onclick = () => joinRoom(false);
document.getElementById('join-spectator-btn').onclick = () => joinRoom(true);

function joinRoom(asSpectator) {
  myName = document.getElementById('name-input').value.trim() || 'ضيف';
  const roomId = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (!roomId) {
    document.getElementById('lobby-error').textContent = 'اكتب كود الغرفة';
    return;
  }
  currentRoomId = roomId;
  const token = getOrCreateToken(roomId);
  socket.emit('join_room', { roomId, name: myName, asSpectator, token });
}

socket.on('room_created', ({ roomId }) => {
  currentRoomId = roomId;
  if (window.__pendingToken) {
    localStorage.setItem(`domino_token_${roomId}`, window.__pendingToken);
    window.__pendingToken = null;
  }
});

socket.on('error_msg', (msg) => {
  const el = document.getElementById('lobby-error');
  if (!gameScreen.classList.contains('hidden')) {
    showBanner(msg, true);
  } else {
    el.textContent = msg;
  }
});

// ---------- Room state rendering ----------

socket.on('room_state', (state) => {
  latestState = state;
  lobbyScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  render(state);
});

function render(state) {
  // Scoreboard (يدعم فريقين أو N أفراد)
  const scoreboardEl = document.getElementById('scoreboard');
  scoreboardEl.innerHTML = '';
  const infoBox = document.createElement('div');
  infoBox.className = 'room-info';
  infoBox.innerHTML = `<span>كود الغرفة: ${state.id}</span><span>${state.modeLabel} — مباراة ${state.matchNumber} - يد ${state.roundNumber}</span>`;

  const unitsRow = document.createElement('div');
  unitsRow.style.display = 'flex';
  unitsRow.style.gap = '10px';
  state.units.forEach((u, idx) => {
    const box = document.createElement('div');
    box.className = 'team-score ' + (idx === 0 ? 'team-a' : idx === 1 ? 'team-b' : 'team-c');
    box.innerHTML = `<span class="team-label">${u.label}</span><span class="score-num">${u.score}</span>`;
    unitsRow.appendChild(box);
  });

  if (state.units.length <= 2) {
    scoreboardEl.appendChild(unitsRow.children[0] || document.createElement('div'));
    scoreboardEl.appendChild(infoBox);
    scoreboardEl.appendChild(unitsRow.children[state.units.length - 1] || document.createElement('div'));
  } else {
    scoreboardEl.appendChild(infoBox);
    scoreboardEl.appendChild(unitsRow);
  }

  // Seats (مواقع حول محيط الطاولة حسب عدد اللاعبين)
  const SEAT_POSITIONS = {
    2: ['pos-bottom', 'pos-top'],
    3: ['pos-bottom', 'pos-top-left', 'pos-top-right'],
    4: ['pos-bottom', 'pos-right', 'pos-top', 'pos-left'],
  };
  const positions = SEAT_POSITIONS[state.playerCount] || SEAT_POSITIONS[4];
  const seatsEl = document.getElementById('seats');
  seatsEl.innerHTML = '';
  for (let i = 0; i < state.playerCount; i++) {
    const p = state.players[i];
    const seatDiv = document.createElement('div');
    seatDiv.className = 'seat ' + (positions[i] || 'pos-bottom') +
      (state.status === 'playing' && state.turn === i ? ' active' : '');
    seatDiv.innerHTML = `<div class="seat-name">${p ? p.name : '(مقعد فارغ)'}</div><div class="seat-count">${p ? state.handCounts[i] + ' قطعة' : ''}</div>`;
    seatsEl.appendChild(seatDiv);
  }

  // Board (نمط متعرّج: يلتف الصف كل عدد معيّن من القطع)
  const boardEl = document.getElementById('board');
  boardEl.innerHTML = '';
  const TILES_PER_ROW = 8;
  const tiles = state.board.map(entry => entry.display || entry.tile);
  for (let r = 0; r < tiles.length; r += TILES_PER_ROW) {
    const rowTiles = tiles.slice(r, r + TILES_PER_ROW);
    const rowIsReversed = (r / TILES_PER_ROW) % 2 === 1;
    const rowEl = document.createElement('div');
    rowEl.className = 'board-row' + (rowIsReversed ? ' reverse' : '');
    rowTiles.forEach(t => rowEl.appendChild(renderDomino(t, false)));
    boardEl.appendChild(rowEl);
  }

  // Turn indicator
  const turnEl = document.getElementById('turn-indicator');
  if (state.status === 'playing') {
    const turnName = state.players[state.turn] ? state.players[state.turn].name : '';
    turnEl.textContent = state.turn === state.mySeat ? '🎯 دورك الآن!' : `دور: ${turnName}`;
  } else if (state.status === 'choosing_starter') {
    const label = state.units[state.pendingStarterUnit] ? state.units[state.pendingStarterUnit].label : '';
    turnEl.textContent = `⏳ ${label} فاز باليد ويتشاور من يبدأ...`;
  } else {
    turnEl.textContent = '';
  }

  // My hand / reveal view
  const handEl = document.getElementById('my-hand');
  handEl.innerHTML = '';
  const revealMoment = ['round_end', 'match_end', 'tie_reveal'].includes(state.status);
  const isMyTurnNow = state.status === 'playing' && state.mySeat !== -1 && state.turn === state.mySeat;

  if (revealMoment) {
    renderUnitsReveal(handEl, state);
  } else if (state.mySeat !== -1) {
    const myHand = state.hands[state.mySeat];
    myHand.forEach((tile, idx) => {
      const playable = isMyTurnNow && isTilePlayable(state, tile);
      const d = renderDomino(tile, true);
      if (isMyTurnNow) {
        d.classList.add(playable ? 'playable' : 'not-playable');
        if (lockMode && playable) d.classList.add('lock-candidate');
      }
      d.onclick = () => {
        if (lockMode) { onLockTileClick(idx); return; }
        onTileClick(idx, tile);
      };
      handEl.appendChild(d);
    });
  } else {
    state.players.forEach((p, seat) => {
      if (!p) return;
      const wrap = document.createElement('div');
      wrap.style.margin = '6px';
      const label = document.createElement('div');
      label.style.fontSize = '12px';
      label.style.color = '#bfe7d4';
      label.textContent = p.name + ':';
      wrap.appendChild(label);
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '4px';
      row.style.flexWrap = 'wrap';
      (state.hands[seat] || []).forEach(tile => row.appendChild(renderDomino(tile, false)));
      wrap.appendChild(row);
      handEl.appendChild(wrap);
    });
  }

  // Controls
  if (!isMyTurnNow && lockMode) {
    lockMode = false;
    document.getElementById('lock-btn').textContent = 'قفلة 🔒';
  }
  document.getElementById('pass-btn').classList.toggle('hidden', !isMyTurnNow);
  document.getElementById('lock-btn').classList.toggle('hidden', !isMyTurnNow);

  const canDraw = isMyTurnNow && state.hasBoneyard && state.boneyardCount > 0 &&
    state.mySeat !== -1 && !isTilePlayableAny(state, state.hands[state.mySeat] || []);
  document.getElementById('draw-btn').classList.toggle('hidden', !canDraw);
  document.getElementById('boneyard-count').textContent = state.boneyardCount || 0;

  const canChooseStarter = state.status === 'choosing_starter' && state.mySeat !== -1 &&
    unitOfSeatClient(state, state.mySeat) === state.pendingStarterUnit;
  document.getElementById('choose-starter-btn').classList.toggle('hidden', !canChooseStarter);

  // Banner
  if (state.lastRoundInfo && state.status === 'tie_reveal') {
    showBanner('⚖️ تعادل عند قفل الطاولة — يُلغى الدور بدون نقاط، جارٍ إعادة التوزيع...', false);
  } else if (state.lastRoundInfo && (state.status === 'round_end' || state.status === 'match_end')) {
    const info = state.lastRoundInfo;
    let msg = `✅ ${info.winnerLabel} فاز باليد (${info.reason}) وحصل على ${info.points} نقطة`;
    if (info.label) msg += ` — 🏆 ${info.label}`;
    if (state.status === 'match_end') msg += ` — 🎉 ${info.winnerLabel} فاز بالمباراة كاملة!`;
    showBanner(msg, false);
  } else if (state.status === 'lobby') {
    showBanner(`بانتظار اكتمال ${state.playerCount} لاعبين... الأدمن يبدأ الجولة عند الجاهزية`, false);
  } else {
    hideBanner();
  }

  // Admin panel
  document.getElementById('admin-panel').classList.toggle('hidden', !state.amAdmin);
  document.getElementById('start-match-btn').classList.toggle('hidden', state.status !== 'lobby');
  document.getElementById('next-round-btn').classList.toggle('hidden', state.status !== 'round_end');
  document.getElementById('remove-losers-btn').classList.toggle('hidden', state.status !== 'match_end');

  // Spectators
  const specList = document.getElementById('spectator-list');
  specList.innerHTML = '';
  state.spectators.forEach(s => {
    const li = document.createElement('li');
    li.textContent = s.name + ' ';
    if (state.amAdmin) {
      const btn = document.createElement('button');
      btn.className = 'btn secondary';
      btn.style.width = 'auto';
      btn.style.padding = '2px 8px';
      btn.style.fontSize = '11px';
      btn.style.marginRight = '6px';
      btn.textContent = 'أضفه كلاعب ▶️';
      btn.onclick = () => socket.emit('promote_spectator', { targetName: s.name });
      li.appendChild(btn);
    }
    specList.appendChild(li);
  });

  // Admins
  const adminList = document.getElementById('admin-list');
  adminList.innerHTML = '';
  state.admins.forEach(name => {
    const li = document.createElement('li');
    li.textContent = '👑 ' + name;
    adminList.appendChild(li);
  });

  // History
  const historyList = document.getElementById('history-list');
  historyList.innerHTML = '';
  state.history.slice().reverse().forEach(h => {
    const li = document.createElement('li');
    const who = h.winnerLabel || 'تعادل';
    let txt = `م${h.match}/ي${h.round}: ${who} +${h.points} (${h.reason})`;
    if (h.label) txt += ` [${h.label}]`;
    li.textContent = txt;
    historyList.appendChild(li);
  });

  // Chat
  const chatList = document.getElementById('chat-list');
  const wasAtBottom = chatList.scrollTop + chatList.clientHeight >= chatList.scrollHeight - 10;
  chatList.innerHTML = '';
  (state.chatLog || []).forEach(m => {
    const li = document.createElement('li');
    const time = new Date(m.timestamp).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' });
    const nameSpan = document.createElement('span');
    nameSpan.className = 'chat-name';
    nameSpan.textContent = m.name + ':';
    const timeSpan = document.createElement('span');
    timeSpan.className = 'chat-time';
    timeSpan.textContent = time;
    li.appendChild(timeSpan);
    li.appendChild(nameSpan);
    li.appendChild(document.createTextNode(m.text));
    chatList.appendChild(li);
  });
  if (wasAtBottom) chatList.scrollTop = chatList.scrollHeight;
}

function unitOfSeatClient(state, seat) {
  return state.hasTeams ? seat % 2 : seat;
}

function isTilePlayable(state, tile) {
  if (state.board.length === 0) return true;
  return tile[0] === state.leftEnd || tile[1] === state.leftEnd ||
         tile[0] === state.rightEnd || tile[1] === state.rightEnd;
}

function isTilePlayableAny(state, hand) {
  return hand.some(t => isTilePlayable(state, t));
}

function renderUnitsReveal(container, state) {
  const lockCard = state.lastRoundInfo && state.lastRoundInfo.lockCard;
  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.gap = '16px';
  wrap.style.width = '100%';
  wrap.style.justifyContent = 'center';
  wrap.style.flexWrap = 'wrap';

  state.units.forEach((unit, uIdx) => {
    const box = document.createElement('div');
    box.style.background = '#0b2d21';
    box.style.border = '1px solid #2c6b4f';
    box.style.borderRadius = '10px';
    box.style.padding = '10px';
    box.style.minWidth = '220px';
    box.style.flex = '1';

    const title = document.createElement('div');
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '6px';
    title.style.color = uIdx === 0 ? '#f4c542' : uIdx === 1 ? '#5fc9e8' : '#c98ee8';

    let total = 0;
    unit.seats.forEach(s => {
      (state.hands[s] || []).forEach(t => {
        const val = (t[0] === 0 && t[1] === 0) ? 25 : (t[0] + t[1]);
        const isLockCard = lockCard && lockCard.seat === s && lockCard.tile[0] === t[0] && lockCard.tile[1] === t[1];
        if (!isLockCard) total += val;
      });
    });
    title.textContent = `${unit.label} — مجموع نقاط الأوراق: ${total}`;
    box.appendChild(title);

    unit.seats.forEach(seat => {
      const p = state.players[seat];
      const nameEl = document.createElement('div');
      nameEl.style.fontSize = '12px';
      nameEl.style.color = '#bfe7d4';
      nameEl.style.margin = '4px 0 2px';
      nameEl.textContent = p ? p.name : `مقعد ${seat + 1}`;
      box.appendChild(nameEl);

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '4px';
      row.style.flexWrap = 'wrap';
      (state.hands[seat] || []).forEach(tile => {
        const d = renderDomino(tile, false);
        const isLockCard = lockCard && lockCard.seat === seat && lockCard.tile[0] === tile[0] && lockCard.tile[1] === tile[1];
        if (isLockCard) {
          const holder = document.createElement('div');
          holder.style.display = 'flex';
          holder.style.flexDirection = 'column';
          holder.style.alignItems = 'center';
          const tag = document.createElement('div');
          tag.textContent = '🔒 قفلة';
          tag.style.fontSize = '10px';
          tag.style.color = '#ff9a8a';
          holder.appendChild(tag);
          holder.appendChild(d);
          row.appendChild(holder);
        } else {
          row.appendChild(d);
        }
      });
      box.appendChild(row);
    });

    wrap.appendChild(box);
  });

  container.appendChild(wrap);
}

const PIP_PATTERNS = {
  0: [],
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function renderPipHalf(value) {
  const half = document.createElement('div');
  half.className = 'half';
  const grid = document.createElement('div');
  grid.className = 'pip-grid';
  const active = PIP_PATTERNS[value] || [];
  for (let i = 0; i < 9; i++) {
    const pip = document.createElement('div');
    pip.className = 'pip' + (active.includes(i) ? ' on' : '');
    grid.appendChild(pip);
  }
  half.appendChild(grid);
  return half;
}

function renderDomino(tile, inHand) {
  const d = document.createElement('div');
  d.className = 'domino' + (inHand ? ' in-hand' : '');
  d.appendChild(renderPipHalf(tile[0]));
  d.appendChild(renderPipHalf(tile[1]));
  return d;
}

function onTileClick(idx, tile) {
  if (!latestState || latestState.status !== 'playing') return;
  if (latestState.turn !== latestState.mySeat) { showBanner('ليس دورك الآن', true); return; }
  if (!isTilePlayable(latestState, tile)) { showBanner('هذه القطعة لا تناسب طرفي الطاولة', true); return; }

  if (latestState.board.length === 0) {
    socket.emit('play_tile', { tileIndex: idx, side: 'any' });
    return;
  }
  const canLeft = tile[0] === latestState.leftEnd || tile[1] === latestState.leftEnd;
  const canRight = tile[0] === latestState.rightEnd || tile[1] === latestState.rightEnd;

  if (canLeft && canRight) {
    const side = confirm('اضغط "موافق" للعب من اليسار، أو "إلغاء" للعب من اليمين') ? 'left' : 'right';
    socket.emit('play_tile', { tileIndex: idx, side });
  } else if (canLeft) {
    socket.emit('play_tile', { tileIndex: idx, side: 'left' });
  } else if (canRight) {
    socket.emit('play_tile', { tileIndex: idx, side: 'right' });
  } else {
    showBanner('هذه القطعة لا تناسب طرفي الطاولة', true);
  }
}

document.getElementById('pass-btn').onclick = () => socket.emit('pass_turn');
document.getElementById('draw-btn').onclick = () => socket.emit('draw_tile');

document.getElementById('lock-btn').onclick = () => {
  lockMode = !lockMode;
  const btn = document.getElementById('lock-btn');
  btn.textContent = lockMode ? 'إلغاء اختيار كرت القفلة ✖️' : 'قفلة 🔒';
  if (lockMode) showBanner('اختر كرت القفلة من يدك — لن يُحسب على وحدتك، وسيبقى بيدك ظاهرًا', false);
  else hideBanner();
  render(latestState);
};

function onLockTileClick(idx) {
  socket.emit('lock_round', { tileIndex: idx });
  lockMode = false;
  document.getElementById('lock-btn').textContent = 'قفلة 🔒';
}

document.getElementById('choose-starter-btn').onclick = () => socket.emit('choose_starter');

function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat_message', { text });
  input.value = '';
}
document.getElementById('chat-send-btn').onclick = sendChat;
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

document.getElementById('start-match-btn').onclick = () => socket.emit('start_match');
document.getElementById('next-round-btn').onclick = () => socket.emit('next_round');
document.getElementById('remove-losers-btn').onclick = () => {
  if (confirm('تأكيد: سيتم إخراج الخاسر(ين) وبدء مباراة جديدة؟')) {
    socket.emit('remove_losing_team');
  }
};
document.getElementById('assign-admin-btn').onclick = () => {
  const targetName = document.getElementById('new-admin-name').value.trim();
  if (targetName) socket.emit('make_admin', { targetName });
};
document.getElementById('invite-btn').onclick = () => {
  const link = `${window.location.origin}?room=${currentRoomId}`;
  navigator.clipboard.writeText(link).then(() => {
    alert('تم نسخ رابط الدعوة، أرسله على قروب الواتساب:\n' + link);
  }).catch(() => {
    prompt('انسخ رابط الدعوة يدويًا:', link);
  });
};

function showBanner(msg, isError) {
  const b = document.getElementById('banner');
  b.textContent = msg;
  b.classList.remove('hidden');
  b.style.background = isError ? '#a3312f' : '#d4a017';
  b.style.color = isError ? '#fff' : '#1c1c1c';
}
function hideBanner() {
  document.getElementById('banner').classList.add('hidden');
}

window.addEventListener('load', () => {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (room) document.getElementById('room-code-input').value = room;
});
