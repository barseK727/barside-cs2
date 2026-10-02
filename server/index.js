require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

let YooKassa = null;
try {
    ({ YooKassa } = require('@webzaytsev/yookassa-ts-sdk'));
} catch (e) {
    console.warn('⚠️ ЮKassa SDK не установлен');
}

const app = express();
const PORT = process.env.PORT || 5000;

// ================== ENV CHECK ==================
if (!process.env.STEAM_API_KEY) {
    console.error('❌ STEAM_API_KEY не задан');
    process.exit(1);
}
if (!process.env.DATABASE_URL && !process.env.DB_HOST) {
    console.error('❌ Ни DATABASE_URL, ни DB_HOST не заданы');
    process.exit(1);
}

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;

console.log('🔑 STEAM_API_KEY:', STEAM_API_KEY.slice(0, 8) + '...');
console.log('🌐 FRONTEND_URL:', FRONTEND_URL);

// ================== POSTGRES ==================
let pool;
if (process.env.DATABASE_URL) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    console.log('🌐 Using DATABASE_URL');
} else {
    pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'barside',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    });
    console.log('🏠 Using local Postgres');
}

async function query(text, params) {
    const res = await pool.query(text, params);
    return res;
}

pool.on('error', (err) => {
    console.error('❌ Postgres pool error:', err.message);
});

// ================== ЮKASSA ==================
let yooKassa = null;
if (process.env.YKASSA_SHOP_ID && process.env.YKASSA_SECRET_KEY && YooKassa) {
    try {
        yooKassa = new YooKassa({
            shopId: process.env.YKASSA_SHOP_ID,
            secretKey: process.env.YKASSA_SECRET_KEY
        });
        console.log('✅ ЮKassa initialized');
    } catch (e) {
        console.warn('⚠️ ЮKassa init error:', e.message);
    }
} else {
    console.log('⚠️ ЮKassa not configured');
}

// ================== SSE ==================
const sseClients = new Map();

app.get('/api/events', (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (e) {}
    }, 25000);

    const userId = payload.userId;
    if (!sseClients.has(userId)) sseClients.set(userId, new Set());
    sseClients.get(userId).add(res);

    req.on('close', () => {
        clearInterval(heartbeat);
        const set = sseClients.get(userId);
        if (set) { set.delete(res); if (set.size === 0) sseClients.delete(userId); }
    });
});

function pushEvent(userId, type, data) {
    const set = sseClients.get(userId);
    if (!set || set.size === 0) return;
    const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of set) {
        try { client.write(message); } catch (e) {}
    }
}

// ================== УТИЛИТЫ ==================
function toCamelCase(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const newObj = {};
    for (const [key, value] of Object.entries(obj)) {
        const camelKey = key.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
        newObj[camelKey] = value;
    }
    return newObj;
}

function safeJsonParse(value, fallback = null) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (e) { return fallback; }
}

function getRequestOrigin(req) {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    const forwardedProto = req.headers['x-forwarded-proto'];
    const protocol = (forwardedProto ? forwardedProto.split(',')[0] : req.protocol) || 'http';
    return `${protocol}://${req.get('host')}`;
}

function getAuthPayload(req) {
    const token = req.cookies.auth_token;
    if (!token) return null;
    try { return JSON.parse(Buffer.from(token, 'base64').toString()); }
    catch (e) { return null; }
}

function sanitizeString(str, max = 500) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, max);
}

// ================== RATE LIMIT (in-memory) ==================
const rateLimitBuckets = new Map();
function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
        bucket.count = 0;
        bucket.resetAt = now + windowMs;
    }
    bucket.count++;
    rateLimitBuckets.set(key, bucket);
    return bucket.count <= limit;
}
function rateLimitMiddleware(limit, windowMs) {
    return (req, res, next) => {
        const payload = getAuthPayload(req);
        const key = payload ? `u:${payload.userId}` : `ip:${req.ip}`;
        if (!rateLimit(key, limit, windowMs)) {
            return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
        }
        next();
    };
}

// ================== USERS ==================
async function findUserBySteamId(steamId) {
    const res = await query('SELECT * FROM users WHERE steam_id = $1', [steamId]);
    return res.rows[0] ? toCamelCase(res.rows[0]) : null;
}
async function findUserById(userId) {
    const res = await query('SELECT * FROM users WHERE id = $1', [userId]);
    return res.rows[0] ? toCamelCase(res.rows[0]) : null;
}
async function createUser(u) {
    const res = await query(`
        INSERT INTO users (id, steam_id, steam_nickname, steam_avatar, display_name, region, role, has_mic, bio, balance, is_admin, is_banned, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING *
    `, [u.id, u.steam_id, u.steam_nickname, u.steam_avatar, u.display_name, u.region, u.role, u.has_mic, u.bio, u.balance, u.is_admin, u.is_banned]);
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
    return res.rows.map(r => { try { return toCamelCase(r); } catch { return null; } }).filter(Boolean);
}

