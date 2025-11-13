const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const dgram = require('dgram');
const crypto = require('crypto');
const { getLocalIP } = require('./utils');

// Load config from file
let serverConfig = {
  password: 'changeme',
  port: 3000,
  allowPublicViewing: true
};

try {
  const configFile = path.join(__dirname, 'config.json');
  if (fs.existsSync(configFile)) {
    const configData = fs.readFileSync(configFile, 'utf8');
    serverConfig = { ...serverConfig, ...JSON.parse(configData) };
    console.log('Loaded config from config.json');
  } else {
    console.log('No config.json found, using defaults. Creating config.json...');
    fs.writeFileSync(configFile, JSON.stringify(serverConfig, null, 2));
    console.log('⚠️  Please edit config.json and set a secure password!');
  }
} catch (err) {
  console.error('Error loading config:', err.message);
  console.log('Using default configuration');
}

// Session management
const activeSessions = new Set();
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidSession(token) {
  return activeSessions.has(token);
}

function createSession() {
  const token = generateSessionToken();
  activeSessions.add(token);
  // Clean up session after duration
  setTimeout(() => activeSessions.delete(token), SESSION_DURATION);
  return token;
}

// Configuration (editable via /api/config)
let cfg = {
  oscHost: '127.0.0.1',
  oscPort: 9000,
  // Default OSC address mappings — these are examples. Update to match VRChat OSC documentation if different.
  addressPosition: '/camera/position',
  addressRotation: '/camera/rotation',
  addressFov: '/camera/fov'
};

// Local camera state (server-side authoritative so UI can send deltas)
const state = {
  x: 0,
  y: 1.6,
  z: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  fov: 60
};

const oscSocket = dgram.createSocket('udp4');

function pad4(n) { return (4 - (n % 4)) % 4; }

function writePaddedString(str) {
  const s = Buffer.from(str + '\0');
  const pad = pad4(s.length);
  if (pad === 0) return s;
  return Buffer.concat([s, Buffer.alloc(pad)]);
}

function floatToBuffer(f) {
  const b = Buffer.alloc(4);
  b.writeFloatBE(f, 0);
  return b;
}

function intToBuffer(i) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(i, 0);
  return b;
}

// Build a simple OSC message buffer for address and simple arg types (f,i,s)
function buildOscMessage(address, types, args) {
  const addressBuf = writePaddedString(address);
  const typeTag = ',' + types.join('');
  const typeBuf = writePaddedString(typeTag);

  const argBufs = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    const a = args[i];
    if (t === 'f') argBufs.push(floatToBuffer(Number(a)));
    else if (t === 'i') argBufs.push(intToBuffer(Number(a)));
    else if (t === 's') {
      argBufs.push(writePaddedString(String(a)));
    } else {
      // unsupported type, send string fallback
      argBufs.push(writePaddedString(String(a)));
    }
  }

  return Buffer.concat([addressBuf, typeBuf, ...argBufs]);
}

function sendOsc(address, types, args) {
  try {
    const msg = buildOscMessage(address, types, args);
    oscSocket.send(msg, 0, msg.length, cfg.oscPort, cfg.oscHost, (err) => {
      if (err) console.error('OSC send error', err);
    });
  } catch (e) {
    console.error('Failed to build/send OSC', e);
  }
}

function broadcastState() {
  // send current state to VRChat using configured addresses
  sendOsc(cfg.addressPosition, ['f','f','f'], [state.x, state.y, state.z]);
  sendOsc(cfg.addressRotation, ['f','f','f'], [state.pitch, state.yaw, state.roll]);
  sendOsc(cfg.addressFov, ['f'], [state.fov]);
}

// Serve static files from ./public
function serveStatic(req, res) {
  let parsed = url.parse(req.url);
  let pathname = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const fp = path.join(__dirname, 'public', pathname);
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    const mt = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    };
    res.setHeader('Content-Type', mt[ext] || 'application/octet-stream');
    res.end(data);
  });
}

