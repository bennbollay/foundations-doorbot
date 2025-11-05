// Direct UniFi Identity implementation
// This module directly uses the Identity cloud endpoint from browser capture

process.loadEnvFile();

import fs from 'fs';
import { execSync } from 'child_process';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// The exact Identity host from browser capture
const IDENTITY_HOST = 'd8b3705351d507855f7d07e296d4064690a08.id.ui.direct';
const IDENTITY_BASE = `https://${IDENTITY_HOST}`;
const AUTH_CACHE_FILE = '.direct_identity_auth.json';

// Load cached auth
function loadAuth() {
  try {
    if (fs.existsSync(AUTH_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(AUTH_CACHE_FILE, 'utf8'));
      if (data.timestamp && Date.now() - data.timestamp < 8 * 60 * 60 * 1000) {
        return data;
      }
    }
  } catch {}
  return null;
}

// Save auth
function saveAuth(authData) {
  try {
    fs.writeFileSync(AUTH_CACHE_FILE, JSON.stringify({
      ...authData,
      timestamp: Date.now()
    }, null, 2));
  } catch {}
}

// Get auth token and CSRF
export async function getAuthToken() {
  // Check cache first
  const cached = loadAuth();
  if (cached && cached.token) {
    console.log('Using cached Identity token');
    // Validate that the token is not just an empty object
    if (typeof cached.token === 'string' && cached.token.length > 0) {
      return cached;
    } else {
      console.log('Cached token is invalid, re-authenticating...');
    }
  }

  const username = process.env.UNIFI_CLOUD_USERNAME || 'root';
  const password = process.env.UNIFI_CLOUD_PASSWORD;
  
  if (!username || !password) {
    throw new Error('UNIFI_CLOUD_USERNAME and UNIFI_CLOUD_PASSWORD must be set');
  }

  console.log(`Getting Identity token for ${username}...`);

  // Try direct authentication to Identity
  // This endpoint might require special handling
  try {
    // First, try to get a session from the Identity host
    const loginUrl = `${IDENTITY_BASE}/api/auth/login`;
    console.log(`Trying Identity login at: ${loginUrl}`);
    
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': IDENTITY_BASE,
        'Referer': `${IDENTITY_BASE}/`
      },
      body: JSON.stringify({
        username,
        password,
        remember: true
      })
    });

    if (res.ok) {
      const data = await res.json();
      const headers = {};
      res.headers.forEach((v, k) => headers[k] = v);
      
      const authData = {
        token: data.token || headers['x-auth-token'] || null,
        csrf: data.csrfToken || headers['x-csrf-token'] || null,
        sessionId: data.sessionId || null
      };

      if (authData.token) {
        console.log('✅ Direct Identity login successful');
        saveAuth(authData);
        return authData;
      }
    } else {
      console.log(`Direct login failed: ${res.status} ${res.statusText}`);
    }
  } catch (e) {
    console.log(`Direct Identity login error: ${e.message}`);
  }

  // Try using curl with cookie jar
  console.log('Trying curl-based Identity login...');
  try {
    // Clean up old files
    try { fs.unlinkSync('/tmp/identity_cookies.txt'); } catch {}
    try { fs.unlinkSync('/tmp/identity_headers.txt'); } catch {}
    
    const curlCmd = `curl -s -X POST '${IDENTITY_BASE}/api/auth/login' \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json' \
      -H 'Origin: ${IDENTITY_BASE}' \
      -H 'Referer: ${IDENTITY_BASE}/' \
      -k -c /tmp/identity_cookies.txt -D /tmp/identity_headers.txt \
      -d '{"username":"${username}","password":"${password}","remember":true}'`;
    
    const result = execSync(curlCmd, { encoding: 'utf8' });
    const headers = fs.readFileSync('/tmp/identity_headers.txt', 'utf8');
    const cookies = fs.existsSync('/tmp/identity_cookies.txt') ? 
      fs.readFileSync('/tmp/identity_cookies.txt', 'utf8') : '';
    
    // Extract token from cookies or headers
    let token = null;
    let csrf = null;
    
    // Check cookies for TOKEN
    const tokenMatch = cookies.match(/TOKEN\s+(\S+)/);
    if (tokenMatch) token = tokenMatch[1];
    
    // Check headers for CSRF
    const csrfMatch = headers.match(/x-csrf-token:\s*(\S+)/i);
    if (csrfMatch) csrf = csrfMatch[1];
    
    if (token) {
      const authData = { token, csrf };
      console.log('✅ Curl Identity login successful');
      saveAuth(authData);
      return authData;
    }
  } catch (e) {
    console.log(`Curl Identity login error: ${e.message}`);
  }

  // If all else fails, we need to use the browser automation
  // or get the token from the user
  console.error(`
❌ Could not authenticate with Identity cloud.

This usually means the account needs to authenticate via unifi.ui.com first.
Please run: npm run doorbot auth-cloud

Or manually set these environment variables:
- UNIFI_ID_TOKEN (from browser DevTools > Application > Cookies > TOKEN)
- UNIFI_ID_CSRF (from browser DevTools > Network > Request Headers > X-Csrf-Token)
`);
  
  throw new Error('Identity authentication failed');
}

