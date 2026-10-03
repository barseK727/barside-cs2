require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');

let YooKassa = null;
try { ({ YooKassa } = require('@webzaytsev/yookassa-ts-sdk')); } catch (e) {}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.STEAM_API_KEY) { console.error('❌ STEAM_API_KEY не задан'); process.exit(1); }
if (!process.env.DATABASE_URL && !process.env.DB_HOST) { console.error('❌ Нет БД'); process.exit(1); }

const STEAM_API_KEY = process.env.STEAM_API_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || `http://localhost:${PORT}`;
console.log('🔑 STEAM_API_KEY:', STEAM_API_KEY.slice(0, 8) + '...');

let pool;
if (process.env.DATABASE_URL) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
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
async function query(text, params) { return pool.query(text, params); }
pool.on('error', (err) => console.error('❌ PG pool:', err.message));

let yooKassa = null;
if (process.env.YKASSA_SHOP_ID && process.env.YKASSA_SECRET_KEY && YooKassa) {
    try { yooKassa = new YooKassa({ shopId: process.env.YKASSA_SHOP_ID, secretKey: process.env.YKASSA_SECRET_KEY }); console.log('✅ ЮKassa'); } catch {}
}

// ================== UPLOADS ==================
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_AUDIO_SIZE = 5 * 1024 * 1024;
const MAX_FILE_SIZE = 15 * 1024 * 1024;

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const date = new Date().toISOString().slice(0, 10);
        const dir = path.join(UPLOADS_DIR, date);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || '').toLowerCase().slice(0, 10);
        const safeExt = /^\.[a-z0-9]+$/.test(ext) ? ext : '';
        cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${safeExt}`);
    }
});
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-m4a'];
const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        const isImage = ALLOWED_IMAGE_TYPES.includes(file.mimetype);
        const isAudio = ALLOWED_AUDIO_TYPES.includes(file.mimetype);
        if (!isImage && !isAudio) return cb(new Error('Разрешены только изображения и аудио'));
        cb(null, true);
    }
});

// ================== УТИЛИТЫ ==================
function toCamelCase(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const n = {};
    for (const [k, v] of Object.entries(obj)) n[k.replace(/_([a-z])/g, (_, l) => l.toUpperCase())] = v;
    return n;
}
function safeJsonParse(v, f = null) {
    if (v === null || v === undefined) return f;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return f; }
}
function getRequestOrigin(req) {
    if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
    const proto = (req.headers['x-forwarded-proto']?.split(',')[0]) || req.protocol || 'http';
    return `${proto}://${req.get('host')}`;
}
function getAuthPayload(req) {
    try {
        const token = req.cookies && req.cookies.auth_token;
        if (!token) return null;
        return JSON.parse(Buffer.from(token, 'base64').toString());
    } catch { return null; }
}
function sanitizeString(str, max = 500) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, max);
}

// ================== RATE LIMIT ==================
const rateLimitBuckets = new Map();
function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    const b = rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > b.resetAt) { b.count = 0; b.resetAt = now + windowMs; }
    b.count++;
    rateLimitBuckets.set(key, b);
    return b.count <= limit;
}
function rateLimitMiddleware(limit, windowMs) {
    return (req, res, next) => {
        const p = getAuthPayload(req);
        const key = p ? `u:${p.userId}` : `ip:${req.ip}`;
        if (!rateLimit(key, limit, windowMs)) return res.status(429).json({ error: 'Слишком много запросов' });
        next();
    };
}

// ================== SSE ==================
const sseClients = new Map();
app.get('/api/events', (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    if (!sseClients.has(p.userId)) sseClients.set(p.userId, new Set());
    sseClients.get(p.userId).add(res);
    req.on('close', () => {
        clearInterval(hb);
        const set = sseClients.get(p.userId);
        if (set) { set.delete(res); if (set.size === 0) sseClients.delete(p.userId); }
    });
});
function pushEvent(userId, type, data) {
    const set = sseClients.get(userId);
    if (!set || set.size === 0) return;
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of set) { try { c.write(msg); } catch {} }
}

// ================== USERS ==================
async function findUserBySteamId(steamId) {
    const r = await query('SELECT * FROM users WHERE steam_id = $1', [steamId]);
    return r.rows[0] ? toCamelCase(r.rows[0]) : null;
}
async function findUserById(userId) {
    const r = await query('SELECT * FROM users WHERE id = $1', [userId]);
    return r.rows[0] ? toCamelCase(r.rows[0]) : null;
}
async function createUser(u) {
    const r = await query(`
        INSERT INTO users (id, steam_id, steam_nickname, steam_avatar, display_name, region, role, has_mic, bio, balance, is_admin, is_banned, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING *
    `, [u.id, u.steam_id, u.steam_nickname, u.steam_avatar, u.display_name, u.region, u.role, u.has_mic, u.bio, u.balance, u.is_admin, u.is_banned]);
    return toCamelCase(r.rows[0]);
}
async function updateUser(steamId, updates) {
    const fields = [], values = [];
    let i = 1;
    for (const [k, v] of Object.entries(updates)) {
        fields.push(`${k.replace(/([A-Z])/g, '_$1').toLowerCase()} = $${i}`);
        values.push(v); i++;
    }
    values.push(steamId);
    const r = await query(`UPDATE users SET ${fields.join(', ')} WHERE steam_id = $${i} RETURNING *`, values);
    return r.rows[0] ? toCamelCase(r.rows[0]) : null;
}
async function getAllUsers() {
    const r = await query('SELECT * FROM users ORDER BY created_at DESC');
    return r.rows.map(x => { try { return toCamelCase(x); } catch { return null; } }).filter(Boolean);
}

// ================== STEAM INVENTORY ==================
const RARITY_COLORS = {
    'Consumer Grade': '#b0c3d9', 'Industrial Grade': '#5e98d9', 'Mil-Spec Grade': '#4b69ff',
    'Restricted': '#8847ff', 'Classified': '#d32ce6', 'Covert': '#eb4b4b',
    'Contraband': '#e4ae39', 'Extraordinary': '#eb4b4b', 'Base Grade': '#b0c3d9',
    'High Grade': '#4b69ff', 'Exotic': '#8847ff', 'Remarkable': '#d32ce6',
    'Common': '#b0c3d9', 'Uncommon': '#5e98d9', 'Rare': '#4b69ff',
    'Mythical': '#8847ff', 'Legendary': '#d32ce6', 'Ancient': '#eb4b4b'
};
const RARITY_ORDER = {
    'Consumer Grade': 1, 'Industrial Grade': 2, 'Mil-Spec Grade': 3, 'Restricted': 4,
    'Classified': 5, 'Covert': 6, 'Contraband': 7, 'Extraordinary': 6, 'Base Grade': 1,
    'High Grade': 3, 'Exotic': 4, 'Remarkable': 5, 'Common': 1, 'Uncommon': 2,
    'Rare': 3, 'Mythical': 4, 'Legendary': 5, 'Ancient': 6
};
const inventoryCooldown = new Map();

