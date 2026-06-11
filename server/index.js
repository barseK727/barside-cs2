const express = require('express');
const path = require('path');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const app = express();
const PORT = process.env.PORT || 5000;
const { v4: uuidv4 } = require('uuid');
const { YooKassa } = require('@webzaytsev/yookassa-ts-sdk');

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }
});

// Инициализация ЮKassa
let yooKassa = null;
if (process.env.YKASSA_SHOP_ID && process.env.YKASSA_SECRET_KEY) {
    yooKassa = new YooKassa({
        shopId: process.env.YKASSA_SHOP_ID,
        secretKey: process.env.YKASSA_SECRET_KEY
    });
    console.log('✅ ЮKassa initialized');
} else {
    console.log('⚠️ ЮKassa not configured - payments disabled');
}

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
    const { id, steam_id, steam_nickname, steam_avatar, display_name, region, role, has_mic, bio, balance, is_admin, is_banned } = userData;
    const res = await query(`
        INSERT INTO users (id, steam_id, steam_nickname, steam_avatar, display_name, region, role, has_mic, bio, balance, is_admin, is_banned, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
        RETURNING *
    `, [id, steam_id, steam_nickname, steam_avatar, display_name, region, role, has_mic, bio, balance, is_admin, is_banned]);
    return toCamelCase(res.rows[0]);
}

