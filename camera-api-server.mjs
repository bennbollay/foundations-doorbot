process.loadEnvFile();

import http from 'http';
import { fetchAllCameraSnapshots } from './protect.mjs';
import { processNewMembers, processManagedAccess, processEmailChanges } from './webhook.mjs';
import { getUserStatus } from './access.mjs';
import {
  createVisitorPass,
  fetchVisitor,
  fetchAllVisitors,
  deleteVisitor,
  toEpochSeconds,
} from './visitors.mjs';

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
  const rawMembers = Array.isArray(body?.newMembers) ? body.newMembers : [body];

  // Only email is required. firstName/lastName are optional (single-word names,
  // company employees without a surname, etc.) — createUser handles empty name
  // parts, and every created/existing user is reconciled into the Foundations
  // group regardless. Normalize so downstream always sees string name fields.
  const invalid = rawMembers.find((m) => !m || !m.email);
  if (rawMembers.length === 0 || invalid) {
    return sendJson(res, 400, {
      error: 'Each member requires an email',
    });
  }

  const members = rawMembers.map((m) => ({
    ...m,
    firstName: m.firstName || '',
    lastName: m.lastName || '',
  }));

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

// Change one or more members' email address (e.g. after an email update in the
// member system). Accepts a single { oldEmail, newEmail } object or a batch via
// { emailChanges: [{ oldEmail, newEmail }, ...] }.
const handleEmailChange = async (res, body) => {
  const changes = Array.isArray(body?.emailChanges)
    ? body.emailChanges
    : body?.oldEmail || body?.newEmail
    ? [{ oldEmail: body.oldEmail, newEmail: body.newEmail }]
    : [];

  const invalid = changes.find((c) => !c || !c.oldEmail || !c.newEmail);
  if (changes.length === 0 || invalid) {
    return sendJson(res, 400, {
      error: 'Each change requires oldEmail and newEmail',
    });
  }

  const result = await processEmailChanges(changes);

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

// Create a time-windowed visitor pass with a PIN, for public events.
// Body: { firstName, lastName?, startTime, endTime, email?, remarks?,
//         mobilePhone?, visitorCompany?, pinCode? }
// startTime/endTime accept epoch seconds, epoch ms, or ISO 8601 strings.
// Passes are assigned the All Locations door group; without it UniFi leaves
// visitors on a "custom" assignment with no door access at all.
const handleCreateVisitorPass = async (res, body) => {
  if (!body?.firstName) {
    return sendJson(res, 400, { error: 'firstName is required' });
  }

  const startTime = toEpochSeconds(body.startTime);
  const endTime = toEpochSeconds(body.endTime);

  if (startTime === undefined || endTime === undefined) {
    return sendJson(res, 400, {
      error: 'startTime and endTime are required (epoch seconds, epoch ms, or ISO 8601)',
    });
  }

  if (endTime <= startTime) {
    return sendJson(res, 400, { error: 'endTime must be after startTime' });
  }

  const pass = await createVisitorPass({
    firstName: body.firstName,
    lastName: body.lastName || '',
    startTime,
    endTime,
    email: body.email || '',
    mobilePhone: body.mobilePhone || '',
    remarks: body.remarks || '',
    visitorCompany: body.visitorCompany || '',
    pinCode: body.pinCode,
  });

  // The plaintext PIN is only available here — UniFi stores a hash.
  return sendJson(res, 201, {
    id: pass.id,
    firstName: pass.first_name,
    lastName: pass.last_name,
    pinCode: pass.pinCode,
    startTime,
    endTime,
    status: pass.status,
    remarks: body.remarks || '',
  });
};

const handleListVisitorPasses = async (res, searchParams) => {
  const visitors = await fetchAllVisitors({
    keyword: searchParams.get('keyword') || undefined,
    pageNum: searchParams.get('page_num') || undefined,
    pageSize: searchParams.get('page_size') || undefined,
  });
  return sendJson(res, 200, visitors);
};

const handleGetVisitorPass = async (res, visitorId) => {
  try {
    const visitor = await fetchVisitor(visitorId);
    return sendJson(res, 200, visitor);
  } catch (error) {
    if (/CODE_NOT_EXISTS|CODE_RESOURCE_NOT_FOUND/.test(error.message)) {
      return sendJson(res, 404, { error: 'Visitor pass not found', id: visitorId });
    }
    throw error;
  }
};

// Revoke a pass. Default cancels the visit (record kept, access revoked);
// ?force=true physically deletes the visitor from UniFi.
const handleDeleteVisitorPass = async (res, visitorId, searchParams) => {
  const force = searchParams.get('force') === 'true';
  try {
    await deleteVisitor(visitorId, { force });
    return sendJson(res, 200, { id: visitorId, revoked: true, deleted: force });
  } catch (error) {
    if (/CODE_NOT_EXISTS|CODE_RESOURCE_NOT_FOUND/.test(error.message)) {
      return sendJson(res, 404, { error: 'Visitor pass not found', id: visitorId });
    }
    throw error;
  }
};

const VISITOR_PASS_PATH = /^\/api\/visitor-passes\/([^/]+)$/;

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

    if (req.method === 'POST' && url.pathname === '/api/members/change-email') {
      return await handleEmailChange(res, await readJsonBody(req));
    }

    if (req.method === 'GET' && url.pathname === '/api/members/status') {
      return await handleMemberStatus(res, url.searchParams.get('email'));
    }

    if (req.method === 'POST' && url.pathname === '/api/visitor-passes') {
      return await handleCreateVisitorPass(res, await readJsonBody(req));
    }

    if (req.method === 'GET' && url.pathname === '/api/visitor-passes') {
      return await handleListVisitorPasses(res, url.searchParams);
    }

    const visitorPassMatch = url.pathname.match(VISITOR_PASS_PATH);
    if (visitorPassMatch) {
      const visitorId = decodeURIComponent(visitorPassMatch[1]);
      if (req.method === 'GET') {
        return await handleGetVisitorPass(res, visitorId);
      }
      if (req.method === 'DELETE') {
        return await handleDeleteVisitorPass(res, visitorId, url.searchParams);
      }
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
  console.log(`  POST /api/members              { email, firstName?, lastName? }`);
  console.log(`  POST /api/members/deactivate   { email }`);
  console.log(`  POST /api/members/activate     { email }`);
  console.log(`  POST /api/members/change-email { oldEmail, newEmail }`);
  console.log(`  GET  /api/members/status?email=...`);
  console.log(`  POST   /api/visitor-passes         { firstName, startTime, endTime, ... }`);
  console.log(`  GET    /api/visitor-passes`);
  console.log(`  GET    /api/visitor-passes/:id`);
  console.log(`  DELETE /api/visitor-passes/:id     (?force=true to hard-delete)`);
  console.log(`Protect host: ${process.env.UNIFI_PROTECT_HOST}`);
  console.log(`Auth mode: ${process.env.UNIFI_PROTECT_API_TOKEN ? 'API token' : 'username/password'}`);
});
