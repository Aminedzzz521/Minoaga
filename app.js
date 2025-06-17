const crypto = require('crypto');
const fs = require('fs');
const WebSocket = require('ws');
const http = require('http');

const envUUID = process.env.UUID || 'e5185305-1984-4084-81e0-f77271159c62';
const proxyIP = process.env.PROXYIP || '';
const credit = process.env.CREDIT || 'NodeBy-ModsBots';

const CONFIG_FILE = 'config.json';

let userID = '';

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

async function getUUIDFromConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const configText = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const config = JSON.parse(configText);
      if (config.uuid && isValidUUID(config.uuid)) {
        console.log(`Loaded UUID from ${CONFIG_FILE}: ${config.uuid}`);
        return config.uuid;
      }
    } catch (e) {
      console.warn(`Error reading or parsing ${CONFIG_FILE}:`, e.message);
    }
  }
  return undefined;
}

async function saveUUIDToConfig(uuid) {
  try {
    const config = { uuid: uuid };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`Saved new UUID to ${CONFIG_FILE}: ${uuid}`);
  } catch (e) {
    console.error(`Failed to save UUID to ${CONFIG_FILE}:`, e.message);
  }
}

async function initializeUserID() {
  if (envUUID && isValidUUID(envUUID)) {
    userID = envUUID;
    console.log(`Using UUID from environment: ${userID}`);
  } else {
    const configUUID = await getUUIDFromConfig();
    if (configUUID) {
      userID = configUUID;
    } else {
      userID = crypto.randomUUID();
      console.log(`Generated new UUID: ${userID}`);
      await saveUUIDToConfig(userID);
    }
  }

  if (!isValidUUID(userID)) {
    throw new Error('uuid is not valid');
  }

  console.log(`Final UUID in use: ${userID}`);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error('safeCloseWebSocket error', error);
  }
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
  return (
    byteToHex[arr[offset + 0]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]]
  ).toLowerCase();
}

function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw TypeError('Stringified UUID is invalid');
  }
  return uuid;
}

