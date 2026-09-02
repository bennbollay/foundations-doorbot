# foundations-doorbot
Unifi-Slack DoorBot to update a channel on entry

Creates a message on an hourly basis in channel, updated with people that have unlocked the specified door.

# Installation

Install node v22.

Install homebrew.

Install the `zx` shell:

```
brew install zx
```

Create a new Slack bot and grant it the following `Bot Token Scopes` under `OAuth & Permissions`:
  * `chat:write`
  * `users.profile:read`
  * `users:read`
  * `users:read.email`

Reinstall the bot to the Slack Workspace.

Take the `Bot User OAuth Token` and place it in the `.env` file:

```
# Slack Configuration Values
SLACK_OAUTH_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C...

# Unifi Door Endpoint Configuration
UNIFI_DOOR_API=https://192.168.1.1:12445
UNIFI_DOOR_TOKEN=Wh...
UNIFI_DOOR_DEVICES=5f9... 515... 636...
```

You will need to invite (via `/invite @DoorBot`) to the specific channel you want it to post to, and populate the `SLACK_CHANNEL_ID` field
in the `.env` accordingly.

On the Unifi side, create a new token with the following permissions:
- `VIEW` permissions on `User & Group` and `System Log` (required for door opening logs and status checks)
- `WRITE` permissions on `User & Group` (required for activate/deactivate commands)

Place that credential in the `.env` file, along with the API endpoint for the Unifi service.

Also, populate the list of allowed devices into the `UNIFI_DOOR_DEVICES` variable in the `.env`.

Finally, you can create a `config.json` file that references the profile id fields (experimentally derived by looking at slack API responses) and any user-specific overrides desired:

```
{
  "slackLinkedInProfileId": "Xf07RM6SNW3W",
  "slackBlurbProfileId": "Xf07RC36BECE",
  "specialUsers": {
    "user@example.com": {
      "pictureEmoji": ":heart:"
    }
  }
}
```

# Usage

## Slack Bot Updates

Install the `zx` shell, and then run `./main.mjs` via CRON every minute, and filter out the TLS certificate warning:

```
* * * * * cd doorbot && /opt/homebrew/bin/zx ./main.mjs 2>&1 | grep -v NODE_TLS_REJECT_UNAUTHORIZED | grep -v "was created" > doorlog.txt
```

It will leave a file `doorbot.json` in the working directory which tracks the message to update for each hour.

## User Access Management

The doorbot now includes CLI commands to manage user access in UniFi Access. You can deactivate users and check their status by email address.

### Authentication Setup

The system uses automatic authentication with the UniFi Identity cloud service. Set these credentials in your `.env` file:

```bash
# UniFi Console/Cloud credentials (required)
UNIFI_CLOUD_USERNAME=root
UNIFI_CLOUD_PASSWORD=your_password

# UniFi Door API endpoint (already set)
UNIFI_DOOR_API=https://192.168.1.1:12445
```

The system will automatically:
1. Authenticate with the UniFi Identity service at `d8b3705351d507855f7d07e296d4064690a08.id.ui.direct`
2. Cache authentication tokens for 8 hours
3. Re-authenticate when tokens expire

### Available Commands

#### Create a New User ✅ (WORKING)
Create a new user with door access:
```bash
npm run doorbot create FirstName LastName user@example.com
# Example:
npm run doorbot create John Doe john.doe@example.com
```

#### Activate a User ✅ (WORKING)
Activate door access for a user by email:
```bash
npm run doorbot activate user@example.com
```

#### Deactivate a User ✅ (WORKING)
Deactivate door access for a user by email:
```bash
npm run doorbot deactivate user@example.com
```

#### Check User Status ✅ (WORKING)
Check the current access status of a user:
```bash
npm run doorbot status user@example.com
```

#### Resend Invitation ✅ (WORKING)
Resend an invitation email to an existing user:
```bash
npm run doorbot resend-invite user@example.com
```

### Alternative Usage

You can also use the shorter npm scripts:
```bash
# These commands will show help for the specific action
npm run create
npm run activate
npm run deactivate
npm run status
```

Or run the CLI directly:
```bash
node cli.mjs create FirstName LastName user@example.com
node cli.mjs activate user@example.com
node cli.mjs deactivate user@example.com
node cli.mjs status user@example.com
node cli.mjs resend-invite user@example.com
```

### Global Installation (Optional)

If you want to use the `doorbot` command globally, you can install the package globally:
```bash
npm link
```

