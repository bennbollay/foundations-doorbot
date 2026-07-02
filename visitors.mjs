process.loadEnvFile();

// The UniFi console uses a self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Visitor pass management via the UniFi Access developer API.
//
// A "visitor pass" is a UniFi Access visitor with a one-time visit window
// (start_time/end_time, epoch seconds) and an assigned PIN code. Outside the
// window the PIN simply stops working, so no cleanup job is needed. This is
// the same API host/token used for door logs (UNIFI_DOOR_API/UNIFI_DOOR_TOKEN),
// but the token additionally needs edit:visitor and view:credential permissions.
//
// Visitors are deliberately NOT assigned to any door group or resources, so
// they only get UniFi's default visitor access (the front door).

const doorEndpoint = process.env.UNIFI_DOOR_API;
const doorAuthToken = process.env.UNIFI_DOOR_TOKEN;

const accessRequest = async (path, { method = 'GET', body } = {}) => {
  const response = await fetch(`${doorEndpoint}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${doorAuthToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error(`UniFi Access ${method} ${path} returned non-JSON response (HTTP ${response.status})`);
  }

  if (result.code !== 'SUCCESS') {
    throw new Error(`UniFi Access ${method} ${path} failed: ${result.code} - ${result.msg}`);
  }

  return result.data;
};

// Accepts epoch seconds, epoch milliseconds, or anything Date can parse
// (e.g. ISO 8601 strings) and normalizes to the epoch seconds UniFi expects.
export const toEpochSeconds = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Treat values that look like milliseconds (past ~2033 in seconds) as ms.
    return value > 2_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return toEpochSeconds(asNumber);
    }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return Math.floor(parsed.getTime() / 1000);
    }
  }

  return undefined;
};

// Generates a PIN code server-side so it satisfies UniFi's PIN constraints.
export const generatePinCode = () =>
  accessRequest('/api/v1/developer/credentials/pin_codes', { method: 'POST' });

export const assignPinToVisitor = (visitorId, pinCode) =>
  accessRequest(`/api/v1/developer/visitors/${visitorId}/pin_codes`, {
    method: 'PUT',
    body: { pin_code: pinCode },
  });

export const fetchVisitor = (visitorId) =>
  accessRequest(`/api/v1/developer/visitors/${visitorId}`);

export const fetchAllVisitors = ({ keyword, pageNum, pageSize } = {}) => {
  const params = new URLSearchParams();
  if (keyword) params.set('keyword', keyword);
  if (pageNum) params.set('page_num', String(pageNum));
  if (pageSize) params.set('page_size', String(pageSize));
  params.append('expand[]', 'pin_code');

  return accessRequest(`/api/v1/developer/visitors?${params.toString()}`);
};

// Soft delete marks the visit CANCELLED (revokes access, keeps the record);
// force physically deletes the visitor.
export const deleteVisitor = (visitorId, { force = false } = {}) =>
  accessRequest(`/api/v1/developer/visitors/${visitorId}${force ? '?is_force=true' : ''}`, {
    method: 'DELETE',
  });

/**
 * Creates a time-windowed visitor pass with an assigned PIN.
 *
 * @param {Object} pass
 * @param {string} pass.firstName - Visitor or event attendee first name.
 * @param {string} [pass.lastName] - Last name (optional; e.g. "Open House Guest").
 * @param {number} pass.startTime - Epoch seconds the pass becomes valid.
 * @param {number} pass.endTime - Epoch seconds the pass expires.
 * @param {string} [pass.email]
 * @param {string} [pass.mobilePhone]
 * @param {string} [pass.remarks] - Free-form note, e.g. the event name.
 * @param {string} [pass.visitorCompany]
 * @param {string} [pass.pinCode] - Explicit PIN; generated via UniFi if omitted.
 * @returns {Object} The created visitor plus the plaintext pinCode. UniFi only
 *   stores a hash, so this response is the one chance to capture the PIN.
 */
export const createVisitorPass = async ({
  firstName,
  lastName = '',
  startTime,
  endTime,
  email = '',
  mobilePhone = '',
  remarks = '',
  visitorCompany = '',
  pinCode,
}) => {
  // No resources/door groups on purpose: default visitor access = front door.
  const payload = {
    first_name: firstName,
    last_name: lastName,
    remarks,
    mobile_phone: mobilePhone,
    email,
    visitor_company: visitorCompany,
    start_time: startTime,
    end_time: endTime,
    visit_reason: 'Others',
  };

  const visitor = await accessRequest('/api/v1/developer/visitors', {
    method: 'POST',
    body: payload,
  });

  const pin = pinCode || (await generatePinCode());

  try {
    await assignPinToVisitor(visitor.id, pin);
  } catch (error) {
    // A pass without a PIN is useless for events; remove the orphaned visitor
    // so retries don't pile up duplicates, then surface the original failure.
    try {
      await deleteVisitor(visitor.id, { force: true });
    } catch (cleanupError) {
      console.error(`Failed to clean up visitor ${visitor.id} after PIN assignment error: ${cleanupError.message}`);
    }
    throw new Error(`Visitor created but PIN assignment failed: ${error.message}`);
  }

  return { ...visitor, pinCode: pin };
};
