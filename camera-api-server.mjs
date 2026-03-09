process.loadEnvFile();

import http from 'http';
import { fetchAllCameraSnapshots } from './protect.mjs';

const PORT = Number(process.env.CAMERA_API_PORT || '8787');
const API_KEY = process.env.CAMERA_API_KEY;

if (!API_KEY) {
  console.error('CAMERA_API_KEY is not set in .env');
  process.exit(1);
}

const sendJson = (res, statusCode, body) => {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const getProvidedApiKey = (req) => {
  if (req.headers['x-api-key']) {
    return req.headers['x-api-key'];
  }

  const auth = req.headers.authorization;
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
  }

  return '';
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method !== 'GET' || url.pathname !== '/api/camera-snapshots') {
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (getProvidedApiKey(req) !== API_KEY) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    const snapshots = await fetchAllCameraSnapshots();
    sendJson(res, 200, snapshots);
  } catch (error) {
    console.error('Failed to fetch camera snapshots:', error);
    sendJson(res, 502, { error: error.message });
  }
});

server.on('error', (error) => {
  console.error(`Camera snapshot API failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Camera snapshot API listening on http://localhost:${PORT}/api/camera-snapshots`);
  console.log(`Protect host: ${process.env.UNIFI_PROTECT_HOST}`);
  console.log(`Auth mode: ${process.env.UNIFI_PROTECT_API_TOKEN ? 'API token' : 'username/password'}`);
});