// ================== LFG ==================
async function getActiveLfgPosts() {
    const res = await query(`
        SELECT l.*,
               json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname,
                                 'steamAvatar', u.steam_avatar, 'displayName', u.display_name,
                                 'region', u.region, 'role', u.role) as author,
               COALESCE(accepted.accepted_players, '[]'::json) as accepted_players,
               COALESCE(pending.pending_responses_count, 0) as pending_responses_count
        FROM lfg_posts l
        JOIN users u ON l.author_id = u.id
        LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object('id', r.id, 'role', r.role,
                'user', json_build_object('id', ru.id, 'steamId', ru.steam_id,
                    'steamNickname', ru.steam_nickname, 'steamAvatar', ru.steam_avatar,
                    'displayName', ru.display_name)) ORDER BY r.created_at ASC) as accepted_players
            FROM lfg_responses r JOIN users ru ON r.user_id = ru.id
            WHERE r.post_id = l.id AND r.status = 'accepted'
        ) accepted ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int as pending_responses_count FROM lfg_responses r
            WHERE r.post_id = l.id AND r.status = 'pending'
        ) pending ON true
        WHERE l.status = 'active' ORDER BY l.created_at DESC
    `);
    return res.rows.map(toCamelCase);
}

async function getCompletedLfgPosts() {
    const res = await query(`
        SELECT l.*,
               json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname,
                                 'steamAvatar', u.steam_avatar, 'displayName', u.display_name,
                                 'region', u.region, 'role', u.role) as author,
               COALESCE(accepted.accepted_players, '[]'::json) as accepted_players, l.review
        FROM lfg_posts l
        JOIN users u ON l.author_id = u.id
        LEFT JOIN LATERAL (
            SELECT json_agg(json_build_object('id', r.id, 'role', r.role,
                'user', json_build_object('id', ru.id, 'steamId', ru.steam_id,
                    'steamNickname', ru.steam_nickname, 'steamAvatar', ru.steam_avatar,
                    'displayName', ru.display_name)) ORDER BY r.created_at ASC) as accepted_players
            FROM lfg_responses r JOIN users ru ON r.user_id = ru.id
            WHERE r.post_id = l.id AND r.status = 'accepted'
        ) accepted ON true
        WHERE l.status = 'completed' ORDER BY l.completed_at DESC
    `);
    return res.rows.map(toCamelCase);
}

async function createLfgPost(p) {
    const res = await query(`
        INSERT INTO lfg_posts (id, author_id, title, region, my_role, schedule_type, schedule,
                               week_schedule, players_needed, roles_needed, min_faceit_level,
                               min_premier_rank, description, language, status, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',NOW()) RETURNING *
    `, [p.id, p.authorId, p.title, p.region, p.myRole, p.scheduleType, p.schedule,
        JSON.stringify(p.weekSchedule || {}), p.playersNeeded, JSON.stringify(p.rolesNeeded),
        p.minFaceitLevel || 1, p.minPremierRank || 0, p.description || '', p.language || 'ru']);
    return toCamelCase(res.rows[0]);
}

