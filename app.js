const net = require('net');
const http = require('http');
const { WebSocket, createWebSocketStream } = require('ws');
const { TextDecoder } = require('util');
const axios = require('axios');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// تحسين نظام التسجيل مع طابع زمني
const logger = {
    log: (...args) => console.log(`[${new Date().toISOString()}]`, ...args),
    error: (...args) => console.error(`[${new Date().toISOString()}] ERROR:`, ...args)
};

// إعدادات التكوين مع قيم افتراضية محسنة
const config = {
    uuid: (process.env.UUID || 'a378c13e-27f0-44e0-afa9-138a55208041').replace(/-/g, ""),
    port: process.env.PORT || 8080,
    zerothrust_auth: process.env.ZERO_AUTH || 'your-auth-token',
    connectionTimeout: 60000, // 60 ثانية مهلة للاتصال
    pingInterval: 30000, // إرسال ping كل 30 ثانية
    maxConnections: 100, // الحد الأقصى للاتصالات المتزامنة
    keepAlive: true // تفعيل إبقاء الاتصال نشطاً
};

class VLESSProxyServer {
    constructor() {
        this.server = null;
        this.wss = null;
        this.activeConnections = new Set();
        this.connectionCount = 0;
        this.isShuttingDown = false;
    }

    async start() {
        try {
            logger.log('Starting VLESS proxy server...');
            
            // إعداد الخادم الأساسي
            await this.setupBackendServer();
            
            // بدء خادم HTTP و WebSocket
            await this.startWebSocketServer();
            
            logger.log(`Server running on port ${config.port}`);
            logger.log(`VLESS UUID: ${config.uuid}`);
            
            // بدء إرسال إشارات ping للحفاظ على الاتصال
            this.startPingInterval();
            
        } catch (error) {
            logger.error('Failed to start server:', error);
            this.restartServer();
        }
    }

    async setupBackendServer() {
        try {
            await Promise.all([
                exec('chmod +x server'),
                exec(`nohup ./server tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${config.zerothrust_auth} >/dev/null 2>&1 &`)
            ]);
            logger.log('Backend server setup completed');
        } catch (error) {
            logger.error('Backend setup error:', error);
            throw error;
        }
    }

    async startWebSocketServer() {
        return new Promise((resolve, reject) => {
            // إنشاء خادم HTTP
            this.server = http.createServer((req, res) => {
                this.handleHttpRequest(req, res);
            });

            // إعداد خادم WebSocket
            this.wss = new WebSocket.Server({ 
                noServer: true,
                maxPayload: 64 * 1024 * 1024 // 64MB (للاستخدام مع VLESS)
            });

            // معالجة ترقية الاتصال إلى WebSocket
            this.server.on('upgrade', (req, socket, head) => {
                if (this.isShuttingDown || this.connectionCount >= config.maxConnections) {
                    socket.destroy();
                    return;
                }

                socket.setTimeout(config.connectionTimeout, () => {
                    logger.log('Connection timeout, closing socket');
                    socket.destroy();
                });

                this.wss.handleUpgrade(req, socket, head, (ws) => {
                    this.handleWebSocketConnection(ws, req);
                });
            });

            // بدء الاستماع على المنفذ
            this.server.listen(config.port, () => {
                logger.log(`HTTP server listening on port ${config.port}`);
                resolve();
            });

            this.server.on('error', (err) => {
                logger.error('HTTP server error:', err);
                reject(err);
            });
        });
    }

    handleHttpRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(this.generateHomePage());
        } else if (req.method === 'GET' && url.searchParams.get('check') === 'VLESS__CONFIG') {
            this.sendVlessConfig(req, res);
        } else if (req.method === 'GET' && url.pathname === '/status') {
            this.sendServerStatus(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    }

    generateHomePage() {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>VLESS Proxy Server</title>
    <meta http-equiv="refresh" content="30">
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .status { padding: 10px; margin: 10px 0; border-radius: 5px; }
        .healthy { background-color: #d4edda; color: #155724; }
        .unhealthy { background-color: #f8d7da; color: #721c24; }
    </style>
</head>
<body>
    <h1>VLESS Proxy Server</h1>
    <div class="status ${this.isShuttingDown ? 'unhealthy' : 'healthy'}">
        Status: ${this.isShuttingDown ? 'Shutting down' : 'Running'}
    </div>
    <p>Server uptime: ${Math.floor(process.uptime())} seconds</p>
    <p>Active connections: ${this.connectionCount}</p>
    <p>Max connections: ${config.maxConnections}</p>
</body>
</html>
        `;
    }

    sendVlessConfig(req, res) {
        const hostname = req.headers.host.split(':')[0];
        const vlessConfig = {
            uuid: config.uuid,
            port: config.port,
            host: hostname,
            vless_uri: `vless://${config.uuid}@${hostname}:443?security=tls&fp=randomized&type=ws&path=/&host=${hostname}&encryption=none`
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(vlessConfig));
    }

    async sendServerStatus(res) {
        try {
            const [externalStatus, localStatus] = await Promise.all([
                axios.get('https://www.google.com').catch(() => ({ data: 'external check failed' })),
                this.checkLocalStatus()
            ]);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'running',
                uptime: process.uptime(),
                connections: this.connectionCount,
                external: externalStatus.status,
                local: localStatus
            }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Status check failed', details: error.message }));
        }
    }

    handleWebSocketConnection(ws, req) {
        if (this.isShuttingDown) {
            ws.close();
            return;
        }

        this.connectionCount++;
        this.activeConnections.add(ws);
        logger.log(`New connection (Total: ${this.connectionCount})`);

        // إعداد معالجات الأحداث للاتصال الجديد
        ws.on('close', () => this.handleConnectionClose(ws));
        ws.on('error', (err) => this.handleConnectionError(ws, err));
        ws.on('pong', () => this.handlePong(ws));
        
        // بدء إرسال ping للحفاظ على الاتصال
        if (config.keepAlive) {
            this.setupConnectionPing(ws);
        }

        // معالجة الرسائل الواردة
        ws.on('message', (msg) => this.handleVlessMessage(ws, msg));
    }

    handleConnectionClose(ws) {
        this.connectionCount--;
        this.activeConnections.delete(ws);
        logger.log(`Connection closed (Remaining: ${this.connectionCount})`);
        
        // إلغاء أي مهلات ping مرتبطة بهذا الاتصال
        if (ws.pingInterval) {
            clearInterval(ws.pingInterval);
        }
    }

    handleConnectionError(ws, err) {
        logger.error('WebSocket error:', err);
        ws.close();
    }

    handlePong(ws) {
        ws.isAlive = true;
    }

    setupConnectionPing(ws) {
        ws.isAlive = true;
        
        ws.pingInterval = setInterval(() => {
            if (ws.isAlive === false) {
                logger.log('Terminating dead connection');
                ws.terminate();
                return;
            }
            
            ws.isAlive = false;
            ws.ping(() => {});
        }, config.pingInterval);
    }

    async handleVlessMessage(ws, msg) {
        try {
            // تحقق من أن الرسالة هي Buffer
            if (!Buffer.isBuffer(msg)) {
                logger.log('Invalid message type, expected Buffer');
                ws.close();
                return;
            }

            // التحقق من صحة رسالة VLESS
            if (msg.length < 18) {
                logger.log('Invalid VLESS message length');
                ws.close();
                return;
            }

            const [VERSION] = msg;
            const id = msg.slice(1, 17);

            // التحقق من تطابق UUID
            if (!id.every((v, i) => v === parseInt(config.uuid.substr(i * 2, 2), 16))) {
                logger.log("UUID mismatch. Connection rejected.");
                ws.close();
                return;
            }

            let i = msg.slice(17, 18).readUInt8() + 19;
            const port = msg.slice(i, i += 2).readUInt16BE(0);
            const ATYP = msg.slice(i, i += 1).readUInt8();

            let host;
            if (ATYP === 1) {
                host = msg.slice(i, i += 4).join('.');
            } else if (ATYP === 2) {
                host = new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8()));
            } else if (ATYP === 3) {
                host = msg.slice(i, i += 16).reduce((s, b, idx, arr) => 
                    (idx % 2 ? s.concat(arr.slice(idx - 1, idx + 1)) : s), [])
                    .map(b => b.readUInt16BE(0).toString(16))
                    .join(':');
            } else {
                logger.log("Unsupported ATYP:", ATYP);
                ws.close();
                return;
            }

            logger.log(`New VLESS connection to: ${host}:${port}`);
            ws.send(new Uint8Array([VERSION, 0]));

            // إنشاء اتصال TCP إلى الوجهة النهائية
            this.createTcpProxy(ws, msg.slice(i), host, port);
        } catch (error) {
            logger.error('Error processing VLESS message:', error);
            ws.close();
        }
    }

    createTcpProxy(ws, remainingMsg, host, port) {
        const duplex = createWebSocketStream(ws, {
            decodeStrings: false,
            encoding: 'binary'
        });

        const socket = net.connect({ 
            host, 
            port,
            timeout: config.connectionTimeout
        }, () => {
            socket.write(remainingMsg);
            
            duplex.on('error', (err) => {
                logger.error('Duplex error:', err);
                socket.end();
            });
            
            socket.on('error', (err) => {
                logger.error('Socket error:', err);
                duplex.end();
            });
            
            duplex.pipe(socket).pipe(duplex);
        });

        socket.on('timeout', () => {
            logger.log(`Socket timeout for ${host}:${port}`);
            socket.end();
        });

        socket.on('close', () => {
            logger.log(`Connection to ${host}:${port} closed`);
        });
    }

    startPingInterval() {
        // إرسال ping عام للخادم كل دقيقة لمنع إيقافه
        this.globalPingInterval = setInterval(() => {
            logger.log('Server heartbeat ping');
        }, 60000);
    }

    async checkLocalStatus() {
        return {
            status: 'healthy',
            connections: this.connectionCount,
            maxConnections: config.maxConnections,
            uptime: process.uptime()
        };
    }

    async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        
        logger.log('Starting graceful shutdown...');
        
        // إيقاف الفترات الزمنية
        if (this.globalPingInterval) {
            clearInterval(this.globalPingInterval);
        }
        
        // إغلاق جميع اتصالات WebSocket النشطة
        const closePromises = [];
        this.activeConnections.forEach(ws => {
            closePromises.push(new Promise(resolve => {
                ws.once('close', resolve);
                ws.close();
            }));
        });
        
        await Promise.all(closePromises);
        
        // إغلاق خادم WebSocket
        if (this.wss) {
            await new Promise(resolve => {
                this.wss.close(resolve);
            });
        }
        
        // إغلاق خادم HTTP
        if (this.server) {
            await new Promise(resolve => {
                this.server.close(resolve);
            });
        }
        
        logger.log('Shutdown completed');
    }

    restartServer() {
        logger.log('Attempting to restart server...');
        this.shutdown().then(() => {
            setTimeout(() => {
                this.isShuttingDown = false;
                this.start();
            }, 5000);
        });
    }
}

// معالجة إشارات الإغلاق
process.on('SIGINT', () => {
    logger.log('Received SIGINT (Ctrl+C)');
    server.shutdown().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
    logger.log('Received SIGTERM');
    server.shutdown().then(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    server.restartServer();
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// بدء تشغيل الخادم
const server = new VLESSProxyServer();
server.start();

// إبقاء العملية نشطة (مهم لـ Replit)
setInterval(() => {}, 1000);