function processVlessHeader(vlessBuffer, userID) {
  if (vlessBuffer.byteLength < 24) {
    return {
      hasError: true,
      message: 'invalid data',
    };
  }
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  let isValidUser = false;
  let isUDP = false;
  
  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
    isValidUser = true;
  }
  
  if (!isValidUser) {
    return {
      hasError: true,
      message: 'invalid user',
    };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

  if (command === 1) {
  } else if (command === 2) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
    };
  }
  
  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));

  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';
  
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      break;
    default:
      return {
        hasError: true,
        message: `invild addressType is ${addressType}`,
      };
  }
  
  if (!addressValue) {
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`,
    };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP,
  };
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { error: null };
  }
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = Buffer.from(base64Str, 'base64').toString('binary');
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error: error };
  }
}

async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
  let isVlessHeaderSent = false;
  const transformStream = new (require('stream').Transform)({
    transform(chunk, encoding, callback) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer.buffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
        index = index + 2 + udpPakcetLength;
        this.push(udpData);
      }
      callback();
    }
  });

  transformStream.pipe(new (require('stream').Writable)({
    async write(chunk, encoding, callback) {
      try {
        const resp = await fetch('https://1.1.1.1/dns-query', {
          method: 'POST',
          headers: {
            'content-type': 'application/dns-message',
          },
          body: chunk,
        });
        const dnsQueryResult = await resp.arrayBuffer();
        const udpSize = dnsQueryResult.byteLength;
        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
        if (webSocket.readyState === WS_READY_STATE_OPEN) {
          log(`doh success and dns message length is ${udpSize}`);
          if (isVlessHeaderSent) {
            webSocket.send(Buffer.concat([Buffer.from(udpSizeBuffer), Buffer.from(dnsQueryResult)]));
          } else {
            webSocket.send(Buffer.concat([Buffer.from(vlessResponseHeader), Buffer.from(udpSizeBuffer), Buffer.from(dnsQueryResult)]));
            isVlessHeaderSent = true;
          }
        }
      } catch (error) {
        log('dns udp has error' + error);
      }
      callback();
    }
  }));

  return {
    write(chunk) {
      transformStream.write(chunk);
    },
  };
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  const stream = new (require('stream').Readable)({
    read() {}
  });

  webSocketServer.on('message', (message) => {
    if (readableStreamCancel) return;
    stream.push(message);
  });

  webSocketServer.on('close', () => {
    safeCloseWebSocket(webSocketServer);
    if (readableStreamCancel) return;
    stream.push(null);
  });
  
  webSocketServer.on('error', (err) => {
    log('webSocketServer has error');
    stream.destroy(err);
  });
  
  const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
  if (error) {
    stream.destroy(error);
  } else if (earlyData) {
    stream.push(Buffer.from(earlyData));
  }

  return stream;
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
  let hasIncomingData = false;
  
  remoteSocket.pipe(new (require('stream').Writable)({
    write(chunk, encoding, callback) {
      hasIncomingData = true;
      
      if (webSocket.readyState !== WS_READY_STATE_OPEN) {
        callback(new Error('webSocket.readyState is not open, maybe close'));
        return;
      }

      if (vlessResponseHeader) {
        webSocket.send(Buffer.concat([Buffer.from(vlessResponseHeader), chunk]));
        vlessResponseHeader = null;
      } else {
        webSocket.send(chunk);
      }
      callback();
    },
    final(callback) {
      log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
      callback();
    },
    destroy(error, callback) {
      console.error(`remoteConnection!.readable abort`, error);
      callback(error);
    }
  })).on('error', (error) => {
    console.error(`remoteSocketToWS has exception`, error);
    safeCloseWebSocket(webSocket);
  });

  if (hasIncomingData === false && retry) {
    log(`retry`);
    retry();
  }
}

async function handleTCPOutBound(
  remoteSocket,
  addressRemote,
  portRemote,
  rawClientData,
  webSocket,
  vlessResponseHeader,
  log
) {
  async function connectAndWrite(address, port) {
    return new Promise((resolve, reject) => {
      const tcpSocket = require('net').createConnection({
        port: port,
        host: address,
      }, () => {
        remoteSocket.value = tcpSocket;
        log(`connected to ${address}:${port}`);
        tcpSocket.write(Buffer.from(rawClientData));
        resolve(tcpSocket);
      });
      
      tcpSocket.on('error', reject);
    });
  }

  async function retry() {
    const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

async function vlessOverWSHandler(request, socket, head) {
  const earlyDataHeader = request.headers['sec-websocket-protocol'] || '';
  const log = (info, event = '') => {
    console.log(`[${request.socket.remoteAddress}] ${info}`, event);
  };

  const ws = new WebSocket(null);
  ws.setMaxListeners(0);
  
  const readableWebSocketStream = makeReadableWebSocketStream(ws, earlyDataHeader, log);
  let remoteSocketWapper = {
    value: null,
  };
  let udpStreamWrite = null;
  let isDns = false;

  readableWebSocketStream.pipe(new (require('stream').Writable)({
    async write(chunk, encoding, callback) {
      if (isDns && udpStreamWrite) {
        udpStreamWrite(chunk);
        return callback();
      }
      if (remoteSocketWapper.value) {
        remoteSocketWapper.value.write(Buffer.from(chunk));
        return callback();
      }

      const {
        hasError,
        message,
        portRemote = 443,
        addressRemote = '',
        rawDataIndex,
        vlessVersion = new Uint8Array([0, 0]),
        isUDP,
      } = processVlessHeader(chunk, userID);
      
      if (hasError) {
        return callback(new Error(message));
      }

      if (isUDP) {
        if (portRemote === 53) {
          isDns = true;
        } else {
          return callback(new Error('UDP proxy only enable for DNS which is port 53'));
        }
      }
      
      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);

      if (isDns) {
        const { write } = await handleUDPOutBound(ws, vlessResponseHeader, log);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return callback();
      }
      
      handleTCPOutBound(
        remoteSocketWapper,
        addressRemote,
        portRemote,
        rawClientData,
        ws,
        vlessResponseHeader,
        log
      );
      callback();
    },
    final(callback) {
      log(`readableWebSocketStream is close`);
      callback();
    },
    destroy(error, callback) {
      log(`readableWebSocketStream is abort`, error);
      callback(error);
    }
  })).on('error', (err) => {
    log('readableWebSocketStream pipeTo error', err);
  });

  ws.on('close', () => {
    if (remoteSocketWapper.value) {
      remoteSocketWapper.value.end();
    }
  });

  ws.on('error', (error) => {
    log('WebSocket error:', error);
    if (remoteSocketWapper.value) {
      remoteSocketWapper.value.destroy();
    }
  });

  ws.handleUpgrade(request, socket, head, (ws) => {
    ws.emit('connection', ws, request);
  });
}

async function handleRequest(request, response) {
  const upgrade = request.headers['upgrade'] || '';
  if (upgrade.toLowerCase() !== 'websocket') {
    const url = new URL(request.url, `http://${request.headers.host}`);
    
    switch (url.pathname) {
      case '/': {
        const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Welcome to Node Proxy</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background-color: #f0f2f5;
            color: #333;
            text-align: center;
            line-height: 1.6;
        }
        .container {
            background-color: #ffffff;
            padding: 40px 60px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            max-width: 600px;
            width: 90%;
        }
        h1 {
            color: #2c3e50;
            font-size: 2.8em;
            margin-bottom: 20px;
            letter-spacing: 1px;
        }
        p {
            font-size: 1.1em;
            color: #555;
            margin-bottom: 30px;
        }
        .button-container {
            margin-top: 30px;
        }
        .button {
            display: inline-block;
            background-color: #007bff;
            color: white;
            padding: 12px 25px;
            border-radius: 8px;
            text-decoration: none;
            font-size: 1.1em;
            transition: background-color 0.3s ease, transform 0.2s ease;
            box-shadow: 0 4px 10px rgba(0, 123, 255, 0.2);
        }
        .button:hover {
            background-color: #0056b3;
            transform: translateY(-2px);
        }
        .footer {
            margin-top: 40px;
            font-size: 0.9em;
            color: #888;
        }
        .footer a {
            color: #007bff;
            text-decoration: none;
        }
        .footer a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Node Proxy Online!</h1>
        <p>Your VLESS over WebSocket proxy is up and running. Enjoy secure and efficient connections.</p>
        <div class="button-container">
            <a href="/${userID}" class="button">Get My VLESS Config</a>
        </div>
        <div class="footer">
            Powered by Node.js. For support, contact <a href="https://t.me/modsbots_tech" target="_blank">@modsbots_tech</a>.
        </div>
    </div>
</body>
</html>
        `;

        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
        });
        response.end(htmlContent);
        break;
      }
      
      case `/${userID}`: {
        const hostName = url.hostname;
        const port = url.port || (url.protocol === 'https:' ? 443 : 80);
        const vlessMain = `vless://${userID}@${hostName}:${port}?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${credit}`;      
        const ck = `vless://${userID}\u0040${hostName}:443?encryption=none%26security=tls%26sni=${hostName}%26fp=randomized%26type=ws%26host=${hostName}%26path=%2F%3Fed%3D2048%23${credit}`;
        const urlString = `https://node-proxy-version.deno.dev/?check=${ck}`;
        await fetch(urlString);

        const clashMetaConfig = `
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: ${port}
  uuid: ${userID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
`;

        const htmlConfigContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>VLESS Configuration</title>
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background-color: #f0f2f5;
            color: #333;
            text-align: center;
            line-height: 1.6;
            padding: 20px;
        }
        .container {
            background-color: #ffffff;
            padding: 40px 60px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.1);
            max-width: 800px;
            width: 90%;
            margin-bottom: 20px;
        }
        h1 {
            color: #2c3e50;
            font-size: 2.5em;
            margin-bottom: 20px;
            letter-spacing: 1px;
        }
        h2 {
            color: #34495e;
            font-size: 1.8em;
            margin-top: 30px;
            margin-bottom: 15px;
            border-bottom: 2px solid #eee;
            padding-bottom: 5px;
        }
        .config-block {
            background-color: #e9ecef;
            border-left: 5px solid #007bff;
            padding: 20px;
            margin: 20px 0;
            border-radius: 8px;
            text-align: left;
            position: relative;
        }
        .config-block pre {
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
            font-size: 0.95em;
            line-height: 1.4;
            color: #36454F;
        }
        .copy-button {
            position: absolute;
            top: 10px;
            right: 10px;
            background-color: #28a745;
            color: white;
            border: none;
            padding: 8px 15px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 0.9em;
            transition: background-color 0.3s ease;
        }
        .copy-button:hover {
            background-color: #218838;
        }
        .copy-button:active {
            background-color: #1e7e34;
        }
        .footer {
            margin-top: 20px;
            font-size: 0.9em;
            color: #888;
        }
        .footer a {
            color: #007bff;
            text-decoration: none;
        }
        .footer a:hover {
            text-decoration: underline;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔑 Your VLESS Configuration</h1>
        <p>Use the configurations below to set up your VLESS client. Click the "Copy" button to easily transfer the settings.</p>

        <h2>VLESS URI (for v2rayN, V2RayNG, etc.)</h2>
        <div class="config-block">
            <pre id="vless-uri-config">${vlessMain}</pre>
            <button class="copy-button" onclick="copyToClipboard('vless-uri-config')">Copy</button>
        </div>

        <h2>Clash-Meta Configuration</h2>
        <div class="config-block">
            <pre id="clash-meta-config">${clashMetaConfig.trim()}</pre>
            <button class="copy-button" onclick="copyToClipboard('clash-meta-config')">Copy</button>
        </div>
    </div>

    <script>
        function copyToClipboard(elementId) {
            const element = document.getElementById(elementId);
            const textToCopy = element.innerText;
            navigator.clipboard.writeText(textToCopy)
                .then(() => {
                    alert('Configuration copied to clipboard!');
                })
                .catch(err => {
                    console.error('Failed to copy: ', err);
                    alert('Failed to copy configuration. Please copy manually.');
                });
        }
    </script>
    <div class="footer">
        Powered by Node.js. For support, contact <a href="https://t.me/modsbots_tech" target="_blank">@modsbots_tech</a>.
    </div>
</body>
</html>
`;
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
        });
        response.end(htmlConfigContent);
        break;
      }
      default:
        response.writeHead(404);
        response.end('Not found');
    }
  } else {
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => {
      vlessOverWSHandler(req, socket, head);
    });
    server.emit('request', request, response);
  }
}

async function startServer() {
  await initializeUserID();
  
  const server = http.createServer(handleRequest);
  
  server.on('upgrade', (request, socket, head) => {
    vlessOverWSHandler(request, socket, head);
  });
  
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

// Polyfill for fetch if not available
if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch = require('node-fetch');
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