function collectRequestJson(req, callback) {
  let body = '';
  req.on('data', (chunk) => body += chunk);
  req.on('end', () => {
    if (!body) return callback(null);
    try { callback(JSON.parse(body)); }
    catch (e) { callback(null); }
  });
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? match[2] : null;
}

function setCookie(res, name, value, maxAge = SESSION_DURATION) {
  res.setHeader('Set-Cookie', `${name}=${value}; HttpOnly; Max-Age=${Math.floor(maxAge / 1000)}; Path=/; SameSite=Strict`);
}

function requireAuth(req, res, callback) {
  const sessionToken = getCookie(req, 'session');
  if (!sessionToken || !isValidSession(sessionToken)) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Unauthorized', message: 'Please log in' }));
    return false;
  }
  callback();
  return true;
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  
  // Login endpoint
  if (req.method === 'POST' && parsed.pathname === '/api/login') {
    collectRequestJson(req, (body) => {
      if (!body || !body.password) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Password required' }));
        return;
      }
      
      if (body.password === serverConfig.password) {
        const token = createSession();
        setCookie(res, 'session', token);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, message: 'Login successful' }));
        console.log('User logged in successfully');
      } else {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Invalid password' }));
        console.log('Failed login attempt');
      }
    });
    return;
  }
  
  // Check auth status
  if (req.method === 'GET' && parsed.pathname === '/api/auth') {
    const sessionToken = getCookie(req, 'session');
    const authenticated = sessionToken && isValidSession(sessionToken);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ authenticated, allowPublicViewing: serverConfig.allowPublicViewing }));
    return;
  }
  
  // Logout endpoint
  if (req.method === 'POST' && parsed.pathname === '/api/logout') {
    const sessionToken = getCookie(req, 'session');
    if (sessionToken) {
      activeSessions.delete(sessionToken);
    }
    setCookie(res, 'session', '', 0);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, message: 'Logged out' }));
    return;
  }
  
  // Serve static files
  if (req.method === 'GET' && (parsed.pathname === '/' || parsed.pathname.startsWith('/index') || parsed.pathname.startsWith('/app') || parsed.pathname.startsWith('/styles'))) {
    serveStatic(req, res);
    return;
  }

  // Public endpoints (if allowed)
  if (req.method === 'GET' && parsed.pathname === '/api/state') {
    // State can be read by anyone if public viewing is allowed, but only authenticated users can modify
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({state, cfg}));
    return;
  }

  // Protected endpoints - require authentication
  if (req.method === 'POST' && parsed.pathname === '/api/config') {
    if (!requireAuth(req, res, () => {
      collectRequestJson(req, (body) => {
        if (!body) {
          res.statusCode = 400; res.end('bad json'); return;
        }
        if (body.oscHost) cfg.oscHost = body.oscHost;
        if (body.oscPort) cfg.oscPort = Number(body.oscPort);
        if (body.addressPosition) cfg.addressPosition = body.addressPosition;
        if (body.addressRotation) cfg.addressRotation = body.addressRotation;
        if (body.addressFov) cfg.addressFov = body.addressFov;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ok:true, cfg}));
      });
    })) return;
    return;
  }

  if (req.method === 'POST' && parsed.pathname === '/api/move') {
    if (!requireAuth(req, res, () => {
      collectRequestJson(req, (body) => {
        if (!body) { res.statusCode = 400; res.end('bad json'); return; }

        // Accept either deltas (dx/dy/dz/dPitch/...) or absolute values when absolute:true
        if (body.absolute) {
          if (typeof body.x === 'number') state.x = body.x;
          if (typeof body.y === 'number') state.y = body.y;
          if (typeof body.z === 'number') state.z = body.z;
          if (typeof body.pitch === 'number') state.pitch = body.pitch;
          if (typeof body.yaw === 'number') state.yaw = body.yaw;
          if (typeof body.roll === 'number') state.roll = body.roll;
          if (typeof body.fov === 'number') state.fov = body.fov;
        } else {
          if (typeof body.dx === 'number') state.x += body.dx;
          if (typeof body.dy === 'number') state.y += body.dy;
          if (typeof body.dz === 'number') state.z += body.dz;
          if (typeof body.dpitch === 'number') state.pitch += body.dpitch;
          if (typeof body.dyaw === 'number') state.yaw += body.dyaw;
          if (typeof body.droll === 'number') state.roll += body.droll;
          if (typeof body.dfov === 'number') state.fov += body.dfov;
        }

        // bounding / normalization
        if (state.fov < 1) state.fov = 1;
        if (state.fov > 179) state.fov = 179;

        // Send to VRChat via OSC
        try { broadcastState(); } catch (e) { console.error(e); }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ok:true, state}));
      });
    })) return;
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/api/spout') {
    // Proxy the MJPEG stream from the Spout bridge
    // The Spout bridge captures from the desktop/Spout and serves MJPEG on port 8888
    // Video stream is public if allowPublicViewing is true, otherwise requires auth
    if (!serverConfig.allowPublicViewing) {
      const sessionToken = getCookie(req, 'session');
      if (!sessionToken || !isValidSession(sessionToken)) {
        res.statusCode = 401;
        res.end('Unauthorized');
        return;
      }
    }
    const http = require('http');
    const options = {
      hostname: '127.0.0.1',
      port: 8888,
      path: '/mjpeg',
      method: 'GET',
      timeout: 5000
    };
    
    let headersWritten = false;
    
    const proxyReq = http.request(options, (spoutRes) => {
      headersWritten = true;
      res.writeHead(spoutRes.statusCode, {
        'Content-Type': spoutRes.headers['content-type'] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'close'
      });
      spoutRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      // If Spout bridge is not running, return error
      if (headersWritten) {
        res.destroy();
        return;
      }
      console.error('Spout bridge error:', err.message);
      res.writeHead(503, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        error: 'Spout bridge not running',
        message: 'Start spout-bridge.js in another terminal: node spout-bridge.js'
      }));
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (headersWritten) {
        res.destroy();
        return;
      }
      res.writeHead(503, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({
        error: 'Spout bridge timeout',
        message: 'Spout bridge is not responding'
      }));
    });

    proxyReq.end();
    return;
  }

  // fallback 404
  res.statusCode = 404; res.end('not found');
});

