const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

const demo = process.argv.includes('--demo');
const dataDir = path.join(__dirname, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(process.env.LOST_FOUND_DB || path.join(dataDir, demo ? 'demo.sqlite' : 'app.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    salt TEXT NOT NULL, hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL, category TEXT NOT NULL, location TEXT NOT NULL,
    description TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('found', 'lost')),
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), proof TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
    UNIQUE(item_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS handovers (
    item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
    claim_id INTEGER NOT NULL UNIQUE REFERENCES claims(id) ON DELETE CASCADE,
    meeting_note TEXT NOT NULL
  );
`);

function createUser(name, email, password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  const row = db.prepare('INSERT INTO users(name, email, salt, hash) VALUES (?, ?, ?, ?) RETURNING id, name, email');
  return row.get(name, email, salt, hash);
}

const app = express();
const sessions = new Map();
const sessionAge = 24 * 60 * 60 * 1000;
const categories = ['Электроника', 'Документы и канцтовары', 'Ключи', 'Одежда', 'Другое'];
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Ожидается запрос JSON.' });
  }
  const cookie = (req.headers.cookie || '').match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/);
  req.token = cookie?.[1];
  const session = sessions.get(req.token);
  if (session && session.expires > Date.now()) req.user = session.user;
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Войдите в аккаунт.' });
  next();
}

function startSession(req, res, user) {
  sessions.delete(req.token);
  for (const [token, session] of sessions) {
    if (session.expires <= Date.now()) sessions.delete(token);
  }
  const token = randomBytes(32).toString('hex');
  const profile = { id: user.id, name: user.name, email: user.email };
  sessions.set(token, { user: profile, expires: Date.now() + sessionAge });
  res.cookie('session', token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: sessionAge });
  return profile;
}

function field(body, name) {
  return typeof body?.[name] === 'string' ? body[name].trim() : '';
}

app.get('/api/session', (req, res) => res.json({ user: req.user || null, demo }));

app.post('/api/register', (req, res) => {
  const name = field(req.body, 'name');
  const email = field(req.body, 'email').toLowerCase();
  const password = req.body?.password;
  if (name.length < 2 || name.length > 60 || email.length > 120 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Проверьте имя, почту и пароль (от 8 до 128 символов).' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Аккаунт с такой почтой уже есть.' });
  }
  res.status(201).json({ user: startSession(req, res, createUser(name, email, password)) });
});

app.post('/api/login', (req, res) => {
  const email = field(req.body, 'email').toLowerCase();
  const password = req.body?.password;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || typeof password !== 'string' || password.length > 128 ||
      !timingSafeEqual(Buffer.from(user.hash, 'hex'), scryptSync(password, user.salt, 64))) {
    return res.status(401).json({ error: 'Неверная почта или пароль.' });
  }
  res.json({ user: startSession(req, res, user) });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(req.token);
  res.clearCookie('session');
  res.json({ user: null });
});

app.get('/api/items', (req, res) => {
  const items = db.prepare(`
    SELECT i.*, u.name AS author, h.item_id IS NOT NULL AS has_handover,
      EXISTS(SELECT 1 FROM claims c WHERE c.item_id = i.id AND c.user_id = ?) AS has_claim
    FROM items i JOIN users u ON i.author_id = u.id
    LEFT JOIN handovers h ON h.item_id = i.id ORDER BY i.id DESC
  `).all(req.user?.id || 0);
  res.json({ items: items.map(({ has_handover, ...item }) => ({
    ...item, status: item.status === 'open' && has_handover ? 'awaiting_handover' : item.status
  })) });
});

function itemData(req, res, next) {
  const fields = ['title', 'category', 'location', 'description', 'kind'];
  req.itemData = fields.map(name => field(req.body, name));
  const [title, category, location, description, kind] = req.itemData;
  if (title.length < 3 || title.length > 80 || !categories.includes(category) ||
      location.length < 2 || location.length > 100 || description.length < 10 || description.length > 500 ||
      !['found', 'lost'].includes(kind)) {
    return res.status(400).json({ error: 'Заполните название, категорию, место и описание (10–500 символов).' });
  }
  next();
}

const findItem = db.prepare(`
  SELECT i.*, h.item_id IS NOT NULL AS has_handover
  FROM items i LEFT JOIN handovers h ON h.item_id = i.id WHERE i.id = ?
`);

function ownOpenItem(req, res, next) {
  const item = findItem.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Объявление не найдено.' });
  if (item.author_id !== req.user.id) return res.status(403).json({ error: 'Изменить объявление может только автор.' });
  if (item.status !== 'open' || item.has_handover) {
    return res.status(409).json({ error: 'Объявление закрыто или ожидает передачи.' });
  }
  next();
}

app.post('/api/items', requireUser, itemData, (req, res) => {
  const item = db.prepare(`
    INSERT INTO items(author_id, title, category, location, description, kind)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING *
  `).get(req.user.id, ...req.itemData);
  res.status(201).json({ item });
});

app.patch('/api/items/:id', requireUser, ownOpenItem, itemData, (req, res) => {
  const item = db.prepare(`
    UPDATE items SET title = ?, category = ?, location = ?, description = ?, kind = ?
    WHERE id = ? RETURNING *
  `).get(...req.itemData, req.params.id);
  res.json({ item });
});

app.delete('/api/items/:id', requireUser, ownOpenItem, (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

app.get('/api/claims', requireUser, (req, res) => {
  const claims = db.prepare(`
    SELECT c.*, i.title, i.author_id, i.kind, u.name AS claimant,
      h.meeting_note, i.status AS item_status
    FROM claims c JOIN items i ON c.item_id = i.id JOIN users u ON c.user_id = u.id
    LEFT JOIN handovers h ON h.claim_id = c.id
    WHERE c.user_id = ? OR i.author_id = ? ORDER BY c.id DESC
  `).all(req.user.id, req.user.id);
  res.json({ claims });
});

app.post('/api/items/:id/claims', requireUser, (req, res) => {
  const item = findItem.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Объявление не найдено.' });
  if (item.author_id === req.user.id) return res.status(403).json({ error: 'Это ваше объявление.' });
  if (item.status !== 'open' || item.has_handover) {
    return res.status(409).json({ error: 'Объявление закрыто или ожидает передачи.' });
  }
  const proof = field(req.body, 'proof');
  if (proof.length < 10 || proof.length > 500) {
    return res.status(400).json({ error: 'Опишите отличительные признаки или где находится вещь (10–500 символов).' });
  }
  const claim = db.prepare(`
    INSERT INTO claims(item_id, user_id, proof) VALUES (?, ?, ?)
    ON CONFLICT(item_id, user_id) DO NOTHING RETURNING id
  `).get(item.id, req.user.id, proof);
  if (!claim) return res.status(409).json({ error: 'Вы уже отправляли заявку на это объявление.' });
  res.status(201).json({ claim });
});

app.patch('/api/claims/:id', requireUser, (req, res) => {
  const status = field(req.body, 'status');
  if (!['accepted', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Выберите подтверждение или отклонение.' });
  }
  const claim = db.prepare(`
    SELECT c.*, i.author_id, i.status AS item_status
    FROM claims c JOIN items i ON c.item_id = i.id WHERE c.id = ?
  `).get(req.params.id);
  if (!claim) return res.status(404).json({ error: 'Заявка не найдена.' });
  if (claim.author_id !== req.user.id) return res.status(403).json({ error: 'Решение принимает автор объявления.' });
  if (claim.status !== 'pending' || claim.item_status !== 'open') {
    return res.status(409).json({ error: 'Эта заявка уже рассмотрена.' });
  }

  const meetingNote = field(req.body, 'meeting_note');
  if (status === 'accepted' && (meetingNote.length < 5 || meetingNote.length > 500)) {
    return res.status(400).json({ error: 'Укажите место и время встречи (5–500 символов).' });
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(status, claim.id);
    if (status === 'accepted') {
      db.prepare("UPDATE claims SET status = 'rejected' WHERE item_id = ? AND status = 'pending'").run(claim.item_id);
      db.prepare('INSERT INTO handovers(item_id, claim_id, meeting_note) VALUES (?, ?, ?)')
        .run(claim.item_id, claim.id, meetingNote);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  res.json({ status });
});

app.patch('/api/claims/:id/received', requireUser, (req, res) => {
  const handover = db.prepare(`
    SELECT i.id AS item_id, i.status,
      CASE WHEN i.kind = 'found' THEN c.user_id ELSE i.author_id END AS recipient_id
    FROM handovers h JOIN items i ON h.item_id = i.id
    JOIN claims c ON h.claim_id = c.id WHERE h.claim_id = ?
  `).get(req.params.id);
  if (!handover) return res.status(404).json({ error: 'Передача не найдена.' });
  if (handover.recipient_id !== req.user.id) {
    return res.status(403).json({ error: 'Подтвердить получение может только получатель вещи.' });
  }
  const result = db.prepare("UPDATE items SET status = 'closed' WHERE id = ? AND status = 'open'")
    .run(handover.item_id);
  if (!result.changes) return res.status(409).json({ error: 'Получение уже подтверждено.' });
  res.json({ status: 'closed' });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не найден.' }));
app.use((error, req, res, next) => {
  if (error.status === 400 || error.status === 413) {
    return res.status(error.status).json({ error: 'Проверьте формат и размер запроса.' });
  }
  console.error(error);
  res.status(500).json({ error: 'Ошибка сервера. Повторите попытку.' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '127.0.0.1', () => console.log('Lost & Found: http://127.0.0.1:' + port));
