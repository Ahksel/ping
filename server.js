const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

class PongServer {
    constructor() {
        this.server = http.createServer(this.handleRequest.bind(this));
        this.wss = new WebSocket.Server({ server: this.server });
        
        this.players = new Map(); // ws -> {id, ready}
        this.gameState = this.initGameState();
        this.gameRunning = false;
        this.gameLoopId = null;
        this.lobbyState = {
            player1: null,
            player2: null,
            player1Ready: false,
            player2Ready: false,
            playersCount: 0
        };
        
        this.setupWebSocket();
        console.log('🏓 Server Pong Ultimate avviato!');
        console.log('📡 WebSocket server pronto sulla porta 3000');
        console.log('🌐 Apri http://localhost:3000 nel browser per giocare!');
        console.log('🌍 Per giocare da altre reti, configura il port forwarding sulla porta 3000');
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
        // Aggiungi headers CORS per servizi cloud
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        
        if (req.url === '/') {
            // Serve il file HTML del gioco
            const htmlPath = path.join(__dirname, 'index.html');
            
            // Prova prima con index.html (standard Glitch)
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
                // Fallback per pong.html
                const pongPath = path.join(__dirname, 'pong.html');
                if (fs.existsSync(pongPath)) {
                    fs.readFile(pongPath, (err, data) => {
                        if (err) {
                            res.writeHead(500);
                            res.end('Errore nel caricamento del gioco');
                            return;
                        }
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(data);
                    });
                } else {
                    // HTML inline di debug
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
                        <h1>🏓 Server Pong Ultimate Attivo!</h1>
                        <p><strong>WebSocket server attivo!</strong></p>
                        <p>File HTML non trovato. Assicurati di avere:</p>
                        <ul>
                            <li><code>index.html</code> (preferito)</li>
                            <li>oppure <code>pong.html</code></li>
                        </ul>
                        <p><strong>URL WebSocket:</strong> <code>wss://${req.headers.host}</code></p>
                        <script>
                            console.log('🏓 Tentativo connessione WebSocket...');
                            const ws = new WebSocket('wss://' + window.location.host);
                            ws.onopen = () => console.log('✅ WebSocket OK!');
                            ws.onerror = (e) => console.error('❌ WebSocket ERROR:', e);
                        </script>
                    `);
                }
            }
        } else {
            res.writeHead(404);
            res.end('Pagina non trovata');
        }
    }
    
    setupWebSocket() {
        this.wss.on('connection', (ws) => {
            console.log('🎮 Nuovo giocatore connesso');
            
            // Assegna ID giocatore
            let playerId = null;
            if (!this.lobbyState.player1) {
                playerId = 1;
                this.lobbyState.player1 = ws;
            } else if (!this.lobbyState.player2) {
                playerId = 2;
                this.lobbyState.player2 = ws;
            } else {
                ws.send(JSON.stringify({ type: 'error', message: 'Lobby piena!' }));
                ws.close();
                return;
            }
            
            this.players.set(ws, { id: playerId, ready: false });
            this.lobbyState.playersCount++;
            
            ws.send(JSON.stringify({ type: 'playerId', id: playerId }));
            
            console.log(`👤 Giocatore ${playerId} connesso (${this.lobbyState.playersCount}/2)`);
            
            // Invia stato lobby aggiornato
            this.broadcastLobbyState();
            
            // Gestisci messaggi
            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    this.handlePlayerMessage(ws, message);
                } catch (error) {
                    console.error('Errore nel parsing del messaggio:', error);
                }
            });
            
            // Gestisci disconnessione
            ws.on('close', () => {
                const playerData = this.players.get(ws);
                if (playerData) {
                    console.log(`👋 Giocatore ${playerData.id} disconnesso`);
                    
                    // Reset lobby state
                    if (playerData.id === 1) {
                        this.lobbyState.player1 = null;
                        this.lobbyState.player1Ready = false;
                    } else {
                        this.lobbyState.player2 = null;
                        this.lobbyState.player2Ready = false;
                    }
                    
                    this.lobbyState.playersCount--;
                    this.players.delete(ws);
                    
                    if (this.gameRunning) {
                        this.stopGame();
                    }
                    
                    this.broadcastLobbyState();
                    this.broadcast({ type: 'playerLeft' });
                }
            });
        });
    }

    handlePlayerMessage(ws, message) {
        const playerData = this.players.get(ws);
        if (!playerData) return;

        switch (message.type) {
            case 'playerReady':
                this.handlePlayerReady(ws, message.ready);
                break;
            case 'input':
                if (this.gameRunning) {
                    this.handlePlayerInput(ws, message);
                }
                break;
            case 'inputStop':
                if (this.gameRunning) {
                    this.handleInputStop(ws);
                }
                break;
        }
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
        
        // Controlla se entrambi sono pronti
        if (this.lobbyState.player1Ready && this.lobbyState.player2Ready && 
            this.lobbyState.playersCount === 2) {
            console.log('🚀 Entrambi i giocatori pronti! Iniziando il gioco...');
            setTimeout(() => this.startGame(), 1000);
        }
    }

    broadcastLobbyState() {
        const lobbyUpdate = {
            type: 'lobbyUpdate',
            player1: !!this.lobbyState.player1,
            player2: !!this.lobbyState.player2,
            player1Ready: this.lobbyState.player1Ready,
            player2Ready: this.lobbyState.player2Ready,
            playersCount: this.lobbyState.playersCount
        };
        
        this.broadcast(lobbyUpdate);
    }
    
    handlePlayerInput(ws, message) {
        if (message.type === 'input' && this.gameRunning) {
            const playerData = this.players.get(ws);
            if (!playerData) return;
            
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
    
    startGame() {
        console.log('🚀 Gioco iniziato!');
        this.gameRunning = true;
        this.gameState.gameRunning = true;
        
        this.broadcast({ type: 'gameStart' });
        this.gameLoopId = setInterval(() => this.updateGame(), 1000 / 60); // 60 FPS
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
            // Aggiungi effetto spin
            const hitPos = (this.gameState.ball.y - this.gameState.paddle1.y - 50) / 50;
            this.gameState.ball.dy += hitPos * 3;
        }
        
        // Collisione con paddle destro
        if (this.gameState.ball.x >= 765 && 
            this.gameState.ball.y >= this.gameState.paddle2.y && 
            this.gameState.ball.y <= this.gameState.paddle2.y + 100) {
            this.gameState.ball.dx = -Math.abs(this.gameState.ball.dx);
            // Aggiungi effetto spin
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
        
        // Invia stato di gioco
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
}

// Avvia il server
const pongServer = new PongServer();
pongServer.start();
