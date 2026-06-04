const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const app = express();
const PORT = process.env.PORT || 5000;

// ============= ПОДКЛЮЧЕНИЕ К POSTGRESQL =============
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
    const start = Date.now();
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('executed query', { text: text.substring(0, 100), duration, rows: res.rowCount });
    return res;
}

// --- ПОЛЬЗОВАТЕЛИ ---
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
    
    const res = await query(
        `INSERT INTO users (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
    );
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

async function searchUsers(query_term) {
    const res = await query(
        `SELECT * FROM users 
         WHERE display_name ILIKE $1 OR steam_nickname ILIKE $1 
         ORDER BY created_at DESC`,
        [`%${query_term}%`]
    );
    return res.rows.map(toCamelCase);
}

// --- LFG ПОСТЫ ---
async function getLfgPosts(filters = {}) {
    let sql = `SELECT l.*, 
                      json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname, 'steamAvatar', u.steam_avatar, 'displayName', u.display_name, 'region', u.region, 'role', u.role) as author
               FROM lfg_posts l
               JOIN users u ON l.author_id = u.id`;
    const conditions = [];
    const values = [];
    let i = 1;
    
    if (filters.region && filters.region !== 'all') {
        conditions.push(`l.region = $${i}`);
        values.push(filters.region);
        i++;
    }
    if (filters.role && filters.role !== 'all') {
        conditions.push(`l.role = $${i}`);
        values.push(filters.role);
        i++;
    }
    
    if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY l.created_at DESC';
    
    const res = await query(sql, values);
    return res.rows.map(row => ({
        ...toCamelCase(row),
        author: row.author,
        playersNeeded: row.players_needed || 5,
        rolesNeeded: row.roles_needed || { IGL: false, AWP: false, ENTRY: false, RIFLER: false, LURKER: false }
    }));
}

async function createLfgPost(post) {
    const snakePost = toSnakeCase(post);
    const res = await query(
        `INSERT INTO lfg_posts (id, author_id, title, region, rank, role, schedule, description, players_needed, roles_needed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [snakePost.id, snakePost.author_id, snakePost.title, snakePost.region, snakePost.rank, snakePost.role, snakePost.schedule, snakePost.description, snakePost.players_needed, JSON.stringify(snakePost.roles_needed)]
    );
    return toCamelCase(res.rows[0]);
}

async function deleteLfgPost(postId, userId, isAdmin) {
    let sql = 'DELETE FROM lfg_posts WHERE id = $1';
    const values = [postId];
    if (!isAdmin) {
        sql += ' AND author_id = $2';
        values.push(userId);
    }
    const res = await query(sql, values);
    return res.rowCount > 0;
}

async function getUserLfgPosts(userId) {
    const res = await query('SELECT * FROM lfg_posts WHERE author_id = $1 ORDER BY created_at DESC', [userId]);
    return res.rows.map(toCamelCase);
}

// --- ТУРНИРЫ ---
async function getTournaments() {
    const res = await query('SELECT * FROM tournaments ORDER BY created_at DESC');
    return res.rows.map(toCamelCase);
}

