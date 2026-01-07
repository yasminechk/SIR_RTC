const fs = require('fs');
const https = require('https');
const path = require('path');
const WebSocket = require('ws');
const uuid = require('uuid');

const port = 8443;
const certDir = path.join(__dirname, 'certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

// === HTTPS ===
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error('✗ SSL certificates not found, run: node generate-cert.js');
  process.exit(1);
}

let options;
try {
  options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
} catch (err) {
  console.error('✗ Failed to load SSL certificates:', err.message);
  process.exit(1);
}

const server = https.createServer(options);

server.on('error', (err) => {
  console.error('Server error:', err.message);
  process.exit(1);
});

server.listen(port, '0.0.0.0');
server.on('listening', () => {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  console.log('HTTPS server running on:');
  console.log('  https://localhost:' + port);
  Object.values(ifaces).flat().forEach(iface => {
    if (iface.family === 'IPv4' && !iface.internal) {
      console.log('  https://' + iface.address + ':' + port);
    }
  });
});

// === Servir les fichiers statiques ===
server.on('request', (req, res) => {
  const headers = { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' };

  let pathname = req.url.split('?')[0].split('#')[0];
  if (pathname === '/') pathname = '/index.html';

  const fileMap = {
    '/index.html': { path: 'static/index.html', type: 'text/html' },
    '/main.js':    { path: 'static/main.js',   type: 'application/javascript' },
    '/main.css':   { path: 'static/main.css',  type: 'text/css' },
  };

  const entry = fileMap[pathname];
  if (!entry) {
    if (pathname.includes('favicon')) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    res.writeHead(404, headers);
    res.end('Not found');
    return;
  }

  fs.readFile(entry.path, (err, data) => {
    if (err) {
      res.writeHead(500, headers);
      res.end('Error');
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': entry.type });
    res.end(data);
  });
});

// === WebSocket de signalisation minimal ===
const connections = new Map();
const wss = new WebSocket.Server({ server });

function generateClientId() {
  return uuid.v4();
}

wss.on('connection', (ws) => {
  const id = generateClientId();
  connections.set(id, ws);
  console.log(id, 'connected');

  // Message de bienvenue avec l’id du client
  ws.send(JSON.stringify({ type: 'hello', id }));

  // STUN public Google (suffisant pour ton cas)
  ws.send(JSON.stringify({
    type: 'iceServers',
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  }));

  ws.on('close', () => {
    console.log(id, 'closed');
    connections.delete(id);
  });

  ws.on('message', (msg) => {
    let data;
    try {
      data = JSON.parse(msg);
    } catch (e) {
      console.log(id, 'invalid JSON');
      return;
    }
    if (!data.id || !data.type) return;

    const peer = connections.get(data.id);
    if (!peer) {
      console.log(id, 'peer not found', data.id);
      return;
    }

    // On remplace l’ID de destination par l’ID de l’expéditeur
    data.id = id;
    peer.send(JSON.stringify(data));
  });
});
