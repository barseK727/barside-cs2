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

// ================== ПРОВЕРКА ENV ==================
if (!process.env.STEAM_API_KEY) {
    console.error('❌ STEAM_API_KEY не задан в .env');
    process.exit(1);
}
if (!process.env.DB_HOST) {
    console.error('❌ DB_HOST не задан в .env');
    process.exit(1);
}

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;

console.log('🔑 STEAM_API_KEY:', STEAM_API_KEY.slice(0, 8) + '...');
console.log('🌐 FRONTEND_URL:', FRONTEND_URL);

// ================== POSTGRES ==================
let pool;

if (process.env.DATABASE_URL) {
    // Render / облако: используем connection string
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }  // облачные БД требуют SSL
    });
    console.log('🌐 Using DATABASE_URL for Postgres');
} else {
    // Локально: используем отдельные переменные
    pool = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'barside',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD,
        ssl: false
    });
    console.log('🏠 Using local Postgres');
}

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
    console.log('⚠️ ЮKassa not configured - payments disabled');
}

// ================== УТИЛИТЫ ==================
function toCamelCase(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const newObj = {};
    for (const [key, value] of Object.entries(obj)) {
        const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
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

// Возвращает payload из cookie или null
function getAuthPayload(req) {
    const token = req.cookies.auth_token;
    if (!token) return null;
    try {
        return JSON.parse(Buffer.from(token, 'base64').toString());
    } catch (e) {
        return null;
    }
}

// Универсальный ответ админских роутов
function adminError(res, code, message) {
    return res.status(code).json({ error: message });
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

async function createUser(userData) {
    const {
        id, steam_id, steam_nickname, steam_avatar, display_name,
        region, role, has_mic, bio, balance, is_admin, is_banned
    } = userData;
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
    return res.rows.map(row => {
        try {
            return toCamelCase(row);
        } catch (e) {
            return null;
        }
    }).filter(Boolean);
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
            SELECT json_agg(
                json_build_object(
                    'id', r.id,
                    'role', r.role,
                    'user', json_build_object(
                        'id', ru.id,
                        'steamId', ru.steam_id,
                        'steamNickname', ru.steam_nickname,
                        'steamAvatar', ru.steam_avatar,
                        'displayName', ru.display_name
                    )
                ) ORDER BY r.created_at ASC
            ) as accepted_players
            FROM lfg_responses r
            JOIN users ru ON r.user_id = ru.id
            WHERE r.post_id = l.id AND r.status = 'accepted'
        ) accepted ON true
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int as pending_responses_count
            FROM lfg_responses r
            WHERE r.post_id = l.id AND r.status = 'pending'
        ) pending ON true
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
               COALESCE(accepted.accepted_players, '[]'::json) as accepted_players,
               l.review
        FROM lfg_posts l
        JOIN users u ON l.author_id = u.id
        LEFT JOIN LATERAL (
            SELECT json_agg(
                json_build_object(
                    'id', r.id,
                    'role', r.role,
                    'user', json_build_object(
                        'id', ru.id,
                        'steamId', ru.steam_id,
                        'steamNickname', ru.steam_nickname,
                        'steamAvatar', ru.steam_avatar,
                        'displayName', ru.display_name
                    )
                ) ORDER BY r.created_at ASC
            ) as accepted_players
            FROM lfg_responses r
            JOIN users ru ON r.user_id = ru.id
            WHERE r.post_id = l.id AND r.status = 'accepted'
        ) accepted ON true
        WHERE l.status = 'completed'
        ORDER BY l.completed_at DESC
    `);
    return res.rows.map(row => toCamelCase(row));
}

async function createLfgPost(postData) {
    const {
        id, authorId, title, region, myRole, scheduleType, schedule, weekSchedule,
        playersNeeded, rolesNeeded, minFaceitLevel, minPremierRank, description, language
    } = postData;

    const res = await query(`
        INSERT INTO lfg_posts (id, author_id, title, region, my_role, schedule_type, schedule,
                               week_schedule, players_needed, roles_needed, min_faceit_level,
                               min_premier_rank, description, language, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'active', NOW())
        RETURNING *
    `, [id, authorId, title, region, myRole, scheduleType, schedule,
        JSON.stringify(weekSchedule || {}), playersNeeded, JSON.stringify(rolesNeeded),
        minFaceitLevel || 1, minPremierRank || 0, description || '', language || 'ru']);

    return toCamelCase(res.rows[0]);
}

async function addResponseToLfg(postId, userId, role, message) {
    const checkRes = await query(
        'SELECT * FROM lfg_responses WHERE post_id = $1 AND user_id = $2 AND status IN ($3, $4)',
        [postId, userId, 'pending', 'accepted']
    );
    if (checkRes.rows.length > 0) throw new Error('Вы уже откликались на эту анкету');

    const postRes = await query('SELECT author_id, players_needed, roles_needed FROM lfg_posts WHERE id = $1 AND status = $2',
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id === userId) throw new Error('Нельзя откликнуться на свою анкету');

    const rolesNeeded = safeJsonParse(postRes.rows[0].roles_needed, {});
    if (!rolesNeeded[role]) throw new Error('Эта роль уже занята или не требуется');

    const acceptedCount = await query(
        'SELECT COUNT(*) FROM lfg_responses WHERE post_id = $1 AND status = $2',
        [postId, 'accepted']
    );
    if (parseInt(acceptedCount.rows[0].count, 10) >= postRes.rows[0].players_needed) {
        throw new Error('В этой анкете уже набраны все игроки');
    }

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
    const postRes = await query('SELECT author_id, players_needed, roles_needed FROM lfg_posts WHERE id = $1 AND status = $2',
        [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');

    const responseRes = await query('SELECT role FROM lfg_responses WHERE id = $1 AND post_id = $2 AND status = $3',
        [responseId, postId, 'pending']);
    if (responseRes.rows.length === 0) throw new Error('Отклик не найден');
    const role = responseRes.rows[0].role;

    const rolesNeeded = safeJsonParse(postRes.rows[0].roles_needed, {});
    if (!rolesNeeded[role]) throw new Error('Эта роль уже занята');

    const acceptedCount = await query(
        'SELECT COUNT(*) FROM lfg_responses WHERE post_id = $1 AND status = $2',
        [postId, 'accepted']
    );
    if (parseInt(acceptedCount.rows[0].count, 10) >= postRes.rows[0].players_needed) {
        throw new Error('Все места уже заняты');
    }

    await query('UPDATE lfg_responses SET status = $1 WHERE post_id = $2 AND role = $3 AND status = $4',
        ['rejected', postId, role, 'pending']);
    await query('UPDATE lfg_responses SET status = $1 WHERE id = $2', ['accepted', responseId]);
    await query(`UPDATE lfg_posts SET roles_needed = jsonb_set(roles_needed, $1, 'false'::jsonb) WHERE id = $2`,
        [`{${role}}`, postId]);

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

    const acceptedResponses = await query(
        'SELECT COUNT(*) FROM lfg_responses WHERE post_id = $1 AND status = $2',
        [postId, 'accepted']
    );

    const neededCount = postRes.rows[0].players_needed;
    if (parseInt(acceptedResponses.rows[0].count, 10) < neededCount) {
        throw new Error(`Необходимо принять ${neededCount} игроков`);
    }

    await query('UPDATE lfg_posts SET status = $1, completed_at = NOW() WHERE id = $2', ['completed', postId]);
    return true;
}

async function addReviewToLfg(postId, authorId, rating, comment) {
    const postRes = await query('SELECT author_id FROM lfg_posts WHERE id = $1 AND status = $2', [postId, 'completed']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');

    const normalizedRating = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
    const normalizedComment = String(comment || '').trim().slice(0, 200);
    if (!normalizedRating || !normalizedComment) throw new Error('Rating and comment required');

    const review = { rating: normalizedRating, comment: normalizedComment, createdAt: new Date().toISOString() };
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

// ================== FRIENDS ==================
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
    await query(
        `INSERT INTO friend_requests (id, from_id, to_id, status, created_at) VALUES ($1, $2, $3, 'pending', NOW())`,
        [requestId, fromId, toId]
    );
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
        const reqRes = await client.query(
            'SELECT from_id, to_id FROM friend_requests WHERE id = $1 AND to_id = $2 AND status = $3',
            [requestId, toUserId, 'pending']
        );
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

async function cancelFriendRequest(requestId, fromUserId) {
    const res = await query(
        `DELETE FROM friend_requests WHERE id = $1 AND from_id = $2 AND status = 'pending'`,
        [requestId, fromUserId]
    );
    return res.rowCount > 0;
}

async function removeFriend(userId, friendId) {
    await query(
        'DELETE FROM friends WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)',
        [userId, friendId]
    );
    return true;
}

// ================== MESSAGES ==================
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
    await query(`UPDATE messages SET read = true WHERE to_id = $1 AND from_id = $2 AND read = false`,
        [userId, fromUserId]);
}

async function getUnreadCount(userId) {
    const res = await query(`SELECT COUNT(*) FROM messages WHERE to_id = $1 AND read = false`, [userId]);
    return parseInt(res.rows[0].count, 10);
}

// ================== BALANCE ==================
async function getUserBalance(userId) {
    const res = await query('SELECT balance FROM users WHERE id = $1', [userId]);
    return res.rows[0]?.balance || 0;
}

async function updateUserBalance(userId, newBalance) {
    await query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, userId]);
}

// ================== TOURNAMENTS ==================
async function getTournaments() {
    const res = await query('SELECT * FROM tournaments ORDER BY created_at DESC');
    return res.rows.map(row => {
        const t = toCamelCase(row);
        if (typeof t.registeredTeams === 'string') {
            t.registeredTeams = safeJsonParse(t.registeredTeams, []);
        }
        return t;
    });
}

async function getTournamentById(id) {
    const res = await query('SELECT * FROM tournaments WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    const t = toCamelCase(res.rows[0]);
    if (typeof t.registeredTeams === 'string') {
        t.registeredTeams = safeJsonParse(t.registeredTeams, []);
    }
    return t;
}

async function createTournament(tournament) {
    const {
        id, title, description, prize_pool, date, status, entry_fee,
        max_teams, format, rules, schedule, registered_teams
    } = tournament;
    const res = await query(`
        INSERT INTO tournaments (id, title, description, prize_pool, date, status, entry_fee, max_teams, format, rules, schedule, registered_teams)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *
    `, [id, title, description, prize_pool, date, status, entry_fee, max_teams, format, rules, schedule,
        JSON.stringify(registered_teams || [])]);
    return toCamelCase(res.rows[0]);
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

        // Автоназначение админа, если админов нет
        const adminCount = await client.query('SELECT COUNT(*) FROM users WHERE is_admin = true');
        if (parseInt(adminCount.rows[0].count, 10) === 0) {
            const firstUser = await client.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
            if (firstUser.rows.length > 0) {
                await client.query('UPDATE users SET is_admin = true WHERE id = $1', [firstUser.rows[0].id]);
                console.log('👑 Первый пользователь назначен админом (auto-promote при старте)');
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
app.use(express.json());
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
        const steamResponse = await axios.get(apiUrl);
        const steamUser = steamResponse.data.response?.players?.[0];
        if (!steamUser) {
            console.error('❌ Steam API не вернул игрока. Проверьте ключ. steamId:', steamId);
            return res.redirect(`${frontendUrl}/?error=steam_api_failed`);
        }

        let user = await findUserBySteamId(steamId);
        if (!user) {
            const userCountRes = await query('SELECT COUNT(*) FROM users');
            const isFirstUser = parseInt(userCountRes.rows[0].count, 10) === 0;
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
            console.log(`✅ Создан пользователь: ${user.displayName} (${user.steamId}), isAdmin=${user.isAdmin}`);

            const tournamentCountRes = await query('SELECT COUNT(*) FROM tournaments');
            if (parseInt(tournamentCountRes.rows[0].count, 10) === 0) {
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
                    rules: 'Best of 3',
                    schedule: 'Первые выходные',
                    registered_teams: []
                });
                console.log('🏆 Создан турнир BARSIDE CUP #1');
            }
        } else {
            await updateUser(steamId, {
                steam_nickname: steamUser.personaname,
                steam_avatar: steamUser.avatarfull
            });
            user = await findUserBySteamId(steamId);
            console.log(`🔐 Вход: ${user.displayName}, isAdmin=${user.isAdmin}`);
        }

        const sessionToken = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steam_id })).toString('base64');
        res.cookie('auth_token', sessionToken, {
            httpOnly: true,
            maxAge: 7 * 24 * 60 * 60 * 1000,
            sameSite: 'lax'
        });
        res.redirect(`${frontendUrl}/`);
    } catch (error) {
        console.error('Steam auth error:', error.message);
        if (error.response) {
            console.error('Steam API response:', error.response.status, error.response.data);
        }
        res.redirect(`${frontendUrl}/?error=auth_failed`);
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.json({ data: null });
    try {
        const user = await findUserById(payload.userId);
        if (user) return res.json({ data: user });
    } catch (e) {}
    res.json({ data: null });
});

// ================== ONLINE ==================
const onlineSessions = new Set();
app.get('/api/online', (req, res) => { res.json({ count: onlineSessions.size }); });
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
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.put('/api/profile/:steamId', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const currentUser = await findUserById(payload.userId);
        const targetUser = await findUserBySteamId(req.params.steamId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        const isAdmin = currentUser?.isAdmin;
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
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ================== BALANCE ==================
app.get('/api/balance', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const balance = await getUserBalance(payload.userId);
        res.json({ balance });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ================== STATS ==================
app.get('/api/stats', async (req, res) => {
    try {
        const usersRes = await query('SELECT COUNT(*) FROM users');
        const lfgRes = await query("SELECT COUNT(*) FROM lfg_posts WHERE status = 'active'");
        const tournamentsRes = await query('SELECT COUNT(*) FROM tournaments');
        res.json({
            totalUsers: parseInt(usersRes.rows[0].count, 10),
            totalLfgPosts: parseInt(lfgRes.rows[0].count, 10),
            totalTournaments: parseInt(tournamentsRes.rows[0].count, 10),
            online: onlineSessions.size
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.json({ totalUsers: 0, totalLfgPosts: 0, totalTournaments: 0, online: 0 });
    }
});

// ================== LFG ROUTES ==================
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
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });

        const {
            title, region, myRole, scheduleType, schedule, weekSchedule, playersNeeded,
            rolesNeeded, minFaceitLevel, minPremierRank, description, language
        } = req.body;

        if (!title || !region || !myRole) return res.status(400).json({ error: 'Missing required fields' });

        const allowedRoles = ['IGL', 'AWP', 'ENTRY', 'RIFLER', 'LURKER'];
        const neededCount = Math.max(1, Math.min(4, parseInt(playersNeeded, 10) || 1));
        if (!allowedRoles.includes(myRole)) return res.status(400).json({ error: 'Invalid role' });

        const selectedRoles = Object.entries(rolesNeeded || {})
            .filter(([, selected]) => selected)
            .map(([role]) => role);
        if (selectedRoles.length !== neededCount) return res.status(400).json({ error: `Выберите ровно ${neededCount} ролей` });
        if (selectedRoles.includes(myRole)) return res.status(400).json({ error: 'Ваша роль уже занята вами' });
        if (selectedRoles.some(r => !allowedRoles.includes(r))) return res.status(400).json({ error: 'Invalid roles' });

        const normalizedRolesNeeded = Object.fromEntries(allowedRoles.map(r => [r, selectedRoles.includes(r)]));

        const newPost = {
            id: `lfg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            authorId: user.id,
            title,
            region,
            myRole,
            scheduleType: scheduleType || 'daily',
            schedule: schedule || '',
            weekSchedule: weekSchedule || {},
            playersNeeded: neededCount,
            rolesNeeded: normalizedRolesNeeded,
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
        res.status(500).json({ error: 'Internal server error: ' + err.message });
    }
});

