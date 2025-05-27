const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

class PongServerDB {
    constructor() {
        this.server = http.createServer(this.handleRequest.bind(this));
        this.wss = new WebSocket.Server({ server: this.server });
        
        // MongoDB connection
        this.mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017';
        this.dbName = 'pongultimate';
        this.client = null;
        this.db = null;
        
        // In-memory session management
        this.activeSessions = new Map(); // ws -> {username, playerId, ready}
        this.players = new Map(); // ws -> {id, ready, username}
        this.gameState = this.initGameState();
        this.gameRunning = false;
        this.gameLoopId = null;
        this.lobbyState = {
            player1: null,
            player2: null,
            player1Ready: false,
            player2Ready: false,
            player1Name: '',
            player2Name: '',
            playersCount: 0
        };
        
        this.initDatabase().then(() => {
            this.setupWebSocket();
            console.log('🏓 Server Pong Ultimate con MongoDB avviato!');
            console.log('💾 Database connesso e pronto');
            console.log('📡 WebSocket server pronto sulla porta 3000');
        }).catch(error => {
            console.error('❌ Errore connessione database:', error);
            console.log('⚠️  Server avviato senza database (modalità memoria)');
            this.setupWebSocket();
        });
    }

    async initDatabase() {
        try {
            this.client = new MongoClient(this.mongoUrl);
            await this.client.connect();
            this.db = this.client.db(this.dbName);
            
            // Crea collezioni se non esistono
            await this.db.createCollection('users');
            await this.db.collection('users').createIndex({ username: 1 }, { unique: true });
            
            // Crea utenti demo se non esistono
            await this.createDemoUsers();
            
            console.log('✅ Database MongoDB connesso!');
        } catch (error) {
            console.error('❌ Errore inizializzazione database:', error);
            throw error;
        }
    }

    async createDemoUsers() {
        if (!this.db) return;
        
        const demoUsers = [
            { username: 'guest1', password: 'password', stats: { wins: 5, losses: 3, games: 8 } },
            { username: 'guest2', password: 'password', stats: { wins: 2, losses: 6, games: 8 } },
            { username: 'admin', password: 'admin123', stats: { wins: 10, losses: 2, games: 12 } }
        ];

        for (let user of demoUsers) {
            try {
                await this.db.collection('users').insertOne(user);
                console.log(`👤 Utente demo creato: ${user.username}`);
            } catch (error) {
                // Utente già esistente, ignora errore
            }
        }
    }

    initGameState() {
        return {
            ball: { 
                x: 400, 
                y: 200, 
                dx: Math.random() > 0.5 ? 5 : -5, 
                dy: (Math.random() - 0.5) * 6,
                radius: 8 
            },
            paddle1: { x: 20, y: 150, width: 15, height: 100, dy: 0 },
            paddle2: { x: 765, y: 150, width: 15, height: 100, dy: 0 },
            score1: 0,
            score2: 0,
            gameRunning: false
        };
    }

