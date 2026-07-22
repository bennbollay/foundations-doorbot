#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"
PLIST_NAME="com.foundations.costco-automation.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

# Unload existing service if present
launchctl unload "$PLIST_DEST" 2>/dev/null || true

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_DEST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.foundations.costco-automation</string>

	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN</string>
		<string>costco-automation.mjs</string>
		<string>serve</string>
	</array>

	<key>WorkingDirectory</key>
	<string>$PROJECT_DIR</string>

	<key>RunAtLoad</key>
	<true/>

	<key>KeepAlive</key>
	<true/>

	<key>StandardOutPath</key>
	<string>$PROJECT_DIR/costco-automation.log</string>

	<key>StandardErrorPath</key>
	<string>$PROJECT_DIR/costco-automation.err.log</string>

	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
	</dict>
</dict>
</plist>
EOF

launchctl load "$PLIST_DEST"

echo "Installed and started com.foundations.costco-automation"
echo "  Node:    $NODE_BIN"
echo "  Project: $PROJECT_DIR"
echo "  Plist:   $PLIST_DEST"
echo ""
echo "View logs: npm run costco:logs"