async function addResponseToLfg(postId, userId, role, message) {
    const dup = await query('SELECT 1 FROM lfg_responses WHERE post_id=$1 AND user_id=$2 AND status IN ($3,$4)',
        [postId, userId, 'pending', 'accepted']);
    if (dup.rows.length > 0) throw new Error('Вы уже откликались');

    const postRes = await query('SELECT author_id, players_needed, roles_needed FROM lfg_posts WHERE id=$1 AND status=$2',
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id === userId) throw new Error('Нельзя на свою анкету');

    const rolesNeeded = safeJsonParse(postRes.rows[0].roles_needed, {});
    if (!rolesNeeded[role]) throw new Error('Роль занята или не нужна');

    const cnt = await query('SELECT COUNT(*) FROM lfg_responses WHERE post_id=$1 AND status=$2', [postId, 'accepted']);
    if (parseInt(cnt.rows[0].count, 10) >= postRes.rows[0].players_needed) throw new Error('Все места заняты');

    const res = await query(`
        INSERT INTO lfg_responses (id, post_id, user_id, role, message, status, created_at)
        VALUES ($1,$2,$3,$4,$5,'pending',NOW()) RETURNING *
    `, [`resp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, postId, userId, role, message || '']);
    return toCamelCase(res.rows[0]);
}

async function getLfgResponses(postId) {
    const res = await query(`
        SELECT r.*, json_build_object('id', u.id, 'steamId', u.steam_id,
            'steamNickname', u.steam_nickname, 'steamAvatar', u.steam_avatar,
            'displayName', u.display_name) as user
        FROM lfg_responses r JOIN users u ON r.user_id = u.id
        WHERE r.post_id=$1 AND r.status='pending' ORDER BY r.created_at ASC
    `, [postId]);
    return res.rows.map(toCamelCase);
}

async function acceptResponse(postId, responseId, authorId) {
    const postRes = await query('SELECT author_id, players_needed, roles_needed FROM lfg_posts WHERE id=$1 AND status=$2',
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');

    const responseRes = await query('SELECT role FROM lfg_responses WHERE id=$1 AND post_id=$2 AND status=$3',
        [responseId, postId, 'pending']);
    if (responseRes.rows.length === 0) throw new Error('Отклик не найден');
    const role = responseRes.rows[0].role;

    const rolesNeeded = safeJsonParse(postRes.rows[0].roles_needed, {});
    if (!rolesNeeded[role]) throw new Error('Роль занята');

    const cnt = await query('SELECT COUNT(*) FROM lfg_responses WHERE post_id=$1 AND status=$2', [postId, 'accepted']);
    if (parseInt(cnt.rows[0].count, 10) >= postRes.rows[0].players_needed) throw new Error('Все места заняты');

    await query('UPDATE lfg_responses SET status=$1 WHERE post_id=$2 AND role=$3 AND status=$4',
        ['rejected', postId, role, 'pending']);
    await query('UPDATE lfg_responses SET status=$1 WHERE id=$2', ['accepted', responseId]);
    await query(`UPDATE lfg_posts SET roles_needed = jsonb_set(roles_needed, $1, 'false'::jsonb) WHERE id=$2`,
        [`{${role}}`, postId]);
    return true;
}

async function rejectResponse(postId, responseId, authorId) {
    const postRes = await query('SELECT author_id FROM lfg_posts WHERE id=$1', [postId]);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    await query('UPDATE lfg_responses SET status=$1 WHERE id=$2', ['rejected', responseId]);
    return true;
}

async function completeLfgPost(postId, authorId) {
    const postRes = await query('SELECT author_id, players_needed FROM lfg_posts WHERE id=$1 AND status=$2',
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');

    const cnt = await query('SELECT COUNT(*) FROM lfg_responses WHERE post_id=$1 AND status=$2', [postId, 'accepted']);
    if (parseInt(cnt.rows[0].count, 10) < postRes.rows[0].players_needed) {
        throw new Error(`Нужно ${postRes.rows[0].players_needed} игроков`);
    }
    await query('UPDATE lfg_posts SET status=$1, completed_at=NOW() WHERE id=$2', ['completed', postId]);
    return true;
}

async function addReviewToLfg(postId, authorId, rating, comment) {
    const postRes = await query('SELECT author_id FROM lfg_posts WHERE id=$1 AND status=$2', [postId, 'completed']);
    if (postRes.rows.length === 0) throw new Error('Не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');

    const r = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
    const c = sanitizeString(comment, 200);
    if (!r || !c) throw new Error('Нужна оценка и комментарий');

    const review = { rating: r, comment: c, createdAt: new Date().toISOString() };
    await query('UPDATE lfg_posts SET review=$1 WHERE id=$2', [JSON.stringify(review), postId]);

    // начисляем ELO принятым игрокам
    const accepted = await query('SELECT user_id FROM lfg_responses WHERE post_id=$1 AND status=$2', [postId, 'accepted']);
    for (const row of accepted.rows) {
        await query('UPDATE users SET rating = rating + 10, matches_played = matches_played + 1 WHERE id=$1', [row.user_id]);
    }
    await query('UPDATE users SET rating = rating + 15, matches_played = matches_played + 1 WHERE id=$1', [authorId]);

    return true;
}

async function deleteLfgPost(postId, userId, isAdmin) {
    const r = await query('SELECT author_id FROM lfg_posts WHERE id=$1', [postId]);
    if (r.rows.length === 0) return false;
    if (r.rows[0].author_id !== userId && !isAdmin) return false;
    await query('DELETE FROM lfg_posts WHERE id=$1', [postId]);
    return true;
}

// ================== FRIENDS ==================
async function getFriends(userId) {
    const r = await query(`
        SELECT u.id, u.steam_id, u.steam_nickname, u.steam_avatar, u.display_name, u.region, u.role, u.balance
        FROM users u JOIN friends f ON f.friend_id = u.id WHERE f.user_id = $1
    `, [userId]);
    return r.rows.map(toCamelCase);
}
async function sendFriendRequest(id, fromId, toId) {
    await query(`INSERT INTO friend_requests (id, from_id, to_id, status, created_at) VALUES ($1,$2,$3,'pending',NOW())`,
        [id, fromId, toId]);
}
async function getFriendRequests(toUserId) {
    const r = await query(`
        SELECT fr.*, u.steam_nickname as from_name, u.steam_avatar as from_avatar
        FROM friend_requests fr JOIN users u ON fr.from_id = u.id
        WHERE fr.to_id = $1 AND fr.status='pending' ORDER BY fr.created_at DESC
    `, [toUserId]);
    return r.rows.map(toCamelCase);
}
async function getSentFriendRequests(fromUserId) {
    const r = await query(`
        SELECT fr.*, u.steam_nickname as to_name, u.steam_avatar as to_avatar
        FROM friend_requests fr JOIN users u ON fr.to_id = u.id
        WHERE fr.from_id = $1 AND fr.status='pending' ORDER BY fr.created_at DESC
    `, [fromUserId]);
    return r.rows.map(toCamelCase);
}
async function acceptFriendRequest(requestId, toUserId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqRes = await client.query('SELECT from_id, to_id FROM friend_requests WHERE id=$1 AND to_id=$2 AND status=$3',
            [requestId, toUserId, 'pending']);
        if (reqRes.rows.length === 0) throw new Error('Not found');
        const { from_id, to_id } = reqRes.rows[0];
        await client.query('INSERT INTO friends (user_id, friend_id) VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING', [from_id, to_id]);
        await client.query('UPDATE friend_requests SET status=$1 WHERE id=$2', ['accepted', requestId]);
        await client.query('COMMIT');
        return true;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
}
async function declineFriendRequest(id, userId) {
    const r = await query(`UPDATE friend_requests SET status='declined' WHERE id=$1 AND to_id=$2 AND status='pending'`, [id, userId]);
    return r.rowCount > 0;
}
async function cancelFriendRequest(id, userId) {
    const r = await query(`DELETE FROM friend_requests WHERE id=$1 AND from_id=$2 AND status='pending'`, [id, userId]);
    return r.rowCount > 0;
}
async function removeFriend(userId, friendId) {
    await query('DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)', [userId, friendId]);
    return true;
}

// ================== MESSAGES ==================
async function getMessages(userId, otherId) {
    const r = await query(`
        SELECT * FROM messages
        WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)
        ORDER BY created_at ASC
    `, [userId, otherId]);
    return r.rows.map(toCamelCase);
}
async function createMessage(m) {
    const r = await query(`
        INSERT INTO messages (id, from_id, to_id, text, read, created_at)
        VALUES ($1,$2,$3,$4,false,NOW()) RETURNING *
    `, [m.id, m.from_id, m.to_id, m.text]);
    return toCamelCase(r.rows[0]);
}
async function markMessagesAsRead(userId, fromId) {
    await query(`UPDATE messages SET read=true WHERE to_id=$1 AND from_id=$2 AND read=false`, [userId, fromId]);
}
async function getUnreadCount(userId) {
    const r = await query('SELECT COUNT(*) FROM messages WHERE to_id=$1 AND read=false', [userId]);
    return parseInt(r.rows[0].count, 10);
}

// ================== BALANCE ==================
async function getUserBalance(userId) {
    const r = await query('SELECT balance FROM users WHERE id=$1', [userId]);
    return r.rows[0]?.balance || 0;
}
async function updateUserBalance(userId, balance) {
    await query('UPDATE users SET balance=$1 WHERE id=$2', [balance, userId]);
}

// ================== TOURNAMENTS ==================
async function getTournaments() {
    const r = await query('SELECT * FROM tournaments ORDER BY created_at DESC');
    return r.rows.map(row => {
        const t = toCamelCase(row);
        if (typeof t.registeredTeams === 'string') t.registeredTeams = safeJsonParse(t.registeredTeams, []);
        return t;
    });
}
async function getTournamentById(id) {
    const r = await query('SELECT * FROM tournaments WHERE id=$1', [id]);
    if (r.rows.length === 0) return null;
    const t = toCamelCase(r.rows[0]);
    if (typeof t.registeredTeams === 'string') t.registeredTeams = safeJsonParse(t.registeredTeams, []);
    return t;
}
async function createTournament(t) {
    const r = await query(`
        INSERT INTO tournaments (id, title, description, prize_pool, date, status, entry_fee, max_teams, format, rules, schedule, registered_teams)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [t.id, t.title, t.description, t.prize_pool, t.date, t.status, t.entry_fee, t.max_teams,
        t.format, t.rules, t.schedule, JSON.stringify(t.registered_teams || [])]);
    return toCamelCase(r.rows[0]);
}

