const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 5000;

// ============= ПОДКЛЮЧЕНИЕ К POSTGRESQL =============
const { Pool } = require('pg');

// Настройка подключения к PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }  // важно для Render!
});

// Инициализация таблиц в PostgreSQL
async function initPostgresDB() {
  const client = await pool.connect();
  try {
    // Таблица пользователей
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        steam_id TEXT UNIQUE NOT NULL,
        steam_nickname TEXT NOT NULL,
        steam_avatar TEXT,
        display_name TEXT UNIQUE,
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

    // Таблица LFG постов
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

    // Таблица друзей
    await client.query(`
      CREATE TABLE IF NOT EXISTS friends (
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        friend_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, friend_id)
      )
    `);

    // Таблица заявок в друзья
    await client.query(`
      CREATE TABLE IF NOT EXISTS friend_requests (
        id TEXT PRIMARY KEY,
        from_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        to_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        status TEXT DEFAULT 'pending'
      )
    `);

    // Таблица сообщений
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

    // Таблица турниров
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

    // Таблица забаненных пользователей
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

// Вызов инициализации БД (не блокирует запуск сервера)
initPostgresDB().catch(console.error);

// ============= ФУНКЦИИ ДЛЯ РАБОТЫ С БД (JSON файл - резервный вариант) =============
function loadDB() {
    const dataPath = path.join(__dirname, 'data', 'db.json');
    if (fs.existsSync(dataPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
            if (!data.friends) data.friends = [];
            if (!data.friendRequests) data.friendRequests = [];
            if (!data.messages) data.messages = [];
            if (!data.payments) data.payments = [];
            if (!data.bannedUsers) data.bannedUsers = [];
            return data;
        } catch(e) {
            console.error('Error parsing db.json:', e);
        }
    }
    return { 
        users: [], 
        lfgPosts: [], 
        tournaments: [], 
        payments: [], 
        friends: [], 
        friendRequests: [], 
        messages: [],
        bannedUsers: []
    };
}

function saveDB(db) {
    const dataPath = path.join(__dirname, 'data', 'db.json');
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
        fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    }
    fs.writeFileSync(dataPath, JSON.stringify(db, null, 2));
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Парсер cookies
app.use((req, res, next) => {
    req.cookies = {};
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
            const [name, value] = cookie.trim().split('=');
            req.cookies[name] = decodeURIComponent(value);
        });
    }
    next();
});

// ============= STEAM AUTH =============
const STEAM_API_KEY = process.env.STEAM_API_KEY || 'B71E8712CD37B69EFF9DAE898EBDB2A3';
const STEAM_RETURN_URL = `https://barside-api.onrender.com/api/auth/steam/callback`;

app.get('/api/auth/steam', (req, res) => {
    const openIdUrl = `https://steamcommunity.com/openid/login?openid.ns=http://specs.openid.net/auth/2.0&openid.mode=checkid_setup&openid.return_to=${encodeURIComponent(STEAM_RETURN_URL)}&openid.realm=https://barside-api.onrender.com&openid.identity=http://specs.openid.net/auth/2.0/identifier_select&openid.claimed_id=http://specs.openid.net/auth/2.0/identifier_select`;
    res.redirect(openIdUrl);
});

