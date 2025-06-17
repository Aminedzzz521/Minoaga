const net = require('net');
const http = require('http');
const { WebSocket, createWebSocketStream } = require('ws');
const { TextDecoder } = require('util');
const axios = require('axios');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

const logcb = (...args) => console.log.bind(this, ...args);
const errcb = (...args) => console.error.bind(this, ...args);

const uuid = (process.env.UUID || 'a378c13e-27f0-44e0-afa9-138a55208041').replace(/-/g, "");
const port = process.env.PORT || 8080;
const zerothrust_auth = process.env.ZERO_AUTH || 'eyJhIjoiZmM5YWQ3MmI4ZTYyZGZkMzMxZTk1MjY3MjA1YjhmZGUiLCJ0IjoiMmRiNGIzZTAtZDRjMy00ZDQwLWI2ZTktOGJiNjJhMmRkOTYyIiwicyI6IllURTNNMkZqTkdVdE1EQTVaUzAwTXpjMExUazVaamN0Tm1VMU9UQTNOalk1TURG';

async function startServer() {
    try {
        await Promise.all([
            exec(`chmod +x server`),
            exec(`nohup ./server tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${zerothrust_auth} >/dev/null 2>&1 &`)
        ]);
        console.log('Server setup completed successfully');
    } catch (error) {
        console.error('Error during server setup:', error);
        process.exit(1);
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>HELLO WORLD</title></head>
<body><h1>HELLO WORLD</h1></body>
</html>`);
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
                    axios.get('https://example.com/api/status'),
                    checkLocalServiceStatus()
                ]);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    external: externalStatus.data,
                    local: localStatus,
                    server: 'running'
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

    const wss = new WebSocket.Server({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, ws => {
            wss.emit('connection', ws, request);
        });
    });

    const activeConnections = new Set();

    wss.on('connection', ws => {
        console.log("New WebSocket connection");
        activeConnections.add(ws);
        
        ws.on('close', () => {
            activeConnections.delete(ws);
            console.log("Connection closed. Active connections:", activeConnections.size);
        });

        ws.once('message', async msg => {
            try {
                const [VERSION] = msg;
                const id = msg.slice(1, 17);

                if (!id.every((v, i) => v === parseInt(uuid.substr(i * 2, 2), 16))) {
                    console.log("UUID mismatch. Connection rejected.");
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
                    console.log("Unsupported ATYP:", ATYP);
                    ws.close();
                    return;
                }

                console.log('New connection to:', host, port);
                ws.send(new Uint8Array([VERSION, 0]));

                const duplex = createWebSocketStream(ws);
                const socket = net.connect({ host, port }, () => {
                    socket.write(msg.slice(i));
                    duplex.on('error', err => {
                        console.error('E1:', err);
                        ws.close();
                    })
                    .pipe(socket)
                    .on('error', err => {
                        console.error('Conn-Err:', { host, port, error: err });
                        ws.close();
                    })
                    .pipe(duplex);
                });

                socket.on('error', err => {
                    console.error('Conn-Err:', { host, port, error: err });
                    ws.close();
                });

            } catch (error) {
                console.error('Error handling WebSocket message:', error);
                ws.close();
            }
        }).on('error', errcb('WebSocket Error:'));
    });

    server.listen(port, () => {
        console.log('Server listening on port:', port);
        console.log('VLESS Proxy UUID:', uuid);
        console.log('Access home page at: http://localhost:' + port);
    });

    server.on('error', err => {
        console.error('Server Error:', err);
    });
}

async function checkLocalServiceStatus() {
    try {
        const checks = await Promise.all([
            checkPortAvailability(port),
        ]);
        return { status: 'healthy', details: checks };
    } catch (error) {
        return { status: 'unhealthy', error: error.message };
    }
}

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

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

// منع Replit من إيقاف التطبيق عبر Ping ذاتي
setInterval(() => {
    const http = require('http');
    http.get(`http://localhost:${port}`, res => {
        console.log(`[SelfPing] Status: ${res.statusCode}`);
    }).on("error", err => {
        console.error("[SelfPing Error]", err.message);
    });
}, 240000); // كل 4 دقائق