async function updateUser(steamId, updates) {
    const fields = [];
    const values = [];
    let i = 1;
    for (const [key, value] of Object.entries(updates)) {
        const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        fields.push(`${dbKey} = $${i}`);
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

// ============= LFG ПОСТЫ =============
async function getActiveLfgPosts() {
    const res = await query(`
        SELECT l.*, 
               json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname, 
                                 'steamAvatar', u.steam_avatar, 'displayName', u.display_name, 
                                 'region', u.region, 'role', u.role) as author
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
                               min_premier_rank, description, language, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active', NOW())
        RETURNING *
    `, [id, authorId, title, region, myRole, scheduleType, schedule, JSON.stringify(weekSchedule || {}),
        playersNeeded, JSON.stringify(rolesNeeded), minFaceitLevel || 1, minPremierRank || 0, description || '', language || 'ru']);
    
    return toCamelCase(res.rows[0]);
}

async function addResponseToLfg(postId, userId, role, message) {
    const checkRes = await query('SELECT * FROM lfg_responses WHERE post_id = $1 AND user_id = $2 AND status = $3', 
        [postId, userId, 'pending']);
    if (checkRes.rows.length > 0) throw new Error('Вы уже откликались на эту анкету');
    
    const postRes = await query('SELECT author_id, players_needed FROM lfg_posts WHERE id = $1 AND status = $2', 
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    
    const res = await query(`
        INSERT INTO lfg_responses (id, post_id, user_id, role, message, status, created_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
        RETURNING *
    `, [`resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, postId, userId, role, message || '']);
    
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

async function acceptResponse(postId, responseId, authorId) {
    const postRes = await query('SELECT author_id FROM lfg_posts WHERE id = $1', [postId]);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    
    const responseRes = await query('SELECT role FROM lfg_responses WHERE id = $1', [responseId]);
    if (responseRes.rows.length === 0) throw new Error('Отклик не найден');
    const role = responseRes.rows[0].role;
    
    await query('UPDATE lfg_responses SET status = $1 WHERE post_id = $2 AND role = $3 AND status = $4', 
        ['rejected', postId, role, 'pending']);
    await query('UPDATE lfg_responses SET status = $1 WHERE id = $2', ['accepted', responseId]);
    
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
    const postRes = await query('SELECT author_id, players_needed FROM lfg_posts WHERE id = $1 AND status = $2', 
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    
    const acceptedResponses = await query('SELECT COUNT(*) FROM lfg_responses WHERE post_id = $1 AND status = $2', 
        [postId, 'accepted']);
    
    const neededCount = postRes.rows[0].players_needed;
    if (parseInt(acceptedResponses.rows[0].count) < neededCount) {
        throw new Error(`Необходимо принять ${neededCount} игроков`);
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
        SELECT u.id, u.steam_id, u.steam_nickname, u.steam_avatar, u.display_name, u.region, u.role, u.balance
        FROM users u 
        JOIN friends f ON f.friend_id = u.id 
        WHERE f.user_id = $1
    `, [userId]);
    return res.rows.map(toCamelCase);
}

async function sendFriendRequest(requestId, fromId, toId) {
    await query(`INSERT INTO friend_requests (id, from_id, to_id, status, created_at) VALUES ($1, $2, $3, 'pending', NOW())`, [requestId, fromId, toId]);
}

async function getFriendRequests(toUserId) {
    const res = await query(`
        SELECT fr.*, u.steam_nickname as from_name, u.steam_avatar as from_avatar 
        FROM friend_requests fr 
        JOIN users u ON fr.from_id = u.id 
        WHERE fr.to_id = $1 AND fr.status = 'pending'
        ORDER BY fr.created_at DESC
    `, [toUserId]);
    return res.rows.map(row => toCamelCase(row));
}

async function getSentFriendRequests(fromUserId) {
    const res = await query(`
        SELECT fr.*, u.steam_nickname as to_name, u.steam_avatar as to_avatar
        FROM friend_requests fr
        JOIN users u ON fr.to_id = u.id
        WHERE fr.from_id = $1 AND fr.status = 'pending'
        ORDER BY fr.created_at DESC
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
    const { id, from_id, to_id, text } = message;
    const res = await query(`
        INSERT INTO messages (id, from_id, to_id, text, read, created_at) 
        VALUES ($1, $2, $3, $4, false, NOW()) 
        RETURNING *
    `, [id, from_id, to_id, text]);
    return toCamelCase(res.rows[0]);
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
    const { id, title, description, prize_pool, date, status, entry_fee, max_teams, format, rules, schedule, registered_teams } = tournament;
    const res = await query(`
        INSERT INTO tournaments (id, title, description, prize_pool, date, status, entry_fee, max_teams, format, rules, schedule, registered_teams) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
        RETURNING *
    `, [id, title, description, prize_pool, date, status, entry_fee, max_teams, format, rules, schedule, JSON.stringify(registered_teams || [])]);
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
                steam_id: steamId, 
                steam_nickname: steamUser.personaname, 
                steam_avatar: steamUser.avatarfull, 
                display_name: steamUser.personaname, 
                region: 'RU', 
                role: 'RIFLER', 
                has_mic: false, 
                bio: '', 
                balance: 1000, 
                is_admin: isFirstUser, 
                is_banned: false 
            };
            user = await createUser(newUser);
            
            const tournamentCountRes = await query('SELECT COUNT(*) FROM tournaments');
            if (parseInt(tournamentCountRes.rows[0].count) === 0) {
                await createTournament({ 
                    id: `tourn_${Date.now()}`, 
                    title: 'BARSIDE CUP #1', 
                    description: 'Главный турнир сезона', 
                    prize_pool: '50000₽', 
                    date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), 
                    status: 'UPCOMING', 
                    entry_fee: 500, 
                    max_teams: 16, 
                    format: '5x5', 
                    rules: '1. Формат Best of 3\n2. Карты: Dust2, Mirage, Inferno, Nuke, Overpass', 
                    schedule: 'Групповой этап: первые выходные\nПлей-офф: следующие выходные', 
                    registered_teams: [] 
                });
            }
        } else {
            await updateUser(steamId, { 
                steam_nickname: steamUser.personaname, 
                steam_avatar: steamUser.avatarfull 
            });
            user = await findUserBySteamId(steamId);
        }
        
        const sessionToken = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steam_id })).toString('base64');
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
        if (user) return res.json({ data: user });
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
        res.json({ user });
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
        const isAdmin = currentUser?.is_admin;
        const isOwnProfile = targetUser.id === payload.userId;
        if (!isOwnProfile && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
        
        const updates = {};
        if (req.body.displayName !== undefined) updates.display_name = req.body.displayName;
        if (req.body.region !== undefined) updates.region = req.body.region;
        if (req.body.role !== undefined) updates.role = req.body.role;
        if (req.body.hasMic !== undefined) updates.has_mic = req.body.hasMic;
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
    } catch (err) { 
        console.error('Stats error:', err);
        res.json({ totalUsers: 0, totalLfgPosts: 0, totalTournaments: 0, online: 0 }); 
    }
});

// ============= LFG МАРШРУТЫ =============
app.get('/api/lfg', async (req, res) => {
    try {
        const posts = await getActiveLfgPosts();
        res.json({ data: posts });
    } catch (err) { 
        console.error('GET /api/lfg error:', err);
        res.json({ data: [] }); 
    }
});

app.get('/api/lfg/completed', async (req, res) => {
    try {
        const posts = await getCompletedLfgPosts();
        res.json({ data: posts });
    } catch (err) { 
        console.error('GET /api/lfg/completed error:', err);
        res.json({ data: [] }); 
    }
});

app.post('/api/lfg', async (req, res) => {
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
        
        const result = {
            ...created,
            author: {
                id: user.id,
                steamId: user.steam_id,
                steamNickname: user.steam_nickname,
                steamAvatar: user.steam_avatar,
                displayName: user.display_name,
                region: user.region,
                role: user.role
            }
        };
        
        res.status(201).json({ data: result });
    } catch (err) { 
        console.error('Error creating LFG post:', err);
        res.status(500).json({ error: 'Internal server error: ' + err.message }); 
    }
});

app.post('/api/lfg/:postId/respond', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const { role, message } = req.body;
        if (!role) return res.status(400).json({ error: 'Role is required' });
        
        const response = await addResponseToLfg(req.params.postId, user.id, role, message);
        res.status(201).json({ data: response });
    } catch (err) { 
        console.error('Respond error:', err);
        res.status(400).json({ error: err.message }); 
    }
});

app.get('/api/lfg/:postId/responses', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const postRes = await query('SELECT author_id FROM lfg_posts WHERE id = $1', [req.params.postId]);
        if (postRes.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        if (postRes.rows[0].author_id !== user.id && !user.is_admin) return res.status(403).json({ error: 'Forbidden' });
        
        const responses = await getLfgResponses(req.params.postId);
        res.json({ data: responses });
    } catch (err) { 
        console.error('Get responses error:', err);
        res.status(500).json({ error: 'Server error' }); 
    }
});

app.get('/api/lfg/responses/unread', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const unreadRes = await query(`
            SELECT COUNT(*)
            FROM lfg_responses r
            JOIN lfg_posts p ON r.post_id = p.id
            WHERE p.author_id = $1 AND p.status = 'active' AND r.status = 'pending'
        `, [payload.userId]);
        res.json({ count: parseInt(unreadRes.rows[0].count, 10) || 0 });
    } catch (err) {
        res.json({ count: 0 });
    }
});

app.post('/api/lfg/:postId/responses/:responseId/accept', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        await acceptResponse(req.params.postId, req.params.responseId, user.id);
        res.json({ success: true });
    } catch (err) { 
        console.error('Accept error:', err);
        res.status(400).json({ error: err.message }); 
    }
});

app.post('/api/lfg/:postId/responses/:responseId/reject', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        await rejectResponse(req.params.postId, req.params.responseId, user.id);
        res.json({ success: true });
    } catch (err) { 
        console.error('Reject error:', err);
        res.status(400).json({ error: err.message }); 
    }
});

app.post('/api/lfg/:postId/complete', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        await completeLfgPost(req.params.postId, user.id);
        res.json({ success: true });
    } catch (err) { 
        console.error('Complete error:', err);
        res.status(400).json({ error: err.message }); 
    }
});

app.post('/api/lfg/:postId/review', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const { rating, comment } = req.body;
        if (!rating || !comment) return res.status(400).json({ error: 'Rating and comment required' });
        
        await addReviewToLfg(req.params.postId, user.id, rating, comment);
        res.json({ success: true });
    } catch (err) { 
        console.error('Review error:', err);
        res.status(400).json({ error: err.message }); 
    }
});

app.delete('/api/lfg/:id', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        
        const deleted = await deleteLfgPost(req.params.id, user.id, user.is_admin);
        if (!deleted) return res.status(404).json({ error: 'Post not found or forbidden' });
        res.json({ success: true });
    } catch (err) { 
        console.error('Delete error:', err);
        res.status(500).json({ error: 'Server error' }); 
    }
});

// ============= ДРУЗЬЯ =============
app.get('/api/friends', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const friends = await getFriends(payload.userId);
        res.json({ data: friends });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/friends/requests', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const requests = await getFriendRequests(payload.userId);
        res.json({ data: requests });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/friends/requests/sent', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const requests = await getSentFriendRequests(payload.userId);
        res.json({ data: requests });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/request/:userId', async (req, res) => {
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

app.post('/api/friends/request/:requestId/accept', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await acceptFriendRequest(req.params.requestId, payload.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/request/:requestId/decline', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await declineFriendRequest(req.params.requestId, payload.userId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/friends/request/:requestId', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const deleted = await cancelFriendRequest(req.params.requestId, payload.userId);
        if (!deleted) return res.status(404).json({ error: 'Request not found' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/friends/:friendId', async (req, res) => {
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
app.get('/api/messages/:userId', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const messages = await getMessages(payload.userId, req.params.userId);
        await markMessagesAsRead(payload.userId, req.params.userId);
        res.json({ data: messages });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/messages/:userId', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
        const newMessage = { id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, from_id: payload.userId, to_id: req.params.userId, text: text.trim() };
        const created = await createMessage(newMessage);
        res.json({ success: true, message: created });
    } catch (err) { res.status(500).json({ error: 'Failed to send message' }); }
});

app.get('/api/messages/unread/count', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const count = await getUnreadCount(payload.userId);
        res.json({ count });
    } catch (err) { res.json({ count: 0 }); }
});

app.get('/api/user/by-id/:userId', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
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
                    name: description?.market_hash_name || description?.name || 'Unknown Item', 
                    icon: description?.icon_url ? `https://steamcommunity-a.akamaihd.net/economy/image/${description.icon_url}` : null, 
                    rarity: description?.tags?.find(t => t.category === 'Rarity')?.localized_tag_name || 'Common', 
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

// ============= АДМИН МАРШРУТЫ =============
app.get('/api/admin/users', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user?.is_admin) return res.status(403).json({ error: 'Admin only' });
        const users = await getAllUsers();
        res.json({ data: users });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/search', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user?.is_admin) return res.status(403).json({ error: 'Admin only' });
        const { query: searchTerm } = req.query;
        if (!searchTerm) return res.json({ data: [] });
        const users = await getAllUsers();
        const filtered = users.filter(u => 
            (u.display_name || '').toLowerCase().includes(searchTerm.toLowerCase()) || 
            (u.steam_nickname || '').toLowerCase().includes(searchTerm.toLowerCase())
        );
        res.json({ data: filtered });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// ============= HEALTH CHECK =============
app.get('/healthz', (req, res) => { res.status(200).json({ status: 'ok' }); });

// ============= ПЛАТЕЖИ ЮKASSA =============

// Создание платежа
app.post('/api/payments/create', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    if (!yooKassa) {
        return res.status(503).json({ error: 'Платежная система не настроена' });
    }
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const { amount, returnUrl } = req.body;
        
        const minAmount = 100;
        const maxAmount = 100000;
        if (!amount || amount < minAmount || amount > maxAmount) {
            return res.status(400).json({ error: `Сумма должна быть от ${minAmount} до ${maxAmount} ₽` });
        }
        
        const idempotenceKey = uuidv4();
        const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        
        await query(`
            CREATE TABLE IF NOT EXISTS payments (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                amount INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                yookassa_id TEXT,
                created_at TIMESTAMP DEFAULT NOW(),
                completed_at TIMESTAMP
            )
        `);
        
        await query(
            'INSERT INTO payments (id, user_id, amount, status) VALUES ($1, $2, $3, $4)',
            [paymentId, user.id, amount, 'pending']
        );
        
        const payment = await yooKassa.createPayment({
            amount: {
                value: amount.toString(),
                currency: 'RUB'
            },
            payment_method_data: {
                type: 'bank_card'
            },
            confirmation: {
                type: 'redirect',
                return_url: returnUrl || `${FRONTEND_URL}/profile/${user.steam_id}`
            },
            description: `Пополнение баланса BARSIDE CS2: ${amount} ₽`,
            metadata: {
                payment_id: paymentId,
                user_id: user.id
            }
        }, idempotenceKey);
        
        await query('UPDATE payments SET yookassa_id = $1 WHERE id = $2', [payment.id, paymentId]);
        
        res.json({
            success: true,
            paymentId: paymentId,
            confirmationUrl: payment.confirmation.confirmation_url
        });
        
    } catch (err) {
        console.error('Create payment error:', err);
        res.status(500).json({ error: 'Ошибка при создании платежа: ' + err.message });
    }
});

// Webhook для обработки статусов платежей
app.post('/api/payments/webhook', async (req, res) => {
    try {
        const event = req.body;
        
        if (event.object && event.object.status) {
            const yookassaId = event.object.id;
            const paymentStatus = event.object.status;
            
            const paymentRes = await query('SELECT * FROM payments WHERE yookassa_id = $1', [yookassaId]);
            
            if (paymentRes.rows.length === 0) {
                console.log('Payment not found:', yookassaId);
                return res.status(200).send('OK');
            }
            
            const payment = paymentRes.rows[0];
            
            if (payment.status !== 'pending') {
                return res.status(200).send('OK');
            }
            
            if (paymentStatus === 'succeeded') {
                await query('UPDATE payments SET status = $1, completed_at = NOW() WHERE id = $2', ['completed', payment.id]);
                
                const currentBalance = await getUserBalance(payment.user_id);
                await updateUserBalance(payment.user_id, currentBalance + payment.amount);
                
                console.log(`✅ Payment succeeded: ${payment.id}, user: ${payment.user_id}, amount: ${payment.amount}`);
            } else if (paymentStatus === 'canceled') {
                await query('UPDATE payments SET status = $1 WHERE id = $2', ['canceled', payment.id]);
                console.log(`❌ Payment canceled: ${payment.id}`);
            }
        }
        
        res.status(200).send('OK');
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(200).send('OK');
    }
});

// Проверка статуса платежа
app.get('/api/payments/:paymentId/status', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const paymentRes = await query('SELECT * FROM payments WHERE id = $1 AND user_id = $2', [req.params.paymentId, user.id]);
        
        if (paymentRes.rows.length === 0) {
            return res.status(404).json({ error: 'Payment not found' });
        }
        
        res.json({
            status: paymentRes.rows[0].status,
            amount: paymentRes.rows[0].amount,
            completedAt: paymentRes.rows[0].completed_at
        });
        
    } catch (err) {
        console.error('Payment status error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Получить историю платежей пользователя
app.get('/api/payments/history', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const paymentsRes = await query(`
            SELECT id, amount, status, created_at, completed_at 
            FROM payments 
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT 50
        `, [user.id]);
        
        res.json({ data: paymentsRes.rows });
        
    } catch (err) {
        console.error('Payment history error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============= СТАТИКА =============
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, '../public/index.html')); });

// ============= ЗАПУСК =============
async function startServer() {
    await initPostgresDB();
    app.listen(PORT, () => {
        console.log(`\n🚀 BARSIDE CS2 Server running on port ${PORT}`);
        console.log(`🐘 PostgreSQL: ${process.env.DB_HOST ? 'Connected' : 'Not configured!'}`);
    });
}
startServer().catch(console.error);