// Find user by email
export async function findUserByEmail(email, retryOnAuth = true) {
  const auth = await getAuthToken();
  
  console.log(`Looking up user: ${email}`);
  
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://unifi.ui.com',
    'Referer': 'https://unifi.ui.com/',
    'Cookie': `TOKEN=${auth.token}`
  };
  
  if (auth.csrf) {
    headers['X-Csrf-Token'] = auth.csrf;
  }

  // Try different search endpoints
  const endpoints = [
    `${IDENTITY_BASE}/proxy/users/api/v2/users?email=${encodeURIComponent(email)}`,
    `${IDENTITY_BASE}/proxy/users/api/v2/search?keyword=${encodeURIComponent(email)}`,
    `${IDENTITY_BASE}/proxy/users/api/v2/users?keyword=${encodeURIComponent(email)}`
  ];

  for (const url of endpoints) {
    try {
      console.log(`Trying: ${url}`);
      const res = await fetch(url, { headers });
      
      // If we get 401, clear cache and retry once
      if (res.status === 401 && retryOnAuth) {
        console.log('Got 401 Unauthorized, clearing cache and retrying...');
        // Clear the cached auth
        try { fs.unlinkSync(AUTH_CACHE_FILE); } catch {}
        // Retry with fresh auth
        return findUserByEmail(email, false);
      }
      
      if (res.ok) {
        const data = await res.json();
        
        // Parse response
        let users = [];
        if (Array.isArray(data)) {
          users = data;
        } else if (data.data && Array.isArray(data.data)) {
          users = data.data;
        } else if (data.users && Array.isArray(data.users)) {
          users = data.users;
        }

        // Find exact match
        const user = users.find(u => 
          (u.email || u.user_email || '').toLowerCase() === email.toLowerCase()
        );

        if (user) {
          const userId = user.id || user.unique_id || user.user_id || user._id;
          console.log(`Found user: ${user.full_name || user.name || email} (ID: ${userId})`);
          return {
            id: userId,
            email: user.email || user.user_email,
            name: user.full_name || user.name,
            status: user.status || user.activation_status,
            raw: user
          };
        }
      } else {
        const text = await res.text();
        console.log(`Search failed: ${res.status} ${res.statusText}`);
        if (text && text.length < 500 && !text.includes('<!DOCTYPE')) {
          console.log('Response:', text);
        }
      }
    } catch (e) {
      console.log(`Search error: ${e.message}`);
    }
  }

  console.log(`User ${email} not found`);
  return null;
}

// Activate or deactivate user
export async function setUserStatus(userId, activate = false) {
  const auth = await getAuthToken();
  
  const action = activate ? 'activate' : 'deactivate';
  console.log(`${activate ? 'Activating' : 'Deactivating'} user ${userId}...`);

  // Use exact endpoints from browser capture
  let url;
  if (activate) {
    // Use /active endpoint for activation (from browser capture)
    url = `${IDENTITY_BASE}/proxy/users/api/v2/user/${userId}/active?isULP=1`;
  } else {
    // Use /deactivate endpoint for deactivation
    url = `${IDENTITY_BASE}/proxy/users/api/v2/user/${userId}/deactivate?isULP=1`;
  }
  
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://unifi.ui.com',
    'Referer': 'https://unifi.ui.com/',
    'Cookie': `TOKEN=${auth.token}`
  };
  
  if (auth.csrf) {
    headers['X-Csrf-Token'] = auth.csrf;
  }

  try {
    console.log(`PUT ${url}`);
    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: 'isULP=1'  // Same body for both activate and deactivate
    });

    if (res.ok) {
      console.log(`✅ Successfully ${action}d user ${userId}`);
      return true;
    } else {
      const text = await res.text();
      console.log(`Failed: ${res.status} ${res.statusText}`);
      if (text && text.length < 500 && !text.includes('<!DOCTYPE')) {
        console.log('Response:', text);
      }
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
  }

  console.error(`❌ Failed to ${action} user ${userId}`);
  return false;
}

