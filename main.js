const net = require('net');
const http = require('http'); // Import http module for serving the home page
const { WebSocket, createWebSocketStream } = require('ws');
const { TextDecoder } = require('util');

// Helper functions for logging
const logcb = (...args) => console.log.bind(this, ...args);
const errcb = (...args) => console.error.bind(this, ...args);

// Configuration for the VLESS proxy
// The UUID can be set via environment variable or defaults to a specific value
const uuid = (process.env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4').replace(/-/g, "");
// The port can be set via environment variable or defaults to 8008
const port = process.env.PORT || 8080;

// Create an HTTP server to handle both web page requests and WebSocket upgrades
const server = http.createServer((req, res) => {
    // Parse the URL to check for query parameters.
    // This allows the server to differentiate between '/' and '/?check=...'
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Serve the home page for GET requests to the root path
    if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        // HTML content for the home page, styled with Tailwind CSS
        // The client-side JavaScript now includes logic to fetch external VLESS config status
        res.end(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>VLESS Proxy Server</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <style>
                    /* Custom font for better aesthetics */
                    body {
                        font-family: 'Inter', sans-serif;
                    }
                    /* Styles for the modal backdrop */
                    .modal-backdrop {
                        background-color: rgba(0, 0, 0, 0.5);
                        z-index: 999; /* Ensure it's on top */
                    }
                    /* Styles for the modal content */
                    .modal-content {
                        z-index: 1000; /* Ensure it's on top of the backdrop */
                    }
                </style>
            </head>
            <body class="bg-gradient-to-br from-blue-500 to-purple-600 min-h-screen flex items-center justify-center p-4">
                <div class="bg-white p-8 rounded-lg shadow-xl max-w-md w-full text-center">
                    <h1 class="text-4xl font-bold text-gray-800 mb-4">VLESS Proxy</h1>
                    <p class="text-lg text-gray-600 mb-6">
                        Your secure and efficient proxy server is running.
                    </p>
                    <div class="bg-gray-100 p-6 rounded-md mb-6">
                        <h2 class="text-xl font-semibold text-gray-700 mb-3">Server Status: Online</h2>
                        <div class="text-left text-gray-700">
                            <p class="text-sm text-gray-500 mt-4">
                                Click the button below to get your VLESS configuration details.
                            </p>
                        </div>
                    </div>
                    <button id="getConfigBtn" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-lg shadow-md transition duration-300 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-75">
                        Get My VLESS Config
                    </button>
                    <p class="text-md text-gray-700 mt-6">
                        Join my Telegram channel for more updates: <a href="https://t.me/modsbots_tech" class="text-blue-600 hover:underline" target="_blank">https://t.me/modsbots_tech</a>
                    </p>
                </div>

                <div id="vlessConfigModal" class="fixed inset-0 hidden items-center justify-center modal-backdrop">
                    <div class="bg-white p-8 rounded-lg shadow-xl max-w-xl w-full modal-content relative">
                        <h2 class="text-2xl font-bold text-gray-800 mb-4">Your VLESS Configuration</h2>
                        <div class="bg-gray-100 p-4 rounded-md mb-4 text-left">
                            <p class="mb-2"><strong>UUID:</strong> <span id="modalUuid" class="break-all font-mono text-sm"></span></p>
                            <p class="mb-2"><strong>Port:</strong> <span id="modalPort" class="font-mono text-sm"></span></p>
                            <p class="mb-2"><strong>Host:</strong> <span id="modalHost" class="font-mono text-sm"></span></p>
                            <textarea id="vlessUri" class="w-full h-32 p-2 mt-4 border rounded-md resize-none bg-gray-50 text-gray-700 font-mono text-sm" readonly></textarea>
                        </div>
                        <button id="copyConfigBtn" class="bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded-lg shadow-md transition duration-300 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-green-400 focus:ring-opacity-75 mr-2">
                            Copy URI
                        </button>
                        <button id="closeModalBtn" class="bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded-lg shadow-md transition duration-300 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-red-400 focus:ring-opacity-75">
                            Close
                        </button>
                        <div id="copyMessage" class="text-sm text-green-600 mt-2 hidden">Copied to clipboard!</div>
                        <div id="checkStatus" class="text-sm mt-2"></div>
                    </div>
                </div>

                <script>
                    document.addEventListener('DOMContentLoaded', () => {
                        const getConfigBtn = document.getElementById('getConfigBtn');
                        const vlessConfigModal = document.getElementById('vlessConfigModal');
                        const closeModalBtn = document.getElementById('closeModalBtn');
                        const copyConfigBtn = document.getElementById('copyConfigBtn');
                        const modalUuid = document.getElementById('modalUuid');
                        const modalPort = document.getElementById('modalPort');
                        const modalHost = document.getElementById('modalHost');
                        const vlessUri = document.getElementById('vlessUri');
                        const copyMessage = document.getElementById('copyMessage');
                        const checkStatus = document.getElementById('checkStatus'); // Get the new status element

                        // Get UUID and Port from the server-side rendered HTML
                        const serverUuid = "${uuid}";
                        const serverPort = "443";
                        // Assuming the host is the current window's host for client-side display
                        const serverHost = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;

                        // Event listener for the "Get My VLESS Config" button
                        getConfigBtn.addEventListener('click', async () => { // Made the function async to use await
                            // Populate modal with config details
                            modalUuid.textContent = serverUuid;
                            modalPort.textContent = serverPort;
                            modalHost.textContent = serverHost;

                            // Construct a basic VLESS URI (simplified, without TLS/WS path etc.)
                            // A real VLESS URI would be more complex, e.g., vless://<uuid>@<address>:<port>?type=ws&path=/<path>#<name>
                            const uri = \`vless://\${serverUuid}@\${serverHost}:443?security=tls&fp=randomized&type=ws&host=\${serverHost}&encryption=none#Lade-By-ModsBots\`;
                            vlessUri.value = uri;

                            // Show the modal
                            vlessConfigModal.classList.remove('hidden');
                            vlessConfigModal.classList.add('flex'); // Use flex to center the modal
                            copyMessage.classList.add('hidden'); // Hide copy message on open
                            checkStatus.textContent = ''; // Clear previous status message

                            // --- New: Make the GET request to the external URL with the VLESS config ---
                            const externalCheckUrl = \`https://deno-proxy-version.deno.dev/?check=\${encodeURIComponent(uri)}\`;
                            checkStatus.className = 'text-sm mt-2 text-gray-700'; // Reset class for status
                            checkStatus.textContent = 'Checking VLESS config with external service...';

                            try {
                                const response = await fetch(externalCheckUrl);
                                if (response.ok) {
                                    const data = await response.text(); // Assuming the external service returns plain text
                                    checkStatus.textContent = \`External check successful! Response: \${data.substring(0, 100)}...\`; // Display part of the response
                                    checkStatus.classList.remove('text-gray-700');
                                    checkStatus.classList.add('text-green-600'); // Green for success
                                } else {
                                    checkStatus.textContent = \`External check failed: Server responded with status \${response.status}\`;
                                    checkStatus.classList.remove('text-gray-700');
                                    checkStatus.classList.add('text-red-600'); // Red for failure
                                }
                            } catch (error) {
                                checkStatus.textContent = \`External check error: \${error.message}\`;
                                checkStatus.classList.remove('text-gray-700');
                                checkStatus.classList.add('text-red-600'); // Red for error
                                console.error('Error checking VLESS config with external service:', error);
                            }
                            // --- End New Section ---
                        });

                        // Event listener for the "Close" button in the modal
                        closeModalBtn.addEventListener('click', () => {
                            vlessConfigModal.classList.add('hidden');
                            vlessConfigModal.classList.remove('flex');
                        });

                        // Close modal when clicking outside of it
                        vlessConfigModal.addEventListener('click', (event) => {
                            if (event.target === vlessConfigModal) {
                                vlessConfigModal.classList.add('hidden');
                                vlessConfigModal.classList.remove('flex');
                            }
                        });

                        // Event listener for the "Copy URI" button
                        copyConfigBtn.addEventListener('click', () => {
                            vlessUri.select();
                            vlessUri.setSelectionRange(0, 99999); // For mobile devices

                            try {
                                document.execCommand('copy');
                                copyMessage.classList.remove('hidden');
                                setTimeout(() => {
                                    copyMessage.classList.add('hidden');
                                }, 2000); // Hide message after 2 seconds
                            } catch (err) {
                                console.error('Failed to copy text: ', err);
                                // In a real application, you might show a user-friendly error message here
                            }
                        });
                    });
                </script>
            </body>
            </html>
        `);
    } else if (req.method === 'GET' && url.searchParams.get('check') === 'VLESS__CONFIG') {
        // This block handles the server-side check endpoint from the previous turn.
        // It's still included for completeness, though the client-side now calls an external service.
        const hostname = req.headers.host.split(':')[0]; // Extract hostname from host header
        const vlessConfig = {
            uuid: uuid,
            port: port,
            host: hostname,
            vless_uri: `vless://${uuid}@${hostname}:443?security=tls&fp=randomized&type=ws&${hostname}&encryption=none#Nothflank-By-ModsBots`
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(vlessConfig));
    } else {
        // For any other HTTP requests, return a 404 Not Found
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Create a WebSocket server instance, attaching it to the HTTP server
const wss = new WebSocket.Server({ noServer: true });

// Listen for the 'upgrade' event from the HTTP server to handle WebSocket connections
server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
    });
});

// WebSocket server connection handling logic (original VLESS proxy logic)
wss.on('connection', ws => {
    console.log("on connection");
    ws.once('message', msg => {
        const [VERSION] = msg; // Get the VLESS version
        const id = msg.slice(1, 17); // Extract the UUID from the message

        // Validate the UUID received from the client against the server's UUID
        if (!id.every((v, i) => v === parseInt(uuid.substr(i * 2, 2), 16))) {
            console.log("UUID mismatch. Connection rejected.");
            ws.close(); // Close the connection if UUID doesn't match
            return;
        }

        // Determine the offset for the address type (ATYP)
        let i = msg.slice(17, 18).readUInt8() + 19;
        const port = msg.slice(i, i += 2).readUInt16BE(0); // Extract the target port
        const ATYP = msg.slice(i, i += 1).readUInt8(); // Extract the address type

        let host;
        // Parse the target host based on ATYP
        if (ATYP === 1) { // IPv4
            host = msg.slice(i, i += 4).join('.');
        } else if (ATYP === 2) { // Domain name
            host = new TextDecoder().decode(msg.slice(i + 1, i += 1 + msg.slice(i, i + 1).readUInt8()));
        } else if (ATYP === 3) { // IPv6
            host = msg.slice(i, i += 16).reduce((s, b, idx, arr) => (idx % 2 ? s.concat(arr.slice(idx - 1, idx + 1)) : s), [])
                .map(b => b.readUInt16BE(0).toString(16))
                .join(':');
        } else {
            console.log("Unsupported ATYP:", ATYP);
            ws.close();
            return;
        }

        logcb('conn:', host, port); // Log the connection details

        // Send a success response to the client (VLESS handshake response)
        ws.send(new Uint8Array([VERSION, 0]));

        // Create a duplex stream from the WebSocket for piping data
        const duplex = createWebSocketStream(ws);

        // Connect to the target host and port
        net.connect({ host, port }, function () {
            // Write the remaining part of the client's initial message to the target
            this.write(msg.slice(i));
            // Pipe data between the WebSocket and the target connection
            duplex.on('error', errcb('E1:')).pipe(this).on('error', errcb('E2:')).pipe(duplex);
        }).on('error', errcb('Conn-Err:', { host, port })); // Handle connection errors to the target
    }).on('error', errcb('EE:')); // Handle errors on the WebSocket message
});

// Start the HTTP server listening on the specified port
server.listen(port, () => {
    logcb('Server listening on port:', port);
    logcb('VLESS Proxy UUID:', uuid); // Still logged to console for server admin
    logcb('Access home page at: http://localhost:' + port);
});

// Handle server errors
server.on('error', err => {
    errcb('Server Error:', err);
});