    handleRequest(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.url === '/') {
            const htmlPath = path.join(__dirname, 'index.html');
            
            if (fs.existsSync(htmlPath)) {
                fs.readFile(htmlPath, (err, data) => {
                    if (err) {
                        res.writeHead(500);
                        res.end('Errore nel caricamento del gioco');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(data);
                });
            } else {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
                    <h1>🏓 Server Pong Ultimate con Database Attivo!</h1>
                    <p><strong>Database MongoDB:</strong> ${this.db ? '✅ Connesso' : '❌ Non connesso'}</p>
                    <p><strong>WebSocket server attivo!</strong></p>
                    <p><strong>URL WebSocket:</strong> <code>wss://${req.headers.host}</code></p>
                `);
            }
        } else {
            res.writeHead(404);
            res.end('Pagina non trovata');
        }
    }

    setupWebSocket() {
        this.wss.on('connection', (ws) => {
            console.log('🎮 Nuova connessione');
            
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handlePlayerMessage(ws, message);
                } catch (error) {
                    console.error('Errore nel parsing del messaggio:', error);
                }
            });
            
            ws.on('close', () => {
                this.handleDisconnection(ws);
            });
        });
    }

    async handlePlayerMessage(ws, message) {
        const session = this.activeSessions.get(ws);

        switch (message.type) {
            case 'login':
                await this.handleLogin(ws, message);
                break;
            case 'register':
                await this.handleRegister(ws, message);
                break;
            case 'joinLobby':
                if (session) {
                    this.joinLobby(ws);
                }
                break;
            case 'playerReady':
                const playerData = this.players.get(ws);
                if (playerData) {
                    this.handlePlayerReady(ws, message.ready);
                }
                break;
            case 'input':
                if (this.gameRunning && this.players.has(ws)) {
                    this.handlePlayerInput(ws, message);
                }
                break;
            case 'inputStop':
                if (this.gameRunning && this.players.has(ws)) {
                    this.handleInputStop(ws);
                }
                break;
            case 'mouseInput':
                if (this.gameRunning && this.players.has(ws)) {
                    this.handleMouseInput(ws, message);
                }
                break;
            case 'getStats':
                await this.handleGetStats(ws);
                break;
        }
    }

    async handleLogin(ws, message) {
        const { username, password } = message;
        
        try {
            let user;
            if (this.db) {
                user = await this.db.collection('users').findOne({ username });
            } else {
                // Fallback per utenti demo in memoria
                const demoUsers = {
                    'guest1': { password: 'password', stats: { wins: 5, losses: 3, games: 8 } },
                    'guest2': { password: 'password', stats: { wins: 2, losses: 6, games: 8 } }
                };
                user = demoUsers[username];
            }

            if (!user) {
                ws.send(JSON.stringify({ 
                    type: 'loginResult', 
                    success: false, 
                    message: 'Utente non trovato' 
                }));
                return;
            }

            if (user.password !== password) {
                ws.send(JSON.stringify({ 
                    type: 'loginResult', 
                    success: false, 
                    message: 'Password errata' 
                }));
                return;
            }

            // Controlla se l'utente è già connesso
            for (let [otherWs, otherSession] of this.activeSessions) {
                if (otherSession.username === username && otherWs !== ws) {
                    ws.send(JSON.stringify({ 
                        type: 'loginResult', 
                        success: false, 
                        message: 'Utente già connesso' 
                    }));
                    return;
                }
            }

            // Login riuscito
            this.activeSessions.set(ws, { username, playerId: null, ready: false });
            
            ws.send(JSON.stringify({ 
                type: 'loginResult', 
                success: true, 
                username: username,
                stats: user.stats
            }));

            console.log(`👤 ${username} ha effettuato il login`);
        } catch (error) {
            console.error('Errore login:', error);
            ws.send(JSON.stringify({ 
                type: 'loginResult', 
                success: false, 
                message: 'Errore del server' 
            }));
        }
    }

    async handleRegister(ws, message) {
        const { username, password } = message;
        
        if (!username || !password || username.length < 3 || password.length < 3) {
            ws.send(JSON.stringify({ 
                type: 'registerResult', 
                success: false, 
                message: 'Username e password devono avere almeno 3 caratteri' 
            }));
            return;
        }

        try {
            if (this.db) {
                // Controlla se utente esiste già
                const existingUser = await this.db.collection('users').findOne({ username });
                if (existingUser) {
                    ws.send(JSON.stringify({ 
                        type: 'registerResult', 
                        success: false, 
                        message: 'Username già esistente' 
                    }));
                    return;
                }

                // Crea nuovo utente
                await this.db.collection('users').insertOne({
                    username: username,
                    password: password,
                    stats: { wins: 0, losses: 0, games: 0 },
                    createdAt: new Date()
                });

                ws.send(JSON.stringify({ 
                    type: 'registerResult', 
                    success: true, 
                    message: 'Registrazione completata! Ora puoi fare il login.' 
                }));

                console.log(`✨ Nuovo utente registrato: ${username}`);
            } else {
                ws.send(JSON.stringify({ 
                    type: 'registerResult', 
                    success: false, 
                    message: 'Database non disponibile' 
                }));
            }
        } catch (error) {
            console.error('Errore registrazione:', error);
            ws.send(JSON.stringify({ 
                type: 'registerResult', 
                success: false, 
                message: 'Errore del server' 
            }));
        }
    }

    async handleGetStats(ws) {
        const session = this.activeSessions.get(ws);
        if (session) {
            try {
                let user;
                if (this.db) {
                    user = await this.db.collection('users').findOne({ username: session.username });
                } else {
                    // Fallback per demo users
                    const demoUsers = {
                        'guest1': { stats: { wins: 5, losses: 3, games: 8 } },
                        'guest2': { stats: { wins: 2, losses: 6, games: 8 } }
                    };
                    user = demoUsers[session.username];
                }

                if (user) {
                    ws.send(JSON.stringify({ 
                        type: 'userStats', 
                        username: session.username,
                        stats: user.stats 
                    }));
                }
            } catch (error) {
                console.error('Errore recupero statistiche:', error);
            }
        }
    }

    joinLobby(ws) {
        const session = this.activeSessions.get(ws);
        if (!session) return;

        let playerId = null;
        if (!this.lobbyState.player1) {
            playerId = 1;
            this.lobbyState.player1 = ws;
            this.lobbyState.player1Name = session.username;
        } else if (!this.lobbyState.player2) {
            playerId = 2;
            this.lobbyState.player2 = ws;
            this.lobbyState.player2Name = session.username;
        } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Lobby piena!' }));
            return;
        }
        
        this.players.set(ws, { id: playerId, ready: false, username: session.username });
        session.playerId = playerId;
        this.lobbyState.playersCount++;
        
        ws.send(JSON.stringify({ type: 'playerId', id: playerId }));
        
        console.log(`👤 ${session.username} è entrato in lobby come giocatore ${playerId}`);
        
        this.broadcastLobbyState();
    }

    handlePlayerReady(ws, ready) {
        const playerData = this.players.get(ws);
        playerData.ready = ready;
        
        if (playerData.id === 1) {
            this.lobbyState.player1Ready = ready;
        } else {
            this.lobbyState.player2Ready = ready;
        }
        
        console.log(`🎯 Giocatore ${playerData.id} ${ready ? 'PRONTO' : 'non pronto'}`);
        
        this.broadcastLobbyState();
        
        if (this.lobbyState.player1Ready && this.lobbyState.player2Ready && 
            this.lobbyState.playersCount === 2) {
            console.log('🚀 Entrambi i giocatori pronti! Iniziando il gioco...');
            setTimeout(() => this.startGame(), 1000);
        }
    }

    handlePlayerInput(ws, message) {
        const playerData = this.players.get(ws);
        if (!playerData || !this.gameRunning) return;
        
        const speed = 8;
        
        if (playerData.id === 1) {
            if (message.input === 'up') {
                this.gameState.paddle1.dy = -speed;
            } else if (message.input === 'down') {
                this.gameState.paddle1.dy = speed;
            }
        } else if (playerData.id === 2) {
            if (message.input === 'up') {
                this.gameState.paddle2.dy = -speed;
            } else if (message.input === 'down') {
                this.gameState.paddle2.dy = speed;
            }
        }
    }

    handleInputStop(ws) {
        const playerData = this.players.get(ws);
        if (!playerData) return;
        
        if (playerData.id === 1) {
            this.gameState.paddle1.dy = 0;
        } else if (playerData.id === 2) {
            this.gameState.paddle2.dy = 0;
        }
    }

    handleMouseInput(ws, message) {
        const playerData = this.players.get(ws);
        if (!playerData || !this.gameRunning) return;
        
        const paddleY = Math.max(0, Math.min(300, message.paddleY));
        
        if (playerData.id === 1) {
            this.gameState.paddle1.y = paddleY;
            this.gameState.paddle1.dy = 0;
        } else if (playerData.id === 2) {
            this.gameState.paddle2.y = paddleY;
            this.gameState.paddle2.dy = 0;
        }
    }

    startGame() {
        console.log('🚀 Gioco iniziato!');
        this.gameRunning = true;
        this.gameState.gameRunning = true;
        
        this.broadcast({ type: 'gameStart' });
        this.gameLoopId = setInterval(() => this.updateGame(), 1000 / 60);
    }

    stopGame() {
        this.gameRunning = false;
        this.gameState.gameRunning = false;
        if (this.gameLoopId) {
            clearInterval(this.gameLoopId);
            this.gameLoopId = null;
        }
    }

    updateGame() {
        if (!this.gameRunning) return;
        
        // Aggiorna paddle
        this.gameState.paddle1.y += this.gameState.paddle1.dy;
        this.gameState.paddle2.y += this.gameState.paddle2.dy;
        
        // Limiti paddle
        this.gameState.paddle1.y = Math.max(0, Math.min(300, this.gameState.paddle1.y));
        this.gameState.paddle2.y = Math.max(0, Math.min(300, this.gameState.paddle2.y));
        
        // Aggiorna palla
        this.gameState.ball.x += this.gameState.ball.dx;
        this.gameState.ball.y += this.gameState.ball.dy;
        
        // Rimbalzo sui bordi verticali
        if (this.gameState.ball.y <= this.gameState.ball.radius || 
            this.gameState.ball.y >= 400 - this.gameState.ball.radius) {
            this.gameState.ball.dy = -this.gameState.ball.dy;
        }
        
        // Collisione con paddle sinistro
        if (this.gameState.ball.x <= 35 && 
            this.gameState.ball.y >= this.gameState.paddle1.y && 
            this.gameState.ball.y <= this.gameState.paddle1.y + 100) {
            this.gameState.ball.dx = Math.abs(this.gameState.ball.dx);
            const hitPos = (this.gameState.ball.y - this.gameState.paddle1.y - 50) / 50;
            this.gameState.ball.dy += hitPos * 3;
        }
        
        // Collisione con paddle destro
        if (this.gameState.ball.x >= 765 && 
            this.gameState.ball.y >= this.gameState.paddle2.y && 
            this.gameState.ball.y <= this.gameState.paddle2.y + 100) {
            this.gameState.ball.dx = -Math.abs(this.gameState.ball.dx);
            const hitPos = (this.gameState.ball.y - this.gameState.paddle2.y - 50) / 50;
            this.gameState.ball.dy += hitPos * 3;
        }
        
        // Goal detection
        if (this.gameState.ball.x < 0) {
            this.gameState.score2++;
            this.broadcast({ type: 'goal', scorer: 2 });
            this.resetBall();
        } else if (this.gameState.ball.x > 800) {
            this.gameState.score1++;
            this.broadcast({ type: 'goal', scorer: 1 });
            this.resetBall();
        }
        
        this.broadcast({ 
            type: 'gameState', 
            state: this.gameState 
        });
    }

    resetBall() {
        this.gameState.ball.x = 400;
        this.gameState.ball.y = 200;
        this.gameState.ball.dx = Math.random() > 0.5 ? 5 : -5;
        this.gameState.ball.dy = (Math.random() - 0.5) * 6;
        
        console.log(`⚽ Goal! Punteggio: ${this.gameState.score1} - ${this.gameState.score2}`);
        
        if (this.gameState.score1 >= 5 || this.gameState.score2 >= 5) {
            this.endGame();
        }
    }

    async endGame() {
        const winner = this.gameState.score1 > this.gameState.score2 ? 1 : 2;
        const finalScore = {
            player1: this.gameState.score1,
            player2: this.gameState.score2
        };

        await this.updateUserStats(winner);

        this.broadcast({
            type: 'gameEnd',
            winner: winner,
            finalScore: finalScore
        });

        console.log(`🏆 Partita terminata! Vince il giocatore ${winner} (${finalScore.player1}-${finalScore.player2})`);

        setTimeout(() => {
            this.stopGame();
            this.resetGameState();
            this.resetLobbyReadyState();
            this.broadcastLobbyState();
        }, 3000);
    }

    async updateUserStats(winner) {
        for (let [ws, playerData] of this.players) {
            const session = this.activeSessions.get(ws);
            if (session && session.username) {
                try {
                    if (this.db) {
                        const isWinner = playerData.id === winner;
                        await this.db.collection('users').updateOne(
                            { username: session.username },
                            {
                                $inc: {
                                    'stats.games': 1,
                                    'stats.wins': isWinner ? 1 : 0,
                                    'stats.losses': isWinner ? 0 : 1
                                }
                            }
                        );
                        console.log(`📊 Stats aggiornate nel DB per ${session.username}`);
                    }
                } catch (error) {
                    console.error('Errore aggiornamento statistiche:', error);
                }
            }
        }
    }

    resetGameState() {
        this.gameState = this.initGameState();
    }

    resetLobbyReadyState() {
        this.lobbyState.player1Ready = false;
        this.lobbyState.player2Ready = false;
        
        this.players.forEach((playerData) => {
            playerData.ready = false;
        });
    }

    broadcastLobbyState() {
        const lobbyUpdate = {
            type: 'lobbyUpdate',
            player1: !!this.lobbyState.player1,
            player2: !!this.lobbyState.player2,
            player1Ready: this.lobbyState.player1Ready,
            player2Ready: this.lobbyState.player2Ready,
            player1Name: this.lobbyState.player1Name,
            player2Name: this.lobbyState.player2Name,
            playersCount: this.lobbyState.playersCount
        };
        
        this.broadcast(lobbyUpdate);
    }

    handleDisconnection(ws) {
        const session = this.activeSessions.get(ws);
        const playerData = this.players.get(ws);
        
        if (session) {
            console.log(`👋 ${session.username} disconnesso`);
            this.activeSessions.delete(ws);
        }
        
        if (playerData) {
            if (playerData.id === 1) {
                this.lobbyState.player1 = null;
                this.lobbyState.player1Ready = false;
                this.lobbyState.player1Name = '';
            } else if (playerData.id === 2) {
                this.lobbyState.player2 = null;
                this.lobbyState.player2Ready = false;
                this.lobbyState.player2Name = '';
            }
            
            this.lobbyState.playersCount--;
            this.players.delete(ws);
            
            if (this.gameRunning) {
                this.stopGame();
            }
            
            this.broadcastLobbyState();
            this.broadcast({ type: 'playerLeft' });
        }
    }

    broadcast(message) {
        this.players.forEach((playerData, ws) => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(message));
            }
        });
    }

    start(port = process.env.PORT || 3000) {
        this.server.listen(port, '0.0.0.0', () => {
            console.log(`🌟 Server in ascolto sulla porta ${port}`);
            console.log(`🌐 Il gioco è accessibile su tutte le reti!`);
            if (process.env.RENDER_EXTERNAL_URL) {
                console.log(`🚀 URL pubblico: ${process.env.RENDER_EXTERNAL_URL}`);
            }
        });
    }

    async close() {
        if (this.client) {
            await this.client.close();
            console.log('📦 Connessione database chiusa');
        }
    }
}

// Gestione chiusura graceful
process.on('SIGINT', async () => {
    console.log('\n🛑 Arresto server in corso...');
    if (global.pongServer) {
        await global.pongServer.close();
    }
    process.exit(0);
});

// Avvia il server
global.pongServer = new PongServerDB();
global.pongServer.start();
