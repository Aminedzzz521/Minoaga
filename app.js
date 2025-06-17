const net = require('net');
const http = require('http');
const { WebSocket, createWebSocketStream } = require('ws');
const { TextDecoder } = require('util');
const axios = require('axios');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// ========== [Global Config] ==========
const CONFIG = {
  PORT: process.env.PORT || 8080,
  UUID: (process.env.UUID || 'a378c13e-27f0-44e0-afa9-138a55208041').replace(/-/g, ""),
  ZERO_AUTH: process.env.ZERO_AUTH || 'eyJhIjoiZmM5YWQ3MmI4ZTYyZGZkMzMxZTk1MjY3MjA1YjhmZGUiLCJ0IjoiMmRiNGIzZTAtZDRjMy00ZDQwLWI2ZTktOGJiNjJhMmRkOTYyIiwicyI6IllURTNNMkZqTkdVdE1EQTVaUzAwTXpjMExUazVaamN0Tm1VMU9UQTNOalk1TURG',
  KEEP_ALIVE_INTERVAL: 240000, // 4 دقائق
  PING_TIMEOUT: 5000 // 5 ثواني
};

// ========== [Logger Functions] ==========
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function error(...args) {
  console.error(`[${new Date().toISOString()}]`, ...args);
}

// ========== [Server Utilities] ==========
async function setupServerBinary() {
  try {
    log('Setting up server binaries...');
    await Promise.all([
      exec('chmod +x server'),
      exec(`nohup ./server tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token ${CONFIG.ZERO_AUTH} >/dev/null 2>&1 &`)
    ]);
    log('Server binaries setup completed');
  } catch (err) {
    error('Failed to setup server binaries:', err);
    throw err;
  }
}

async function checkPortAvailability(port) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.once('close', () => resolve(true)).close();
      })
      .listen(port);
  });
}

// ========== [Keep-Alive Mechanism] ==========
function startKeepAlive(port) {
  const pingServer = async () => {
    try {
      const response = await axios.get(`http://localhost:${port}/ping`, {
        timeout: CONFIG.PING_TIMEOUT
      });
      log(`Keep-Alive Ping Successful (Status: ${response.data.status})`);
    } catch (err) {
      error('Keep-Alive Ping Failed:', err.message);
    }
  };

  // Ping immediately on startup
  pingServer();
  
  // Set up periodic pinging
  const intervalId = setInterval(pingServer, CONFIG.KEEP_ALIVE_INTERVAL);
  
  return intervalId;
}

// ========== [WebSocket Handler] ==========
function handleWebSocketConnection(ws) {
  log('New WebSocket connection');
  
  const connectionInfo = {
    id: Math.random().toString(36).substring(7),
    startTime: Date.now()
  };

  ws.on('message', async (msg) => {
    try {
      // Handle VLESS protocol messages here
      // ... (الكود الأصلي لمعالجة رسائل VLESS)
    } catch (err) {
      error('WebSocket message error:', err);
      ws.close();
    }
  });

  ws.on('close', () => {
    log(`Connection ${connectionInfo.id} closed after ${(Date.now() - connectionInfo.startTime)/1000}s`);
  });

  ws.on('error', (err) => {
    error('WebSocket error:', err);
  });
}

// ========== [HTTP Server] ==========
function createHttpServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      
      // Route Handling
      if (req.method === 'GET') {
        switch (url.pathname) {
          case '/':
            return serveHomePage(res);
          case '/ping':
            return servePingResponse(res);
          case '/status':
            return await serveStatusPage(res);
          case '/config':
            return serveVlessConfig(req, res);
          default:
            return serveNotFound(res);
        }
      } else {
        return serveNotFound(res);
      }
    } catch (err) {
      error('HTTP request error:', err);
      serveServerError(res);
    }
  });

  // WebSocket Upgrade Handler
  const wss = new WebSocket.Server({ noServer: true });
  wss.on('connection', handleWebSocketConnection);

  server.on('upgrade', (req, socket, head) => {
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (err) {
      error('WebSocket upgrade error:', err);
      socket.destroy();
    }
  });

  return server;
}

// ========== [HTTP Route Handlers] ==========
function serveHomePage(res) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>VLESS Server</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 2rem; line-height: 1.6 }
    .container { max-width: 800px; margin: 0 auto }
    .status { padding: 1rem; background: #f5f5f5; border-radius: 5px }
  </style>
</head>
<body>
  <div class="container">
    <h1>VLESS Proxy Server</h1>
    <div class="status">
      <p>Server is running with Keep-Alive mechanism</p>
      <p>UUID: ${CONFIG.UUID}</p>
      <p>Port: ${CONFIG.PORT}</p>
      <p><a href="/ping">Check server status</a></p>
      <p><a href="/config">Show VLESS config</a></p>
    </div>
  </div>
</body>
</html>
  `);
}

function servePingResponse(res) {
  res.writeHead(200, { 
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify({
    status: 'alive',
    timestamp: Date.now(),
    uptime: process.uptime()
  }));
}

async function serveStatusPage(res) {
  try {
    const [portAvailable, externalStatus] = await Promise.all([
      checkPortAvailability(CONFIG.PORT),
      axios.get('https://httpbin.org/get').catch(() => ({ data: 'external_check_failed' }))
    ]);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      server: {
        status: 'running',
        port: CONFIG.PORT,
        port_available: portAvailable,
        uptime: process.uptime()
      },
      external_status: externalStatus.data
    }));
  } catch (err) {
    error('Status check error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Status check failed' }));
  }
}

function serveVlessConfig(req, res) {
  const hostname = req.headers.host.split(':')[0];
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    uuid: CONFIG.UUID,
    port: CONFIG.PORT,
    host: hostname,
    vless_uri: `vless://${CONFIG.UUID}@${hostname}:443?security=tls&fp=randomized&type=ws&${hostname}&encryption=none`
  }));
}

function serveNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

function serveServerError(res) {
  res.writeHead(500, { 'Content-Type': 'text/plain' });
  res.end('Internal Server Error');
}

// ========== [Main Server Startup] ==========
async function startServer() {
  try {
    // Verify port availability
    const portAvailable = await checkPortAvailability(CONFIG.PORT);
    if (!portAvailable) {
      throw new Error(`Port ${CONFIG.PORT} is already in use`);
    }

    // Setup server binary
    await setupServerBinary();

    // Create HTTP server
    const server = createHttpServer();

    // Start listening
    server.listen(CONFIG.PORT, '0.0.0.0', () => {
      log(`Server started on port ${CONFIG.PORT}`);
      log(`Web interface available at: http://localhost:${CONFIG.PORT}`);
      
      // Start keep-alive mechanism
      const keepAliveInterval = startKeepAlive(CONFIG.PORT);
      
      // Cleanup on exit
      process.on('SIGINT', () => {
        log('Shutting down server...');
        clearInterval(keepAliveInterval);
        server.close(() => {
          process.exit(0);
        });
      });
    });

    server.on('error', (err) => {
      error('Server error:', err);
      process.exit(1);
    });

  } catch (err) {
    error('Failed to start server:', err);
    process.exit(1);
  }
}

// ========== [Start the Server] ==========
startServer();
