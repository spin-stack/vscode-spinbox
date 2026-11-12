# Spinbox for VS Code

Open your Spinbox workspaces in VS Code over Remote-SSH: list them, start and stop them, and open
one in a new window, without leaving the editor.

## Requirements

- VS Code 1.120 or newer, or an editor built on it that installs from Open VSX (VSCodium,
  Cursor, ...).
- A Remote-SSH extension: Microsoft's `ms-vscode-remote.remote-ssh` in VS Code, or
  `jeanp413.open-remote-ssh` elsewhere. When none is installed, Spinbox offers to install the one
  your editor's marketplace carries.
- A Spinbox account, with an SSH key of this machine added to it. If none is, Spinbox says so and
  offers to add one.

## Spinbox's own connection

With `spin-stack.open-remote-ssh` installed and allowed VS Code's proposed API, Spinbox opens a
workspace as `vscode-remote://spin+<workspace>/...` instead of over Remote-SSH: the connection is
Spinbox's, so a workspace that does not open says why, in VS Code, with what to do. Its server
comes from your installation, never a download.

VS Code, VSCodium and the other editors let a third-party extension use a proposed API only when
`argv.json` names it. Run **Preferences: Configure Runtime Arguments**, add this line inside the
object it opens, and restart the editor:

```jsonc
"enable-proposed-api": ["spin-stack.open-remote-ssh"]
```

Spinbox checks for it on every open: until the resolver activates, workspaces open over Remote-SSH,
and Spinbox says once what is missing.

The extension carries the `spin` CLI it needs, for Linux and macOS on x64 and arm64: there is
nothing else to install.

## Getting started

1. Install **Spinbox** from the Extensions view.
2. Open **Spinbox Workspaces** in the Explorer and select **Sign In**, or run
   **Spinbox: Sign In** from the Command Palette. Spinbox then shows in the Accounts menu.
3. Select a workspace's **Open Workspace** action. A stopped workspace is started first; it opens
   in a new window, through Spinbox's own connection where it is enabled (above), otherwise over
   Remote-SSH.

## Features

- **Spinbox Workspaces** in the Explorer: every workspace with its state, and actions to open,
  start, stop and refresh.
- **Commands**: Open Workspace, Start Workspace, Stop Workspace, Refresh Workspaces, Sign In and
  Sign Out, under **Spinbox** in the Command Palette.
- **Links**: `vscode://spin-stack.spinbox/open?workspace=<id>` opens a workspace from a browser,
  and `&path=<absolute path>` a folder inside it.
- **Errors you can act on**: an outdated CLI, a missing SSH key or no room for a workspace each say
  what fixes it, with a button for it where there is one.

## Settings

| Setting | Default | What |
|---|---|---|
| `spinbox.cliPath` | empty | The `spin` CLI to run. Empty runs the one the extension carries. |
| `spinbox.telemetry` | `true` | Join each operation to the trace of the `spin` command it runs. Off, the CLI still traces its own commands unless its profile sets `telemetry: false`. |

## Contributing

How to build, test and release the extension is in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
