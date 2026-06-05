const express = require('express');
const path = require('path');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const app = express();
const PORT = process.env.PORT || 5000;

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

// ============= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =============
function toCamelCase(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const newObj = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    newObj[camelKey] = value;
  }
  return newObj;
}

function toSnakeCase(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const newObj = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    newObj[snakeKey] = value;
  }
  return newObj;
}

async function query(text, params) {
    const res = await pool.query(text, params);
    return res;
}

// ============= ПОЛЬЗОВАТЕЛИ =============
async function findUserBySteamId(steamId) {
    const res = await query('SELECT * FROM users WHERE steam_id = $1', [steamId]);
    return res.rows[0] ? toCamelCase(res.rows[0]) : null;
}

async function findUserById(userId) {
    const res = await query('SELECT * FROM users WHERE id = $1', [userId]);
    return res.rows[0] ? toCamelCase(res.rows[0]) : null;
}

async function createUser(userData) {
    const snakeData = toSnakeCase(userData);
    const keys = Object.keys(snakeData);
    const values = Object.values(snakeData);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const res = await query(`INSERT INTO users (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`, values);
    return toCamelCase(res.rows[0]);
}

async function updateUser(steamId, updates) {
    const snakeUpdates = toSnakeCase(updates);
    const fields = [];
    const values = [];
    let i = 1;
    for (const [key, value] of Object.entries(snakeUpdates)) {
        fields.push(`${key} = $${i}`);
        values.push(value);
        i++;
    }
    values.push(steamId);
    const res = await query(`UPDATE users SET ${fields.join(', ')} WHERE steam_id = $${i} RETURNING *`, values);
    return res.rows[0] ? toCamelCase(res.rows[0]) : null;
}

async function getAllUsers() {
    const res = await query('SELECT * FROM users ORDER BY created_at DESC');
    return res.rows.map(toCamelCase);
}

// ============= БАНЫ =============
async function isUserBanned(userId) {
    const res = await query('SELECT * FROM banned_users WHERE user_id = $1 AND (banned_until IS NULL OR banned_until > NOW())', [userId]);
    return res.rows.length > 0;
}

async function banUser(userId, reason, durationMinutes = null) {
    const bannedUntil = durationMinutes ? new Date(Date.now() + durationMinutes * 60 * 1000) : null;
    await query(`INSERT INTO banned_users (user_id, reason, banned_until) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET reason = $2, banned_until = $3`, [userId, reason, bannedUntil]);
    await query('UPDATE users SET is_banned = true WHERE id = $1', [userId]);
}

async function unbanUser(userId) {
    await query('DELETE FROM banned_users WHERE user_id = $1', [userId]);
    await query('UPDATE users SET is_banned = false WHERE id = $1', [userId]);
}

async function getAllBannedUsers() {
    const res = await query(`SELECT bu.*, u.display_name, u.steam_nickname, u.steam_avatar FROM banned_users bu JOIN users u ON bu.user_id = u.id ORDER BY bu.created_at DESC`);
    return res.rows.map(row => toCamelCase(row));
}

// ============= LFG ПОСТЫ =============
async function getActiveLfgPosts() {
    const res = await query(`
        SELECT l.*, 
               json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname, 
                                 'steamAvatar', u.steam_avatar, 'displayName', u.display_name, 
                                 'region', u.region, 'role', u.role) as author,
               COALESCE(l.team_members, '[]'::json) as team_members
        FROM lfg_posts l
        JOIN users u ON l.author_id = u.id
        WHERE l.status = 'active'
        ORDER BY l.created_at DESC
    `);
    return res.rows.map(row => toCamelCase(row));
}

async function getCompletedLfgPosts() {
    const res = await query(`
        SELECT l.*, 
               json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname, 
                                 'steamAvatar', u.steam_avatar, 'displayName', u.display_name, 
                                 'region', u.region, 'role', u.role) as author,
               COALESCE(l.team_members, '[]'::json) as team_members,
               l.review
        FROM lfg_posts l
        JOIN users u ON l.author_id = u.id
        WHERE l.status = 'completed'
        ORDER BY l.completed_at DESC
    `);
    return res.rows.map(row => toCamelCase(row));
}

