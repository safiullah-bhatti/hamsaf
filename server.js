// server.js — Kahoot-style local quiz game. One process, one port.
// Host opens http://localhost:PORT/          on the laptop
// Players open http://<laptop-lan-ip>:PORT/play  on their phones

require('dotenv').config();
const path = require('path');
const os = require('os');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenAI } = require('@google/genai');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 4321;
const QUESTION_SECONDS = 30;
const REVEAL_SECONDS = 6; // pause between questions to show correct answer + leaderboard

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ---------- In-memory game state ----------
// gameId -> game object. No DB, this is a party game — everything lives in RAM.
const games = new Map();

// Find this machine's LAN IP (the one phones on the same Wi-Fi can reach), so we can
// build a full join URL for the QR code without the user having to type/paste it.
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

function makeGameId() {
  // 5-digit numeric code, easy to type on a phone keyboard
  let id;
  do {
    id = String(Math.floor(10000 + Math.random() * 90000));
  } while (games.has(id));
  return id;
}

// ---------- Gemini question generation ----------
async function generateQuestions(topicName, maxAge, qCount) {
  const schemaHint = `
Return ONLY a JSON array (no prose, no markdown fences) with exactly ${qCount} items.
Mix the question "type" across: "single" (one correct option), "multiple" (2+ correct options),
"yesno" (exactly two options "Yes" and "No"), and "text" (short open-answer, one or two words).
Each item must match exactly one of these shapes:

{"type":"single","question":"...","options":["A","B","C","D"],"correctIndexes":[1]}
{"type":"multiple","question":"...","options":["A","B","C","D"],"correctIndexes":[0,2]}
{"type":"yesno","question":"...","options":["Yes","No"],"correctIndexes":[0]}
{"type":"text","question":"...","acceptableAnswers":["answer","alt spelling"]}

Rules:
- Topic: "${topicName}"
- Difficulty/vocabulary: suitable for someone up to age ${maxAge} (simpler wording and concepts for younger ages).
- "single"/"multiple"/"yesno" options: 2 to 4 short strings, correctIndexes are 0-based indices into "options".
- "text": acceptableAnswers should include the main answer plus close variants/synonyms, all lowercase.
- No duplicate questions. Keep each question under 140 characters.
`.trim();

  const response = await ai.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: schemaHint,
    config: { responseMimeType: 'application/json' },
  });

  const raw = response.text;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Gemini did not return valid JSON: ' + raw.slice(0, 300));
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Gemini returned no questions');
  }
  return parsed.slice(0, qCount);
}

// ---------- REST: create a game ----------
// POST /startGame  { topicName, maxAge, qCount }
app.post('/startGame', async (req, res) => {
  try {
    const { topicName, maxAge, qCount } = req.body;
    if (!topicName || !maxAge || !qCount) {
      return res.status(400).json({ error: 'topicName, maxAge and qCount are required' });
    }
    const questions = await generateQuestions(topicName, Number(maxAge), Number(qCount));

    const gameId = makeGameId();
    games.set(gameId, {
      id: gameId,
      topicName,
      maxAge: Number(maxAge),
      questions,
      state: 'lobby', // lobby -> question -> reveal -> ended
      currentIndex: -1,
      players: new Map(), // socketId -> { nickname, score }
      hostSocketId: null,
      questionStartedAt: null,
      timer: null,
    });

    const joinUrl = `http://${getLanIp()}:${PORT}/play?game=${gameId}`;
    const qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 260, margin: 1 });

    res.json({ gameId, questionCount: questions.length, joinUrl, qrDataUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to create game' });
  }
});

// ---------- Helpers ----------
function publicQuestion(q) {
  // Strip correct answers before sending to clients while a question is live
  const { type, question, options } = q;
  return { type, question, options };
}

function leaderboard(game, top = null) {
  const list = [...game.players.values()]
    .map((p) => ({ nickname: p.nickname, score: p.score }))
    .sort((a, b) => b.score - a.score);
  return top ? list.slice(0, top) : list;
}

function lobbyPlayers(game) {
  return [...game.players.values()].map((p) => p.nickname);
}

function isAnswerCorrect(q, answer) {
  if (q.type === 'single' || q.type === 'yesno') {
    return Array.isArray(answer) && answer.length === 1 && q.correctIndexes.includes(answer[0]);
  }
  if (q.type === 'multiple') {
    if (!Array.isArray(answer)) return false;
    const a = [...answer].sort().join(',');
    const b = [...q.correctIndexes].sort().join(',');
    return a === b;
  }
  if (q.type === 'text') {
    if (typeof answer !== 'string') return false;
    const norm = answer.trim().toLowerCase();
    return (q.acceptableAnswers || []).some((acc) => acc.trim().toLowerCase() === norm);
  }
  return false;
}

function scoreFor(correct, msElapsed) {
  if (!correct) return 0;
  const clamped = Math.min(Math.max(msElapsed, 0), QUESTION_SECONDS * 1000);
  const speedFraction = 1 - clamped / (QUESTION_SECONDS * 1000); // 1 = instant, 0 = used all time
  return Math.round(500 + 500 * speedFraction); // 500-1000 points
}

