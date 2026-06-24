// UniFi Access user group management.
//
// User/group writes go through the UniFi Identity cloud API (the same root-credential
// auth used by createUser/activate/deactivate in direct_identity.mjs). The local
// developer API token (UNIFI_DOOR_TOKEN) is VIEW-only and cannot perform group writes.

process.loadEnvFile();

// The UniFi console uses a self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { getAuthToken } from './direct_identity.mjs';

const IDENTITY_HOST = 'd8b3705351d507855f7d07e296d4064690a08.id.ui.direct';
const IDENTITY_BASE = `https://${IDENTITY_HOST}`;

// Name of the group that every UniFi Access user should belong to.
export const FOUNDATIONS_GROUP_NAME = 'Foundations';

async function cloudRequest(path, options = {}) {
  const auth = await getAuthToken();

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Origin: 'https://unifi.ui.com',
    Referer: 'https://unifi.ui.com/',
    Cookie: `TOKEN=${auth.token}`,
    ...(options.headers || {}),
  };
  if (auth.csrf) {
    headers['X-Csrf-Token'] = auth.csrf;
  }

  const res = await fetch(`${IDENTITY_BASE}${path}`, { ...options, headers });
  const text = await res.text();

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response from ${path} (${res.status}): ${text.slice(0, 200)}`);
  }

  const ok = res.ok && (json.code === 1 || json.codeS === 'SUCCESS');
  if (!ok) {
    const detail = json.msg || json.codeS || text.slice(0, 200);
    throw new Error(`Request to ${path} failed (${res.status}): ${detail}`);
  }

  return json;
}

// Fetch every UniFi Access user, following pagination. Each user includes its
// current `groups` array.
export async function fetchAllUsers() {
  const pageSize = 100;
  let pageNum = 1;
  const users = [];

  while (true) {
    const json = await cloudRequest(`/proxy/access/api/v2/users?page_num=${pageNum}&page_size=${pageSize}`);
    const page = json.data || [];
    users.push(...page);

    const total = json.total;
    if (page.length === 0 || (typeof total === 'number' && users.length >= total)) {
      break;
    }
    pageNum += 1;
  }

  return users;
}

const normalize = (s) => (s || '').trim().toLowerCase();

// Find the Foundations group id within an already-fetched set of users.
export function findFoundationsGroupId(users) {
  const target = normalize(FOUNDATIONS_GROUP_NAME);
  for (const user of users) {
    const match = (user.groups || []).find((g) => normalize(g.name) === target);
    if (match) {
      return match.unique_id;
    }
  }
  return null;
}

// Resolve the Foundations group id. The cloud API has no standalone group-list
// endpoint, so we scan users (groups are embedded on each user) and return early.
export async function resolveFoundationsGroupId() {
  const pageSize = 100;
  let pageNum = 1;
  let seen = 0;

  while (true) {
    const json = await cloudRequest(`/proxy/access/api/v2/users?page_num=${pageNum}&page_size=${pageSize}`);
    const page = json.data || [];

    const id = findFoundationsGroupId(page);
    if (id) {
      return id;
    }

    seen += page.length;
    const total = json.total;
    if (page.length === 0 || (typeof total === 'number' && seen >= total)) {
      break;
    }
    pageNum += 1;
  }

  throw new Error(`Could not find a user group named "${FOUNDATIONS_GROUP_NAME}". Create it in UniFi Access first.`);
}

// Replace a user's group membership with the provided set of group ids.
export async function setUserGroups(userId, groupIds) {
  const ids = [...new Set(groupIds.filter(Boolean))];
  await cloudRequest(`/proxy/access/api/v2/user/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ group_ids: ids }),
  });
}

// Add a single user to the Foundations group while preserving their other groups.
// Returns true if a change was made, false if the user was already a member.
export async function addUserToFoundations(userId, foundationsGroupId) {
  const json = await cloudRequest(`/proxy/access/api/v2/user/${userId}`);
  const current = (json.data?.groups || []).map((g) => g.unique_id).filter(Boolean);

  if (current.includes(foundationsGroupId)) {
    return false;
  }

  await setUserGroups(userId, [...current, foundationsGroupId]);
  return true;
}