async function createLfgPost(postData) {
    const { id, authorId, title, region, myRole, scheduleType, schedule, weekSchedule, 
            playersNeeded, rolesNeeded, minFaceitLevel, minPremierRank, description, language } = postData;
    
    const res = await query(`
        INSERT INTO lfg_posts (id, author_id, title, region, my_role, schedule_type, schedule, 
                               week_schedule, players_needed, roles_needed, min_faceit_level, 
                               min_premier_rank, description, language, team_members, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'active')
        RETURNING *
    `, [id, authorId, title, region, myRole, scheduleType, schedule, JSON.stringify(weekSchedule || {}),
        playersNeeded, JSON.stringify(rolesNeeded), minFaceitLevel, minPremierRank, description || '', language || 'ru',
        JSON.stringify([{ userId: authorId, name: null, avatar: null, role: myRole, isCreator: true, joinedAt: new Date().toISOString() }])]);
    
    return toCamelCase(res.rows[0]);
}

async function addResponseToLfg(postId, userId, role, message) {
    // Проверяем, не откликался ли уже
    const checkRes = await query('SELECT * FROM lfg_responses WHERE post_id = $1 AND user_id = $2 AND status = $3', 
        [postId, userId, 'pending']);
    if (checkRes.rows.length > 0) throw new Error('Вы уже откликались на эту анкету');
    
    // Проверяем, не занята ли роль
    const postRes = await query('SELECT team_members, my_role, roles_needed FROM lfg_posts WHERE id = $1 AND status = $2', 
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    
    const post = toCamelCase(postRes.rows[0]);
    const teamMembers = post.teamMembers || [];
    const rolesNeeded = post.rolesNeeded || {};
    
    if (!rolesNeeded[role]) {
        throw new Error('Эта роль не требуется в анкете');
    }
    if (teamMembers.some(m => m.role === role)) {
        throw new Error('Эта роль уже занята');
    }
    
    const res = await query(`
        INSERT INTO lfg_responses (id, post_id, user_id, role, message, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *
    `, [`resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, postId, userId, role, message || '', 'pending']);
    
    // Создаем уведомление для автора
    const postAuthor = await query('SELECT author_id FROM lfg_posts WHERE id = $1', [postId]);
    const responder = await findUserById(userId);
    await query(`
        INSERT INTO notifications (id, user_id, type, title, message, data, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [`notif_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, postAuthor.rows[0].author_id, 'lfg_response',
        'Новый отклик на анкету!', `${responder.displayName || responder.steamNickname} хочет играть на роли ${role}`, JSON.stringify({ postId, responseId: res.rows[0].id })]);
    
    return toCamelCase(res.rows[0]);
}

async function getLfgResponses(postId) {
    const res = await query(`
        SELECT r.*, 
               json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname,
                                 'steamAvatar', u.steam_avatar, 'displayName', u.display_name) as user
        FROM lfg_responses r
        JOIN users u ON r.user_id = u.id
        WHERE r.post_id = $1 AND r.status = 'pending'
        ORDER BY r.created_at ASC
    `, [postId]);
    return res.rows.map(row => toCamelCase(row));
}

async function getUnreadResponsesCount(userId) {
    const res = await query(`
        SELECT COUNT(*) FROM lfg_responses r
        JOIN lfg_posts p ON r.post_id = p.id
        WHERE p.author_id = $1 AND r.status = 'pending' AND r.read = false
    `, [userId]);
    return parseInt(res.rows[0].count);
}

async function acceptResponse(postId, responseId, authorId) {
    const postRes = await query('SELECT author_id, team_members, players_needed FROM lfg_posts WHERE id = $1 AND status = $2', 
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    
    const responseRes = await query('SELECT * FROM lfg_responses WHERE id = $1 AND post_id = $2 AND status = $3', 
        [responseId, postId, 'pending']);
    if (responseRes.rows.length === 0) throw new Error('Отклик не найден');
    
    const response = toCamelCase(responseRes.rows[0]);
    let teamMembers = postRes.rows[0].team_members || [];
    if (typeof teamMembers === 'string') teamMembers = JSON.parse(teamMembers);
    
    const userRes = await query('SELECT steam_nickname, steam_avatar, display_name FROM users WHERE id = $1', [response.userId]);
    const newMember = {
        userId: response.userId,
        name: userRes.rows[0].display_name || userRes.rows[0].steam_nickname,
        avatar: userRes.rows[0].steam_avatar,
        role: response.role,
        joinedAt: new Date().toISOString()
    };
    teamMembers.push(newMember);
    
    // Отклоняем все остальные отклики на эту роль
    await query('UPDATE lfg_responses SET status = $1 WHERE post_id = $2 AND role = $3 AND status = $4 AND id != $5', 
        ['rejected', postId, response.role, 'pending', responseId]);
    await query('UPDATE lfg_responses SET status = $1 WHERE id = $2', ['accepted', responseId]);
    await query('UPDATE lfg_posts SET team_members = $1 WHERE id = $2', [JSON.stringify(teamMembers), postId]);
    
    // Уведомление принятому игроку
    await query(`
        INSERT INTO notifications (id, user_id, type, title, message, data, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [`notif_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, response.userId, 'lfg_accepted',
        'Вас приняли в команду!', `Ваш отклик на анкету был принят.`, JSON.stringify({ postId })]);
    
    return true;
}

async function rejectResponse(postId, responseId, authorId) {
    const postRes = await query('SELECT author_id FROM lfg_posts WHERE id = $1', [postId]);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    
    await query('UPDATE lfg_responses SET status = $1 WHERE id = $2', ['rejected', responseId]);
    return true;
}

async function completeLfgPost(postId, authorId) {
    const postRes = await query('SELECT author_id, team_members, players_needed FROM lfg_posts WHERE id = $1 AND status = $2', 
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    
    let teamMembers = postRes.rows[0].team_members || [];
    if (typeof teamMembers === 'string') teamMembers = JSON.parse(teamMembers);
    
    const neededCount = postRes.rows[0].players_needed;
    if (teamMembers.length - 1 < neededCount) {
        throw new Error(`Необходимо набрать ${neededCount} игроков, набрано ${teamMembers.length - 1}`);
    }
    
    await query('UPDATE lfg_posts SET status = $1, completed_at = NOW() WHERE id = $2', ['completed', postId]);
    return true;
}

async function addReviewToLfg(postId, authorId, rating, comment) {
    const postRes = await query('SELECT author_id FROM lfg_posts WHERE id = $1 AND status = $2', [postId, 'completed']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    
    const review = { rating, comment, createdAt: new Date().toISOString() };
    await query('UPDATE lfg_posts SET review = $1 WHERE id = $2', [JSON.stringify(review), postId]);
    return true;
}

async function deleteLfgPost(postId, userId, isAdmin) {
    const postRes = await query('SELECT author_id FROM lfg_posts WHERE id = $1', [postId]);
    if (postRes.rows.length === 0) return false;
    if (postRes.rows[0].author_id !== userId && !isAdmin) return false;
    
    await query('DELETE FROM lfg_posts WHERE id = $1', [postId]);
    return true;
}

// ============= ДРУЗЬЯ =============
async function getFriends(userId) {
    const res = await query(`
        SELECT u.id, u.steam_id, u.steam_nickname, u.steam_avatar, u.display_name, u.region, u.role, u.balance, u.status, u.last_seen
        FROM users u 
        JOIN friends f ON f.friend_id = u.id 
        WHERE f.user_id = $1
    `, [userId]);
    return res.rows.map(toCamelCase);
}

async function sendFriendRequest(requestId, fromId, toId) {
    await query(`INSERT INTO friend_requests (id, from_id, to_id, status) VALUES ($1, $2, $3, 'pending')`, [requestId, fromId, toId]);
}

async function getFriendRequests(toUserId) {
    const res = await query(`
        SELECT fr.*, u.steam_nickname as from_name, u.steam_avatar as from_avatar 
        FROM friend_requests fr 
        JOIN users u ON fr.from_id = u.id 
        WHERE fr.to_id = $1 AND fr.status = 'pending'
    `, [toUserId]);
    return res.rows.map(row => toCamelCase(row));
}

async function getSentFriendRequests(fromUserId) {
    const res = await query(`
        SELECT fr.*, u.steam_nickname as to_name, u.steam_avatar as to_avatar 
        FROM friend_requests fr 
        JOIN users u ON fr.to_id = u.id 
        WHERE fr.from_id = $1 AND fr.status = 'pending'
    `, [fromUserId]);
    return res.rows.map(row => toCamelCase(row));
}

async function acceptFriendRequest(requestId, toUserId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqRes = await client.query('SELECT from_id, to_id FROM friend_requests WHERE id = $1 AND to_id = $2 AND status = $3', [requestId, toUserId, 'pending']);
        if (reqRes.rows.length === 0) throw new Error('Request not found');
        const { from_id, to_id } = reqRes.rows[0];
        await client.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2), ($2, $1)', [from_id, to_id]);
        await client.query('UPDATE friend_requests SET status = $1 WHERE id = $2', ['accepted', requestId]);
        await client.query('COMMIT');
        return true;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

async function declineFriendRequest(requestId, toUserId) {
    const res = await query(`UPDATE friend_requests SET status = 'declined' WHERE id = $1 AND to_id = $2 AND status = 'pending'`, [requestId, toUserId]);
    return res.rowCount > 0;
}

async function cancelFriendRequest(requestId, fromUserId) {
    const res = await query(`DELETE FROM friend_requests WHERE id = $1 AND from_id = $2 AND status = 'pending'`, [requestId, fromUserId]);
    return res.rowCount > 0;
}

async function removeFriend(userId, friendId) {
    await query('DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)', [userId, friendId]);
    return true;
}

// ============= СООБЩЕНИЯ =============
async function getMessages(userId, otherUserId) {
    const res = await query(`
        SELECT * FROM messages 
        WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1) 
        ORDER BY created_at ASC
    `, [userId, otherUserId]);
    return res.rows.map(toCamelCase);
}

async function createMessage(message) {
    const snakeMsg = toSnakeCase(message);
    const res = await query(`
        INSERT INTO messages (id, from_id, to_id, text, read, created_at) 
        VALUES ($1, $2, $3, $4, $5, NOW()) 
        RETURNING *
    `, [snakeMsg.id, snakeMsg.from_id, snakeMsg.to_id, snakeMsg.text, false]);
    return toCamelCase(res.rows[0]);
}

async function deleteMessage(messageId, userId) {
    await query('DELETE FROM messages WHERE id = $1 AND from_id = $2', [messageId, userId]);
    return true;
}

async function updateMessage(messageId, userId, text) {
    await query('UPDATE messages SET text = $1 WHERE id = $2 AND from_id = $3', [text, messageId, userId]);
    return true;
}

async function clearChat(userId, otherUserId) {
    await query('DELETE FROM messages WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)', [userId, otherUserId]);
    return true;
}

async function markMessagesAsRead(userId, fromUserId) {
    await query(`UPDATE messages SET read = true WHERE to_id = $1 AND from_id = $2 AND read = false`, [userId, fromUserId]);
}

async function getUnreadCount(userId) {
    const res = await query(`SELECT COUNT(*) FROM messages WHERE to_id = $1 AND read = false`, [userId]);
    return parseInt(res.rows[0].count);
}

// ============= БАЛАНС =============
async function getUserBalance(userId) {
    const res = await query('SELECT balance FROM users WHERE id = $1', [userId]);
    return res.rows[0]?.balance || 0;
}

async function updateUserBalance(userId, newBalance) {
    await query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, userId]);
}

// ============= ТУРНИРЫ =============
async function getTournaments() {
    const res = await query('SELECT * FROM tournaments ORDER BY created_at DESC');
    return res.rows.map(toCamelCase);
}

async function createTournament(tournament) {
    const snakeTour = toSnakeCase(tournament);
    const res = await query(`
        INSERT INTO tournaments (id, title, description, prize_pool, date, status, entry_fee, max_teams, format, rules, schedule, registered_teams) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
        RETURNING *
    `, [snakeTour.id, snakeTour.title, snakeTour.description, snakeTour.prize_pool, snakeTour.date, snakeTour.status, snakeTour.entry_fee, snakeTour.max_teams, snakeTour.format, snakeTour.rules, snakeTour.schedule, JSON.stringify(snakeTour.registered_teams || [])]);
    return toCamelCase(res.rows[0]);
}

// ============= ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ =============
async function initPostgresDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        steam_id TEXT UNIQUE NOT NULL,
        steam_nickname TEXT NOT NULL,
        steam_avatar TEXT,
        display_name TEXT,
        region TEXT DEFAULT 'RU',
        role TEXT DEFAULT 'RIFLER',
        has_mic BOOLEAN DEFAULT FALSE,
        bio TEXT,
        balance INTEGER DEFAULT 1000,
        is_admin BOOLEAN DEFAULT FALSE,
        is_banned BOOLEAN DEFAULT FALSE,
        status TEXT DEFAULT 'online',
        last_seen TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW(),
        settings JSONB
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS lfg_posts (
        id TEXT PRIMARY KEY,
        author_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        region TEXT NOT NULL,
        my_role TEXT NOT NULL,
        schedule_type TEXT DEFAULT 'daily',
        schedule TEXT NOT NULL,
        week_schedule JSONB,
        players_needed INTEGER DEFAULT 1,
        roles_needed JSONB NOT NULL,
        min_faceit_level INTEGER DEFAULT 1,
        min_premier_rank INTEGER DEFAULT 0,
        description TEXT,
        language TEXT DEFAULT 'ru',
        team_members JSONB DEFAULT '[]',
        status TEXT DEFAULT 'active',
        review JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS lfg_responses (
        id TEXT PRIMARY KEY,
        post_id TEXT REFERENCES lfg_posts(id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        message TEXT,
        status TEXT DEFAULT 'pending',
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        data JSONB,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS friends (
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        friend_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, friend_id)
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS friend_requests (
        id TEXT PRIMARY KEY,
        from_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        to_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        status TEXT DEFAULT 'pending'
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        to_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS tournaments (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        prize_pool TEXT,
        date TIMESTAMP,
        status TEXT DEFAULT 'UPCOMING',
        entry_fee INTEGER DEFAULT 0,
        max_teams INTEGER DEFAULT 16,
        registered_teams JSONB,
        format TEXT,
        rules TEXT,
        schedule TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS banned_users (
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        banned_until TIMESTAMP,
        reason TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id)
      )
    `);
    
    console.log('✅ PostgreSQL tables created/verified');
  } catch (err) {
    console.error('Error creating tables:', err);
  } finally {
    client.release();
  }
}

// ============= MIDDLEWARE =============
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

async function checkBanned(req, res, next) {
    const token = req.cookies.auth_token;
    if (!token) return next();
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (user && await isUserBanned(user.id)) {
            return res.status(403).json({ error: 'Your account is banned', isBanned: true });
        }
        next();
    } catch(e) { next(); }
}

// ============= STEAM AUTH =============
const STEAM_API_KEY = process.env.STEAM_API_KEY || 'B71E8712CD37B69EFF9DAE898EBDB2A3';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://barside-web.onrender.com';

app.get('/api/auth/steam', (req, res) => {
    const openIdUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(`https://barside-api.onrender.com/api/auth/steam/callback`)}&openid.realm=https://barside-api.onrender.com&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;
    res.redirect(openIdUrl);
});

app.get('/api/auth/steam/callback', async (req, res) => {
    const claimedId = req.query['openid.claimed_id'];
    if (!claimedId) return res.redirect(`${FRONTEND_URL}/?error=auth_failed`);
    const steamId = claimedId.split('/').pop();
    try {
        const apiUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`;
        const steamResponse = await axios.get(apiUrl);
        const steamUser = steamResponse.data.response?.players?.[0];
        if (!steamUser) return res.redirect(`${FRONTEND_URL}/?error=steam_api_failed`);
        
        let user = await findUserBySteamId(steamId);
        if (!user) {
            const userCountRes = await query('SELECT COUNT(*) FROM users');
            const isFirstUser = parseInt(userCountRes.rows[0].count) === 0;
            const newUser = { 
                id: `user_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, 
                steamId: steamId, 
                steamNickname: steamUser.personaname, 
                steamAvatar: steamUser.avatarfull, 
                displayName: steamUser.personaname, 
                region: 'RU', 
                role: 'RIFLER', 
                hasMic: false, 
                bio: '', 
                balance: 1000, 
                isAdmin: isFirstUser, 
                isBanned: false 
            };
            user = await createUser(newUser);
            
            const tournamentCountRes = await query('SELECT COUNT(*) FROM tournaments');
            if (parseInt(tournamentCountRes.rows[0].count) === 0) {
                await createTournament({ 
                    id: `tourn_${Date.now()}`, 
                    title: 'BARSIDE CUP #1', 
                    description: 'Главный турнир сезона', 
                    prizePool: '50000₽', 
                    date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), 
                    status: 'UPCOMING', 
                    entryFee: 500, 
                    maxTeams: 16, 
                    format: '5x5', 
                    rules: '1. Формат Best of 3\n2. Карты: Dust2, Mirage, Inferno, Nuke, Overpass', 
                    schedule: 'Групповой этап: первые выходные\nПлей-офф: следующие выходные', 
                    registeredTeams: [] 
                });
            }
        } else {
            await updateUser(steamId, { 
                steamNickname: steamUser.personaname, 
                steamAvatar: steamUser.avatarfull 
            });
            user = await findUserBySteamId(steamId);
        }
        
        const sessionToken = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steamId })).toString('base64');
        res.cookie('auth_token', sessionToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
        res.redirect(`${FRONTEND_URL}/`);
    } catch (error) {
        console.error('Steam auth error:', error.message);
        res.redirect(`${FRONTEND_URL}/?error=auth_failed`);
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.json({ data: null });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (user) {
            const banned = await isUserBanned(user.id);
            return res.json({ data: { ...user, isBanned: banned } });
        }
    } catch(e) {}
    res.json({ data: null });
});