// ================== INIT DB ==================
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
        await client.query(`
            CREATE TABLE IF NOT EXISTS teams (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                tag TEXT,
                logo_url TEXT,
                description TEXT,
                captain_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS team_members (
                team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                role TEXT DEFAULT 'MEMBER',
                joined_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (team_id, user_id)
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS team_invites (
                id TEXT PRIMARY KEY,
                team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
                from_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                to_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS tournament_teams (
                id TEXT PRIMARY KEY,
                tournament_id TEXT REFERENCES tournaments(id) ON DELETE CASCADE,
                team_name TEXT NOT NULL,
                captain_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                players JSONB NOT NULL,
                status TEXT DEFAULT 'registered',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // МИГРАЦИИ (безопасные)
        const migrations = [
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS faceit_url TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_url TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS matches_played INTEGER DEFAULT 0`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 1000`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT DEFAULT 'Новичок'`,
            `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rounds JSONB DEFAULT '[]'::jsonb`,
            `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS bracket_type TEXT DEFAULT 'SINGLE_ELIM'`
        ];
        for (const m of migrations) {
            try { await client.query(m); } catch (e) { /* ignore if exists */ }
        }

        // Автоназначение админа
        const adminCount = await client.query('SELECT COUNT(*) FROM users WHERE is_admin=true');
        if (parseInt(adminCount.rows[0].count, 10) === 0) {
            const first = await client.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
            if (first.rows.length > 0) {
                await client.query('UPDATE users SET is_admin=true WHERE id=$1', [first.rows[0].id]);
                console.log('👑 Первый пользователь назначен админом');
            }
        }

        console.log('✅ PostgreSQL tables created/verified');
    } catch (err) {
        console.error('❌ Error creating tables:', err);
        throw err;
    } finally {
        client.release();
    }
}

// ================== MIDDLEWARE ==================
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ================== AUTH ==================
app.get('/api/auth/steam', (req, res) => {
    const origin = getRequestOrigin(req);
    const openIdUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(`${origin}/api/auth/steam/callback`)}&openid.realm=${encodeURIComponent(origin)}&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;
    res.redirect(openIdUrl);
});