Then you can use:
```bash
doorbot create FirstName LastName user@example.com
doorbot activate user@example.com
doorbot deactivate user@example.com
doorbot status user@example.com
```

### Important Notes

⚠️ **Warning**: This uses unofficial UniFi APIs that may change without notice.

**Current Status:**
- ✅ **User creation is fully working** - Successfully creates new users with door access
- ✅ **User activation is fully working** - Successfully activates users via the Identity API
- ✅ **User deactivation is fully working** - Successfully deactivates users via the Identity API
- ✅ **User status lookup is fully working** - Can check if users are active or deactivated

**Technical Details:**
- Uses the UniFi Identity cloud service at `d8b3705351d507855f7d07e296d4064690a08.id.ui.direct`
- Requires root/admin credentials with access to UniFi Identity
- Authentication tokens are cached locally in `.direct_identity_auth.json`
- The create user endpoint matches the browser's exact API call: `POST /proxy/access/api/v2/user`
- The activation endpoint matches the browser's exact API call: `PUT /proxy/users/api/v2/user/{userId}/active?isULP=1`
- The deactivation endpoint matches the browser's exact API call: `PUT /proxy/users/api/v2/user/{userId}/deactivate?isULP=1`

**Recommendation**: Always maintain a backup of your UniFi configuration before using these commands.

## Camera Snapshot API

This repo can also run a small HTTP API that returns the current snapshot for every camera in UniFi Protect, aggregated across one or more Protect consoles (e.g. a UNVR plus a UDM that hosts the door access devices). All configured controllers are queried in parallel and the results are merged into a single response.

### Environment

Add these values to your `.env`:

```bash
CAMERA_API_PORT=8787
CAMERA_API_KEY=replace-with-your-api-key
CAMERA_SNAPSHOT_TIMEOUT_MS=10000
CAMERA_SNAPSHOT_CONCURRENCY=4
CAMERA_SNAPSHOT_START_INTERVAL_MS=150

# First Protect controller (required)
UNIFI_PROTECT_HOST=https://192.168.6.199
UNIFI_PROTECT_API_TOKEN=your_protect_integration_api_key
UNIFI_PROTECT_NAME=UNVR

# Additional controllers use _2, _3, ... suffixes
UNIFI_PROTECT_HOST_2=https://192.168.1.1
UNIFI_PROTECT_NAME_2=UDM
#UNIFI_PROTECT_API_TOKEN_2=optional_api_key
```

Notes:
- Each controller authenticates with its own integration API token (`UNIFI_PROTECT_API_TOKEN`, `UNIFI_PROTECT_API_TOKEN_2`, ...) if set; otherwise it uses cookie-based username/password login.
- Username/password per controller (`UNIFI_PROTECT_USERNAME_2`, ...) falls back to the unsuffixed `UNIFI_PROTECT_USERNAME`/`UNIFI_PROTECT_PASSWORD`, then to `UNIFI_CLOUD_USERNAME`/`UNIFI_CLOUD_PASSWORD`.
- `UNIFI_PROTECT_NAME`/`UNIFI_PROTECT_NAME_2` are optional labels included as `controller` on each camera in the response (defaults to the host).
- Concurrency and rate limiting are applied per controller, since each NVR enforces its own snapshot rate limit.
- If one controller is unreachable, its error is reported in `failures` and the other controllers' cameras are still returned. The request only fails outright if every controller fails.

### Run the API

```bash
npm run camera-api
```

### Request snapshots

```bash
curl -H "x-api-key: replace-with-your-api-key" \
  "http://localhost:8787/api/camera-snapshots"
```

To disable the high-quality snapshot flag:

```bash
curl -H "x-api-key: replace-with-your-api-key" \
  "http://localhost:8787/api/camera-snapshots?highQuality=false"
```

The response is JSON with success/failure counts for all cameras. The `cameras` array only includes cameras whose snapshot was fetched successfully:

```json
{
  "generatedAt": "2026-03-09T00:00:00.000Z",
  "totalCameras": 2,
  "succeeded": 2,
  "failed": 0,
  "cameras": [
    {
      "id": "camera-id",
      "name": "Front Door",
      "controller": "UNVR",
      "contentType": "image/jpeg",
      "snapshotBase64": "/9j/4AAQSk..."
    }
  ]
}
```

If a snapshot request fails, it is counted in `failed` and logged server-side with the camera name, start/end time, duration, byte count, and error. An entire controller failing (unreachable, bad credentials) appears as a `failures` entry with `id: null` and the `controller` name.