app.post('/api/lfg/:postId/respond', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
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
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });

        const postRes = await query('SELECT author_id FROM lfg_posts WHERE id = $1', [req.params.postId]);
        if (postRes.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
        if (postRes.rows[0].author_id !== user.id && !user.isAdmin) return res.status(403).json({ error: 'Forbidden' });

        const responses = await getLfgResponses(req.params.postId);
        res.json({ data: responses });
    } catch (err) {
        console.error('Get responses error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/lfg/responses/unread', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
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
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
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
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
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
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
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
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
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
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'Unauthorized' });

        const deleted = await deleteLfgPost(req.params.id, user.id, user.isAdmin);
        if (!deleted) return res.status(404).json({ error: 'Post not found or forbidden' });
        res.json({ success: true });
    } catch (err) {
        console.error('Delete error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ================== FRIENDS ROUTES ==================
app.get('/api/friends', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const friends = await getFriends(payload.userId);
        res.json({ data: friends });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/friends/requests', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const requests = await getFriendRequests(payload.userId);
        res.json({ data: requests });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/friends/requests/sent', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const requests = await getSentFriendRequests(payload.userId);
        res.json({ data: requests });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/friends/request/:userId', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const fromUser = await findUserById(payload.userId);
        const toUser = await findUserById(req.params.userId);
        if (!fromUser || !toUser) return res.status(404).json({ error: 'User not found' });
        if (fromUser.id === req.params.userId) return res.status(400).json({ error: 'Cannot add yourself' });

        const existingReq = await query(
            'SELECT * FROM friend_requests WHERE from_id = $1 AND to_id = $2 AND status = $3',
            [fromUser.id, req.params.userId, 'pending']
        );
        if (existingReq.rows.length > 0) return res.status(400).json({ error: 'Request already sent' });

        const existingFriend = await query(
            'SELECT * FROM friends WHERE user_id = $1 AND friend_id = $2',
            [fromUser.id, req.params.userId]
        );
        if (existingFriend.rows.length > 0) return res.status(400).json({ error: 'Already friends' });

        await sendFriendRequest(
            `fr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            fromUser.id,
            req.params.userId
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/friends/request/:requestId/accept', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await acceptFriendRequest(req.params.requestId, payload.userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/friends/request/:requestId/decline', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await declineFriendRequest(req.params.requestId, payload.userId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/friends/request/:requestId', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const deleted = await cancelFriendRequest(req.params.requestId, payload.userId);
        if (!deleted) return res.status(404).json({ error: 'Request not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/friends/:friendId', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        await removeFriend(payload.userId, req.params.friendId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/user/:steamId/friends', async (req, res) => {
    try {
        const user = await findUserBySteamId(req.params.steamId);
        if (!user) return res.json({ data: [] });
        const friends = await getFriends(user.id);
        res.json({ data: friends });
    } catch (err) {
        res.json({ data: [] });
    }
});

// ================== MESSAGES ==================
app.get('/api/messages/:userId', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const messages = await getMessages(payload.userId, req.params.userId);
        await markMessagesAsRead(payload.userId, req.params.userId);
        res.json({ data: messages });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/messages/:userId', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
        const newMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            from_id: payload.userId,
            to_id: req.params.userId,
            text: text.trim()
        };
        const created = await createMessage(newMessage);
        res.json({ success: true, message: created });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.get('/api/messages/unread/count', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const count = await getUnreadCount(payload.userId);
        res.json({ count });
    } catch (err) {
        res.json({ count: 0 });
    }
});

app.get('/api/user/by-id/:userId', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ user });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ================== INVENTORY ==================
app.get('/api/inventory/:steamId', async (req, res) => {
    const { steamId } = req.params;
    try {
        const inventoryUrl = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=2000`;
        const response = await axios.get(inventoryUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (response.data && response.data.success === 1) {
            const assets = response.data.assets || [];
            const descriptions = response.data.descriptions || [];
            const items = assets.map(asset => {
                const description = descriptions.find(d =>
                    d.classid === asset.classid && d.instanceid === asset.instanceid
                );
                return {
                    assetid: asset.assetid,
                    name: description?.market_hash_name || description?.name || 'Unknown Item',
                    icon: description?.icon_url
                        ? `https://steamcommunity-a.akamaihd.net/economy/image/${description.icon_url}`
                        : null,
                    rarity: description?.tags?.find(t => t.category === 'Rarity')?.localized_tag_name || 'Common',
                    quantity: asset.amount || 1
                };
            });
            res.json({ success: true, total: response.data.total_inventory_count || items.length, items });
        } else {
            res.json({ success: false, error: 'Inventory is private', items: [], total: 0 });
        }
    } catch (error) {
        res.json({ success: false, error: 'Failed to fetch inventory', items: [], total: 0 });
    }
});

// ================== TOURNAMENTS ==================
app.get('/api/tournaments', async (req, res) => {
    try {
        const tournaments = await getTournaments();
        res.json({ data: tournaments });
    } catch (err) {
        console.error('Get tournaments error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/tournaments/:id', async (req, res) => {
    try {
        const tournament = await getTournamentById(req.params.id);
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
        res.json({ data: tournament });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/tournaments/:id/register', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });

        const tournament = await getTournamentById(req.params.id);
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

        if (tournament.status === 'COMPLETED' || tournament.status === 'CANCELLED') {
            return res.status(400).json({ error: 'Турнир уже завершён' });
        }

        const registered = Array.isArray(tournament.registeredTeams) ? tournament.registeredTeams : [];
        if (registered.length >= tournament.maxTeams) {
            return res.status(400).json({ error: 'Турнир заполнен' });
        }
        if (registered.some(t => t.captainId === user.id)) {
            return res.status(400).json({ error: 'Вы уже зарегистрированы в этом турнире' });
        }

        const entryFee = tournament.entryFee || 0;
        if (entryFee > 0) {
            const balance = await getUserBalance(user.id);
            if (balance < entryFee) {
                return res.status(400).json({ error: `Недостаточно средств. Нужно ${entryFee} ₽, у вас ${balance} ₽` });
            }
            await updateUserBalance(user.id, balance - entryFee);
        }

        const newTeam = {
            captainId: user.id,
            captainName: user.displayName || user.steamNickname,
            captainAvatar: user.steamAvatar,
            teamName: String(req.body.teamName || `${user.displayName || user.steamNickname} team`).slice(0, 60),
            registeredAt: new Date().toISOString()
        };

        registered.push(newTeam);

        await query(
            'UPDATE tournaments SET registered_teams = $1 WHERE id = $2',
            [JSON.stringify(registered), tournament.id]
        );

        res.json({ success: true, team: newTeam, balance: await getUserBalance(user.id) });
    } catch (err) {
        console.error('Tournament register error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ================== ADMIN ==================
// Универсальная проверка админа
async function requireAdmin(req, res) {
    const payload = getAuthPayload(req);
    if (!payload) {
        adminError(res, 403, 'Admin only');
        return null;
    }
    const user = await findUserById(payload.userId);
    if (!user) {
        adminError(res, 403, 'Admin only');
        return null;
    }
    if (!user.isAdmin) {
        adminError(res, 403, 'Admin only');
        return null;
    }
    return user;
}

app.get('/api/admin/users', async (req, res) => {
    try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const users = await getAllUsers();
        res.json({ data: users });
    } catch (err) {
        console.error('Admin users error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

app.get('/api/admin/search', async (req, res) => {
    try {
        const admin = await requireAdmin(req, res);
        if (!admin) return;
        const searchTerm = String(req.query.q || '').toLowerCase();
        if (!searchTerm) return res.json({ data: [] });
        const users = await getAllUsers();
        const filtered = users.filter(u =>
            (u.displayName || '').toLowerCase().includes(searchTerm) ||
            (u.steamNickname || '').toLowerCase().includes(searchTerm)
        );
        res.json({ data: filtered });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Аварийное назначение себя админом (только если админов нет вообще)
app.post('/api/admin/make-me-admin', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const adminCount = await query('SELECT COUNT(*) FROM users WHERE is_admin = true');
        if (parseInt(adminCount.rows[0].count, 10) > 0) {
            return res.status(403).json({ error: 'Админ уже есть' });
        }
        const user = await findUserById(payload.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        await query('UPDATE users SET is_admin = true WHERE id = $1', [user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('make-me-admin error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// ================== HEALTH ==================
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

// ================== PAYMENTS ==================
app.post('/api/payments/create', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    if (!yooKassa) return res.status(503).json({ error: 'Платёжная система не настроена' });

    try {
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });

        const { amount, returnUrl } = req.body;
        const minAmount = 100;
        const maxAmount = 100000;
        if (!amount || amount < minAmount || amount > maxAmount) {
            return res.status(400).json({ error: `Сумма должна быть от ${minAmount} до ${maxAmount} ₽` });
        }

        const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        await query(
            'INSERT INTO payments (id, user_id, amount, status) VALUES ($1, $2, $3, $4)',
            [paymentId, user.id, amount, 'pending']
        );

        const payment = await yooKassa.createPayment({
            amount: { value: amount.toString(), currency: 'RUB' },
            payment_method_data: { type: 'bank_card' },
            confirmation: {
                type: 'redirect',
                return_url: returnUrl || `${FRONTEND_URL}/profile/${user.steamId}`
            },
            description: `Пополнение баланса BARSIDE CS2: ${amount} ₽`,
            metadata: { payment_id: paymentId, user_id: user.id }
        }, uuidv4());

        await query('UPDATE payments SET yookassa_id = $1 WHERE id = $2', [payment.id, paymentId]);

        res.json({
            success: true,
            paymentId,
            confirmationUrl: payment.confirmation.confirmation_url
        });
    } catch (err) {
        console.error('Create payment error:', err);
        res.status(500).json({ error: 'Ошибка при создании платежа: ' + err.message });
    }
});

app.post('/api/payments/webhook', async (req, res) => {
    try {
        const event = req.body;
        if (event.object && event.object.status) {
            const yookassaId = event.object.id;
            const paymentStatus = event.object.status;

            const paymentRes = await query('SELECT * FROM payments WHERE yookassa_id = $1', [yookassaId]);
            if (paymentRes.rows.length === 0) return res.status(200).send('OK');

            const payment = paymentRes.rows[0];
            if (payment.status !== 'pending') return res.status(200).send('OK');

            if (paymentStatus === 'succeeded') {
                await query('UPDATE payments SET status = $1, completed_at = NOW() WHERE id = $2',
                    ['completed', payment.id]);
                const currentBalance = await getUserBalance(payment.user_id);
                await updateUserBalance(payment.user_id, currentBalance + payment.amount);
                console.log(`✅ Payment succeeded: ${payment.id}`);
            } else if (paymentStatus === 'canceled') {
                await query('UPDATE payments SET status = $1 WHERE id = $2', ['canceled', payment.id]);
            }
        }
        res.status(200).send('OK');
    } catch (err) {
        console.error('Webhook error:', err);
        res.status(200).send('OK');
    }
});

app.get('/api/payments/history', async (req, res) => {
    const payload = getAuthPayload(req);
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const paymentsRes = await query(`
            SELECT id, amount, status, created_at, completed_at
            FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50
        `, [payload.userId]);
        res.json({ data: paymentsRes.rows });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ================== SPA FALLBACK ==================
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================== START ==================
async function startServer() {
    try {
        await initPostgresDB();
    } catch (err) {
        console.error('❌ Не удалось инициализировать БД:', err.message);
        process.exit(1);
    }
    app.listen(PORT, () => {
        console.log(`\n🚀 BARSIDE CS2 Server running on port ${PORT}`);
        console.log(`🐘 PostgreSQL: Connected (${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME})`);
        console.log(`🔗 http://localhost:${PORT}\n`);
    });
}
startServer().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});