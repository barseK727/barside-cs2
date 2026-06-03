const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 5000;

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

// ============= ФУНКЦИИ ДЛЯ РАБОТЫ С БД =============
function loadDB() {
    const dataPath = path.join(__dirname, 'data', 'db.json');
    if (fs.existsSync(dataPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
            if (!data.friends) data.friends = [];
            if (!data.friendRequests) data.friendRequests = [];
            if (!data.messages) data.messages = [];
            if (!data.payments) data.payments = [];
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
        messages: [] 
    };
}

function saveDB(db) {
    const dataPath = path.join(__dirname, 'data', 'db.json');
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
        fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    }
    fs.writeFileSync(dataPath, JSON.stringify(db, null, 2));
}

// ============= STEAM AUTH =============
const STEAM_API_KEY = process.env.STEAM_API_KEY || '73B0E2A44B4F9B28DD3C5C760D5249DD';
const STEAM_RETURN_URL = `https://barside-api.onrender.com/api/auth/steam/callback`;

console.log('🔧 Steam Auth URL:', STEAM_RETURN_URL);
console.log('🔑 Steam API Key:', STEAM_API_KEY ? 'Установлен' : 'НЕ УСТАНОВЛЕН!');

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
        
        const sessionToken = Buffer.from(JSON.stringify({ userId: user.id, steamId: user.steamId })).toString('base64');
        res.cookie('auth_token', sessionToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
        res.redirect('https://barside-api.onrender.com/');
        
    } catch (error) {
        console.error('❌ Steam auth error:', error.message);
        res.redirect('https://barside-api.onrender.com/?error=auth_failed');
    }
});

// Выход
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
        if (user && !user.isBanned) {
            return res.json({ data: user });
        }
    } catch(e) {}
    
    res.json({ data: null });
});

// Инвентарь
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

// Онлайн счётчик
const onlineSessions = new Set();
app.get('/api/online', (req, res) => { res.json({ count: onlineSessions.size }); });
app.post('/api/heartbeat', (req, res) => { const { sessionId } = req.body; if (sessionId) onlineSessions.add(sessionId); res.json({ success: true }); });

// Профиль
app.get('/api/profile/:steamId', (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.steamId === req.params.steamId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { ...safeUser } = user;
    res.json({ user: safeUser });
});

app.put('/api/profile/:steamId', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const { steamId } = req.params;
    const { displayName, region, role, hasMic, bio } = req.body;
    const db = loadDB();
    const userIndex = db.users.findIndex(u => u.steamId === steamId);
    if (userIndex === -1) return res.status(404).json({ error: 'User not found' });
    if (db.users[userIndex].id !== payload.userId) return res.status(403).json({ error: 'Forbidden' });
    
    db.users[userIndex] = { ...db.users[userIndex], displayName: displayName || db.users[userIndex].displayName, region: region || db.users[userIndex].region, role: role || db.users[userIndex].role, hasMic: hasMic !== undefined ? hasMic : db.users[userIndex].hasMic, bio: bio !== undefined ? bio : db.users[userIndex].bio };
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
    
    const userPosts = db.lfgPosts.filter(p => p.authorId === user.id);
    if (userPosts.length >= 2) return res.status(400).json({ error: 'Maximum 2 active posts per user' });
    
    const newPost = { 
        id: Date.now().toString(), 
        authorId: user.id, 
        author: { steamId: user.steamId, steamNickname: user.steamNickname, steamAvatar: user.steamAvatar, displayName: user.displayName, region: user.region, role: user.role }, 
        title, region, rank: 'GOLD_1', role: user.role || 'RIFLER', schedule, description: description || '',
        playersNeeded: playersNeeded || 5, rolesNeeded: rolesNeeded || { IGL: false, AWP: false, ENTRY: false, RIFLER: false, LURKER: false },
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
    if (post.authorId !== user.id && !user.isAdmin) return res.status(403).json({ error: 'Forbidden' });
    db.lfgPosts = db.lfgPosts.filter(p => p.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

// ============= ТУРНИРЫ =============
app.get('/api/tournaments', (req, res) => {
    const db = loadDB();
    res.json({ data: db.tournaments });
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
    res.json({ data: db.users.map(u => { const { ...safe } = u; return safe; }) });
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

app.post('/api/admin/users/:userId/ban', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(403).json({ error: 'Admin only' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const admin = db.users.find(u => u.id === payload.userId);
    if (!admin?.isAdmin) return res.status(403).json({ error: 'Admin only' });
    
    const userIndex = db.users.findIndex(u => u.id === req.params.userId);
    if (userIndex === -1) return res.status(404).json({ error: 'User not found' });
    db.users[userIndex].isBanned = true;
    saveDB(db);
    res.json({ success: true });
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

app.get('/api/messages/:userId', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const messages = db.messages.filter(m => 
        (m.fromId === payload.userId && m.toId === req.params.userId) ||
        (m.fromId === req.params.userId && m.toId === payload.userId)
    ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    
    messages.forEach(msg => { if (msg.toId === payload.userId && !msg.read) msg.read = true; });
    saveDB(db);
    res.json({ data: messages });
});

app.post('/api/messages/:userId', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Message cannot be empty' });
    
    const db = loadDB();
    db.messages.push({ id: Date.now().toString(), fromId: payload.userId, toId: req.params.userId, text: text.trim(), createdAt: new Date().toISOString(), read: false });
    saveDB(db);
    res.json({ success: true });
});

app.get('/api/messages/unread/count', (req, res) => {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    const db = loadDB();
    const count = db.messages.filter(m => m.toId === payload.userId && !m.read).length;
    res.json({ count });
});

// Health check для Render
app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Статика
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🚀 BARSIDE CS2 Server running!`);
    console.log(`📍 URL: http://localhost:${PORT}`);
    console.log(`🔑 Steam Auth: http://localhost:${PORT}/api/auth/steam`);
    console.log(`📁 Data folder: ${path.join(__dirname, 'data')}`);
});