app.get('/api/auth/steam/callback', async (req, res) => {
    const frontendUrl = process.env.FRONTEND_URL || getRequestOrigin(req);
    const claimedId = req.query['openid.claimed_id'];
    if (!claimedId) return res.redirect(`${frontendUrl}/?error=auth_failed`);
    const steamId = claimedId.split('/').pop();
    try {
        const apiUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`;
        const r = await axios.get(apiUrl);
        const steamUser = r.data.response?.players?.[0];
        if (!steamUser) return res.redirect(`${frontendUrl}/?error=steam_api_failed`);

        let user = await findUserBySteamId(steamId);
        if (!user) {
            const cnt = await query('SELECT COUNT(*) FROM users');
            const isFirst = parseInt(cnt.rows[0].count, 10) === 0;
            user = await createUser({
                id: `user_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
                steam_id: steamId,
                steam_nickname: steamUser.personaname,
                steam_avatar: steamUser.avatarfull,
                display_name: steamUser.personaname,
                region: 'RU', role: 'RIFLER', has_mic: false, bio: '',
                balance: 1000, is_admin: isFirst, is_banned: false
            });

            const tcnt = await query('SELECT COUNT(*) FROM tournaments');
            if (parseInt(tcnt.rows[0].count, 10) === 0) {
                await createTournament({
                    id: `tourn_${Date.now()}`,
                    title: 'BARSIDE CUP #1',
                    description: 'Главный турнир сезона',
                    prize_pool: '50000₽',
                    date: new Date(Date.now() + 7 * 86400000).toISOString(),
                    status: 'UPCOMING', entry_fee: 500, max_teams: 16, format: '5x5',
                    rules: 'Best of 3', schedule: 'Первые выходные',
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

        const token = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steam_id })).toString('base64');
        res.cookie('auth_token', token, { httpOnly: true, maxAge: 7*24*60*60*1000, sameSite: 'lax' });
        res.redirect(`${frontendUrl}/`);
    } catch (e) {
        console.error('Steam auth error:', e.message);
        res.redirect(`${frontendUrl}/?error=auth_failed`);
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.json({ data: null });
    try {
        const u = await findUserById(p.userId);
        res.json({ data: u });
    } catch (e) { res.json({ data: null }); }
});

// ================== ONLINE ==================
const onlineSessions = new Set();
app.get('/api/online', (req, res) => res.json({ count: onlineSessions.size }));
app.post('/api/heartbeat', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId) onlineSessions.add(sessionId);
    res.json({ success: true });
});