async function fetchSteamInventory(steamId) {
    const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=5000`;
    console.log('🎒 Fetching:', url);
    try {
        const r = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Referer': `https://steamcommunity.com/profiles/${steamId}/inventory/`
            },
            timeout: 20000, validateStatus: () => true
        });
        console.log('🎒 Status:', r.status, '| CT:', r.headers['content-type']);
        if (r.status === 429) {
            inventoryCooldown.set(steamId, Date.now() + 5 * 60 * 1000);
            return { success: false, error: 'rate_limited', retryAfterSeconds: 300, items: [], total: 0 };
        }
        if (typeof r.data === 'string' && r.data.includes('<html')) {
            inventoryCooldown.set(steamId, Date.now() + 5 * 60 * 1000);
            return { success: false, error: 'steam_blocked', retryAfterSeconds: 300, items: [], total: 0 };
        }
        if (r.status !== 200) return { success: false, error: `http_${r.status}`, items: [], total: 0 };
        if (!r.data || r.data.success !== 1) {
            return { success: false, error: r.data?.Error ? 'steam_error' : 'private_or_empty', message: r.data?.Error || null, items: [], total: 0 };
        }
        const assets = r.data.assets || [];
        const descriptions = r.data.descriptions || [];
        console.log(`🎒 assets=${assets.length}, descriptions=${descriptions.length}`);
        if (assets.length === 0) return { success: true, items: [], total: 0, empty: true };
        const descMap = new Map();
        for (const d of descriptions) descMap.set(`${d.classid}_${d.instanceid}`, d);
        const items = assets.map(a => {
            const d = descMap.get(`${a.classid}_${a.instanceid}`) || {};
            const rarityTag = d.tags?.find(t => t.category === 'Rarity')?.localized_tag_name || 'Common';
            const rarityColorHex = d.tags?.find(t => t.category === 'Rarity')?.color || (RARITY_COLORS[rarityTag] || '#b0c3d9').replace('#', '');
            return {
                assetId: a.assetid, classId: a.classid,
                name: d.market_hash_name || d.name || 'Unknown Item',
                displayName: d.name || 'Unknown Item',
                icon: d.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${d.icon_url}/330x192` : null,
                iconLarge: d.icon_url_large ? `https://community.cloudflare.steamstatic.com/economy/image/${d.icon_url_large}/512x512` : (d.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${d.icon_url}/512x512` : null),
                rarity: rarityTag, rarityColor: `#${rarityColorHex.replace('#', '')}`,
                type: d.tags?.find(t => t.category === 'Type')?.localized_tag_name || 'Item',
                exterior: d.tags?.find(t => t.category === 'Exterior')?.localized_tag_name || '',
                quality: d.tags?.find(t => t.category === 'Quality')?.localized_tag_name || '',
                weapon: d.tags?.find(t => t.category === 'Weapon')?.localized_tag_name || '',
                collection: d.tags?.find(t => t.category === 'Collection')?.localized_tag_name || '',
                tradable: d.tradable === 1, marketable: d.marketable === 1,
                quantity: parseInt(a.amount, 10) || 1, rarityRank: RARITY_ORDER[rarityTag] || 1
            };
        });
        const total = items.reduce((s, it) => s + it.quantity, 0);
        return { success: true, items, total };
    } catch (e) {
        console.error('🎒 Exception:', e.message);
        return { success: false, error: 'fetch_failed', message: e.message, items: [], total: 0 };
    }
}
async function getCachedInventory(steamId, maxAgeMinutes = 30) {
    const r = await query('SELECT * FROM inventory_cache WHERE steam_id = $1', [steamId]);
    if (r.rows.length === 0) return null;
    const c = r.rows[0];
    if ((Date.now() - new Date(c.fetched_at).getTime()) / 60000 > maxAgeMinutes) return null;
    return { items: safeJsonParse(c.items, []), total: c.total, fetchedAt: c.fetched_at, cached: true, success: true };
}
async function saveInventoryCache(steamId, items, total) {
    await query(`INSERT INTO inventory_cache (steam_id, items, total, fetched_at) VALUES ($1, $2, $3, NOW())
        ON CONFLICT (steam_id) DO UPDATE SET items = $2, total = $3, fetched_at = NOW()`,
        [steamId, JSON.stringify(items), total]);
}
async function refreshInventory(steamId, force = false) {
    const cd = inventoryCooldown.get(steamId);
    if (cd && Date.now() < cd) {
        const sec = Math.ceil((cd - Date.now()) / 1000);
        const anyCache = await query('SELECT * FROM inventory_cache WHERE steam_id = $1', [steamId]);
        if (anyCache.rows.length > 0) {
            const c = anyCache.rows[0];
            return { success: true, items: safeJsonParse(c.items, []), total: c.total, fetchedAt: c.fetched_at, cached: true, stale: true };
        }
        return { success: false, error: 'rate_limited', retryAfterSeconds: sec, items: [], total: 0 };
    }
    if (!force) { const c = await getCachedInventory(steamId); if (c) return c; }
    const fresh = await fetchSteamInventory(steamId);
    if (!fresh.success) {
        if (fresh.error === 'rate_limited' || fresh.error === 'steam_blocked') {
            const anyCache = await query('SELECT * FROM inventory_cache WHERE steam_id = $1', [steamId]);
            if (anyCache.rows.length > 0) {
                const c = anyCache.rows[0];
                return { success: true, items: safeJsonParse(c.items, []), total: c.total, fetchedAt: c.fetched_at, cached: true, stale: true, retryAfterSeconds: fresh.retryAfterSeconds };
            }
        }
        return fresh;
    }
    fresh.items.sort((a, b) => (b.rarityRank - a.rarityRank) || a.name.localeCompare(b.name));
    try { await saveInventoryCache(steamId, fresh.items, fresh.total); } catch {}
    return { ...fresh, cached: false };
}