// Create a new user
export async function createUser(firstName, lastName, email) {
  const auth = await getAuthToken();
  
  console.log(`Creating user: ${firstName} ${lastName} (${email})...`);
  
  // Use the exact endpoint from browser capture
  const url = `${IDENTITY_BASE}/proxy/access/api/v2/user`;
  
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Origin': 'https://unifi.ui.com',
    'Referer': 'https://unifi.ui.com/',
    'Cookie': `TOKEN=${auth.token}`
  };
  
  if (auth.csrf) {
    headers['X-Csrf-Token'] = auth.csrf;
  }

  // Payload matching browser capture
  const payload = {
    first_name: firstName,
    last_name: lastName,
    group_ids: [],
    nfc_token: "",
    force_add_nfc: true,
    employee_number: "",
    pin_code: "",
    user_email: email,
    onboard_time: 0
  };

  try {
    console.log(`POST ${url}`);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const result = await res.json();
      if (result.code === 1 || result.codeS === 'SUCCESS') {
        const newUser = result.data;
        console.log(`✅ Successfully created user: ${newUser.full_name} (ID: ${newUser.unique_id})`);
        return {
          success: true,
          user: {
            id: newUser.unique_id,
            email: newUser.user_email || email,
            firstName: newUser.first_name,
            lastName: newUser.last_name,
            fullName: newUser.full_name,
            status: newUser.status
          }
        };
      } else {
        console.error(`Failed to create user: ${result.msg || result.error || 'Unknown error'}`);
        return { success: false, error: result.msg || result.error || 'Unknown error' };
      }
    } else {
      const text = await res.text();
      console.log(`Failed: ${res.status} ${res.statusText}`);
      if (text && text.length < 500 && !text.includes('<!DOCTYPE')) {
        console.log('Response:', text);
      }
      return { success: false, error: `${res.status} ${res.statusText}` };
    }
  } catch (e) {
    console.log(`Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// High-level functions
export async function activateUserByEmail(email) {
  const user = await findUserByEmail(email);
  if (!user) {
    console.error(`User ${email} not found`);
    return false;
  }
  return setUserStatus(user.id, true);
}

export async function deactivateUserByEmail(email) {
  const user = await findUserByEmail(email);
  if (!user) {
    console.error(`User ${email} not found`);
    return false;
  }
  return setUserStatus(user.id, false);
}

export async function getUserStatus(email) {
  const user = await findUserByEmail(email);
  if (!user) {
    return null;
  }
  
  return {
    email: user.email,
    name: user.name,
    id: user.id,
    status: user.status || 'UNKNOWN',
    isActive: user.status === 'ACTIVE' || user.status === 'active'
  };
}

/**
 * Resend invitation to a user
 * @param {string} email - User email to resend invitation to
 * @returns {Object} Result of the invitation resend
 */
export async function resendInvitation(email) {
  const auth = await getAuthToken();
  
  console.log(`Resending invitation to: ${email}`);
  
  // First find the user to get their ID
  const user = await findUserByEmail(email);
  if (!user) {
    console.error(`User ${email} not found`);
    return {
      success: false,
      error: 'User not found',
      email
    };
  }
  
  // Step 1: Get the invitation link first
  const inviteLinkUrl = `${IDENTITY_BASE}/proxy/users/api/v2/identity/user/${user.id}/invitation_link`;
  
  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://unifi.ui.com',
    'Referer': 'https://unifi.ui.com/',
    'Cookie': `TOKEN=${auth.token}`
  };
  
  if (auth.csrf) {
    headers['X-Csrf-Token'] = auth.csrf;
  }
  
  try {
    // Get the invitation link data
    console.log(`GET ${inviteLinkUrl}`);
    const linkRes = await fetch(inviteLinkUrl, {
      method: 'GET',
      headers
    });
    
    if (!linkRes.ok) {
      const errorText = await linkRes.text();
      console.error(`Failed to get invitation link (${linkRes.status}): ${errorText}`);
      return {
        success: false,
        email,
        error: `Failed to get invitation link: ${errorText}`
      };
    }
    
    const linkData = await linkRes.json();
    if (!linkData.data || !linkData.data.link) {
      console.error('Invalid invitation link response:', linkData);
      return {
        success: false,
        email,
        error: 'Invalid invitation link response'
      };
    }
    
    // Step 2: Send the invitation using the retrieved link data
    const sendUrl = `${IDENTITY_BASE}/proxy/users/api/v2/identity/user/${user.id}/send_invitation`;
    
    // Build payload from the invitation link data
    const payload = {
      link: linkData.data.link,
      email: email,
      link_id: linkData.data.id,
      token: linkData.data.shared_token,
      code: linkData.data.code
    };
    
    console.log(`POST ${sendUrl}`);
    const sendRes = await fetch(sendUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (sendRes.ok) {
      const result = await sendRes.json();
      if (result.code === 1 || result.codeS === 'SUCCESS1' || result.codeS === 'SUCCESS') {
        console.log(`✅ Successfully resent invitation to: ${email}`);
        return {
          success: true,
          email,
          userId: user.id,
          message: 'Invitation resent successfully',
          invitationCode: linkData.data.code
        };
      } else {
        console.error(`Failed to resend invitation: ${result.msg || result.codeS}`);
        return {
          success: false,
          email,
          error: result.msg || result.codeS || 'Unknown error'
        };
      }
    } else {
      const errorText = await sendRes.text();
      console.error(`Failed to resend invitation (${sendRes.status}): ${errorText}`);
      return {
        success: false,
        email,
        error: `HTTP ${sendRes.status}: ${errorText}`
      };
    }
  } catch (error) {
    console.error(`Error resending invitation to ${email}:`, error);
    return {
      success: false,
      email,
      error: error.message
    };
  }
}
