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

// --- НОВАЯ СИСТЕМА LFG С ОТКЛИКАМИ ---
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
            playersNeeded, rolesNeeded, minFaceitLevel, minPremierRank, description } = postData;
    
    const res = await query(`
        INSERT INTO lfg_posts (id, author_id, title, region, my_role, schedule_type, schedule, 
                               week_schedule, players_needed, roles_needed, min_faceit_level, 
                               min_premier_rank, description, team_members, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *
    `, [id, authorId, title, region, myRole, scheduleType, schedule, JSON.stringify(weekSchedule || {}),
        playersNeeded, JSON.stringify(rolesNeeded), minFaceitLevel, minPremierRank, description || '', 
        JSON.stringify([]), 'active']);
    
    return toCamelCase(res.rows[0]);
}

async function addResponseToLfg(postId, userId, role, message) {
    // Проверяем, не откликался ли уже
    const checkRes = await query('SELECT * FROM lfg_responses WHERE post_id = $1 AND user_id = $2 AND status = $3', 
        [postId, userId, 'pending']);
    if (checkRes.rows.length > 0) throw new Error('Вы уже откликались на эту анкету');
    
    // Проверяем, не занята ли роль
    const postRes = await query('SELECT team_members, players_needed, my_role FROM lfg_posts WHERE id = $1', [postId]);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    const post = toCamelCase(postRes.rows[0]);
    const teamMembers = post.teamMembers || [];
    if (teamMembers.some(m => m.role === role) || post.myRole === role) {
        throw new Error('Эта роль уже занята');
    }
    
    const res = await query(`
        INSERT INTO lfg_responses (id, post_id, user_id, role, message, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *
    `, [`resp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, postId, userId, role, message || '', 'pending']);
    
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
    // Проверяем, что пользователь - автор анкеты
    const postRes = await query('SELECT author_id, team_members, players_needed, my_role FROM lfg_posts WHERE id = $1', [postId]);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    
    const responseRes = await query('SELECT * FROM lfg_responses WHERE id = $1 AND post_id = $2 AND status = $3', 
        [responseId, postId, 'pending']);
    if (responseRes.rows.length === 0) throw new Error('Отклик не найден');
    
    const response = toCamelCase(responseRes.rows[0]);
    let teamMembers = postRes.rows[0].team_members || [];
    if (typeof teamMembers === 'string') teamMembers = JSON.parse(teamMembers);
    
    // Добавляем в команду
    const userRes = await query('SELECT steam_nickname, steam_avatar, display_name FROM users WHERE id = $1', [response.userId]);
    const newMember = {
        userId: response.userId,
        name: userRes.rows[0].display_name || userRes.rows[0].steam_nickname,
        avatar: userRes.rows[0].steam_avatar,
        role: response.role,
        joinedAt: new Date().toISOString()
    };
    teamMembers.push(newMember);
    
    // Обновляем статус отклика
    await query('UPDATE lfg_responses SET status = $1 WHERE id = $2', ['accepted', responseId]);
    
    // Обновляем состав команды
    await query('UPDATE lfg_posts SET team_members = $1 WHERE id = $2', [JSON.stringify(teamMembers), postId]);
    
    // Создаем уведомление для принятого игрока
    await query(`
        INSERT INTO notifications (id, user_id, type, title, message, data, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `, [`notif_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`, response.userId, 'lfg_accepted',
        'Вас приняли в команду!', `Ваш отклик на анкету "${postId}" был принят.`, JSON.stringify({ postId })]);
    
    return true;
}

async function rejectResponse(postId, responseId, authorId) {
    const postRes = await query('SELECT author_id FROM lfg_posts WHERE id = $1', [postId]);
    if (postRes.rows.length === 0) throw new Error('Анкета не найдена');
    if (postRes.rows[0].author_id !== authorId) throw new Error('Нет прав');
    
    const responseRes = await query('SELECT user_id FROM lfg_responses WHERE id = $1 AND post_id = $2 AND status = $3', 
        [responseId, postId, 'pending']);
    if (responseRes.rows.length === 0) throw new Error('Отклик не найден');
    
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
    if (teamMembers.length < neededCount) {
        throw new Error(`Необходимо набрать ${neededCount} игроков, набрано ${teamMembers.length}`);
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

async function getUnreadResponseCount(userId) {
    const res = await query(`
        SELECT COUNT(*) FROM lfg_responses r
        JOIN lfg_posts p ON r.post_id = p.id
        WHERE p.author_id = $1 AND r.status = 'pending' AND r.read = false
    `, [userId]);
    return parseInt(res.rows[0].count);
}

// --- ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ ---
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
        players_needed INTEGER DEFAULT 4,
        roles_needed JSONB NOT NULL,
        min_faceit_level INTEGER DEFAULT 1,
        min_premier_rank INTEGER DEFAULT 0,
        description TEXT,
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
        } else {
            await updateUser(steamId, { steamNickname: steamUser.personaname, steamAvatar: steamUser.avatarfull });
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
        if (user) return res.json({ data: user });
    } catch(e) {}
    res.json({ data: null });
});

// ============= ОНЛАЙН СЧЁТЧИК =============
const onlineSessions = new Set();
app.get('/api/online', (req, res) => { res.json({ count: onlineSessions.size }); });
app.post('/api/heartbeat', (req, res) => { const { sessionId } = req.body; if (sessionId) onlineSessions.add(sessionId); res.json({ success: true }); });

// ============= НОВЫЕ LFG МАРШРУТЫ =============
app.get('/api/lfg/active', async (req, res) => {
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

app.post('/api/lfg', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const user = await findUserById(payload.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        
        const postData = {
            id: `lfg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
            authorId: user.id,
            ...req.body
        };
        
        const created = await createLfgPost(postData);
        res.status(201).json({ data: created });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/lfg/:postId/respond', async (req, res) => {
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

app.get('/api/lfg/:postId/responses', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const responses = await getLfgResponses(req.params.postId);
        res.json({ data: responses });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/lfg/:postId/responses/:responseId/accept', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await acceptResponse(req.params.postId, req.params.responseId, payload.userId);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/lfg/:postId/responses/:responseId/reject', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await rejectResponse(req.params.postId, req.params.responseId, payload.userId);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/lfg/:postId/complete', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        await completeLfgPost(req.params.postId, payload.userId);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/lfg/:postId/review', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const { rating, comment } = req.body;
        await addReviewToLfg(req.params.postId, payload.userId, rating, comment);
        res.json({ success: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/lfg/responses/unread', async (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.json({ count: 0 });
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const count = await getUnreadResponseCount(payload.userId);
        res.json({ count });
    } catch (err) { res.json({ count: 0 }); }
});

// ============= СТАТИСТИКА =============
app.get('/api/stats', async (req, res) => {
    try {
        const usersRes = await query('SELECT COUNT(*) FROM users');
        const lfgRes = await query("SELECT COUNT(*) FROM lfg_posts WHERE status = 'active'");
        res.json({ 
            totalUsers: parseInt(usersRes.rows[0].count), 
            totalLfgPosts: parseInt(lfgRes.rows[0].count), 
            totalTournaments: 0, 
            online: onlineSessions.size 
        });
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
        console.log(`🐘 PostgreSQL: ${process.env.DB_HOST ? 'Connected' : 'Not configured!'}`);
    });
}
startServer().catch(console.error);