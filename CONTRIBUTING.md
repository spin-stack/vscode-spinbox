# Contributing

The extension talks to Spinbox through the `spin` CLI alone, by a JSON contract that
`src/cli/contract.ts` holds as types. Every change goes in by pull request, with CI green.

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

## Following spin

Every VSIX carries the spin CLI of one spin release, the one `versions.yaml` pins as `spin`, and a
CLI speaks only to an installation of its own release; so the extension follows each spin release.
[spin-stack/shipset](https://github.com/spin-stack/shipset) dispatches
`.github/workflows/bump-spin.yml` with each spin release newer than the pin (input `release`; the
run is named `spin <release>`, which is how shipset finds it again). The run:

1. stops, successfully, when the release is not newer than the pin (`task spin:newer`);
2. bumps the pin (`task spin:bump`, `go tool versions bump spin <release>`), reading the tag's
   commit from spin with a read-only token of the release app;
3. runs `task ci` and `task package:all`, which pulls that release's CLI for every platform it has
   one for and checks each with cosign;
4. commits as the release app (spin-stack-release), force-pushes `spin/next`, and opens the pull
   request there, or rewrites the one open (`task spin:propose`, `hack/spinpropose`).

One branch, rewritten by each run: what waits there is always the newest release, and a newer one
replaces commits added to it. The pull request is opened by the app, not by the run's own token, so
CI and Package run on it. Merging it, after checking the CLI's contract against
`src/cli/contract.ts` and trying the extension against an installation of that release, and then
tagging the extension, are a person's. The run needs the app's key as the secret `RELEASE_APP_KEY`.

To bump by hand, `go tool versions bump spin <release>` and `go tool task package:all`.

## Releasing

A tag `v*` pushed to this repository runs `.github/workflows/publish.yml`. It packages every
platform once (`task package:all`), makes the tag's GitHub release (`task publish:github`),
pushes the same files to the public package `ghcr.io/spin-stack/vscode-spinbox-release`
(`task publish:ghcr`), and then publishes the same VSIXs to the Visual Studio Marketplace
(`vsce`) and to Open VSX (`ovsx`). The tag is `v` followed by `package.json`'s `version`.

The GitHub release comes first, in a job of its own, so it exists whether or not a registry is set
up or answers. It holds:

| File | What |
|---|---|
| `spinbox-<target>.vsix` | One per platform: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` |
| `spin-release.txt` | The one spin release every VSIX's CLI is (`bin/<target>/VERSION`) |
| `SHA256SUMS` | `sha256sum` of the VSIXs and `spin-release.txt` |
| `SHA256SUMS.sigstore.json` | cosign's keyless signature of `SHA256SUMS`, as `publish.yml` at the tag |

The same files go to a public package as well, so a spin CLI can pull them anonymously, the
way spin publishes its own CLIs (`ghcr.io/spin-stack/spin-release`): one OCI artifact per tag,
pushed with oras (`hack/ghcrpush`), each file a layer named by its file name.

| Tag of `ghcr.io/spin-stack/vscode-spinbox-release` | What |
|---|---|
| `<tag>` (`v0.4.0`) | The release's files, as above |
| `spin-<release>` (`spin-v20261106.01`) | The same artifact: the release last pushed whose VSIXs carry that spin release |
| `spin-<release>-pre` | The same, for a pre-release, so one never takes the tag a release holds |

The manifest's `org.opencontainers.image.version` is the extension's tag. `spin vscode install`,
run by a spin CLI, pulls `spin-<its release>` anonymously (then `spin-<its release>-pre`), holds
`SHA256SUMS.sigstore.json` to `publish.yml` at the tag the manifest names, the VSIX and
`spin-release.txt` to `SHA256SUMS`, and installs the VSIX into VS Code. The package is transport:
a tag moved to another artifact can only point at another release this workflow signed. By hand,
`oras pull ghcr.io/spin-stack/vscode-spinbox-release:<tag>`, the `cosign verify-blob` line the
release notes say, and then `code --install-extension spinbox-<target>.vsix`.

The package is made private by its first push, and nothing installs from it until someone makes
it public, once: [docs/publishing.md](docs/publishing.md#6-ghcr-make-the-package-public).

A tag with `-pre` after it (`v0.3.0-pre`) publishes that version as a pre-release: the Marketplace takes no semver
pre-release versions, and its convention is an odd minor for pre-releases.

```sh
git tag v0.3.0-pre && git push origin v0.3.0-pre   # package.json says "version": "0.3.0"
```

Both registries trust the workflow by OIDC in the GitHub environment `publish`, so it keeps no
token. A run that failed halfway is run again whole: both registries skip a version they already
have.

How to create the two accounts, the publisher and the namespace, and the order to do it in, is
[docs/publishing.md](docs/publishing.md).
