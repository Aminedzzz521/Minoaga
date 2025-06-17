const net = require('net');
const http = require('http');
const { WebSocket, createWebSocketStream } = require('ws');
const { TextDecoder } = require('util');
const axios = require('axios');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// تحسين نظام التسجيل (Logging)
const logger = {
    log: (...args) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}]`, ...args);
    },
    error: (...args) => {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] ERROR:`, ...args);
    }
};

// إعدادات التكوين
const uuid = (process.env.UUID || 'a378c13e-27f0-44e0-afa9-138a55208041').replace(/-/g, "");
const port = process.env.PORT || 8080;
const zerothrust_auth = process.env.ZERO_AUTH || 'eyJhIjoiZmM5YWQ3MmI4ZTYyZGZkMzMxZTk1MjY3MjA1YjhmZGUiLCJ0IjoiMmRiNGIzZTAtZDRjMy00ZDQwLWI2ZTktOGJiNjJhMmRkOTYyIiwicyI6IllURTNNMkZqTkdVdE1EQTVaUzAwTXpjMExUazVaamN0Tm1VMU9UQTNOalk1TURG';
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000; // 5 ثواني

class ServerManager {
    constructor() {
        this.server = null;
        this.wss = null;
        this.activeConnections = new Set();
        this.retryCount = 0;
    }

    async start() {
        try {
            await this.setupServer();
            await this.startHttpServer();
            logger.log('Server started successfully');
            this.retryCount = 0; // إعادة تعيين عداد المحاولات بعد نجاح التشغيل
        } catch (error) {
            logger.error('Failed to start server:', error);
            
            if (this.retryCount < MAX_RETRIES) {
                this.retryCount++;
                logger.log(`Retrying (${this.retryCount}/${MAX_RETRIES}) in ${RETRY_DELAY/1000} seconds...`);
                setTimeout(() => this.start(), RETRY_DELAY);
            } else {
                logger.error('Max retries reached. Exiting...');
                process.exit(1);
            }
        }
    }

    async setupServer() {
        try {
            await Promise.all([
                exec(`chmod +x server`),
                exec(`nohup ./server tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${zerothrust_auth} >/dev/null 2>&1 &`)
            ]);
            logger.log('Server setup completed successfully');
        } catch (error) {
            logger.error('Error during server setup:', error);
            throw error;
        }
    }

