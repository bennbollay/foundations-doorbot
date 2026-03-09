process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function getConfig() {
  const host = process.env.UNIFI_PROTECT_HOST;
  const token = process.env.UNIFI_PROTECT_API_TOKEN;
  const username = process.env.UNIFI_PROTECT_USERNAME || process.env.UNIFI_CLOUD_USERNAME;
  const password = process.env.UNIFI_PROTECT_PASSWORD || process.env.UNIFI_CLOUD_PASSWORD;

  if (!host) {
    throw new Error('UNIFI_PROTECT_HOST must be set (e.g. https://192.168.6.199)');
  }

  if (!token && (!username || !password)) {
    throw new Error('Set UNIFI_PROTECT_API_TOKEN or UNIFI_PROTECT_USERNAME/UNIFI_PROTECT_PASSWORD');
  }

  return {
    baseUrl: host.replace(/\/+$/, ''),
    token,
    username,
    password,
    useToken: Boolean(token),
  };
}

async function getProtectSession() {
  const config = getConfig();

  if (config.useToken) {
    return {
      baseUrl: config.baseUrl,
      headers: {
        'X-API-KEY': config.token,
        Accept: 'application/json',
      },
      cameraListPath: '/proxy/protect/integration/v1/cameras',
      snapshotPathPrefix: '/proxy/protect/integration/v1/cameras',
    };
  }

  const initResponse = await fetch(`${config.baseUrl}/`, { method: 'GET', redirect: 'manual' });
  const initialCsrf = initResponse.headers.get('x-csrf-token');

  const loginHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (initialCsrf) {
    loginHeaders['X-CSRF-Token'] = initialCsrf;
  }

  const loginResponse = await fetch(`${config.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: loginHeaders,
    body: JSON.stringify({
      username: config.username,
      password: config.password,
      rememberMe: true,
      token: '',
    }),
  });

  if (!loginResponse.ok) {
    const text = await loginResponse.text();
    throw new Error(`Protect login failed (${loginResponse.status}): ${text.substring(0, 200)}`);
  }

  const csrfToken =
    loginResponse.headers.get('x-updated-csrf-token') ||
    loginResponse.headers.get('x-csrf-token') ||
    initialCsrf;

  let cookie = '';
  if (typeof loginResponse.headers.getSetCookie === 'function') {
    cookie = loginResponse.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  } else {
    const raw = loginResponse.headers.get('set-cookie');
    if (raw) {
      cookie = raw.split(';')[0];
    }
  }

  if (!cookie) {
    throw new Error('Protect login succeeded but no session cookie was returned');
  }

  const headers = {
    Accept: 'application/json',
    Cookie: cookie,
  };

  if (csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  return {
    baseUrl: config.baseUrl,
    headers,
    cameraListPath: '/proxy/protect/api/bootstrap',
    snapshotPathPrefix: '/proxy/protect/api/cameras',
  };
}

export async function listProtectCameras() {
  const session = await getProtectSession();

  const response = await fetch(`${session.baseUrl}${session.cameraListPath}`, {
    headers: session.headers,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to list cameras (${response.status}): ${text.substring(0, 200)}`);
  }

  const payload = await response.json();

  const rawCameras = Array.isArray(payload)
    ? payload
    : payload.cameras || payload.data || payload.devices || [];

  const cameras = rawCameras
    .map((camera) => ({
      id: camera.id || camera._id || camera.deviceId,
      name: camera.name || camera.marketName || camera.mac || camera.id,
      isConnected: camera.isConnected ?? camera.state === 'CONNECTED' ?? null,
      model: camera.modelKey || camera.type || null,
    }))
    .filter((c) => c.id);

  if (cameras.length === 0) {
    throw new Error('Protect API returned no cameras');
  }

  return { session, cameras };
}

export async function fetchCameraSnapshot(session, camera, { highQuality = true } = {}) {
  const query = new URLSearchParams({ ts: String(Date.now()) });

  const response = await fetch(
    `${session.baseUrl}${session.snapshotPathPrefix}/${camera.id}/snapshot?${query}`,
    {
      headers: {
        ...session.headers,
        Accept: 'image/jpeg',
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Snapshot failed for ${camera.name} (${response.status}): ${text.substring(0, 200)}`);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const imageBuffer = Buffer.from(await response.arrayBuffer());

  return {
    ...camera,
    contentType,
    snapshotBase64: imageBuffer.toString('base64'),
  };
}

export async function fetchAllCameraSnapshots(options = {}) {
  const highQuality = options.highQuality ?? true;
  const { session, cameras } = await listProtectCameras();

  const results = await Promise.all(
    cameras.map(async (camera) => {
      try {
        return await fetchCameraSnapshot(session, camera, { highQuality });
      } catch (error) {
        return {
          ...camera,
          error: error.message,
        };
      }
    })
  );

  const succeeded = results.filter((c) => !c.error).length;
  const failed = results.length - succeeded;

  return {
    generatedAt: new Date().toISOString(),
    totalCameras: cameras.length,
    succeeded,
    failed,
    cameras: results,
  };
}
