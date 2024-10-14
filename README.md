# foundations-doorbot
Unifi-Slack DoorBot to update a channel on entry

Creates a message on an hourly basis in channel, updated with people that have unlocked the specified door.

# Installation

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
```

You will need to invite (via `/invite @DoorBot`) to the specific channel you want it to post to, and populate the `SLACK_CHANNEL_ID` field
in the `.env` accordingly.

On the Unifi side, create a new token with `VIEW` permissions on `User & Group` and `System Log`.  Place that credential in the `.env` file,
along with the API endpoint for the Unifi service.

# Usage

Install the `zx` shell, and then run `./main.mjs` via CRON every minute:

```
* * * * * cd doorbot && ./main.mjs > /dev/null 2>&1
```

It will leave a file `doorbot.json` in the working directory which tracks the message to update for each hour.
