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

A tag `v*` pushed to this repository runs `.github/workflows/publish.yml`. It packages every
platform (`task package:all`) and publishes each VSIX to the Visual Studio Marketplace (`vsce`)
and to Open VSX (`ovsx`). The tag is `v` followed by `package.json`'s `version`. A tag with `-pre`
after it (`v0.3.0-pre`) publishes that version as a pre-release: the Marketplace takes no semver
pre-release versions, and its convention is an odd minor for pre-releases.

```sh
git tag v0.3.0-pre && git push origin v0.3.0-pre   # package.json says "version": "0.3.0"
```

Both registries trust the workflow by OIDC in the GitHub environment `publish`, so it keeps no
token. A run that failed halfway is run again whole: both registries skip a version they already
have.

How to create the two accounts, the publisher and the namespace, and the order to do it in, is
[docs/publishing.md](docs/publishing.md).
