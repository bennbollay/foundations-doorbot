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

On the Unifi side, create a new token with `VIEW` permissions on `User & Group` and `System Log`.  Place that credential in the `.env` file,
along with the API endpoint for the Unifi service.

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

Install the `zx` shell, and then run `./main.mjs` via CRON every minute, and filter out the TLS certificate warning:

```
* * * * * cd doorbot && /opt/homebrew/bin/zx ./main.mjs 2>&1 | grep -v NODE_TLS_REJECT_UNAUTHORIZED | grep -v "was created" > doorlog.txt
```

It will leave a file `doorbot.json` in the working directory which tracks the message to update for each hour.