    async startHttpServer() {
        return new Promise((resolve, reject) => {
            // إنشاء خادم HTTP
            this.server = http.createServer(async (req, res) => {
                const url = new URL(req.url, `http://${req.headers.host}`);

                if (req.method === 'GET' && url.pathname === '/') {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>HELLO WORLD</title>
</head>
<body>
    <h1>HELLO WORLD</h1>
    <p>Server uptime: ${process.uptime()} seconds</p>
    <p>Active connections: ${this.activeConnections.size}</p>
</body>
</html>
                    `);
                } else if (req.method === 'GET' && url.searchParams.get('check') === 'VLESS__CONFIG') {
                    const hostname = req.headers.host.split(':')[0];
                    const vlessConfig = {
                        uuid: uuid,
                        port: port,
                        host: hostname,
                        vless_uri: `vless://${uuid}@${hostname}:443?security=tls&fp=randomized&type=ws&${hostname}&encryption=none`
                    };
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(vlessConfig));
                } else if (req.method === 'GET' && url.pathname === '/status') {
                    try {
                        const [externalStatus, localStatus] = await Promise.all([
                            axios.get('https://example.com/api/status').catch(() => ({ data: 'external check failed' })),
                            checkLocalServiceStatus()
                        ]);
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            external: externalStatus.data,
                            local: localStatus,
                            server: 'running',
                            uptime: process.uptime(),
                            connections: this.activeConnections.size
                        }));
                    } catch (error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Status check failed' }));
                    }
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                }
            });

            // إعداد خادم WebSocket
            this.wss = new WebSocket.Server({ noServer: true });

            this.server.on('upgrade', (request, socket, head) => {
                // إضافة مهلة للاتصال لمنع التوقف
                socket.setTimeout(30000, () => {
                    logger.log('Connection timeout, closing socket');
                    socket.destroy();
                });

                this.wss.handleUpgrade(request, socket, head, ws => {
                    this.wss.emit('connection', ws, request);
                });
            });

            this.wss.on('connection', ws => {
                logger.log("New WebSocket connection");
                this.activeConnections.add(ws);
                
                ws.on('close', () => {
                    this.activeConnections.delete(ws);
                    logger.log(`Connection closed. Active connections: ${this.activeConnections.size}`);
                });

                ws.once('message', async msg => {
                    try {
                        const [VERSION] = msg;
                        const id = msg.slice(1, 17);

                        if (!id.every((v, i) => v === parseInt(uuid.substr(i * 2, 2), 16))) {
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

                        logger.log('New connection to:', host, port);
                        ws.send(new Uint8Array([VERSION, 0]));

                        const duplex = createWebSocketStream(ws);
                        const socket = net.connect({ host, port }, () => {
                            socket.write(msg.slice(i));
                            duplex.on('error', err => logger.error('Duplex error:', err))
                                .pipe(socket)
                                .on('error', err => logger.error('Socket error:', err))
                                .pipe(duplex);
                        });

                        socket.on('error', err => logger.error('Connection error:', { host, port, error: err }));
                    } catch (error) {
                        logger.error('Error handling WebSocket message:', error);
                        ws.close();
                    }
                }).on('error', err => logger.error('WebSocket Error:', err));
            });

            // بدء الخادم
            this.server.listen(port, () => {
                logger.log(`Server listening on port: ${port}`);
                logger.log(`VLESS Proxy UUID: ${uuid}`);
                logger.log(`Access home page at: http://localhost:${port}`);
                resolve();
            });

            this.server.on('error', err => {
                logger.error('Server Error:', err);
                reject(err);
            });
        });
    }

    async shutdown() {
        logger.log('Shutting down server...');
        
        // إغلاق جميع الاتصالات النشطة
        this.activeConnections.forEach(ws => {
            try {
                ws.close();
            } catch (err) {
                logger.error('Error closing connection:', err);
            }
        });

        // إغلاق خادم WebSocket
        if (this.wss) {
            await new Promise(resolve => {
                this.wss.close(err => {
                    if (err) logger.error('Error closing WebSocket server:', err);
                    resolve();
                });
            });
        }

        // إغلاق خادم HTTP
        if (this.server) {
            await new Promise(resolve => {
                this.server.close(err => {
                    if (err) logger.error('Error closing HTTP server:', err);
                    resolve();
                });
            });
        }

        logger.log('Server shutdown complete');
    }
}

// دالة مساعدة للتحقق من حالة الخدمة المحلية
async function checkLocalServiceStatus() {
    try {
        const checks = await Promise.all([
            checkPortAvailability(port),
        ]);
        
        return {
            status: 'healthy',
            details: checks
        };
    } catch (error) {
        return {
            status: 'unhealthy',
            error: error.message
        };
    }
}

// دالة مساعدة للتحقق من توفر المنفذ
function checkPortAvailability(port) {
    return new Promise((resolve, reject) => {
        const tester = net.createServer()
            .once('error', err => {
                if (err.code === 'EADDRINUSE') {
                    resolve({ port, available: false });
                } else {
                    reject(err);
                }
            })
            .once('listening', () => {
                tester.once('close', () => {
                    resolve({ port, available: true });
                }).close();
            })
            .listen(port);
    });
}

// معالجة إشارات الإغلاق
process.on('SIGINT', () => {
    logger.log('Received SIGINT signal');
    serverManager.shutdown().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
    logger.log('Received SIGTERM signal');
    serverManager.shutdown().then(() => process.exit(0));
});

process.on('uncaughtException', err => {
    logger.error('Uncaught Exception:', err);
    serverManager.shutdown()
        .then(() => process.exit(1))
        .catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// بدء تشغيل الخادم
const serverManager = new ServerManager();
serverManager.start();
