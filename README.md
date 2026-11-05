# Spinbox for VS Code

The VS Code extension `spin-stack.spinbox`: opens Spinbox workspaces in VS Code over Remote-SSH.
It talks to Spinbox through the `spin` CLI alone, by the JSON contract in
[spin-stack/spin#833](https://github.com/spin-stack/spin/issues/833); `src/cli/contract.ts` is
that contract as types.

## Developing

Needs Go (the tools are pinned in `go.mod`), Node 22 and pnpm.

```sh
go tool task install            # dependencies, through Socket Firewall
go tool task test               # unit tests (Vitest), against the fake spin in test/fake-spin/
go tool task test:integration   # the extension activated in a real VS Code; needs a display
go tool task ci                 # what CI runs
```

F5 in VS Code runs the extension in an Extension Development Host (`.vscode/launch.json`).

`test/fake-spin/spin.cjs` answers every command and every error code of the contract, from
environment variables or a scenario file: its header says how.

## Publishing

A tag `v*` pushed to this repository runs `.github/workflows/publish.yml`: it packages every
platform (`task package:all`) and publishes each VSIX to the Visual Studio Marketplace (`vsce`)
and to Open VSX (`ovsx`). The tag is `v` and `package.json`'s `version`; a tag with `-pre` after
it (`v0.2.0-pre`) publishes the same version as a pre-release, because the Marketplace takes no
semver pre-release versions.

```sh
git tag v0.2.0 && git push origin v0.2.0   # package.json says "version": "0.2.0"
```

The job runs in the GitHub environment `publish`, and its first step fails, naming each one
missing, until a person has created that environment's two secrets:

| Secret     | What it is                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VSCE_PAT` | An Azure DevOps personal access token of a member of the Marketplace publisher `spin-stack`, organization *All accessible organizations*, scope *Marketplace: Manage*.             |
| `OVSX_PAT` | An access token from open-vsx.org (Settings, Access Tokens) of a member of the Open VSX namespace `spin-stack`; `pnpm exec ovsx create-namespace spin-stack` makes it the first time. |

Settings, Environments, New environment `publish` in this repository; *Deployment branches and
tags* limited to tags `v*` keeps any other ref from reaching the tokens.

A run that failed halfway is run again whole: both publishes skip a version already there. The
same steps run outside a workflow with the tokens in the environment:

```sh
VSCE_PAT=... OVSX_PAT=... go tool task publish TAG=v0.2.0
```