// ---------- Game flow ----------
function askNextQuestion(gameId) {
  const game = games.get(gameId);
  if (!game) return;

  game.currentIndex += 1;
  if (game.currentIndex >= game.questions.length) {
    game.state = 'ended';
    const full = leaderboard(game);
    io.to(gameId).emit('game-over', { leaderboard: full, winners: full.slice(0, 2) });
    return;
  }

  game.state = 'question';
  game.questionStartedAt = Date.now();
  // per-question trackers, reset each round
  game._answeredThisRound = new Set();
  game._textAnswers = new Map(); // normalized text -> { display, count }

  const q = game.questions[game.currentIndex];
  io.to(gameId).emit('question', {
    index: game.currentIndex,
    total: game.questions.length,
    seconds: QUESTION_SECONDS,
    ...publicQuestion(q),
  });

  game.timer = setTimeout(() => revealAnswer(gameId), QUESTION_SECONDS * 1000);
}

function revealAnswer(gameId) {
  const game = games.get(gameId);
  if (!game || game.state !== 'question') return;
  clearTimeout(game.timer);
  game.state = 'reveal';

  const q = game.questions[game.currentIndex];
  const correctPayload =
    q.type === 'text' ? { acceptableAnswers: q.acceptableAnswers } : { correctIndexes: q.correctIndexes };

  io.to(gameId).emit('reveal', {
    index: game.currentIndex,
    ...correctPayload,
    leaderboard: leaderboard(game, 5),
  });

  game.timer = setTimeout(() => askNextQuestion(gameId), REVEAL_SECONDS * 1000);
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  socket.on('host-join', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game) return socket.emit('error-msg', 'Game not found');
    game.hostSocketId = socket.id;
    socket.join(gameId);
    socket.emit('lobby-update', { players: lobbyPlayers(game), gameId, topicName: game.topicName });
  });

  socket.on('player-join', ({ gameId, nickname }) => {
    const game = games.get(gameId);
    if (!game) return socket.emit('join-error', 'Game code not found');
    if (game.state !== 'lobby') return socket.emit('join-error', 'Game already started');
    const clean = (nickname || '').trim().slice(0, 20);
    if (!clean) return socket.emit('join-error', 'Enter a nickname');
    const taken = [...game.players.values()].some((p) => p.nickname.toLowerCase() === clean.toLowerCase());
    if (taken) return socket.emit('join-error', 'Nickname already taken');

    game.players.set(socket.id, { nickname: clean, score: 0 });
    socket.join(gameId);
    socket.emit('joined', { gameId, nickname: clean });
    io.to(gameId).emit('lobby-update', { players: lobbyPlayers(game), gameId, topicName: game.topicName });
  });

  socket.on('start-game', ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.state !== 'lobby') return;
    if (game.players.size === 0) return socket.emit('error-msg', 'No players connected yet');
    io.to(gameId).emit('game-started');
    askNextQuestion(gameId);
  });

  socket.on('submit-answer', ({ gameId, answer }) => {
    const game = games.get(gameId);
    if (!game || game.state !== 'question') return;
    const player = game.players.get(socket.id);
    if (!player) return;
    if (game._answeredThisRound.has(socket.id)) return; // one answer per question
    game._answeredThisRound.add(socket.id);

    const q = game.questions[game.currentIndex];
    const correct = isAnswerCorrect(q, answer);
    const elapsed = Date.now() - game.questionStartedAt;
    const gained = scoreFor(correct, elapsed);
    player.score += gained;

    socket.emit('answer-received', { correct, gained, total: player.score });

    // For text questions, track what people typed (regardless of correctness) so the
    // host screen can show a live "word cloud" sized by how many people typed each answer.
    if (q.type === 'text' && typeof answer === 'string' && answer.trim()) {
      const key = answer.trim().toLowerCase();
      const entry = game._textAnswers.get(key) || { display: answer.trim(), count: 0 };
      entry.count += 1;
      game._textAnswers.set(key, entry);
      const cloud = [...game._textAnswers.values()].sort((a, b) => b.count - a.count).slice(0, 30);
      io.to(gameId).emit('text-cloud-update', { cloud });
    }

    // If everyone connected has answered, reveal early — no need to wait out the full 30s.
    if (game._answeredThisRound.size >= game.players.size) {
      revealAnswer(gameId);
    }
  });

  socket.on('disconnect', () => {
    for (const game of games.values()) {
      if (game.players.has(socket.id)) {
        game.players.delete(socket.id);
        io.to(game.id).emit('lobby-update', { players: lobbyPlayers(game), gameId: game.id, topicName: game.topicName });
      }
      if (game.hostSocketId === socket.id) game.hostSocketId = null;
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Quiz host server running:`);
  console.log(`  Host screen (this laptop): http://localhost:${PORT}/`);
  console.log(`  Player screen (phones):    http://<this-machine-LAN-IP>:${PORT}/play`);
});