## Member Management API

In addition to acting on the response from `DOOR_ACCESS_WEBHOOK_ENDPOINT`, the same Camera Snapshot API server also exposes endpoints to create, deactivate, activate, and look up members directly. These routes run on the **same port and use the same `CAMERA_API_KEY`** as the camera endpoints, and they reuse the exact same UniFi processing path the webhook uses (`processNewMembers` / `processManagedAccess`), so behavior (including idempotency checks) is identical.

No extra configuration is required beyond what the Camera Snapshot API already needs. Member operations use the UniFi Identity credentials already configured for the CLI (`UNIFI_CLOUD_USERNAME` / `UNIFI_CLOUD_PASSWORD`). Start the server the same way:

```bash
npm run camera-api
```

### Authentication

Every endpoint except `/health` requires the API key (`CAMERA_API_KEY`), sent either as `x-api-key: <key>` or `Authorization: Bearer <key>`.

### Endpoints

| Method | Path | Body / Query | Description |
|--------|------|--------------|-------------|
| `POST` | `/api/members` | `{ "firstName", "lastName", "email" }` or `{ "newMembers": [...] }` | Create one or more members. |
| `POST` | `/api/members/deactivate` | `{ "email" }` or `{ "emails": [...] }` | Deactivate door access. |
| `POST` | `/api/members/activate` | `{ "email" }` or `{ "emails": [...] }` | Activate door access. |
| `GET`  | `/api/members/status` | `?email=...` | Look up a member's status. |

### Examples

Create a member:

```bash
curl -H "x-api-key: replace-with-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"John","lastName":"Doe","email":"john.doe@example.com"}' \
  "http://localhost:8787/api/members"
```

Deactivate a member:

```bash
curl -H "x-api-key: replace-with-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"email":"john.doe@example.com"}' \
  "http://localhost:8787/api/members/deactivate"
```

Check a member's status:

```bash
curl -H "x-api-key: replace-with-your-api-key" \
  "http://localhost:8787/api/members/status?email=john.doe@example.com"
```

Responses mirror the webhook processing results. Creation returns `201` when a new member is created (and `200` if the member already existed); activate/deactivate return `200` on success and `502` if any operation failed, with per-email breakdowns (`created`, `alreadyExists`, `activated`, `deactivated`, `alreadyActive`, `alreadyInactive`, `failed`).

## Visitor Pass API

For public events, the same API server can issue **visitor passes**: temporary door access with a PIN code that only works during a specified time window. Passes are backed by UniFi Access visitors (via the official developer API), so UniFi enforces the time window itself — no cleanup job is needed and the PIN simply stops working when the window ends.

