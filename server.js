const fs = require('fs');
const https = require('https');
const path = require('path');
const WebSocket = require('ws');
const uuid = require('uuid');

// Twilio (optionnel)
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
let twilio;
if (twilioAccountSid && twilioAuthToken) {
  twilio = require('twilio')(twilioAccountSid, twilioAuthToken);
}

const port = 8443;
const certDir = path.join(__dirname, 'certs');
const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  console.error('\n✗ SSL certificates not found!');
  console.error('Please run: node generate-cert.js\n');
  process.exit(1);
}

let options;
try {
  options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  console.log('✓ SSL certificates loaded successfully');
} catch (err) {
  console.error('\n✗ Failed to load SSL certificates:', err.message);
  process.exit(1);
}

const server = https.createServer(options);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${port} is already in use!`);
  } else {
    console.error('\n✗ Server error:', err.message);
  }
  process.exit(1);
});

server.listen(port, '0.0.0.0');
server.on('listening', () => {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  const allIPs = [];
  for (const name of Object.keys(networkInterfaces)) {
    for (const iface of networkInterfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        allIPs.push({ name, address: iface.address });
      }
    }
  }

  console.log('\n========================================');
  console.log('HTTPS Server is running!');
  console.log('Local access: https://localhost:' + port);
  console.log('\nNetwork access:');
  allIPs.forEach(({ name, address }) => {
    console.log(`  - https://${address}:${port} (${name})`);
  });
  console.log('========================================\n');
});

server.on('request', (request, response) => {
  const headers = {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
  };

  let pathname = request.url.split('?')[0].split('#')[0];
  try {
    if (request.headers.host) {
      const url = new URL(request.url, `https://${request.headers.host}`);
      pathname = url.pathname;
    }
  } catch (e) {}

  if (!pathname.includes('favicon')) {
    console.log(`${new Date().toISOString()} - ${request.method} ${pathname}`);
  }

  if (pathname === '/test' || pathname === '/test/') {
    response.writeHead(200, {
      ...headers,
      'Content-Type': 'application/json'
    });
    response.end(JSON.stringify({
      status: 'ok',
      message: 'HTTPS server is reachable!',
      timestamp: new Date().toISOString(),
      protocol: 'https'
    }));
    return;
  }

  const urlToPath = {
    '/': 'static/index.html',
    '/main.js': 'static/main.js',
    '/main.css': 'static/main.css',
  };
  const urlToContentType = {
    '/': 'text/html',
    '/main.js': 'application/javascript',
    '/main.css': 'text/css',
  };
  const filename = urlToPath[pathname];
  if (!filename) {
    if (pathname.includes('favicon')) {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    response.writeHead(404, headers);
    response.end();
    return;
  }
  fs.readFile(filename, (err, data) => {
    if (err) {
      response.writeHead(404, headers);
      response.end();
      return;
    }
    response.writeHead(200, {
      ...headers,
      'Content-Type': urlToContentType[pathname]
    });
    response.end(data);
  });
});

// ================== WebSocket / signalisation ==================

const connections = new Map();
const wss = new WebSocket.Server({ server });

function generateClientId() {
  return uuid.v4();
}

wss.on('connection', (ws) => {
  const id = generateClientId();
  console.log(id, 'Received new connection');

  if (connections.has(id)) {
    console.log(id, 'Duplicate id detected, closing');
    ws.close();
    return;
  }
  connections.set(id, ws);

  ws.send(JSON.stringify({
    type: 'hello',
    id,
  }));

  if (twilio) {
    twilio.tokens.create().then(token => {
      ws.send(JSON.stringify({
        type: 'iceServers',
        iceServers: token.iceServers,
      }));
    });
  } else {
    ws.send(JSON.stringify({
      type: 'iceServers',
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    }));
  }

  const notifyOnClose = [];
  ws.on('close', () => {
    console.log(id, 'Connection closed');
    connections.delete(id);
    notifyOnClose.forEach(remoteId => {
      const peer = connections.get(remoteId);
      if (!peer) return;
      peer.sendMessage({
        type: 'bye',
        id,
      });
    });
  });

  ws.on('message', (message) => {
    console.log(id, 'received', message.toString());
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {
      console.log(id, 'invalid json', err);
      return;
    }
    if (!data.id || !data.type) {
      console.log(id, 'missing id or type', data);
      return;
    }

    if (!connections.has(data.id)) {
      console.log(id, 'peer not found', data.id);
      return;
    }
    const peerId = data.id;
    const peer = connections.get(peerId);

    data.id = id;
    peer.sendMessage(data);

    ws.trackCallState(data, peerId);
  });

  ws.sendMessage = (data) => {
    ws.trackCallState(data, data.id);
    ws.send(JSON.stringify(data), (err) => {
      if (err) {
        console.log(id, 'failed to send to socket', err);
      }
    });
  };

  ws.trackCallState = (data, peerId) => {
    switch (data.type) {
      case 'answer':
        notifyOnClose.push(peerId);
        break;
      case 'bye':
        const idx = notifyOnClose.indexOf(peerId);
        if (idx !== -1) notifyOnClose.splice(idx, 1);
        break;
    }
  };
});
