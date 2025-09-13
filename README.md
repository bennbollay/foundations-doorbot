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
