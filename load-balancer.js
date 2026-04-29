// load-balancer.js
// Simple round-robin HTTP + WebSocket load balancer for local backend servers.

const http = require('http');
const net = require('net');

const BACKENDS = [
  { host: '127.0.0.1', port: 3000 },
  { host: '127.0.0.1', port: 3001 }
];
let nextBackendIndex = 0;

function getNextBackend() {
  const backend = BACKENDS[nextBackendIndex];
  nextBackendIndex = (nextBackendIndex + 1) % BACKENDS.length;
  return backend;
}

function logProxyTarget(req, target) {
  console.log(`[proxy] ${req.method} ${req.url} -> ${target.host}:${target.port}`);
}

const proxy = http.createServer((req, res) => {
  const target = getNextBackend();
  logProxyTarget(req, target);
  const proxyReq = http.request(
    {
      host: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: req.headers
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on('error', (err) => {
    console.error('HTTP proxy error:', err.message);
    res.writeHead(502);
    res.end('Bad gateway');
  });

  req.pipe(proxyReq, { end: true });
});

proxy.on('upgrade', (req, socket, head) => {
  const target = getNextBackend();
  console.log(`[proxy] WS upgrade ${req.url} -> ${target.host}:${target.port}`);
  const backendSocket = net.connect(target.port, target.host, () => {
    backendSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    Object.entries(req.headers).forEach(([name, value]) => {
      backendSocket.write(`${name}: ${value}\r\n`);
    });
    backendSocket.write('\r\n');
    backendSocket.write(head);
    backendSocket.pipe(socket);
    socket.pipe(backendSocket);
  });

  backendSocket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      console.error('WebSocket proxy error:', err.message);
    }
    socket.destroy();
  });

  socket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') {
      console.error('Client socket error:', err.message);
    }
    backendSocket.destroy();
  });
});

const LISTEN_PORT = process.env.PORT || 8080;
proxy.listen(LISTEN_PORT, () => {
  console.log(`Load balancer listening on port ${LISTEN_PORT}`);
  console.log(`Backend servers: ${BACKENDS.map(b => `${b.host}:${b.port}`).join(', ')}`);
});