const PORT = serverConfig.port || 3000;
const localIP = getLocalIP();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n====================================`);
  console.log(`Web bridge running!`);
  console.log(`====================================`);
  console.log(`Listening on: 0.0.0.0:${PORT} (all interfaces)`);
  console.log(`Local access:   http://127.0.0.1:${PORT}/`);
  console.log(`Network access: http://${localIP}:${PORT}/`);
  console.log(`====================================`);
  console.log(`Authentication: ${serverConfig.password === 'changeme' ? '⚠️  DEFAULT PASSWORD - Change it in config.json!' : 'Enabled'}`);
  console.log(`Public viewing: ${serverConfig.allowPublicViewing ? 'Enabled' : 'Disabled (requires login)'}`);
  console.log(`Sending OSC to ${cfg.oscHost}:${cfg.oscPort}`);
  console.log(`\n💡 If you can't access from other devices:`);
  console.log(`   1. Check Windows Firewall - allow port ${PORT}`);
  console.log(`   2. Verify server is running on 0.0.0.0:${PORT}`);
  console.log(`   3. Try: http://192.168.1.48:${PORT}/`);
  console.log(`====================================\n`);
});

// -- Spout / snapshot placeholder --
// The /api/spout endpoint is a simple snapshot provider for the web UI.
// Real Spout video requires a Spout-to-HTTP or Spout-to-MJPEG bridge that
// exposes video frames over HTTP. Replace this implementation to fetch
// actual frames from your Spout bridge.