async function createTournament(tournament) {
    const snakeTour = toSnakeCase(tournament);
    const res = await query(
        `INSERT INTO tournaments (id, title, description, prize_pool, date, status, entry_fee, max_teams, format, rules, schedule, registered_teams)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [snakeTour.id, snakeTour.title, snakeTour.description, snakeTour.prize_pool, snakeTour.date, snakeTour.status, snakeTour.entry_fee, snakeTour.max_teams, snakeTour.format, snakeTour.rules, snakeTour.schedule, JSON.stringify(snakeTour.registered_teams || [])]
    );
    return toCamelCase(res.rows[0]);
}

async function deleteTournament(tournamentId) {
    const res = await query('DELETE FROM tournaments WHERE id = $1', [tournamentId]);
    return res.rowCount > 0;
}

async function registerForTournament(tournamentId, teamData) {
    const tourRes = await query('SELECT registered_teams FROM tournaments WHERE id = $1', [tournamentId]);
    if (tourRes.rows.length === 0) throw new Error('Tournament not found');
    
    let registeredTeams = tourRes.rows[0].registered_teams || [];
    registeredTeams.push(teamData);
    
    await query('UPDATE tournaments SET registered_teams = $1 WHERE id = $2', [JSON.stringify(registeredTeams), tournamentId]);
    return true;
}

// --- ДРУЗЬЯ ---
async function getFriends(userId) {
    const res = await query(
        `SELECT u.id, u.steam_id, u.steam_nickname, u.steam_avatar, u.display_name, u.region, u.role, u.balance
         FROM users u
         JOIN friends f ON f.friend_id = u.id
         WHERE f.user_id = $1`,
        [userId]
    );
    return res.rows.map(toCamelCase);
}

async function sendFriendRequest(requestId, fromId, toId) {
    await query(
        `INSERT INTO friend_requests (id, from_id, to_id, status) VALUES ($1, $2, $3, 'pending')`,
        [requestId, fromId, toId]
    );
}

async function getFriendRequests(toUserId) {
    const res = await query(
        `SELECT fr.*, u.steam_nickname as from_name, u.steam_avatar as from_avatar 
         FROM friend_requests fr
         JOIN users u ON fr.from_id = u.id
         WHERE fr.to_id = $1 AND fr.status = 'pending'`,
        [toUserId]
    );
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
    const res = await query(
        `UPDATE friend_requests SET status = 'declined' WHERE id = $1 AND to_id = $2 AND status = 'pending'`,
        [requestId, toUserId]
    );
    return res.rowCount > 0;
}

// --- СООБЩЕНИЯ ---
async function getMessages(userId, otherUserId) {
    const res = await query(
        `SELECT * FROM messages 
         WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)
         ORDER BY created_at ASC`,
        [userId, otherUserId]
    );
    return res.rows.map(toCamelCase);
}

async function createMessage(message) {
    const snakeMsg = toSnakeCase(message);
    const res = await query(
        `INSERT INTO messages (id, from_id, to_id, text, read, created_at) 
         VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING *`,
        [snakeMsg.id, snakeMsg.from_id, snakeMsg.to_id, snakeMsg.text, false]
    );
    return toCamelCase(res.rows[0]);
}

async function markMessagesAsRead(userId, fromUserId) {
    await query(
        `UPDATE messages SET read = true WHERE to_id = $1 AND from_id = $2 AND read = false`,
        [userId, fromUserId]
    );
}

async function getUnreadCount(userId) {
    const res = await query(`SELECT COUNT(*) FROM messages WHERE to_id = $1 AND read = false`, [userId]);
    return parseInt(res.rows[0].count);
}

// --- БАНЫ ---
async function banUser(userId, reason) {
    await query(
        `INSERT INTO banned_users (user_id, reason, banned_until) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET reason = $2, banned_until = $3`,
        [userId, reason, null]
    );
    await query('UPDATE users SET is_banned = true WHERE id = $1', [userId]);
}

async function unbanUser(userId) {
    await query('DELETE FROM banned_users WHERE user_id = $1', [userId]);
    await query('UPDATE users SET is_banned = false WHERE id = $1', [userId]);
}

async function isUserBanned(userId) {
    const res = await query('SELECT * FROM banned_users WHERE user_id = $1', [userId]);
    return res.rows.length > 0;
}

// --- БАЛАНС ---
async function getUserBalance(userId) {
    const res = await query('SELECT balance FROM users WHERE id = $1', [userId]);
    return res.rows[0]?.balance || 0;
}

async function updateUserBalance(userId, newBalance) {
    await query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, userId]);
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
        rank TEXT,
        role TEXT,
        schedule TEXT NOT NULL,
        description TEXT,
        players_needed INTEGER DEFAULT 5,
        roles_needed JSONB,
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
    if (!claimedId) {
        return res.redirect(`${FRONTEND_URL}/?error=auth_failed`);
    }
    
    const steamId = claimedId.split('/').pop();
    
    try {
        const apiUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`;
        const steamResponse = await axios.get(apiUrl);
        const steamUser = steamResponse.data.response?.players?.[0];
        
        if (!steamUser) {
            return res.redirect(`${FRONTEND_URL}/?error=steam_api_failed`);
        }
        
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
                const defaultTournament = {
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
                };
                await createTournament(defaultTournament);
            }
        } else {
            await updateUser(steamId, {
                steamNickname: steamUser.personaname,
                steamAvatar: steamUser.avatarfull
            });
            user = await findUserBySteamId(steamId);
        }
        
        const banned = await isUserBanned(user.id);
        if (banned) {
            const sessionToken = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steamId, banned: true })).toString('base64');
            res.cookie('auth_token', sessionToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
            return res.redirect(`${FRONTEND_URL}/?error=banned`);
        }
        
        const sessionToken = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steamId })).toString('base64');
        res.cookie('auth_token', sessionToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
        res.redirect(`${FRONTEND_URL}/`);
        
    } catch (error) {
        console.error('❌ Steam auth error:', error.message);
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
    } catch(e) {
        console.error('Auth me error:', e);
    }
    
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
        const isBanned = await isUserBanned(user.id);
        
        const tournaments = await getTournaments();
        const userTournaments = tournaments.filter(t => {
            const teams = t.registeredTeams || [];
            return teams.some(team => team.captainId === user.id);
        });
        
        const userPosts = await getUserLfgPosts(user.id);
        
        res.json({ 
            user: { ...user, isBanned }, 
            tournaments: userTournaments,
            lfgPosts: userPosts
        });
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
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
        
        if (!isOwnProfile && !isAdmin) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        
        const { displayName, region, role, hasMic, bio, balance, isAdmin: makeAdmin, isBanned } = req.body;
        const updates = {};
        
        if (displayName !== undefined) updates.displayName = displayName;
        if (region !== undefined) updates.region = region;
        if (role !== undefined) updates.role = role;
        if (hasMic !== undefined) updates.hasMic = hasMic;
        if (bio !== undefined) updates.bio = bio;
        
        if (isAdmin) {
            if (balance !== undefined) updates.balance = balance;
            if (makeAdmin !== undefined) updates.isAdmin = makeAdmin;
            if (isBanned !== undefined) {
                if (isBanned) {
                    await banUser(targetUser.id, 'Banned by admin');
                } else {
                    await unbanUser(targetUser.id);
                }
            }
        }
        
        if (Object.keys(updates).length > 0) {
            await updateUser(req.params.steamId, updates);
        }
        
        const updatedUser = await findUserBySteamId(req.params.steamId);
        res.json({ user: updatedUser });
    } catch (err) {
        console.error('Profile update error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Баланс
app.get('/api/balance', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const balance = await getUserBalance(payload.userId);
        res.json({ balance });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
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
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Статистика
app.get('/api/stats', async (req, res) => {
    try {
        const usersRes = await query('SELECT COUNT(*) FROM users');
        const lfgRes = await query('SELECT COUNT(*) FROM lfg_posts');
        const tournamentsRes = await query('SELECT COUNT(*) FROM tournaments');
        res.json({ 
            totalUsers: parseInt(usersRes.rows[0].count), 
            totalLfgPosts: parseInt(lfgRes.rows[0].count), 
            totalTournaments: parseInt(tournamentsRes.rows[0].count), 
            online: onlineSessions.size 
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============= LFG МАРШРУТЫ =============
app.get('/api/lfg', async (req, res) => {
    try {
        const { region, role } = req.query;
        const posts = await getLfgPosts({ region, role });
        res.json({ data: posts });
    } catch (err) {
        console.error('Error in /api/lfg:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/lfg', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const { title, region, schedule, description, playersNeeded, rolesNeeded } = req.body;
        if (!title || !region || !schedule) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const playersCount = playersNeeded || 5;
        if (playersCount < 2 || playersCount > 4) {
            return res.status(400).json({ error: 'Players needed must be between 2 and 4' });
        }
        
        const userPostsRes = await query('SELECT COUNT(*) FROM lfg_posts WHERE author_id = $1', [user.id]);
        if (parseInt(userPostsRes.rows[0].count) >= 2) {
            return res.status(400).json({ error: 'Maximum 2 active posts per user' });
        }
        
        const newPost = {
            id: `lfg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            authorId: user.id,
            title,
            region,
            rank: 'GOLD_1',
            role: user.role || 'RIFLER',
            schedule,
            description: description || '',
            playersNeeded: playersCount,
            rolesNeeded: rolesNeeded || { IGL: false, AWP: false, ENTRY: false, RIFLER: false, LURKER: false }
        };
        
        const created = await createLfgPost(newPost);
        
        const result = {
            ...created,
            author: {
                id: user.id,
                steamId: user.steamId,
                steamNickname: user.steamNickname,
                steamAvatar: user.steamAvatar,
                displayName: user.displayName,
                region: user.region,
                role: user.role
            }
        };
        
        res.status(201).json({ data: result });
    } catch (err) {
        console.error('Error creating LFG post:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/lfg/:id', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        
        const deleted = await deleteLfgPost(req.params.id, user.id, user.isAdmin);
        if (!deleted) {
            return res.status(404).json({ error: 'Post not found or forbidden' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting LFG post:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ============= ТУРНИРЫ =============
app.get('/api/tournaments', async (req, res) => {
    try {
        const tournaments = await getTournaments();
        res.json({ data: tournaments });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/tournaments/:id', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
        
        const deleted = await deleteTournament(req.params.id);
        if (!deleted) return res.status(404).json({ error: 'Tournament not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/tournaments/:id/register', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        
        const tournaments = await getTournaments();
        const tournament = tournaments.find(t => t.id === req.params.id);
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
        
        if (tournament.entryFee > 0 && user.balance < tournament.entryFee) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        if (tournament.entryFee > 0) {
            const newBalance = user.balance - tournament.entryFee;
            await updateUserBalance(user.id, newBalance);
        }
        
        const teamData = {
            id: Date.now().toString(),
            teamName: req.body.teamName,
            captainId: user.id,
            captainName: user.displayName || user.steamNickname,
            captainTelegram: req.body.captainTelegram,
            captainPhone: req.body.captainPhone,
            players: req.body.players,
            registeredAt: new Date().toISOString()
        };
        
        await registerForTournament(req.params.id, teamData);
        res.json({ success: true });
    } catch (err) {
        console.error('Tournament registration error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============= АДМИН МАРШРУТЫ =============
app.get('/api/admin/users', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
        
        const users = await getAllUsers();
        const usersWithBan = await Promise.all(users.map(async u => ({
            ...u,
            isBanned: await isUserBanned(u.id)
        })));
        res.json({ data: usersWithBan });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/admin/tournaments', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
        
        const newTournament = {
            id: `tourn_${Date.now()}`,
            ...req.body,
            status: 'UPCOMING',
            registeredTeams: []
        };
        
        await createTournament(newTournament);
        res.status(201).json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/admin/search', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
        
        const { query: searchTerm } = req.query;
        if (!searchTerm) return res.json({ data: [] });
        
        const users = await searchUsers(searchTerm);
        const tournaments = await getTournaments();
        const result = await Promise.all(users.map(async u => {
            const userTournaments = tournaments.filter(t => {
                const teams = t.registeredTeams || [];
                return teams.some(team => team.captainId === u.id);
            });
            const userPosts = await getUserLfgPosts(u.id);
            return {
                ...u,
                isBanned: await isUserBanned(u.id),
                tournaments: userTournaments,
                lfgPosts: userPosts
            };
        }));
        
        res.json({ data: result });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ============= ДРУЗЬЯ И СООБЩЕНИЯ =============
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
    } catch (err) {
        console.error('Friend request error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/friends/requests', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const requests = await getFriendRequests(payload.userId);
        res.json({ data: requests });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/friends/request/:requestId/accept', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await acceptFriendRequest(req.params.requestId, payload.userId);
        res.json({ success: true });
    } catch (err) {
        console.error('Accept friend error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/friends/request/:requestId/decline', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await declineFriendRequest(req.params.requestId, payload.userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/friends', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const friends = await getFriends(payload.userId);
        res.json({ data: friends });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
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
    } catch (err) {
        console.error('Error getting messages:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/messages/:userId', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
        
        const newMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            fromId: payload.userId,
            toId: req.params.userId,
            text: text.trim()
        };
        
        const created = await createMessage(newMessage);
        res.json({ success: true, message: created });
    } catch (err) {
        console.error('Error sending message:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.get('/api/messages/unread/count', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const count = await getUnreadCount(payload.userId);
        res.json({ count });
    } catch (err) {
        res.json({ count: 0 });
    }
});

// ============= ПОЛУЧИТЬ ПОЛЬЗОВАТЕЛЯ ПО ID =============
app.get('/api/user/by-id/:userId', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const user = await findUserById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    } catch (err) {
        console.error('Error in /api/user/by-id:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ============= ИНВЕНТАРЬ =============
app.get('/api/inventory/:steamId', async (req, res) => {
    const { steamId } = req.params;
    try {
        const inventoryUrl = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=2000`;
        const response = await axios.get(inventoryUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        
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

// ============= HEALTH CHECK =============
app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// ============= СТАТИКА =============
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ============= ИНИЦИАЛИЗАЦИЯ И ЗАПУСК =============
async function startServer() {
    await initPostgresDB();
    
    app.listen(PORT, () => {
        console.log(`\n🚀 BARSIDE CS2 Server running!`);
        console.log(`📍 API URL: https://barside-api.onrender.com`);
        console.log(`🔑 Steam Auth: https://barside-api.onrender.com/api/auth/steam`);
        console.log(`🐘 PostgreSQL: ${process.env.DB_HOST ? 'Connected' : 'Not configured!'}`);
    });
}

startServer().catch(console.error);