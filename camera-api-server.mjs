process.loadEnvFile();

import http from 'http';
import { fetchAllCameraSnapshots } from './protect.mjs';
import { processNewMembers, processManagedAccess } from './webhook.mjs';
import { getUserStatus } from './access.mjs';

const PORT = Number(process.env.CAMERA_API_PORT || '8787');
const API_KEY = process.env.CAMERA_API_KEY;
const MAX_BODY_BYTES = 1_000_000;

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

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });

const handleCameraSnapshots = async (res) => {
  const snapshots = await fetchAllCameraSnapshots();
  sendJson(res, 200, snapshots);
};

// Create one or more members. Accepts either a single { firstName, lastName, email }
// object or a batch via { newMembers: [...] }, mirroring the webhook contract.
const handleCreateMember = async (res, body) => {
  const members = Array.isArray(body?.newMembers) ? body.newMembers : [body];

  const invalid = members.find(
    (m) => !m || !m.firstName || !m.lastName || !m.email
  );
  if (members.length === 0 || invalid) {
    return sendJson(res, 400, {
      error: 'Each member requires firstName, lastName, and email',
    });
  }

  const result = await processNewMembers(members);

  // 201 when at least one member was newly created, otherwise 200.
  const statusCode = result.created.length > 0 ? 201 : 200;
  return sendJson(res, statusCode, result);
};

// Deactivate or activate one or more members by email. Accepts a single
// { email } object or a batch via { emails: [...] }.
const handleAccessChange = async (res, body, action) => {
  const emails = Array.isArray(body?.emails)
    ? body.emails
    : body?.email
    ? [body.email]
    : [];

  if (emails.length === 0) {
    return sendJson(res, 400, { error: 'email (or emails[]) is required' });
  }

  const result = await processManagedAccess({
    activate: action === 'activate' ? emails : [],
    deactivate: action === 'deactivate' ? emails : [],
  });

  const statusCode = result.failed.length > 0 ? 502 : 200;
  return sendJson(res, statusCode, result);
};

const handleMemberStatus = async (res, email) => {
  if (!email) {
    return sendJson(res, 400, { error: 'email query parameter is required' });
  }

  const status = await getUserStatus(email);
  if (!status) {
    return sendJson(res, 404, { error: 'User not found', email });
  }

  return sendJson(res, 200, status);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (getProvidedApiKey(req) !== API_KEY) {
    return sendJson(res, 401, { error: 'Unauthorized' });
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/camera-snapshots') {
      return await handleCameraSnapshots(res);
    }

    if (req.method === 'POST' && url.pathname === '/api/members') {
      return await handleCreateMember(res, await readJsonBody(req));
    }

    if (req.method === 'POST' && url.pathname === '/api/members/deactivate') {
      return await handleAccessChange(res, await readJsonBody(req), 'deactivate');
    }

    if (req.method === 'POST' && url.pathname === '/api/members/activate') {
      return await handleAccessChange(res, await readJsonBody(req), 'activate');
    }

    if (req.method === 'GET' && url.pathname === '/api/members/status') {
      return await handleMemberStatus(res, url.searchParams.get('email'));
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(`Failed to handle ${req.method} ${url.pathname}:`, error);
    const statusCode = /Invalid JSON|too large/.test(error.message) ? 400 : 502;
    sendJson(res, statusCode, { error: error.message });
  }
});

server.on('error', (error) => {
  console.error(`Camera/member API failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Camera + member API listening on http://localhost:${PORT}`);
  console.log(`  GET  /api/camera-snapshots`);
  console.log(`  POST /api/members              { firstName, lastName, email }`);
  console.log(`  POST /api/members/deactivate   { email }`);
  console.log(`  POST /api/members/activate     { email }`);
  console.log(`  GET  /api/members/status?email=...`);
  console.log(`Protect host: ${process.env.UNIFI_PROTECT_HOST}`);
  console.log(`Auth mode: ${process.env.UNIFI_PROTECT_API_TOKEN ? 'API token' : 'username/password'}`);
});