// ================== PROFILE ==================
app.get('/api/profile/:steamId', async (req, res) => {
    try {
        const user = await findUserBySteamId(req.params.steamId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/profile/:steamId', rateLimitMiddleware(20, 60000), async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const currentUser = await findUserById(payload.userId);
        const target = await findUserBySteamId(req.params.steamId);
        if (!target) return res.status(404).json({ error: 'User not found' });
        if (target.id !== payload.userId && !currentUser?.isAdmin) return res.status(403).json({ error: 'Forbidden' });

        const map = {
            displayName: 'display_name', region: 'region', role: 'role',
            hasMic: 'has_mic', bio: 'bio', avatarUrl: 'avatar_url',
            bannerUrl: 'banner_url', faceitUrl: 'faceit_url', steamUrl: 'steam_url'
        };
        const updates = {};
        for (const [k, col] of Object.entries(map)) {
            if (req.body[k] !== undefined) {
                let v = req.body[k];
                if (typeof v === 'string') v = v.trim().slice(0, 500);
                updates[col] = v;
            }
        }

        if (Object.keys(updates).length > 0) {
            const fields = Object.keys(updates).map((c, i) => `${c} = $${i+1}`).join(', ');
            const values = [...Object.values(updates), req.params.steamId];
            await query(`UPDATE users SET ${fields} WHERE steam_id = $${values.length}`, values);
        }

        res.json({ user: await findUserBySteamId(req.params.steamId) });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ================== BALANCE ==================
app.get('/api/balance', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { res.json({ balance: await getUserBalance(p.userId) }); }
    catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ================== STATS ==================
app.get('/api/stats', async (req, res) => {
    try {
        const u = await query('SELECT COUNT(*) FROM users');
        const l = await query("SELECT COUNT(*) FROM lfg_posts WHERE status='active'");
        const t = await query('SELECT COUNT(*) FROM tournaments');
        res.json({
            totalUsers: parseInt(u.rows[0].count, 10),
            totalLfgPosts: parseInt(l.rows[0].count, 10),
            totalTournaments: parseInt(t.rows[0].count, 10),
            online: onlineSessions.size
        });
    } catch (e) {
        console.error('Stats error:', e.message);
        res.json({ totalUsers: 0, totalLfgPosts: 0, totalTournaments: 0, online: 0 });
    }
});

// ================== LFG ROUTES ==================
app.get('/api/lfg', async (req, res) => {
    try { res.json({ data: await getActiveLfgPosts() }); }
    catch (e) { res.json({ data: [] }); }
});
app.get('/api/lfg/completed', async (req, res) => {
    try { res.json({ data: await getCompletedLfgPosts() }); }
    catch (e) { res.json({ data: [] }); }
});

app.post('/api/lfg', rateLimitMiddleware(5, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const { title, region, myRole, scheduleType, schedule, weekSchedule, playersNeeded,
                rolesNeeded, minFaceitLevel, minPremierRank, description, language } = req.body;
        if (!title || !region || !myRole) return res.status(400).json({ error: 'Заполните поля' });

        const allowed = ['IGL','AWP','ENTRY','RIFLER','LURKER'];
        const cnt = Math.max(1, Math.min(4, parseInt(playersNeeded, 10) || 1));
        if (!allowed.includes(myRole)) return res.status(400).json({ error: 'Bad role' });

        const selected = Object.entries(rolesNeeded || {}).filter(([,v]) => v).map(([k]) => k);
        if (selected.length !== cnt) return res.status(400).json({ error: `Нужно ${cnt} ролей` });
        if (selected.includes(myRole)) return res.status(400).json({ error: 'Ваша роль занята' });

        const normalized = Object.fromEntries(allowed.map(r => [r, selected.includes(r)]));
        const created = await createLfgPost({
            id: `lfg_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
            authorId: user.id,
            title: sanitizeString(title, 100),
            region: sanitizeString(region, 10),
            myRole,
            scheduleType: scheduleType || 'daily',
            schedule: sanitizeString(schedule, 200),
            weekSchedule: weekSchedule || {},
            playersNeeded: cnt,
            rolesNeeded: normalized,
            minFaceitLevel: parseInt(minFaceitLevel, 10) || 1,
            minPremierRank: parseInt(minPremierRank, 10) || 0,
            description: sanitizeString(description, 500),
            language: language || 'ru'
        });
        res.status(201).json({ data: created });
    } catch (e) {
        console.error('Create LFG error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/lfg/:postId/respond', rateLimitMiddleware(10, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const { role, message } = req.body;
        if (!role) return res.status(400).json({ error: 'Role required' });
        const response = await addResponseToLfg(req.params.postId, user.id, role, message);

        const post = await query('SELECT author_id FROM lfg_posts WHERE id=$1', [req.params.postId]);
        if (post.rows[0]) {
            pushEvent(post.rows[0].author_id, 'new-response', {
                postId: req.params.postId, fromUserId: user.id, role
            });
        }
        res.status(201).json({ data: response });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/lfg/:postId/responses', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const post = await query('SELECT author_id FROM lfg_posts WHERE id=$1', [req.params.postId]);
        if (post.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        if (post.rows[0].author_id !== user.id && !user.isAdmin) return res.status(403).json({ error: 'Forbidden' });
        res.json({ data: await getLfgResponses(req.params.postId) });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/lfg/responses/unread', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const r = await query(`
            SELECT COUNT(*) FROM lfg_responses r JOIN lfg_posts p ON r.post_id = p.id
            WHERE p.author_id=$1 AND p.status='active' AND r.status='pending'
        `, [p.userId]);
        res.json({ count: parseInt(r.rows[0].count, 10) || 0 });
    } catch (e) { res.json({ count: 0 }); }
});

app.post('/api/lfg/:postId/responses/:responseId/accept', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        await acceptResponse(req.params.postId, req.params.responseId, user.id);

        const resp = await query('SELECT user_id FROM lfg_responses WHERE id=$1', [req.params.responseId]);
        if (resp.rows[0]) pushEvent(resp.rows[0].user_id, 'response-accepted', { postId: req.params.postId });

        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/lfg/:postId/responses/:responseId/reject', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        await rejectResponse(req.params.postId, req.params.responseId, user.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/lfg/:postId/complete', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        await completeLfgPost(req.params.postId, user.id);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/lfg/:postId/review', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const { rating, comment } = req.body;
        if (!rating || !comment) return res.status(400).json({ error: 'Rating and comment required' });
        await addReviewToLfg(req.params.postId, user.id, rating, comment);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/lfg/:id', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const ok = await deleteLfgPost(req.params.id, user.id, user.isAdmin);
        if (!ok) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ================== FRIENDS ROUTES ==================
app.get('/api/friends', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { res.json({ data: await getFriends(p.userId) }); }
    catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/friends/requests', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { res.json({ data: await getFriendRequests(p.userId) }); }
    catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/friends/requests/sent', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { res.json({ data: await getSentFriendRequests(p.userId) }); }
    catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/request/:userId', rateLimitMiddleware(20, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const fromUser = await findUserById(p.userId);
        const toUser = await findUserById(req.params.userId);
        if (!fromUser || !toUser) return res.status(404).json({ error: 'Not found' });
        if (fromUser.id === req.params.userId) return res.status(400).json({ error: 'Нельзя себя' });

        const exists = await query('SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2 AND status=$3',
            [fromUser.id, req.params.userId, 'pending']);
        if (exists.rows.length > 0) return res.status(400).json({ error: 'Уже отправлена' });

        const alreadyFriend = await query('SELECT 1 FROM friends WHERE user_id=$1 AND friend_id=$2',
            [fromUser.id, req.params.userId]);
        if (alreadyFriend.rows.length > 0) return res.status(400).json({ error: 'Уже друзья' });

        await sendFriendRequest(`fr_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, fromUser.id, req.params.userId);
        pushEvent(req.params.userId, 'friend-request', { fromId: fromUser.id, fromName: fromUser.displayName });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/request/:requestId/accept', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { await acceptFriendRequest(req.params.requestId, p.userId); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friends/request/:requestId/decline', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { await declineFriendRequest(req.params.requestId, p.userId); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/friends/request/:requestId', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const ok = await cancelFriendRequest(req.params.requestId, p.userId);
        if (!ok) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/friends/:friendId', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { await removeFriend(p.userId, req.params.friendId); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ================== MESSAGES ==================
app.get('/api/messages/:userId', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const messages = await getMessages(p.userId, req.params.userId);
        await markMessagesAsRead(p.userId, req.params.userId);
        res.json({ data: messages });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/messages/:userId', rateLimitMiddleware(60, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const text = sanitizeString(req.body.text, 2000);
        if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
        const created = await createMessage({
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
            from_id: p.userId, to_id: req.params.userId, text
        });
        pushEvent(req.params.userId, 'new-message', {
            fromId: p.userId, text, at: new Date().toISOString()
        });
        res.json({ success: true, message: created });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/messages/unread/count', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { res.json({ count: await getUnreadCount(p.userId) }); }
    catch (e) { res.json({ count: 0 }); }
});

app.get('/api/user/by-id/:userId', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const u = await findUserById(req.params.userId);
        if (!u) return res.status(404).json({ error: 'Not found' });
        res.json({ user: u });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ================== TOURNAMENTS ==================
app.get('/api/tournaments', async (req, res) => {
    try { res.json({ data: await getTournaments() }); }
    catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/tournaments/:id', async (req, res) => {
    try {
        const t = await getTournamentById(req.params.id);
        if (!t) return res.status(404).json({ error: 'Not found' });
        res.json({ data: t });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/tournaments/:id/teams', async (req, res) => {
    try {
        const r = await query('SELECT * FROM tournament_teams WHERE tournament_id=$1 ORDER BY created_at ASC', [req.params.id]);
        res.json({ data: r.rows.map(row => {
            const t = toCamelCase(row);
            t.players = safeJsonParse(t.players, []);
            return t;
        })});
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/tournaments/:id/register-team', rateLimitMiddleware(10, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const { teamName, players } = req.body;
        if (!teamName || !Array.isArray(players) || players.length !== 5) {
            return res.status(400).json({ error: 'Нужно 5 игроков' });
        }
        const t = await getTournamentById(req.params.id);
        if (!t) return res.status(404).json({ error: 'Not found' });
        if (t.status === 'COMPLETED') return res.status(400).json({ error: 'Завершён' });

        const cnt = await query('SELECT COUNT(*) FROM tournament_teams WHERE tournament_id=$1', [req.params.id]);
        if (parseInt(cnt.rows[0].count, 10) >= t.maxTeams) return res.status(400).json({ error: 'Турнир заполнен' });

        const already = await query('SELECT 1 FROM tournament_teams WHERE tournament_id=$1 AND captain_id=$2',
            [req.params.id, user.id]);
        if (already.rows.length > 0) return res.status(400).json({ error: 'Уже зарегистрированы' });

        const fee = t.entryFee || 0;
        if (fee > 0) {
            const balance = await getUserBalance(user.id);
            if (balance < fee) return res.status(400).json({ error: `Недостаточно средств: ${balance}/${fee}` });
            await updateUserBalance(user.id, balance - fee);
        }

        const cleanPlayers = players.map(pl => ({
            nick: sanitizeString(pl.nick, 40),
            role: ['IGL','AWP','ENTRY','RIFLER','LURKER'].includes(pl.role) ? pl.role : 'RIFLER'
        }));

        await query('INSERT INTO tournament_teams (id, tournament_id, team_name, captain_id, players) VALUES ($1,$2,$3,$4,$5)',
            [`tt_${Date.now()}`, req.params.id, sanitizeString(teamName, 40), user.id, JSON.stringify(cleanPlayers)]);

        res.json({ success: true, balance: await getUserBalance(user.id) });
    } catch (e) {
        console.error('Register team error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// ================== TEAMS ==================
app.post('/api/teams', rateLimitMiddleware(5, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const { name, tag, description } = req.body;
        const cleanName = sanitizeString(name, 40);
        if (cleanName.length < 3) return res.status(400).json({ error: 'Минимум 3 символа' });

        const exists = await query('SELECT id FROM teams WHERE name=$1', [cleanName]);
        if (exists.rows.length > 0) return res.status(400).json({ error: 'Название занято' });

        const id = `team_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        await query('INSERT INTO teams (id, name, tag, description, captain_id) VALUES ($1,$2,$3,$4,$5)',
            [id, cleanName, sanitizeString(tag, 6), sanitizeString(description, 300), user.id]);
        await query('INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3)', [id, user.id, 'CAPTAIN']);
        res.json({ success: true, teamId: id });
    } catch (e) {
        console.error('Create team error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/teams/my', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const r = await query(`
            SELECT t.*, tm.role as my_role FROM teams t
            JOIN team_members tm ON tm.team_id = t.id
            WHERE tm.user_id = $1
        `, [p.userId]);
        res.json({ data: r.rows.map(toCamelCase) });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/teams/:id', async (req, res) => {
    try {
        const tRes = await query('SELECT * FROM teams WHERE id=$1', [req.params.id]);
        if (tRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const mRes = await query(`
            SELECT u.id, u.steam_id, u.steam_nickname, u.steam_avatar, u.display_name, tm.role, tm.joined_at
            FROM team_members tm JOIN users u ON tm.user_id = u.id
            WHERE tm.team_id=$1 ORDER BY tm.joined_at ASC
        `, [req.params.id]);
        res.json({ team: toCamelCase(tRes.rows[0]), members: mRes.rows.map(toCamelCase) });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/teams/:id/invite/:userId', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const cap = await query('SELECT captain_id FROM teams WHERE id=$1', [req.params.id]);
        if (cap.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        if (cap.rows[0].captain_id !== p.userId) return res.status(403).json({ error: 'Not captain' });

        const already = await query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2',
            [req.params.id, req.params.userId]);
        if (already.rows.length > 0) return res.status(400).json({ error: 'Уже в команде' });

        await query('INSERT INTO team_invites (id, team_id, from_id, to_id) VALUES ($1,$2,$3,$4)',
            [`inv_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, req.params.id, p.userId, req.params.userId]);
        pushEvent(req.params.userId, 'team-invite', { teamId: req.params.id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/teams/invites/my', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const r = await query(`
            SELECT ti.*, t.name as team_name, t.tag as team_tag
            FROM team_invites ti JOIN teams t ON ti.team_id = t.id
            WHERE ti.to_id=$1 AND ti.status='pending'
        `, [p.userId]);
        res.json({ data: r.rows.map(toCamelCase) });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/teams/invites/:id/:action', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { id, action } = req.params;
        const inv = await query('SELECT * FROM team_invites WHERE id=$1 AND to_id=$2 AND status=$3',
            [id, p.userId, 'pending']);
        if (inv.rows.length === 0) return res.status(404).json({ error: 'Not found' });

        if (action === 'accept') {
            await query('INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
                [inv.rows[0].team_id, p.userId, 'MEMBER']);
            await query('UPDATE team_invites SET status=$1 WHERE id=$2', ['accepted', id]);
        } else if (action === 'decline') {
            await query('UPDATE team_invites SET status=$1 WHERE id=$2', ['declined', id]);
        } else return res.status(400).json({ error: 'Bad action' });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ================== ADMIN ==================
async function requireAdmin(req, res) {
    const p = getAuthPayload(req);
    if (!p) { res.status(403).json({ error: 'Admin only' }); return null; }
    const user = await findUserById(p.userId);
    if (!user || !user.isAdmin) { res.status(403).json({ error: 'Admin only' }); return null; }
    return user;
}

app.get('/api/admin/users', async (req, res) => {
    try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        res.json({ data: await getAllUsers() });
    } catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});

app.get('/api/admin/search', async (req, res) => {
    try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const q = String(req.query.q || '').toLowerCase();
        if (!q) return res.json({ data: [] });
        const all = await getAllUsers();
        res.json({ data: all.filter(u =>
            (u.displayName||'').toLowerCase().includes(q) ||
            (u.steamNickname||'').toLowerCase().includes(q)
        )});
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/make-me-admin', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const cnt = await query('SELECT COUNT(*) FROM users WHERE is_admin=true');
        if (parseInt(cnt.rows[0].count, 10) > 0) return res.status(403).json({ error: 'Админ уже есть' });
        const user = await findUserById(p.userId);
        if (!user) return res.status(404).json({ error: 'Not found' });
        await query('UPDATE users SET is_admin=true WHERE id=$1', [user.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/ban/:userId', async (req, res) => {
    try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const { ban } = req.body;
        await query('UPDATE users SET is_banned=$1 WHERE id=$2', [Boolean(ban), req.params.userId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/promote/:userId', async (req, res) => {
    try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const { promote } = req.body;
        await query('UPDATE users SET is_admin=$1 WHERE id=$2', [Boolean(promote), req.params.userId]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ================== INVENTORY ==================
app.get('/api/inventory/:steamId', async (req, res) => {
    try {
        const url = `https://steamcommunity.com/inventory/${req.params.steamId}/730/2?l=english&count=2000`;
        const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (r.data && r.data.success === 1) {
            const items = (r.data.assets || []).map(a => {
                const d = (r.data.descriptions || []).find(x => x.classid === a.classid && x.instanceid === a.instanceid);
                return {
                    assetid: a.assetid,
                    name: d?.market_hash_name || d?.name || 'Unknown',
                    icon: d?.icon_url ? `https://steamcommunity-a.akamaihd.net/economy/image/${d.icon_url}` : null,
                    rarity: d?.tags?.find(t => t.category === 'Rarity')?.localized_tag_name || 'Common',
                    quantity: a.amount || 1
                };
            });
            res.json({ success: true, total: r.data.total_inventory_count || items.length, items });
        } else {
            res.json({ success: false, error: 'Private', items: [], total: 0 });
        }
    } catch (e) { res.json({ success: false, error: 'Failed', items: [], total: 0 }); }
});

// ================== HEALTH ==================
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

// ================== SPA FALLBACK ==================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================== START ==================
async function startServer() {
    try { await initPostgresDB(); }
    catch (err) {
        console.error('❌ Не удалось инициализировать БД:', err.message);
        process.exit(1);
    }
    app.listen(PORT, () => {
        console.log(`\n🚀 BARSIDE CS2 Server running on port ${PORT}`);
        console.log(`🐘 PostgreSQL: Connected`);
        console.log(`🔗 http://localhost:${PORT}\n`);
    });
}
startServer().catch(err => { console.error('Fatal:', err); process.exit(1); });