// ============= ОНЛАЙН СЧЁТЧИК =============
const onlineSessions = new Set();
app.get('/api/online', (req, res) => { res.json({ count: onlineSessions.size }); });
app.post('/api/heartbeat', (req, res) => { const { sessionId } = req.body; if (sessionId) onlineSessions.add(sessionId); res.json({ success: true }); });

// ============= ПРОФИЛЬ =============
app.get('/api/profile/:steamId', async (req, res) => {
    try {
        const user = await findUserBySteamId(req.params.steamId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const banned = await isUserBanned(user.id);
        res.json({ user: { ...user, isBanned: banned } });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/profile/:steamId', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const currentUser = await findUserById(payload.userId);
        const targetUser = await findUserBySteamId(req.params.steamId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        const isAdmin = currentUser?.isAdmin;
        const isOwnProfile = targetUser.id === payload.userId;
        if (!isOwnProfile && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
        
        const updates = {};
        if (req.body.displayName !== undefined) updates.displayName = req.body.displayName;
        if (req.body.region !== undefined) updates.region = req.body.region;
        if (req.body.role !== undefined) updates.role = req.body.role;
        if (req.body.hasMic !== undefined) updates.hasMic = req.body.hasMic;
        if (req.body.bio !== undefined) updates.bio = req.body.bio;
        
        if (Object.keys(updates).length > 0) await updateUser(req.params.steamId, updates);
        const updatedUser = await findUserBySteamId(req.params.steamId);
        res.json({ user: updatedUser });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Баланс
app.get('/api/balance', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const balance = await getUserBalance(payload.userId);
        res.json({ balance });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/balance/topup', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const { amount } = req.body;
        const currentBalance = await getUserBalance(payload.userId);
        if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum topup is 100₽' });
        const newBalance = currentBalance + amount;
        await updateUserBalance(payload.userId, newBalance);
        res.json({ success: true, balance: newBalance });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// Статистика
app.get('/api/stats', async (req, res) => {
    try {
        const usersRes = await query('SELECT COUNT(*) FROM users');
        const lfgRes = await query("SELECT COUNT(*) FROM lfg_posts WHERE status = 'active'");
        const tournamentsRes = await query('SELECT COUNT(*) FROM tournaments');
        res.json({ 
            totalUsers: parseInt(usersRes.rows[0].count), 
            totalLfgPosts: parseInt(lfgRes.rows[0].count), 
            totalTournaments: parseInt(tournamentsRes.rows[0].count), 
            online: onlineSessions.size 
        });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= LFG МАРШРУТЫ =============
app.get('/api/lfg', async (req, res) => {
    try {
        const posts = await getActiveLfgPosts();
        res.json({ data: posts });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/lfg/completed', async (req, res) => {
    try {
        const posts = await getCompletedLfgPosts();
        res.json({ data: posts });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/lfg', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const { title, region, myRole, scheduleType, schedule, weekSchedule, playersNeeded, rolesNeeded, minFaceitLevel, minPremierRank, description, language } = req.body;
        
        if (!title || !region || !myRole) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const userPostsRes = await query("SELECT COUNT(*) FROM lfg_posts WHERE author_id = $1 AND status = 'active'", [user.id]);
        if (parseInt(userPostsRes.rows[0].count) >= 2) {
            return res.status(400).json({ error: 'Maximum 2 active posts per user' });
        }
        
        const newPost = {
            id: `lfg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            authorId: user.id,
            title,
            region,
            myRole: myRole || 'RIFLER',
            scheduleType: scheduleType || 'daily',
            schedule: schedule || '',
            weekSchedule: weekSchedule || {},
            playersNeeded: playersNeeded || 1,
            rolesNeeded: rolesNeeded || { IGL: false, AWP: false, ENTRY: false, RIFLER: false, LURKER: false },
            minFaceitLevel: minFaceitLevel || 1,
            minPremierRank: minPremierRank || 0,
            description: description || '',
            language: language || 'ru'
        };
        
        const created = await createLfgPost(newPost);
        res.status(201).json({ data: created });
    } catch (err) { 
        console.error('Error creating LFG post:', err);
        res.status(500).json({ error: 'Internal server error: ' + err.message }); 
    }
});

app.post('/api/lfg/:postId/respond', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const { role, message } = req.body;
        const response = await addResponseToLfg(req.params.postId, user.id, role, message);
        res.status(201).json({ data: response });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/lfg/:postId/responses', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const postRes = await query('SELECT author_id FROM lfg_posts WHERE id = $1', [req.params.postId]);
        if (postRes.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        if (postRes.rows[0].author_id !== user.id && !user.isAdmin) return res.status(403).json({ error: 'Forbidden' });
        
        const responses = await getLfgResponses(req.params.postId);
        res.json({ data: responses });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/lfg/:postId/responses/:responseId/accept', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        await acceptResponse(req.params.postId, req.params.responseId, user.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/lfg/:postId/responses/:responseId/reject', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        await rejectResponse(req.params.postId, req.params.responseId, user.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/lfg/:postId/complete', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        await completeLfgPost(req.params.postId, user.id);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/lfg/:postId/review', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const { rating, comment } = req.body;
        await addReviewToLfg(req.params.postId, user.id, rating, comment);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/lfg/responses/unread', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.json({ count: 0 });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const count = await getUnreadResponsesCount(payload.userId);
        res.json({ count });
    } catch (err) { res.json({ count: 0 }); }
});

app.delete('/api/lfg/:id', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        
        const deleted = await deleteLfgPost(req.params.id, user.id, user.isAdmin);
        if (!deleted) return res.status(404).json({ error: 'Post not found or forbidden' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= ДРУЗЬЯ =============
app.get('/api/friends', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const friends = await getFriends(payload.userId);
        res.json({ data: friends });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/friends/requests', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const requests = await getFriendRequests(payload.userId);
        res.json({ data: requests });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/friends/requests/sent', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const requests = await getSentFriendRequests(payload.userId);
        res.json({ data: requests });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/request/:userId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const fromUser = await findUserById(payload.userId);
        const toUser = await findUserById(req.params.userId);
        if (!fromUser || !toUser) return res.status(404).json({ error: 'User not found' });
        if (fromUser.id === req.params.userId) return res.status(400).json({ error: 'Cannot add yourself' });
        
        const existingReq = await query('SELECT * FROM friend_requests WHERE from_id = $1 AND to_id = $2 AND status = $3', [fromUser.id, req.params.userId, 'pending']);
        if (existingReq.rows.length > 0) return res.status(400).json({ error: 'Request already sent' });
        
        const existingFriend = await query('SELECT * FROM friends WHERE user_id = $1 AND friend_id = $2', [fromUser.id, req.params.userId]);
        if (existingFriend.rows.length > 0) return res.status(400).json({ error: 'Already friends' });
        
        await sendFriendRequest(`fr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, fromUser.id, req.params.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/request/:requestId/accept', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await acceptFriendRequest(req.params.requestId, payload.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/request/:requestId/decline', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await declineFriendRequest(req.params.requestId, payload.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/friends/request/:requestId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await cancelFriendRequest(req.params.requestId, payload.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/friends/:friendId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await removeFriend(payload.userId, req.params.friendId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/user/:steamId/friends', async (req, res) => {
    try {
        const user = await findUserBySteamId(req.params.steamId);
        if (!user) return res.json({ data: [] });
        const friends = await getFriends(user.id);
        res.json({ data: friends });
    } catch (err) { res.json({ data: [] }); }
});

// ============= СООБЩЕНИЯ =============
app.get('/api/messages/:userId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const messages = await getMessages(payload.userId, req.params.userId);
        await markMessagesAsRead(payload.userId, req.params.userId);
        res.json({ data: messages });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/messages/:userId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
        const newMessage = { id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, fromId: payload.userId, toId: req.params.userId, text: text.trim() };
        const created = await createMessage(newMessage);
        res.json({ success: true, message: created });
    } catch (err) { res.status(500).json({ error: 'Failed to send message' }); }
});

app.delete('/api/messages/:messageId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await deleteMessage(req.params.messageId, payload.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/messages/:messageId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const { text } = req.body;
        await updateMessage(req.params.messageId, payload.userId, text);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/messages/chat/:userId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await clearChat(payload.userId, req.params.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/messages/unread/count', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const count = await getUnreadCount(payload.userId);
        res.json({ count });
    } catch (err) { res.json({ count: 0 }); }
});

app.get('/api/user/by-id/:userId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= АДМИН МАРШРУТЫ =============
app.get('/api/admin/users', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
        const users = await getAllUsers();
        const usersWithBan = await Promise.all(users.map(async u => ({ ...u, isBanned: await isUserBanned(u.id) })));
        res.json({ data: usersWithBan });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/banned-users', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const currentUser = await findUserById(payload.userId);
    if (!currentUser?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const bannedUsers = await getAllBannedUsers();
    res.json({ data: bannedUsers });
});

app.post('/api/admin/unban/:userId', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const currentUser = await findUserById(payload.userId);
    if (!currentUser?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    await unbanUser(req.params.userId);
    res.json({ success: true });
});

app.post('/api/admin/ban', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const currentUser = await findUserById(payload.userId);
    if (!currentUser?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    const { userId, reason, durationMinutes } = req.body;
    if (!userId || !reason) return res.status(400).json({ error: 'Missing userId or reason' });
    await banUser(userId, reason, durationMinutes || null);
    res.json({ success: true });
});

app.get('/api/admin/search', checkBanned, async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
        const { query: searchTerm } = req.query;
        if (!searchTerm) return res.json({ data: [] });
        const users = await getAllUsers();
        const filtered = users.filter(u => 
            (u.displayName || '').toLowerCase().includes(searchTerm.toLowerCase()) || 
            (u.steamNickname || '').toLowerCase().includes(searchTerm.toLowerCase())
        );
        const result = await Promise.all(filtered.map(async u => ({
            ...u,
            isBanned: await isUserBanned(u.id)
        })));
        res.json({ data: result });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= ИНВЕНТАРЬ =============
app.get('/api/inventory/:steamId', async (req, res) => {
    const { steamId } = req.params;
    try {
        const inventoryUrl = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=2000`;
        const response = await axios.get(inventoryUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (response.data && response.data.success === 1) {
            const assets = response.data.assets || [];
            const descriptions = response.data.descriptions || [];
            const items = assets.map(asset => {
                const description = descriptions.find(d => d.classid === asset.classid && d.instanceid === asset.instanceid);
                return { 
                    assetid: asset.assetid, 
                    classid: asset.classid, 
                    name: description?.market_hash_name || description?.name || 'Unknown Item', 
                    icon: description?.icon_url ? `https://steamcommunity-a.akamaihd.net/economy/image/${description.icon_url}` : null, 
                    type: description?.type || 'Unknown', 
                    rarity: description?.tags?.find(t => t.category === 'Rarity')?.localized_tag_name || 'Common', 
                    tradable: description?.tradable || false, 
                    marketable: description?.marketable || false, 
                    quantity: asset.amount || 1 
                };
            });
            res.json({ success: true, total: response.data.total_inventory_count || items.length, items: items });
        } else { 
            res.json({ success: false, error: 'Inventory is private', items: [], total: 0 }); 
        }
    } catch (error) { 
        res.json({ success: false, error: 'Failed to fetch inventory', items: [], total: 0 }); 
    }
});

// ============= ТУРНИРЫ =============
app.get('/api/tournaments', async (req, res) => {
    try {
        const tournaments = await getTournaments();
        res.json({ data: tournaments });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= HEALTH CHECK =============
app.get('/healthz', (req, res) => { res.status(200).json({ status: 'ok' }); });

// ============= СТАТИКА =============
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '../public/index.html')); });

// ============= ЗАПУСК =============
async function startServer() {
    await initPostgresDB();
    app.listen(PORT, () => {
        console.log(`\n🚀 BARSIDE CS2 Server running on port ${PORT}`);
        console.log(`📍 API URL: https://barside-api.onrender.com`);
        console.log(`🐘 PostgreSQL: ${process.env.DB_HOST ? 'Connected' : 'Not configured!'}`);
    });
}
startServer().catch(console.error);