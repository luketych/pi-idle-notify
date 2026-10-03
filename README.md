# pi-idle-notify

An extension for the [pi coding agent](https://github.com/badlogic/pi-mono).

Desktop notifications (plus optional sounds) when Pi finishes a response and is idle. vibecoded on pi with GPT 5.2 Codex in ~15 minutes. Should theoretically work cross-platform, tested on Linux.

I don't know how much I plan on updating this, so probably not much. Caveat emptor.

## Features

- **Desktop notifications** when the agent finishes and is waiting for your next input.
- **Status classification**: `finished`, `question`, `error`, `permission`, `misc`.
- **Sound playback** with configurable player and per-status sound overrides.
- **Linux-first**: defaults to `notify-send` (libnotify). macOS (`osascript`) and Windows (PowerShell toast) supported.
- **Configurable** via standard Pi settings (`~/.pi/agent/settings.json` or `.pi/settings.json`).

## Install

### As a pi package (recommended)

```bash
pi install git:github.com/wschwab/pi-idle-notify
```

### As a local extension

Copy the extension to:

```
~/.pi/agent/extensions/idle-notify/index.ts
```

Then run `/reload` in pi.

## Usage

Once installed, the extension waits for Pi's `agent_settled` event and sends a notification only when the parent session is idle and ready for input. It keeps the existing status classification and sound selection behavior.

To test quickly:
1. Run `/reload`
2. Send a short prompt
3. When the model finishes, you should get a desktop notification (and sound if configured)

## Configuration

Add settings to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

```json
{
  "idleNotify": {
    "enabled": true,
    "title": "Pi",
    "appName": "pi",
    "soundPath": "~/Music/notify.mp3",
    "soundByStatus": {
      "error": "~/Music/error.wav",
      "question": "~/Music/question.opus"
    },
    "soundPlayer": "mpv",
    "soundPlayerArgs": ["--no-video", "--quiet", "{soundPath}"],
    "notifyCommand": "notify-send",
    "notifyArgs": ["-a", "pi", "--urgency", "normal", "{title}", "{body}"],
    "notifyOn": ["finished", "question", "error", "permission", "misc"],
    "includePreview": false,
    "previewMaxLength": 160,
    "minIntervalMs": 0
  }
}
```

### Settings reference

- `enabled`: Toggle the extension on/off.
- `title`: Notification title.
- `appName`: App name passed to `notify-send` on Linux.
- `notifyCommand` / `notifyArgs`: Override the notification command.
- `soundPath`: Default sound for all statuses.
- `soundByStatus`: Override sound per status (`finished`, `question`, `error`, `permission`, `misc`).
- `soundPlayer` / `soundPlayerArgs`: Override audio player and arguments.
- `notifyOn`: Filter which statuses should notify.
- `includePreview`: Include a short preview of the last assistant message.
- `previewMaxLength`: Max preview length (chars).
- `minIntervalMs`: Debounce repeated notifications.

No extra configuration is required for the supported subagent integration.

## Subagent integration

This version supports the installed `pi-subagents` package API verified against `pi-subagents` 0.67.0 on Pi 0.85.1.

- Child sessions are suppressed with the package's child markers: `PI_SUBAGENT_CHILD=1` for background runner processes, and `PI_SUBAGENT_PARENT_SESSION` compared with the current `ctx.sessionManager.getSessionId()` for foreground in-process children.
- Parent sessions track `subagent:async-started`, `subagent:async-complete`, and `subagent:foreground-complete` on `pi.events`, scoped by the payload `sessionId` and stable `id`/`runId`.
- Reload/startup recovery reads active async runs from the `pi-subagents` artifact layout: `$PI_SUBAGENTS_TEMP_ROOT/async-subagent-runs` (or the package's default temp root), `.active-runs`, and each run's `status.json`.
- Completion delivery remains silent until the parent processes the result and settles. `pi-subagents` delivers the completion message before emitting `subagent:async-complete`, so idle-notify invalidates pending notifications on subagent completion and never notifies merely because the active run count reached zero.

Limitations:

- The artifact fallback is specific to `pi-subagents` 0.67.x. If that package changes its temp layout or event payloads, update this integration after checking the installed source.
- Other child-session launchers are not automatically detected unless they use the same environment markers or avoid loading this extension in child sessions.

## Linux notes

- Requires `notify-send` (usually from `libnotify`).
- For sound, `mpv` or `ffplay` provide the broadest codec support (mp3/opus/wav/etc.).

## License

MIT