// ================== LFG ==================
async function getActiveLfgPosts() {
    const r = await query(`
        SELECT l.*, json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname,
            'steamAvatar', u.steam_avatar, 'displayName', u.display_name, 'region', u.region, 'role', u.role) as author,
            COALESCE(accepted.accepted_players, '[]'::json) as accepted_players,
            COALESCE(pending.pending_responses_count, 0) as pending_responses_count
        FROM lfg_posts l JOIN users u ON l.author_id = u.id
        LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id', r.id, 'role', r.role,
            'user', json_build_object('id', ru.id, 'steamId', ru.steam_id, 'steamNickname', ru.steam_nickname,
                'steamAvatar', ru.steam_avatar, 'displayName', ru.display_name)) ORDER BY r.created_at ASC) as accepted_players
            FROM lfg_responses r JOIN users ru ON r.user_id = ru.id WHERE r.post_id = l.id AND r.status = 'accepted') accepted ON true
        LEFT JOIN LATERAL (SELECT COUNT(*)::int as pending_responses_count FROM lfg_responses r WHERE r.post_id = l.id AND r.status = 'pending') pending ON true
        WHERE l.status = 'active' ORDER BY l.created_at DESC`);
    return r.rows.map(toCamelCase);
}
async function getCompletedLfgPosts() {
    const r = await query(`
        SELECT l.*, json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname,
            'steamAvatar', u.steam_avatar, 'displayName', u.display_name, 'region', u.region, 'role', u.role) as author,
            COALESCE(accepted.accepted_players, '[]'::json) as accepted_players, l.review
        FROM lfg_posts l JOIN users u ON l.author_id = u.id
        LEFT JOIN LATERAL (SELECT json_agg(json_build_object('id', r.id, 'role', r.role,
            'user', json_build_object('id', ru.id, 'steamId', ru.steam_id, 'steamNickname', ru.steam_nickname,
                'steamAvatar', ru.steam_avatar, 'displayName', ru.display_name)) ORDER BY r.created_at ASC) as accepted_players
            FROM lfg_responses r JOIN users ru ON r.user_id = ru.id WHERE r.post_id = l.id AND r.status = 'accepted') accepted ON true
        WHERE l.status = 'completed' ORDER BY l.completed_at DESC`);
    return r.rows.map(toCamelCase);
}
async function createLfgPost(p) {
    const r = await query(`INSERT INTO lfg_posts (id, author_id, title, region, my_role, schedule_type, schedule, week_schedule,
        players_needed, roles_needed, min_faceit_level, min_premier_rank, description, language, status, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',NOW()) RETURNING *`,
        [p.id, p.authorId, p.title, p.region, p.myRole, p.scheduleType, p.schedule,
            JSON.stringify(p.weekSchedule || {}), p.playersNeeded, JSON.stringify(p.rolesNeeded),
            p.minFaceitLevel || 1, p.minPremierRank || 0, p.description || '', p.language || 'ru']);
    return toCamelCase(r.rows[0]);
}
async function addResponseToLfg(postId, userId, role, message) {
    const dup = await query('SELECT 1 FROM lfg_responses WHERE post_id=$1 AND user_id=$2 AND status IN ($3,$4)', [postId, userId, 'pending', 'accepted']);
    if (dup.rows.length > 0) throw new Error('Вы уже откликались');
    const postRes = await query('SELECT author_id, players_needed, roles_needed FROM lfg_posts WHERE id=$1 AND status=$2', [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id === userId) throw new Error('Нельзя на свою');
    const rn = safeJsonParse(postRes.rows[0].roles_needed, {});
    if (!rn[role]) throw new Error('Роль занята');
    const cnt = await query('SELECT COUNT(*) FROM lfg_responses WHERE post_id=$1 AND status=$2', [postId, 'accepted']);
    if (parseInt(cnt.rows[0].count, 10) >= postRes.rows[0].players_needed) throw new Error('Все места заняты');
    const r = await query(`INSERT INTO lfg_responses (id, post_id, user_id, role, message, status, created_at)
        VALUES ($1,$2,$3,$4,$5,'pending',NOW()) RETURNING *`,
        [`resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, postId, userId, role, message || '']);
    return toCamelCase(r.rows[0]);
}
async function getLfgResponses(postId) {
    const r = await query(`SELECT r.*, json_build_object('id', u.id, 'steamId', u.steam_id, 'steamNickname', u.steam_nickname,
        'steamAvatar', u.steam_avatar, 'displayName', u.display_name) as user
        FROM lfg_responses r JOIN users u ON r.user_id = u.id WHERE r.post_id=$1 AND r.status='pending' ORDER BY r.created_at ASC`, [postId]);
    return r.rows.map(toCamelCase);
}
async function acceptResponse(postId, responseId, authorId) {
    const postRes = await query('SELECT author_id, players_needed, roles_needed FROM lfg_posts WHERE id=$1 AND status=$2', [postId, 'active']);
    if (postRes.rows.length === 0) throw new Error('Не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    const rr = await query('SELECT role FROM lfg_responses WHERE id=$1 AND post_id=$2 AND status=$3', [responseId, postId, 'pending']);
    if (rr.rows.length === 0) throw new Error('Отклик не найден');
    const role = rr.rows[0].role;
    const rn = safeJsonParse(postRes.rows[0].roles_needed, {});
    if (!rn[role]) throw new Error('Роль занята');
    const cnt = await query('SELECT COUNT(*) FROM lfg_responses WHERE post_id=$1 AND status=$2', [postId, 'accepted']);
    if (parseInt(cnt.rows[0].count, 10) >= postRes.rows[0].players_needed) throw new Error('Места заняты');
    await query('UPDATE lfg_responses SET status=$1 WHERE post_id=$2 AND role=$3 AND status=$4', ['rejected', postId, role, 'pending']);
    await query('UPDATE lfg_responses SET status=$1 WHERE id=$2', ['accepted', responseId]);
    await query(`UPDATE lfg_posts SET roles_needed = jsonb_set(roles_needed, $1, 'false'::jsonb) WHERE id=$2`, [`{${role}}`, postId]);
    return true;
}
async function rejectResponse(postId, responseId, authorId) {
    const p = await query('SELECT author_id FROM lfg_posts WHERE id=$1', [postId]);
    if (p.rows.length === 0) throw new Error('Не найдена');
    if (p.rows[0].author_id !== authorId) throw new Error('Нет прав');
    await query('UPDATE lfg_responses SET status=$1 WHERE id=$2', ['rejected', responseId]);
    return true;
}
async function completeLfgPost(postId, authorId) {
    const p = await query('SELECT author_id, players_needed FROM lfg_posts WHERE id=$1 AND status=$2', [postId, 'active']);
    if (p.rows.length === 0) throw new Error('Не найдена');
    if (p.rows[0].author_id !== authorId) throw new Error('Нет прав');
    const cnt = await query('SELECT COUNT(*) FROM lfg_responses WHERE post_id=$1 AND status=$2', [postId, 'accepted']);
    if (parseInt(cnt.rows[0].count, 10) < p.rows[0].players_needed) throw new Error(`Нужно ${p.rows[0].players_needed} игроков`);
    await query('UPDATE lfg_posts SET status=$1, completed_at=NOW() WHERE id=$2', ['completed', postId]);
    return true;
}
async function addReviewToLfg(postId, authorId, rating, comment) {
    const p = await query('SELECT author_id FROM lfg_posts WHERE id=$1 AND status=$2', [postId, 'completed']);
    if (p.rows.length === 0) throw new Error('Не найдена');
    if (p.rows[0].author_id !== authorId) throw new Error('Нет прав');
    const r = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
    const c = sanitizeString(comment, 200);
    if (!r || !c) throw new Error('Нужна оценка и комментарий');
    await query('UPDATE lfg_posts SET review=$1 WHERE id=$2', [JSON.stringify({ rating: r, comment: c, createdAt: new Date().toISOString() }), postId]);
    const acc = await query('SELECT user_id FROM lfg_responses WHERE post_id=$1 AND status=$2', [postId, 'accepted']);
    for (const row of acc.rows) await query('UPDATE users SET rating = rating + 10, matches_played = matches_played + 1 WHERE id=$1', [row.user_id]);
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
    const r = await query(`SELECT u.id, u.steam_id, u.steam_nickname, u.steam_avatar, u.display_name, u.region, u.role, u.balance
        FROM users u JOIN friends f ON f.friend_id = u.id WHERE f.user_id = $1`, [userId]);
    return r.rows.map(toCamelCase);
}
async function sendFriendRequest(id, fromId, toId) {
    await query(`INSERT INTO friend_requests (id, from_id, to_id, status, created_at) VALUES ($1,$2,$3,'pending',NOW())`, [id, fromId, toId]);
}
async function getFriendRequests(toUserId) {
    const r = await query(`SELECT fr.*, u.steam_nickname as from_name, u.steam_avatar as from_avatar
        FROM friend_requests fr JOIN users u ON fr.from_id = u.id WHERE fr.to_id = $1 AND fr.status='pending' ORDER BY fr.created_at DESC`, [toUserId]);
    return r.rows.map(toCamelCase);
}
async function getSentFriendRequests(fromUserId) {
    const r = await query(`SELECT fr.*, u.steam_nickname as to_name, u.steam_avatar as to_avatar
        FROM friend_requests fr JOIN users u ON fr.to_id = u.id WHERE fr.from_id = $1 AND fr.status='pending' ORDER BY fr.created_at DESC`, [fromUserId]);
    return r.rows.map(toCamelCase);
}
async function acceptFriendRequest(requestId, toUserId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query('SELECT from_id, to_id FROM friend_requests WHERE id=$1 AND to_id=$2 AND status=$3', [requestId, toUserId, 'pending']);
        if (r.rows.length === 0) throw new Error('Not found');
        await client.query('INSERT INTO friends (user_id, friend_id) VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING', [r.rows[0].from_id, r.rows[0].to_id]);
        await client.query('UPDATE friend_requests SET status=$1 WHERE id=$2', ['accepted', requestId]);
        await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    return true;
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
    const r = await query(`SELECT * FROM messages WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1) ORDER BY created_at ASC`, [userId, otherId]);
    return r.rows.map(toCamelCase);
}
async function createMessage(m) {
    const r = await query(`
        INSERT INTO messages (id, from_id, to_id, text, read, created_at,
            attachment_type, attachment_url, attachment_name, attachment_size, attachment_duration)
        VALUES ($1,$2,$3,$4,false,NOW(),$5,$6,$7,$8,$9) RETURNING *`,
        [m.id, m.from_id, m.to_id, m.text || '',
            m.attachmentType || null, m.attachmentUrl || null, m.attachmentName || null,
            m.attachmentSize || null, m.attachmentDuration || null]);
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
    const r = await query(`INSERT INTO tournaments (id, title, description, prize_pool, date, status, entry_fee, max_teams, format, rules, schedule, registered_teams)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [t.id, t.title, t.description, t.prize_pool, t.date, t.status, t.entry_fee, t.max_teams, t.format, t.rules, t.schedule, JSON.stringify(t.registered_teams || [])]);
    return toCamelCase(r.rows[0]);
}

// ================== INIT DB ==================
async function initPostgresDB() {
    const c = await pool.connect();
    try {
        await c.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, steam_id TEXT UNIQUE NOT NULL, steam_nickname TEXT NOT NULL, steam_avatar TEXT, display_name TEXT, region TEXT DEFAULT 'RU', role TEXT DEFAULT 'RIFLER', has_mic BOOLEAN DEFAULT FALSE, bio TEXT, balance INTEGER DEFAULT 1000, is_admin BOOLEAN DEFAULT FALSE, is_banned BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW(), settings JSONB)`);
        await c.query(`CREATE TABLE IF NOT EXISTS lfg_posts (id TEXT PRIMARY KEY, author_id TEXT REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, region TEXT NOT NULL, my_role TEXT NOT NULL, schedule_type TEXT DEFAULT 'daily', schedule TEXT NOT NULL, week_schedule JSONB, players_needed INTEGER DEFAULT 1, roles_needed JSONB NOT NULL, min_faceit_level INTEGER DEFAULT 1, min_premier_rank INTEGER DEFAULT 0, description TEXT, language TEXT DEFAULT 'ru', status TEXT DEFAULT 'active', review JSONB, created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP)`);
        await c.query(`CREATE TABLE IF NOT EXISTS lfg_responses (id TEXT PRIMARY KEY, post_id TEXT REFERENCES lfg_posts(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, message TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW())`);
        await c.query(`CREATE TABLE IF NOT EXISTS friends (user_id TEXT REFERENCES users(id) ON DELETE CASCADE, friend_id TEXT REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (user_id, friend_id))`);
        await c.query(`CREATE TABLE IF NOT EXISTS friend_requests (id TEXT PRIMARY KEY, from_id TEXT REFERENCES users(id) ON DELETE CASCADE, to_id TEXT REFERENCES users(id) ON DELETE CASCADE, created_at TIMESTAMP DEFAULT NOW(), status TEXT DEFAULT 'pending')`);
        await c.query(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_id TEXT REFERENCES users(id) ON DELETE CASCADE, to_id TEXT REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL DEFAULT '', read BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW())`);
        await c.query(`CREATE TABLE IF NOT EXISTS tournaments (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, prize_pool TEXT, date TIMESTAMP, status TEXT DEFAULT 'UPCOMING', entry_fee INTEGER DEFAULT 0, max_teams INTEGER DEFAULT 16, registered_teams JSONB, format TEXT, rules TEXT, schedule TEXT, created_at TIMESTAMP DEFAULT NOW())`);
        await c.query(`CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, amount INTEGER NOT NULL, status TEXT DEFAULT 'pending', yookassa_id TEXT, created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP)`);
        await c.query(`CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, tag TEXT, logo_url TEXT, description TEXT, captain_id TEXT REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMP DEFAULT NOW())`);
        await c.query(`CREATE TABLE IF NOT EXISTS team_members (team_id TEXT REFERENCES teams(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, role TEXT DEFAULT 'MEMBER', joined_at TIMESTAMP DEFAULT NOW(), PRIMARY KEY (team_id, user_id))`);
        await c.query(`CREATE TABLE IF NOT EXISTS team_invites (id TEXT PRIMARY KEY, team_id TEXT REFERENCES teams(id) ON DELETE CASCADE, from_id TEXT REFERENCES users(id) ON DELETE CASCADE, to_id TEXT REFERENCES users(id) ON DELETE CASCADE, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT NOW())`);
        await c.query(`CREATE TABLE IF NOT EXISTS tournament_teams (id TEXT PRIMARY KEY, tournament_id TEXT REFERENCES tournaments(id) ON DELETE CASCADE, team_name TEXT NOT NULL, captain_id TEXT REFERENCES users(id) ON DELETE CASCADE, players JSONB NOT NULL, status TEXT DEFAULT 'registered', created_at TIMESTAMP DEFAULT NOW())`);
        await c.query(`CREATE TABLE IF NOT EXISTS inventory_cache (steam_id TEXT PRIMARY KEY, items JSONB NOT NULL, total INTEGER DEFAULT 0, fetched_at TIMESTAMP DEFAULT NOW())`);

        const migr = [
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS faceit_url TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_url TEXT`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS matches_played INTEGER DEFAULT 0`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS rating INTEGER DEFAULT 1000`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT DEFAULT 'Новичок'`,
            `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type TEXT`,
            `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT`,
            `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT`,
            `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_size INTEGER`,
            `ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_duration INTEGER`
        ];
        for (const m of migr) { try { await c.query(m); } catch {} }

        const ac = await c.query('SELECT COUNT(*) FROM users WHERE is_admin=true');
        if (parseInt(ac.rows[0].count, 10) === 0) {
            const f = await c.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
            if (f.rows.length > 0) { await c.query('UPDATE users SET is_admin=true WHERE id=$1', [f.rows[0].id]); console.log('👑 Первый = админ'); }
        }
        console.log('✅ PostgreSQL OK');
    } catch (err) { console.error('❌ DB:', err); throw err; } finally { c.release(); }
}

