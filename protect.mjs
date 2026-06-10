process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 10000;
const MIN_SNAPSHOT_TIMEOUT_MS = 5000;
const DEFAULT_SNAPSHOT_CONCURRENCY = 4;
const DEFAULT_SNAPSHOT_START_INTERVAL_MS = 150;

function getPositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getSnapshotTimeoutMs() {
  return Math.max(
    MIN_SNAPSHOT_TIMEOUT_MS,
    getPositiveIntegerEnv('CAMERA_SNAPSHOT_TIMEOUT_MS', DEFAULT_SNAPSHOT_TIMEOUT_MS)
  );
}

function getSnapshotConcurrency() {
  return getPositiveIntegerEnv('CAMERA_SNAPSHOT_CONCURRENCY', DEFAULT_SNAPSHOT_CONCURRENCY);
}

function getSnapshotStartIntervalMs() {
  return getPositiveIntegerEnv('CAMERA_SNAPSHOT_START_INTERVAL_MS', DEFAULT_SNAPSHOT_START_INTERVAL_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStartGate(intervalMs) {
  let nextStartAt = 0;

  return async () => {
    const now = Date.now();
    const waitMs = Math.max(0, nextStartAt - now);
    nextStartAt = Math.max(now, nextStartAt) + intervalMs;

    if (waitMs > 0) {
      await sleep(waitMs);
    }
  };
}

async function mapWithConcurrency(items, concurrency, startIntervalMs, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const concurrencyLimit = Math.max(1, concurrency);
  const waitForTurn = createStartGate(startIntervalMs);

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await waitForTurn();
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrencyLimit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function formatLogTime(timestampMs) {
  return new Date(timestampMs).toISOString();
}

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
      // The integration API strictly validates query params (AJV) and rejects
      // unknown ones like a `ts` cache-buster; only `highQuality` is allowed.
      isIntegrationApi: true,
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
    isIntegrationApi: false,
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

export async function fetchCameraSnapshot(session, camera, { highQuality = true, timeoutMs = getSnapshotTimeoutMs() } = {}) {
  const query = session.isIntegrationApi
    ? new URLSearchParams({ highQuality: String(highQuality) })
    : new URLSearchParams({ ts: String(Date.now()) });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let byteCount = 0;
  let errorMessage = '';

  console.log(
    `[camera-snapshot] start camera="${camera.name}" id=${camera.id} timestamp=${formatLogTime(startedAt)} timeoutMs=${timeoutMs}`
  );

  const requestSnapshot = (params) =>
    fetch(`${session.baseUrl}${session.snapshotPathPrefix}/${camera.id}/snapshot?${params}`, {
      headers: {
        ...session.headers,
        Accept: 'image/jpeg',
      },
      signal: controller.signal,
    });

  try {
    let params = query;
    let response;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await requestSnapshot(params);
      if (response.ok) break;

      // Older camera models reject highQuality=true with a 400; retry at standard quality.
      if (session.isIntegrationApi && response.status === 400 && params.get('highQuality') === 'true') {
        params = new URLSearchParams({ highQuality: 'false' });
        continue;
      }

      // The NVR rate-limits snapshot requests (10/sec); back off and retry.
      if (response.status === 429) {
        await sleep(1000);
        continue;
      }

      break;
    }

    if (!response.ok) {
      const text = await response.text();
      byteCount = Buffer.byteLength(text);
      throw new Error(`Snapshot failed for ${camera.name} (${response.status}): ${text.substring(0, 200)}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const imageBuffer = Buffer.from(await response.arrayBuffer());
    byteCount = imageBuffer.length;

    return {
      ...camera,
      contentType,
      snapshotBase64: imageBuffer.toString('base64'),
    };
  } catch (error) {
    errorMessage =
      error.name === 'AbortError' ? `Snapshot timed out after ${timeoutMs}ms for ${camera.name}` : error.message;
    throw new Error(errorMessage);
  } finally {
    clearTimeout(timeout);
    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;
    console.log(
      `[camera-snapshot] end camera="${camera.name}" id=${camera.id} timestamp=${formatLogTime(endedAt)} durationMs=${durationMs} bytes=${byteCount} error=${JSON.stringify(errorMessage || null)}`
    );
  }
}

export async function fetchAllCameraSnapshots(options = {}) {
  const highQuality = options.highQuality ?? true;
  const timeoutMs = options.timeoutMs ?? getSnapshotTimeoutMs();
  const concurrency = options.concurrency ?? getSnapshotConcurrency();
  const startIntervalMs = options.startIntervalMs ?? getSnapshotStartIntervalMs();
  const { session, cameras } = await listProtectCameras();

  console.log(
    `[camera-snapshot] fetching ${cameras.length} cameras concurrency=${concurrency} timeoutMs=${timeoutMs} startIntervalMs=${startIntervalMs}`
  );

  const results = await mapWithConcurrency(
    cameras,
    concurrency,
    startIntervalMs,
    async (camera) => {
      try {
        return await fetchCameraSnapshot(session, camera, { highQuality, timeoutMs });
      } catch (error) {
        return {
          ...camera,
          error: error.message,
        };
      }
    }
  );

  const successfulSnapshots = results.filter((c) => !c.error);
  const failures = results
    .filter((c) => c.error)
    .map(({ id, name, isConnected, error }) => ({ id, name, isConnected, error }));

  return {
    generatedAt: new Date().toISOString(),
    totalCameras: cameras.length,
    succeeded: successfulSnapshots.length,
    failed: failures.length,
    cameras: successfulSnapshots,
    failures,
  };
}
