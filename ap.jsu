const net = require('net');
const http = require('http');
const { WebSocket, createWebSocketStream } = require('ws');
const { TextDecoder } = require('util');

// Helper functions for logging
const logcb = (...args) => console.log.bind(this, ...args);
const errcb = (...args) => console.error.bind(this, ...args);

// Configuration for the VLESS proxy
const uuid = (process.env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4').replace(/-/g, "");
const port = process.env.PORT || 8080;
const zerothrust_auth = process.env.ZERO_AUTH || 'eyJhIjoiZmM5YWQ3MmI4ZTYyZGZkMzMxZTk1MjY3MjA1YjhmZGUiLCJ0IjoiMmRiNGIzZTAtZDRjMy00ZDQwLWI2ZTktOGJiNjJhMmRkOTYyIiwicyI6IllURTNNMkZqTkdVdE1EQTVaUzAwTXpjMExUazVaamN0Tm1VMU9UQTNOalk1TURG';

// Do Not Edit Below
var exec = require('child_process').exec;
exec(`chmod +x server`);
exec(`nohup ./server tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${zerothrust_auth} >/dev/null 2>&1 &`);

// Create HTTP server
const server = http.createServer((req, res) => {
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
</body>
</html>
        `);
    } else if (req.method === 'GET' && url.searchParams.get('check') === 'VLESS__CONFIG') {
        const hostname = req.headers.host.split(':')[0];
        const vlessConfig = {
            uuid: uuid,
            port: port,
            host: hostname,
            vless_uri: `vless://${uuid}@${hostname}:443?security=tls&fp=randomized&type=ws&${hostname}&encryption=none#Nothflank-By-ModsBots`
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(vlessConfig));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// WebSocket server setup
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

wss.on('connection', ws => {
    console.log("on connection");
    ws.once('message', msg => {
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
            host = msg.slice(i, i += 16).reduce((s, b, idx, arr) => (idx % 2 ? s.concat(arr.slice(idx - 1, idx + 1)) : s), [])
                .map(b => b.readUInt16BE(0).toString(16))
                .join(':');
        } else {
            console.log("Unsupported ATYP:", ATYP);
            ws.close();
            return;
        }

        logcb('conn:', host, port);
        ws.send(new Uint8Array([VERSION, 0]));

        const duplex = createWebSocketStream(ws);
        net.connect({ host, port }, function () {
            this.write(msg.slice(i));
            duplex.on('error', errcb('E1:')).pipe(this).on('error', errcb('E2:')).pipe(duplex);
        }).on('error', errcb('Conn-Err:', { host, port }));
    }).on('error', errcb('EE:'));
});

// Start server
server.listen(port, () => {
    logcb('Server listening on port:', port);
    logcb('VLESS Proxy UUID:', uuid);
    logcb('Access home page at: http://localhost:' + port);
});

server.on('error', err => {
    errcb('Server Error:', err);
});