// ================== AUTH ==================
app.get('/api/auth/steam', (req, res) => {
    const origin = getRequestOrigin(req);
    res.redirect(`https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(`${origin}/api/auth/steam/callback`)}&openid.realm=${encodeURIComponent(origin)}&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`);
});
app.get('/api/auth/steam/callback', async (req, res) => {
    const fUrl = process.env.FRONTEND_URL || getRequestOrigin(req);
    const claimedId = req.query['openid.claimed_id'];
    if (!claimedId) return res.redirect(`${fUrl}/?error=auth_failed`);
    const steamId = claimedId.split('/').pop();
    try {
        const r = await axios.get(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`);
        const su = r.data.response?.players?.[0];
        if (!su) return res.redirect(`${fUrl}/?error=steam_api_failed`);
        let user = await findUserBySteamId(steamId);
        if (!user) {
            const cnt = await query('SELECT COUNT(*) FROM users');
            user = await createUser({
                id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                steam_id: steamId, steam_nickname: su.personaname, steam_avatar: su.avatarfull,
                display_name: su.personaname, region: 'RU', role: 'RIFLER', has_mic: false, bio: '',
                balance: 1000, is_admin: parseInt(cnt.rows[0].count, 10) === 0, is_banned: false
            });
            const tc = await query('SELECT COUNT(*) FROM tournaments');
            if (parseInt(tc.rows[0].count, 10) === 0) {
                await createTournament({
                    id: `tourn_${Date.now()}`, title: 'BARSIDE CUP #1',
                    description: 'Главный турнир сезона', prize_pool: '50000₽',
                    date: new Date(Date.now() + 7 * 86400000).toISOString(),
                    status: 'UPCOMING', entry_fee: 500, max_teams: 16, format: '5x5',
                    rules: 'Best of 3', schedule: 'Первые выходные', registered_teams: []
                });
            }
        } else {
            await updateUser(steamId, { steam_nickname: su.personaname, steam_avatar: su.avatarfull });
            user = await findUserBySteamId(steamId);
        }
        const tok = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steam_id })).toString('base64');
        res.cookie('auth_token', tok, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
        res.redirect(`${fUrl}/`);
    } catch (e) { console.error('Steam auth:', e.message); res.redirect(`${fUrl}/?error=auth_failed`); }
});
app.post('/api/auth/logout', (req, res) => { res.clearCookie('auth_token'); res.json({ success: true }); });
app.get('/api/auth/me', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.json({ data: null });
    try { res.json({ data: await findUserById(p.userId) }); } catch { res.json({ data: null }); }
});

// ================== PROFILE ==================
app.get('/api/profile/:steamId', async (req, res) => {
    try {
        const u = await findUserBySteamId(req.params.steamId);
        if (!u) return res.status(404).json({ error: 'Not found' });
        res.json({ user: u });
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/profile/:steamId', rateLimitMiddleware(20, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const cur = await findUserById(p.userId);
        const target = await findUserBySteamId(req.params.steamId);
        if (!target) return res.status(404).json({ error: 'Not found' });
        if (target.id !== p.userId && !cur?.isAdmin) return res.status(403).json({ error: 'Forbidden' });
        const map = { displayName: 'display_name', region: 'region', role: 'role', hasMic: 'has_mic', bio: 'bio', avatarUrl: 'avatar_url', bannerUrl: 'banner_url', faceitUrl: 'faceit_url', steamUrl: 'steam_url' };
        const upd = {};
        for (const [k, col] of Object.entries(map)) {
            if (req.body[k] !== undefined) upd[col] = typeof req.body[k] === 'string' ? req.body[k].trim().slice(0, 500) : req.body[k];
        }
        if (Object.keys(upd).length) {
            const f = Object.keys(upd).map((c, i) => `${c} = $${i + 1}`).join(', ');
            const v = [...Object.values(upd), req.params.steamId];
            await query(`UPDATE users SET ${f} WHERE steam_id = $${v.length}`, v);
        }
        res.json({ user: await findUserBySteamId(req.params.steamId) });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// ================== STATS ==================
app.get('/api/stats', async (req, res) => {
    try {
        const [u, l, t] = await Promise.all([
            query('SELECT COUNT(*) FROM users'),
            query("SELECT COUNT(*) FROM lfg_posts WHERE status='active'"),
            query('SELECT COUNT(*) FROM tournaments')
        ]);
        res.json({ totalUsers: parseInt(u.rows[0].count, 10), totalLfgPosts: parseInt(l.rows[0].count, 10), totalTournaments: parseInt(t.rows[0].count, 10), online: 1 });
    } catch { res.json({ totalUsers: 0, totalLfgPosts: 0, totalTournaments: 0, online: 0 }); }
});

// ================== LFG ROUTES ==================
app.get('/api/lfg', async (req, res) => { try { res.json({ data: await getActiveLfgPosts() }); } catch { res.json({ data: [] }); } });
app.get('/api/lfg/completed', async (req, res) => { try { res.json({ data: await getCompletedLfgPosts() }); } catch { res.json({ data: [] }); } });
app.post('/api/lfg', rateLimitMiddleware(5, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const { title, region, myRole, scheduleType, schedule, weekSchedule, playersNeeded, rolesNeeded, minFaceitLevel, minPremierRank, description, language } = req.body;
        if (!title || !region || !myRole) return res.status(400).json({ error: 'Заполните поля' });
        const allowed = ['IGL', 'AWP', 'ENTRY', 'RIFLER', 'LURKER'];
        const cnt = Math.max(1, Math.min(4, parseInt(playersNeeded, 10) || 1));
        if (!allowed.includes(myRole)) return res.status(400).json({ error: 'Bad role' });
        const sel = Object.entries(rolesNeeded || {}).filter(([, v]) => v).map(([k]) => k);
        if (sel.length !== cnt) return res.status(400).json({ error: `Нужно ${cnt} ролей` });
        if (sel.includes(myRole)) return res.status(400).json({ error: 'Ваша роль занята' });
        const norm = Object.fromEntries(allowed.map(r => [r, sel.includes(r)]));
        const created = await createLfgPost({
            id: `lfg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, authorId: user.id,
            title: sanitizeString(title, 100), region: sanitizeString(region, 10), myRole,
            scheduleType: scheduleType || 'daily', schedule: sanitizeString(schedule, 200),
            weekSchedule: weekSchedule || {}, playersNeeded: cnt, rolesNeeded: norm,
            minFaceitLevel: parseInt(minFaceitLevel, 10) || 1, minPremierRank: parseInt(minPremierRank, 10) || 0,
            description: sanitizeString(description, 500), language: language || 'ru'
        });
        res.status(201).json({ data: created });
    } catch { res.status(500).json({ error: 'Server error' }); }
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
        if (post.rows[0]) pushEvent(post.rows[0].author_id, 'new-response', { postId: req.params.postId, fromUserId: user.id, role });
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
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/lfg/responses/unread', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const r = await query(`SELECT COUNT(*) FROM lfg_responses r JOIN lfg_posts p ON r.post_id = p.id WHERE p.author_id=$1 AND p.status='active' AND r.status='pending'`, [p.userId]);
        res.json({ count: parseInt(r.rows[0].count, 10) || 0 });
    } catch { res.json({ count: 0 }); }
});
app.post('/api/lfg/:postId/responses/:responseId/accept', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        await acceptResponse(req.params.postId, req.params.responseId, user.id);
        const r = await query('SELECT user_id FROM lfg_responses WHERE id=$1', [req.params.responseId]);
        if (r.rows[0]) pushEvent(r.rows[0].user_id, 'response-accepted', { postId: req.params.postId });
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/lfg/:postId/responses/:responseId/reject', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { const u = await findUserById(p.userId); await rejectResponse(req.params.postId, req.params.responseId, u.id); res.json({ success: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/lfg/:postId/complete', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { const u = await findUserById(p.userId); await completeLfgPost(req.params.postId, u.id); res.json({ success: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/lfg/:postId/review', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const u = await findUserById(p.userId);
        const { rating, comment } = req.body;
        if (!rating || !comment) return res.status(400).json({ error: 'Rating required' });
        await addReviewToLfg(req.params.postId, u.id, rating, comment);
        res.json({ success: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/lfg/:id', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const u = await findUserById(p.userId);
        const ok = await deleteLfgPost(req.params.id, u.id, u.isAdmin);
        if (!ok) return res.status(404).json({ error: 'Not found' });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// ================== FRIENDS ROUTES ==================
app.get('/api/friends', async (req, res) => { const p = getAuthPayload(req); if (!p) return res.status(401).json({ error: 'Unauthorized' }); try { res.json({ data: await getFriends(p.userId) }); } catch { res.status(500).json({ error: 'Server error' }); } });
app.get('/api/friends/requests', async (req, res) => { const p = getAuthPayload(req); if (!p) return res.status(401).json({ error: 'Unauthorized' }); try { res.json({ data: await getFriendRequests(p.userId) }); } catch { res.status(500).json({ error: 'Server error' }); } });
app.get('/api/friends/requests/sent', async (req, res) => { const p = getAuthPayload(req); if (!p) return res.status(401).json({ error: 'Unauthorized' }); try { res.json({ data: await getSentFriendRequests(p.userId) }); } catch { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/friends/request/:userId', rateLimitMiddleware(20, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const fromU = await findUserById(p.userId);
        const toU = await findUserById(req.params.userId);
        if (!fromU || !toU) return res.status(404).json({ error: 'Not found' });
        if (fromU.id === req.params.userId) return res.status(400).json({ error: 'Нельзя себя' });
        const ex = await query('SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2 AND status=$3', [fromU.id, req.params.userId, 'pending']);
        if (ex.rows.length > 0) return res.status(400).json({ error: 'Уже отправлена' });
        const af = await query('SELECT 1 FROM friends WHERE user_id=$1 AND friend_id=$2', [fromU.id, req.params.userId]);
        if (af.rows.length > 0) return res.status(400).json({ error: 'Уже друзья' });
        await sendFriendRequest(`fr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, fromU.id, req.params.userId);
        pushEvent(req.params.userId, 'friend-request', { fromId: fromU.id, fromName: fromU.displayName });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/friends/request/:requestId/accept', async (req, res) => { const p = getAuthPayload(req); if (!p) return res.status(401).json({ error: 'Unauthorized' }); try { await acceptFriendRequest(req.params.requestId, p.userId); res.json({ success: true }); } catch { res.status(500).json({ error: 'Server error' }); } });
app.post('/api/friends/request/:requestId/decline', async (req, res) => { const p = getAuthPayload(req); if (!p) return res.status(401).json({ error: 'Unauthorized' }); try { await declineFriendRequest(req.params.requestId, p.userId); res.json({ success: true }); } catch { res.status(500).json({ error: 'Server error' }); } });
app.delete('/api/friends/request/:requestId', async (req, res) => { const p = getAuthPayload(req); if (!p) return res.status(401).json({ error: 'Unauthorized' }); try { const ok = await cancelFriendRequest(req.params.requestId, p.userId); if (!ok) return res.status(404).json({ error: 'Not found' }); res.json({ success: true }); } catch { res.status(500).json({ error: 'Server error' }); } });
app.delete('/api/friends/:friendId', async (req, res) => { const p = getAuthPayload(req); if (!p) return res.status(401).json({ error: 'Unauthorized' }); try { await removeFriend(p.userId, req.params.friendId); res.json({ success: true }); } catch { res.status(500).json({ error: 'Server error' }); } });

// ================== UPLOAD ==================
app.post('/api/upload', rateLimitMiddleware(30, 60000), (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Файл больше 15 МБ' });
            return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
        }
        if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
        const isImage = req.file.mimetype.startsWith('image/');
        const isAudio = req.file.mimetype.startsWith('audio/');
        if (isImage && req.file.size > MAX_IMAGE_SIZE) {
            try { fs.unlinkSync(req.file.path); } catch {}
            return res.status(400).json({ error: 'Изображение больше 10 МБ' });
        }
        if (isAudio && req.file.size > MAX_AUDIO_SIZE) {
            try { fs.unlinkSync(req.file.path); } catch {}
            return res.status(400).json({ error: 'Голосовое больше 5 МБ' });
        }
        const date = new Date().toISOString().slice(0, 10);
        const url = `/uploads/${date}/${req.file.filename}`;
        res.json({ success: true, url, type: isImage ? 'image' : 'audio', name: req.file.originalname, size: req.file.size });
    });
});

// ================== MESSAGES ==================
app.get('/api/messages/:userId', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const msgs = await getMessages(p.userId, req.params.userId);
        await markMessagesAsRead(p.userId, req.params.userId);
        res.json({ data: msgs });
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/messages/:userId', rateLimitMiddleware(60, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const text = sanitizeString(req.body.text || '', 2000);
        const attachmentType = req.body.attachmentType ? sanitizeString(req.body.attachmentType, 20) : null;
        const attachmentUrl = req.body.attachmentUrl ? sanitizeString(req.body.attachmentUrl, 500) : null;
        const attachmentName = req.body.attachmentName ? sanitizeString(req.body.attachmentName, 200) : null;
        const attachmentSize = req.body.attachmentSize ? parseInt(req.body.attachmentSize, 10) || null : null;
        const attachmentDuration = req.body.attachmentDuration ? parseInt(req.body.attachmentDuration, 10) || null : null;
        if (!text && !attachmentUrl) return res.status(400).json({ error: 'Пустое сообщение' });
        if (attachmentUrl && !attachmentUrl.startsWith('/uploads/')) return res.status(400).json({ error: 'Неверный URL вложения' });
        const created = await createMessage({
            id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            from_id: p.userId, to_id: req.params.userId, text,
            attachmentType, attachmentUrl, attachmentName, attachmentSize, attachmentDuration
        });
        pushEvent(req.params.userId, 'new-message', { fromId: p.userId, text: text || '📎', at: new Date().toISOString() });
        res.json({ success: true, message: created });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/messages/unread/count', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try { res.json({ count: await getUnreadCount(p.userId) }); } catch { res.json({ count: 0 }); }
});
app.get('/api/user/by-id/:userId', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const u = await findUserById(req.params.userId);
        if (!u) return res.status(404).json({ error: 'Not found' });
        res.json({ user: u });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// ================== INVENTORY ROUTES ==================
app.get('/api/inventory/:steamId', async (req, res) => {
    const { steamId } = req.params;
    const force = req.query.force === '1';
    try {
        const data = await refreshInventory(steamId, force);
        if (!data.success) {
            const sec = data.retryAfterSeconds || 300;
            const min = Math.ceil(sec / 60);
            let msg;
            if (data.error === 'rate_limited' || data.error === 'steam_blocked') {
                msg = `⏳ Steam временно блокирует запросы с вашего IP. Подождите ~${min} мин и попробуйте снова.`;
            } else if (data.error === 'private_or_empty') {
                msg = 'Инвентарь закрыт или пуст. Открой приватность: Steam → Настройки → Приватность → Инвентарь → Открытый.';
            } else { msg = data.message || 'Не удалось загрузить'; }
            return res.json({ success: false, error: data.error, retryAfterSeconds: sec, items: [], total: 0, message: msg });
        }
        res.json({ success: true, items: data.items, total: data.total, cached: data.cached || false, stale: data.stale || false, fetchedAt: data.fetchedAt || new Date().toISOString() });
    } catch (e) { res.json({ success: false, error: 'fetch_failed', items: [], total: 0, message: e.message }); }
});
app.get('/api/inventory-debug/:steamId', async (req, res) => {
    const { steamId } = req.params;
    try {
        const url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=5000`;
        const r = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': `https://steamcommunity.com/profiles/${steamId}/inventory/` },
            timeout: 20000, validateStatus: () => true
        });
        res.json({
            httpStatus: r.status, contentType: r.headers['content-type'],
            isHtml: typeof r.data === 'string' && r.data.includes('<html'),
            success: r.data?.success, total_inventory_count: r.data?.total_inventory_count,
            assets_count: (r.data?.assets || []).length, descriptions_count: (r.data?.descriptions || []).length,
            error: r.data?.Error || null
        });
    } catch (e) { res.json({ error: e.message }); }
});

// ================== TOURNAMENTS ==================
app.get('/api/tournaments', async (req, res) => { try { res.json({ data: await getTournaments() }); } catch { res.status(500).json({ error: 'Server error' }); } });
app.get('/api/tournaments/:id/teams', async (req, res) => {
    try {
        const r = await query('SELECT * FROM tournament_teams WHERE tournament_id=$1 ORDER BY created_at ASC', [req.params.id]);
        res.json({ data: r.rows.map(row => { const t = toCamelCase(row); t.players = safeJsonParse(t.players, []); return t; }) });
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/tournaments/:id/register-team', rateLimitMiddleware(10, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const { teamName, players } = req.body;
        if (!teamName || !Array.isArray(players) || players.length !== 5) return res.status(400).json({ error: 'Нужно 5 игроков' });
        const t = await getTournamentById(req.params.id);
        if (!t) return res.status(404).json({ error: 'Not found' });
        if (t.status === 'COMPLETED') return res.status(400).json({ error: 'Завершён' });
        const cnt = await query('SELECT COUNT(*) FROM tournament_teams WHERE tournament_id=$1', [req.params.id]);
        if (parseInt(cnt.rows[0].count, 10) >= t.maxTeams) return res.status(400).json({ error: 'Заполнен' });
        const al = await query('SELECT 1 FROM tournament_teams WHERE tournament_id=$1 AND captain_id=$2', [req.params.id, user.id]);
        if (al.rows.length > 0) return res.status(400).json({ error: 'Уже зарегистрированы' });
        const fee = t.entryFee || 0;
        if (fee > 0) {
            const bal = await getUserBalance(user.id);
            if (bal < fee) return res.status(400).json({ error: `Недостаточно: ${bal}/${fee}` });
            await updateUserBalance(user.id, bal - fee);
        }
        const cleanPlayers = players.map(pl => ({ nick: sanitizeString(pl.nick, 40), role: ['IGL', 'AWP', 'ENTRY', 'RIFLER', 'LURKER'].includes(pl.role) ? pl.role : 'RIFLER' }));
        await query('INSERT INTO tournament_teams (id, tournament_id, team_name, captain_id, players) VALUES ($1,$2,$3,$4,$5)',
            [`tt_${Date.now()}`, req.params.id, sanitizeString(teamName, 40), user.id, JSON.stringify(cleanPlayers)]);
        res.json({ success: true, balance: await getUserBalance(user.id) });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// ================== TEAMS ==================
app.post('/api/teams', rateLimitMiddleware(5, 60000), async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const user = await findUserById(p.userId);
        const { name, tag, description } = req.body;
        const cn = sanitizeString(name, 40);
        if (cn.length < 3) return res.status(400).json({ error: 'Минимум 3 символа' });
        const ex = await query('SELECT id FROM teams WHERE name=$1', [cn]);
        if (ex.rows.length > 0) return res.status(400).json({ error: 'Занято' });
        const id = `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await query('INSERT INTO teams (id, name, tag, description, captain_id) VALUES ($1,$2,$3,$4,$5)', [id, cn, sanitizeString(tag, 6), sanitizeString(description, 300), user.id]);
        await query('INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3)', [id, user.id, 'CAPTAIN']);
        res.json({ success: true, teamId: id });
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/teams/my', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const r = await query(`SELECT t.*, tm.role as my_role FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = $1`, [p.userId]);
        res.json({ data: r.rows.map(toCamelCase) });
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/teams/:id', async (req, res) => {
    try {
        const tRes = await query('SELECT * FROM teams WHERE id=$1', [req.params.id]);
        if (tRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        const mRes = await query(`SELECT u.id, u.steam_id, u.steam_nickname, u.steam_avatar, u.display_name, tm.role, tm.joined_at FROM team_members tm JOIN users u ON tm.user_id = u.id WHERE tm.team_id=$1 ORDER BY tm.joined_at ASC`, [req.params.id]);
        res.json({ team: toCamelCase(tRes.rows[0]), members: mRes.rows.map(toCamelCase) });
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.get('/api/teams/invites/my', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const r = await query(`SELECT ti.*, t.name as team_name, t.tag as team_tag FROM team_invites ti JOIN teams t ON ti.team_id = t.id WHERE ti.to_id=$1 AND ti.status='pending'`, [p.userId]);
        res.json({ data: r.rows.map(toCamelCase) });
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/teams/invites/:id/:action', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const { id, action } = req.params;
        const inv = await query('SELECT * FROM team_invites WHERE id=$1 AND to_id=$2 AND status=$3', [id, p.userId, 'pending']);
        if (inv.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        if (action === 'accept') {
            await query('INSERT INTO team_members (team_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [inv.rows[0].team_id, p.userId, 'MEMBER']);
            await query('UPDATE team_invites SET status=$1 WHERE id=$2', ['accepted', id]);
        } else if (action === 'decline') {
            await query('UPDATE team_invites SET status=$1 WHERE id=$2', ['declined', id]);
        } else return res.status(400).json({ error: 'Bad action' });
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error' }); }
});

// ================== ADMIN ==================
async function requireAdmin(req, res) {
    const p = getAuthPayload(req);
    if (!p) { res.status(403).json({ error: 'Admin only' }); return null; }
    const u = await findUserById(p.userId);
    if (!u || !u.isAdmin) { res.status(403).json({ error: 'Admin only' }); return null; }
    return u;
}
app.get('/api/admin/users', async (req, res) => {
    try { const a = await requireAdmin(req, res); if (!a) return; res.json({ data: await getAllUsers() }); }
    catch (e) { res.status(500).json({ error: 'Server error: ' + e.message }); }
});
app.post('/api/admin/make-me-admin', async (req, res) => {
    const p = getAuthPayload(req);
    if (!p) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const c = await query('SELECT COUNT(*) FROM users WHERE is_admin=true');
        if (parseInt(c.rows[0].count, 10) > 0) return res.status(403).json({ error: 'Админ уже есть' });
        const u = await findUserById(p.userId);
        if (!u) return res.status(404).json({ error: 'Not found' });
        await query('UPDATE users SET is_admin=true WHERE id=$1', [u.id]);
        res.json({ success: true });
    } catch { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/ban/:userId', async (req, res) => {
    try { const a = await requireAdmin(req, res); if (!a) return; await query('UPDATE users SET is_banned=$1 WHERE id=$2', [Boolean(req.body.ban), req.params.userId]); res.json({ success: true }); }
    catch { res.status(500).json({ error: 'Server error' }); }
});
app.post('/api/admin/promote/:userId', async (req, res) => {
    try { const a = await requireAdmin(req, res); if (!a) return; await query('UPDATE users SET is_admin=$1 WHERE id=$2', [Boolean(req.body.promote), req.params.userId]); res.json({ success: true }); }
    catch { res.status(500).json({ error: 'Server error' }); }
});

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function startServer() {
    try { await initPostgresDB(); }
    catch (err) { console.error('❌ DB init:', err.message); process.exit(1); }
    app.listen(PORT, () => {
        console.log(`\n🚀 BARSIDE CS2 running on port ${PORT}`);
        console.log(`🔗 http://localhost:${PORT}\n`);
    });
}
startServer().catch(err => { console.error('Fatal:', err); process.exit(1); });