Visitor passes are assigned the **All Locations** door group (UniFi's built-in building-type group covering every door). This is required: creating a visitor without explicit resources leaves it on a "custom" location assignment that includes no doors, so the PIN would never work.

### Requirements

The `UNIFI_DOOR_TOKEN` used for door logs also needs these permissions in the UniFi console:

- `edit:visitor` (create/delete visitors, assign PINs)
- `view:visitor` (list/fetch visitors)
- `view:credential` (generate PIN codes)
- `view:space` (fetch the door group topology to resolve All Locations)

### Endpoints

All endpoints require the same `CAMERA_API_KEY` auth as above.

| Method | Path | Body / Query | Description |
|--------|------|--------------|-------------|
| `POST` | `/api/visitor-passes` | `{ "firstName", "startTime", "endTime", ... }` | Create a pass; returns the PIN. |
| `GET`  | `/api/visitor-passes` | `?keyword=&page_num=&page_size=` | List passes. |
| `GET`  | `/api/visitor-passes/:id` | | Fetch a single pass. |
| `DELETE` | `/api/visitor-passes/:id` | `?force=true` to hard-delete | Revoke a pass (cancels the visit). |

Create body fields:

- `firstName` (required) — e.g. the event name: `"Open House Guest"`
- `startTime` / `endTime` (required) — epoch seconds, epoch milliseconds, or ISO 8601 strings
- `lastName`, `email`, `mobilePhone`, `visitorCompany`, `remarks` (optional)
- `pinCode` (optional) — explicit PIN; if omitted, UniFi generates one

### Examples

Create a pass for an event (4pm–8pm):

```bash
curl -H "x-api-key: replace-with-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Summer Mixer Guest",
    "remarks": "July community mixer",
    "startTime": "2026-07-10T16:00:00-07:00",
    "endTime": "2026-07-10T20:00:00-07:00"
  }' \
  "http://localhost:8787/api/visitor-passes"
```

Response (`201`):

```json
{
  "id": "fbe8d920-47d3-4cfd-bda7-bf4b0e26f73c",
  "firstName": "Summer Mixer Guest",
  "lastName": "",
  "pinCode": "67203419",
  "startTime": 1783810800,
  "endTime": 1783825200,
  "status": "UPCOMING",
  "remarks": "July community mixer"
}
```

**Important:** the plaintext `pinCode` is only returned at creation time — UniFi stores only a hash, so capture it from this response to share with attendees.

Revoke a pass early:

```bash
curl -X DELETE -H "x-api-key: replace-with-your-api-key" \
  "http://localhost:8787/api/visitor-passes/fbe8d920-47d3-4cfd-bda7-bf4b0e26f73c"
```

### Testing

Run the visitor pass test suite against a mock UniFi server (no hardware needed):

```bash
node test-visitor-passes.mjs
```

## Intercom Directory API

The entry intercom (UA-G3-Intercom at the building door) shows visitors a searchable **directory**: each entry is a company name plus the UniFi Access users a call should ring (they answer on the UniFi Identity Endpoint app). This API lets Foundations push company listings onto the callbox directly instead of an admin typing them into the UniFi Access console.

UniFi publishes no API for the intercom directory, so `intercom.mjs` drives the same undocumented endpoints the UniFi Access web UI uses (`/proxy/access/api/v2/callers/...`), authenticated with the Identity session from `direct_identity.mjs` — the same login the member-management endpoints use. No extra `UNIFI_DOOR_TOKEN` permissions are needed.

How it maps:

- A directory **entry** is a UniFi "room" on the intercom caller device.
- Each **contact** is resolved by email to a UniFi Access user (via the same lookup as `/api/members`) and attached as a call receiver. Plain Access users work — receivers do not need to be UniFi admins.
- Contacts with no email, no UniFi account, or a deactivated account are reported back per entry as `unresolvedContacts` instead of being dropped. An entry where **no** contact resolves is reported in `failed` (a listing nobody can answer is not created).
- **Ownership**: the module records which rooms it created (or adopted by matching name) in `.intercom_directory_state.json`. `replace` mode only ever deletes rooms in that file — hand-made entries such as **Building Admins** are never touched and are listed in the response as `unmanaged`.
- Syncs are serialized in-process so concurrent requests can't create duplicate rooms.

### Environment

- `UNIFI_INTERCOM_DEVICE_ID` (optional) — the caller device id to manage. When unset, the single `UA-G3-Intercom` among the caller devices is used; the server errors if there are zero or several.
- `INTERCOM_DIRECTORY_STATE_FILE` (optional) — path of the managed-rooms state file (default `.intercom_directory_state.json` in the working directory).

### Endpoints

All endpoints require the same `CAMERA_API_KEY` auth as above.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `GET`  | `/api/intercom/directory` | | Current directory: every room with its receivers and whether this server manages it. |
| `POST` | `/api/intercom/directory/sync` | `{ "entries": [...], "mode"?: "upsert" \| "replace" }` | Create/update listings; `replace` also removes previously-synced listings missing from `entries`. |

Entry shape: `{ "key"?: "company:42", "company": "Acme Corp", "contacts": [{ "name"?: "Jane Doe", "email": "jane@acme.com" }] }`. `key` is an optional caller-owned stable id — when provided, a company renamed on the Foundations side updates its existing room instead of creating a second one.

Response (`200`, even with per-entry failures — read `failed`):

```json
{
  "ok": true,
  "callerId": "847848340d5a",
  "callerName": "UA G3 Intercom 0d5a",
  "mode": "upsert",
  "synced": [
    {
      "company": "Acme Corp",
      "roomId": "b0365729-a504-4f36-b4cb-d5303d2d61c0",
      "status": "created",
      "receiverCount": 1,
      "resolvedContacts": [{ "name": "Jane Doe", "email": "jane@acme.com", "userId": "293c6d7a-…" }],
      "unresolvedContacts": [{ "name": "New Hire", "email": "new@acme.com", "reason": "no_unifi_account" }]
    }
  ],
  "removed": [],
  "failed": [],
  "unmanaged": [{ "roomId": "096e4ed8-…", "name": "Building Admins" }]
}
```

`status` is `created`, `updated` (name or receivers changed), or `unchanged`. `unresolvedContacts[].reason` is one of `no_email`, `no_unifi_account`, `unifi_account_inactive`, `no_user_id`, or `lookup_failed: …`.

### Examples

```bash
curl -H "x-api-key: replace-with-your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "entries": [
      { "key": "company:42", "company": "Acme Corp",
        "contacts": [{ "name": "Jane Doe", "email": "jane@acme.com" }] }
    ]
  }' \
  "http://localhost:8787/api/intercom/directory/sync"
```

### Testing

```bash
node test-intercom-directory.mjs                    # mock Identity/Access proxy, no hardware
node test-intercom-directory.mjs --list             # read the live directory
node test-intercom-directory.mjs --live you@x.com   # reversible live check: create → update → delete a test entry
```

The live check only creates rooms named `ZZ Root Sync Test …` and removes them on exit, whether or not the assertions pass.

## Costco Same-Day Automation

`costco-automation.mjs` drives the installed Google Chrome (via Playwright)
against sameday.costco.com and exposes an HTTP API the foundations app calls
for order-history sync, product search, and (dry-run by default) checkout. It
runs on this machine because Costco's identity provider blocks logins from
datacenter IPs and cloud browsers — the office connection passes.

### Environment

```bash
COSTCO_AUTOMATION_API_KEY=   # x-api-key secret; falls back to CAMERA_API_KEY
COSTCO_PROFILE_DIR=          # default ~/.costco-automation-profile
COSTCO_HEADLESS=true
COSTCO_DEBUG_DIR=            # default ~/costco-debug
COSTCO_TIMEOUT_MS=60000
COSTCO_ALERT_SLACK_CHANNEL_ID=  # optional: Slack alert when re-login is needed
```

### Run the server

The `/api/costco/*` routes are mounted on the camera API server, so they share
its port (8787) and the single ngrok tunnel — running the camera API
(`npm run camera-api`, or the `com.foundations.camera-api` launchd service)
serves them too. After pulling changes, restart it:

```bash
npm run camera-api:install   # reinstalls + restarts the launchd service
npm run camera-api:logs
```

For ad-hoc use there is also a standalone mode on its own port
(`COSTCO_AUTOMATION_PORT`, default 8789): `npm run costco:serve`. Don't run it
alongside the camera API instance — they'd fight over the Chrome profile.

Endpoints (all JSON; auth header `x-api-key` on everything except `/health`):
`GET /health`, `GET /api/costco/session`, `POST /api/costco/orders/sync`,
`POST /api/costco/search`, `POST /api/costco/order`. These are slow browser
flows — callers should allow ~3 min for search, ~10 min for orders sync, and
~15 min for an order. `POST /api/costco/order` is dry-run unless the body
explicitly sends `dry_run: false`.

### Bootstrap the login (once per machine)

Login cannot be scripted — Costco's bot protection (PerimeterX) swallows
credential submissions from any automated browser, even with a human typing.
So sign in once by hand, on this machine, with a display (Screen Sharing
works):

```bash
npm run costco:login
```

That opens a **regular** Chrome window on the Costco Same-Day orders page.
Click "Sign in via Costco.com", sign in (check **"Keep me signed in"** — the
account credentials are in the on-call vault, see `COSTCO_EMAIL` /
`COSTCO_PASSWORD` in `.env.sample`), wait until you're back on
sameday.costco.com signed in, then return to the terminal and press Enter.
The session cookies are captured to `$COSTCO_PROFILE_DIR/session-cookies.json`
and the command verifies the headless automation is signed in.

Other ops commands:

```bash
npm run costco:status       # is the session still signed in?
npm run costco:submit-test  # dry-run checkout rehearsal (never places an order)
node costco-automation.mjs orders 5
node costco-automation.mjs search "paper towels"
```

### When the session expires

Cookies stay valid server-side for weeks and are refreshed after every
successful operation, but eventually they die. When that happens, operations
fail with a "The Costco session has expired…" error (returned to API callers,
shown to foundations admins, posted to Slack if
`COSTCO_ALERT_SLACK_CHANNEL_ID` is set, and visible in the camera API logs
with a `[costco]` prefix). The fix is to re-run the bootstrap:
`npm run costco:login`.

### Debugging

Every failed browser operation writes a full-page screenshot and HTML dump to
`COSTCO_DEBUG_DIR` (default `~/costco-debug`), and the error message returned
to the caller includes the artifact path. Dry-run checkouts also snapshot the
final checkout page there. Use
`node costco-automation.mjs explore <storefront|orders|search|url>` to dump a
page's visible buttons/links when tuning selectors after a site change.