app.get('/api/auth/steam/callback', async (req, res) => {
    const claimedId = req.query['openid.claimed_id'];
    if (!claimedId) {
        return res.redirect('https://barside-api.onrender.com/?error=auth_failed');
    }
    
    const steamId = claimedId.split('/').pop();
    
    try {
        const apiUrl = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`;
        const steamResponse = await axios.get(apiUrl);
        const steamUser = steamResponse.data.response?.players?.[0];
        
        if (!steamUser) {
            return res.redirect('https://barside-api.onrender.com/?error=steam_api_failed');
        }
        
        let db = loadDB();
        
        let user = db.users.find(u => u.steamId === steamId);
        if (!user) {
            user = {
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
                isAdmin: db.users.length === 0,
                isBanned: false,
                createdAt: new Date().toISOString(),
                settings: { emailNotifications: true, theme: 'dark' }
            };
            db.users.push(user);
            
            if (db.tournaments.length === 0) {
                db.tournaments.push({
                    id: 'tourn_1',
                    title: 'BARSIDE CUP #1',
                    description: 'Главный турнир сезона',
                    prizePool: '50000₽',
                    date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                    status: 'UPCOMING',
                    entryFee: 500,
                    maxTeams: 16,
                    registeredTeams: [],
                    format: '5x5',
                    rules: '1. Формат Best of 3\n2. Карты: Dust2, Mirage, Inferno, Nuke, Overpass',
                    schedule: 'Групповой этап: первые выходные\nПлей-офф: следующие выходные',
                    createdAt: new Date().toISOString()
                });
            }
            saveDB(db);
        } else {
            user.steamNickname = steamUser.personaname;
            user.steamAvatar = steamUser.avatarfull;
            saveDB(db);
        }
        
        if (db.bannedUsers && db.bannedUsers.includes(user.id)) {
            const sessionToken = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steamId, banned: true })).toString('base64');
            res.cookie('auth_token', sessionToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
            return res.redirect('https://barside-api.onrender.com/?error=banned');
        }
        
        const sessionToken = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steamId })).toString('base64');
        res.cookie('auth_token', sessionToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
        res.redirect('https://barside-api.onrender.com/');
        
    } catch (error) {
        console.error('❌ Steam auth error:', error.message);
        res.redirect('https://barside-api.onrender.com/?error=auth_failed');
    }
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.json({ data: null });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const db = loadDB();
        const user = db.users.find(u => u.id === payload.userId);
        if (user) {
            if (db.bannedUsers && db.bannedUsers.includes(user.id)) {
                return res.json({ data: { ...user, isBanned: true } });
            }
            return res.json({ data: user });
        }
    } catch(e) {}
    
    res.json({ data: null });
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

// ============= ОНЛАЙН СЧЁТЧИК =============
const onlineSessions = new Set();
app.get('/api/online', (req, res) => { res.json({ count: onlineSessions.size }); });
app.post('/api/heartbeat', (req, res) => { const { sessionId } = req.body; if (sessionId) onlineSessions.add(sessionId); res.json({ success: true }); });

// ============= ПРОФИЛЬ =============
app.get('/api/profile/:steamId', (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.steamId === req.params.steamId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const isBanned = db.bannedUsers && db.bannedUsers.includes(user.id);
    
    const userTournaments = db.tournaments.filter(t => 
        t.registeredTeams && t.registeredTeams.some(team => team.captainId === user.id)
    ).map(t => ({ id: t.id, title: t.title, prizePool: t.prizePool, date: t.date }));
    
    const userPosts = db.lfgPosts.filter(p => p.authorId === user.id);
    
    res.json({ 
        user: { ...user, isBanned }, 
        tournaments: userTournaments,
        lfgPosts: userPosts
    });
});

app.put('/api/profile/:steamId', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.steamId === req.params.steamId);
    if (userIndex === -1) return res.status(404).json({ error: 'User not found' });
    
    const currentUser = db.users.find(u => u.id === payload.userId);
    const isAdmin = currentUser?.isAdmin;
    const isOwnProfile = db.users[userIndex].id === payload.userId;
    
    if (!isOwnProfile && !isAdmin) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    
    const { displayName, region, role, hasMic, bio, balance, isAdmin: makeAdmin, isBanned } = req.body;
    
    if (displayName !== undefined) db.users[userIndex].displayName = displayName || db.users[userIndex].displayName;
    if (region !== undefined) db.users[userIndex].region = region;
    if (role !== undefined) db.users[userIndex].role = role;
    if (hasMic !== undefined) db.users[userIndex].hasMic = hasMic;
    if (bio !== undefined) db.users[userIndex].bio = bio;
    
    if (isAdmin) {
        if (balance !== undefined) db.users[userIndex].balance = balance;
        if (makeAdmin !== undefined) db.users[userIndex].isAdmin = makeAdmin;
        if (isBanned !== undefined) {
            if (!db.bannedUsers) db.bannedUsers = [];
            if (isBanned) {
                if (!db.bannedUsers.includes(db.users[userIndex].id)) {
                    db.bannedUsers.push(db.users[userIndex].id);
                }
            } else {
                db.bannedUsers = db.bannedUsers.filter(id => id !== db.users[userIndex].id);
            }
        }
    }
    
    saveDB(db);
    res.json({ user: db.users[userIndex] });
});

// Баланс
app.get('/api/balance', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const user = db.users.find(u => u.id === payload.userId);
    res.json({ balance: user?.balance || 0 });
});

app.post('/api/balance/topup', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const { amount } = req.body;
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.id === payload.userId);
    if (userIndex === -1) return res.status(404).json({ error: 'User not found' });
    if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum topup is 100₽' });
    db.users[userIndex].balance += amount;
    saveDB(db);
    res.json({ success: true, balance: db.users[userIndex].balance });
});

// Статистика
app.get('/api/stats', (req, res) => {
    const db = loadDB();
    res.json({ totalUsers: db.users.length, totalLfgPosts: db.lfgPosts.length, totalTournaments: db.tournaments.length, online: onlineSessions.size });
});

// ============= LFG МАРШРУТЫ =============
app.get('/api/lfg', (req, res) => {
    const db = loadDB();
    const { region, role } = req.query;
    let posts = [...db.lfgPosts];
    if (region && region !== 'all') posts = posts.filter(p => p.region === region);
    if (role && role !== 'all') posts = posts.filter(p => p.role === role);
    posts = posts.map(p => ({ ...p, playersNeeded: p.playersNeeded || 5, rolesNeeded: p.rolesNeeded || { IGL: false, AWP: false, ENTRY: false, RIFLER: false, LURKER: false } }));
    res.json({ data: posts });
});

app.post('/api/lfg', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const user = db.users.find(u => u.id === payload.userId);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    
    const { title, region, schedule, description, playersNeeded, rolesNeeded } = req.body;
    if (!title || !region || !schedule) return res.status(400).json({ error: 'Missing required fields' });
    
    const playersCount = playersNeeded || 5;
    if (playersCount < 2 || playersCount > 4) {
        return res.status(400).json({ error: 'Players needed must be between 2 and 4' });
    }
    
    const userPosts = db.lfgPosts.filter(p => p.authorId === user.id);
    if (userPosts.length >= 2) return res.status(400).json({ error: 'Maximum 2 active posts per user' });
    
    const newPost = { 
        id: Date.now().toString(), 
        authorId: user.id, 
        author: { steamId: user.steamId, steamNickname: user.steamNickname, steamAvatar: user.steamAvatar, displayName: user.displayName, region: user.region, role: user.role }, 
        title, region, rank: 'GOLD_1', role: user.role || 'RIFLER', schedule, description: description || '',
        playersNeeded: playersCount,
        rolesNeeded: rolesNeeded || { IGL: false, AWP: false, ENTRY: false, RIFLER: false, LURKER: false },
        createdAt: new Date().toISOString() 
    };
    db.lfgPosts.unshift(newPost);
    saveDB(db);
    res.status(201).json({ data: newPost });
});

app.delete('/api/lfg/:id', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const user = db.users.find(u => u.id === payload.userId);
    const post = db.lfgPosts.find(p => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    
    if (post.authorId !== user.id && !user?.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    
    db.lfgPosts = db.lfgPosts.filter(p => p.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

// ============= ТУРНИРЫ =============
app.get('/api/tournaments', (req, res) => {
    const db = loadDB();
    res.json({ data: db.tournaments });
});

app.delete('/api/tournaments/:id', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const user = db.users.find(u => u.id === payload.userId);
    if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    db.tournaments = db.tournaments.filter(t => t.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/tournaments/:id/register', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const user = db.users.find(u => u.id === payload.userId);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    
    const tournament = db.tournaments.find(t => t.id === req.params.id);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    if (tournament.entryFee > 0 && user.balance < tournament.entryFee) return res.status(400).json({ error: 'Insufficient balance' });
    
    if (tournament.entryFee > 0) {
        const userIndex = db.users.findIndex(u => u.id === user.id);
        db.users[userIndex].balance -= tournament.entryFee;
        db.payments.push({ id: Date.now().toString(), userId: user.id, amount: tournament.entryFee, status: 'SUCCEEDED', description: `Registration for ${tournament.title}`, createdAt: new Date().toISOString() });
    }
    
    tournament.registeredTeams.push({ id: Date.now().toString(), teamName: req.body.teamName, captainId: user.id, captainName: user.displayName || user.steamNickname, captainTelegram: req.body.captainTelegram, captainPhone: req.body.captainPhone, players: req.body.players, registeredAt: new Date().toISOString() });
    saveDB(db);
    res.json({ success: true });
});

// ============= АДМИН МАРШРУТЫ =============
app.get('/api/admin/users', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const user = db.users.find(u => u.id === payload.userId);
    if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    const usersWithBan = db.users.map(u => ({ ...u, isBanned: db.bannedUsers?.includes(u.id) || false }));
    res.json({ data: usersWithBan });
});

app.post('/api/admin/tournaments', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const user = db.users.find(u => u.id === payload.userId);
    if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    db.tournaments.push({ id: Date.now().toString(), ...req.body, status: 'UPCOMING', registeredTeams: [], createdAt: new Date().toISOString() });
    saveDB(db);
    res.status(201).json({ success: true });
});

// Поиск пользователей по имени (для админа)
app.get('/api/admin/search', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const user = db.users.find(u => u.id === payload.userId);
    if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    const { query } = req.query;
    if (!query) return res.json({ data: [] });
    
    const searchLower = query.toLowerCase();
    const foundUsers = db.users.filter(u => 
        (u.displayName && u.displayName.toLowerCase().includes(searchLower)) ||
        (u.steamNickname && u.steamNickname.toLowerCase().includes(searchLower))
    );
    
    const result = foundUsers.map(u => {
        const userTournaments = db.tournaments.filter(t => 
            t.registeredTeams && t.registeredTeams.some(team => team.captainId === u.id)
        );
        const userPosts = db.lfgPosts.filter(p => p.authorId === u.id);
        return {
            ...u,
            isBanned: db.bannedUsers?.includes(u.id) || false,
            tournaments: userTournaments,
            lfgPosts: userPosts
        };
    });
    
    res.json({ data: result });
});

// ============= ДРУЗЬЯ И СООБЩЕНИЯ =============

app.post('/api/friends/request/:userId', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const fromUser = db.users.find(u => u.id === payload.userId);
    const toUser = db.users.find(u => u.id === req.params.userId);
    
    if (!fromUser || !toUser) return res.status(404).json({ error: 'User not found' });
    if (fromUser.id === req.params.userId) return res.status(400).json({ error: 'Cannot add yourself' });
    if (db.friendRequests.some(r => r.fromId === fromUser.id && r.toId === req.params.userId)) return res.status(400).json({ error: 'Request already sent' });
    if (db.friends.some(f => (f.userId === fromUser.id && f.friendId === req.params.userId) || (f.userId === req.params.userId && f.friendId === fromUser.id))) return res.status(400).json({ error: 'Already friends' });
    
    db.friendRequests.push({ id: Date.now().toString(), fromId: fromUser.id, fromName: fromUser.displayName || fromUser.steamNickname, fromAvatar: fromUser.steamAvatar, toId: req.params.userId, createdAt: new Date().toISOString(), status: 'pending' });
    saveDB(db);
    res.json({ success: true });
});

app.get('/api/friends/requests', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    res.json({ data: db.friendRequests.filter(r => r.toId === payload.userId && r.status === 'pending') });
});

app.post('/api/friends/request/:requestId/accept', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const requestIndex = db.friendRequests.findIndex(r => r.id === req.params.requestId);
    if (requestIndex === -1) return res.status(404).json({ error: 'Request not found' });
    const request = db.friendRequests[requestIndex];
    if (request.toId !== payload.userId) return res.status(403).json({ error: 'Forbidden' });
    
    db.friends.push({ userId: request.fromId, friendId: request.toId, createdAt: new Date().toISOString() });
    db.friends.push({ userId: request.toId, friendId: request.fromId, createdAt: new Date().toISOString() });
    db.friendRequests.splice(requestIndex, 1);
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/friends/request/:requestId/decline', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const requestIndex = db.friendRequests.findIndex(r => r.id === req.params.requestId);
    if (requestIndex === -1) return res.status(404).json({ error: 'Request not found' });
    const request = db.friendRequests[requestIndex];
    if (request.toId !== payload.userId) return res.status(403).json({ error: 'Forbidden' });
    
    db.friendRequests.splice(requestIndex, 1);
    saveDB(db);
    res.json({ success: true });
});

app.get('/api/friends', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const friendships = db.friends.filter(f => f.userId === payload.userId);
    const friends = friendships.map(f => db.users.find(u => u.id === f.friendId)).filter(Boolean);
    res.json({ data: friends });
});

// ============= СООБЩЕНИЯ =============

app.get('/api/messages/:userId', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const db = loadDB();
        const messages = db.messages.filter(m => 
            (m.fromId === payload.userId && m.toId === req.params.userId) ||
            (m.fromId === req.params.userId && m.toId === payload.userId)
        ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        
        db.messages.forEach(msg => {
            if (msg.toId === payload.userId && !msg.read) {
                msg.read = true;
            }
        });
        saveDB(db);
        
        res.json({ data: messages });
    } catch(e) {
        console.error('Error getting messages:', e);
        res.json({ data: [] });
    }
});

app.post('/api/messages/:userId', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const { text } = req.body;
        if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
        
        const db = loadDB();
        const newMessage = {
            id: Date.now().toString(),
            fromId: payload.userId,
            toId: req.params.userId,
            text: text.trim(),
            createdAt: new Date().toISOString(),
            read: false
        };
        
        if (!db.messages) db.messages = [];
        db.messages.push(newMessage);
        saveDB(db);
        
        res.json({ success: true, message: newMessage });
    } catch(e) {
        console.error('Error sending message:', e);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.get('/api/messages/unread/count', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const payload = JSON.parse(Buffer.from(token, 'base64').toString());
        const db = loadDB();
        const count = db.messages.filter(m => m.toId === payload.userId && !m.read).length;
        res.json({ count });
    } catch(e) {
        res.json({ count: 0 });
    }
});

// ============= НОВЫЙ МАРШРУТ ДЛЯ ЧАТА - ПОЛУЧИТЬ ПОЛЬЗОВАТЕЛЯ ПО ID =============
app.get('/api/user/by-id/:userId', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    
    try {
        const db = loadDB();
        const user = db.users.find(u => u.id === req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        const { ...safeUser } = user;
        res.json({ user: safeUser });
    } catch(e) {
        console.error('Error in /api/user/by-id:', e);
        res.status(500).json({ error: 'Server error' });
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

// ============= ЗАПУСК СЕРВЕРА =============
app.listen(PORT, () => {
    console.log(`\n🚀 BARSIDE CS2 Server running!`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`🔑 Steam Auth: http://localhost:${PORT}/api/auth/steam`);
    console.log(`📁 Data folder: ${path.join(__dirname, 'data')}`);
    console.log(`🐘 PostgreSQL: ${process.env.DB_HOST ? 'Connected' : 'Not configured, using JSON file'}`);
});