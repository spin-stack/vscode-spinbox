# Publishing: the accounts, once

Spinbox is published to two registries: the **Visual Studio Marketplace**, which VS Code reads, and
**Open VSX**, which VSCodium, Cursor and other editors read. Both trust this repository's Publish
workflow by OIDC (*trusted publishing*), so no token is kept in GitHub.

The Marketplace retires personal access tokens on **2026-12-01**. Open VSX needs one token only for
the very first publish, because it registers a trusted publisher only for an extension that already
exists.

What a person does, once, in this order:

| # | Where | What | Takes |
|---|---|---|---|
| 1 | GitHub | The `publish` environment in this repository | 2 min |
| 2 | Visual Studio Marketplace | The publisher `spin-stack`, and its trusted publishing policy | 10 min |
| 3 | Open VSX | An Eclipse account, the Publisher Agreement, the namespace `spin-stack`, a token | 15 min |
| 4 | Here | The first release, a pre-release | 15 min |
| 5 | Open VSX | Claim the namespace and register the trusted publisher; delete the token | days (a person at Eclipse reviews the claim) |
| 6 | GitHub | Make the package `vscode-spinbox-release` public, after the first release pushed it | 2 min |

## 1. GitHub: the `publish` environment

1. In this repository, open **Settings → Environments → New environment**, and name it `publish`.
2. Under **Deployment branches and tags**, choose **Selected branches and tags**, then **Add
   deployment branch or tag rule**, with *Ref type* **Tag** and the pattern `v*`.
   - Only a tag `v*` can run in it.
   - Both registries' policies name this environment, so no other ref can publish.
3. Optional: add yourself under **Required reviewers**, so a person approves each publish.

## 2. Visual Studio Marketplace

You need a Microsoft account. A personal one works; it does not need Azure or an Azure DevOps
organization when publishing is by trusted publishing.

1. **Create the publisher.**
   1. Open <https://marketplace.visualstudio.com/manage> and sign in with that account.
   2. Select **Create publisher** in the left pane.
   3. Set **ID** to `spin-stack`. It must equal `publisher` in `package.json`, and it **cannot be
      changed later**.
   4. Set **Name** to the name people see, for example `Spinbox`. The other fields are optional.
   5. Select **Create**.
2. **Add the trusted publishing policy.**
   1. On the same page, open the publisher `spin-stack` and select the **Trusted Publishing** tab.
   2. Expand **Create** and fill in:

      | Field | Value |
      |---|---|
      | Policy name | `vscode-spinbox publish` |
      | Repository owner | `spin-stack` |
      | Repository | `vscode-spinbox` |
      | Workflow filename | `publish.yml` |
      | Environment | `publish` |

   3. Select **Create**.
3. **Add people.** In the publisher's **Members**, add whoever else should manage it.

Later, once the publisher has had an extension listed for 6 months, it can verify the domain
(publisher → **Details → Verified domain**, a DNS TXT record). Nothing needs it now.

## 3. Open VSX

You need the GitHub account you will log in to open-vsx.org with.

1. **Create an Eclipse account** at <https://accounts.eclipse.org/user/register>.
   - Fill in the **GitHub Username** field with exactly that GitHub account.
   - Open VSX matches the two accounts by this field.
2. **Log in to <https://open-vsx.org>** with that GitHub account: the account icon, top right.
3. **Sign the Publisher Agreement.**
   1. Open the avatar menu → **Settings**, then select **Log in with Eclipse** and authorize.
   2. Select **Show Publisher Agreement**, read it to the end, and select **Agree**.
4. **Create a token for the first publish.**
   1. Open **Settings → Access Tokens** (<https://open-vsx.org/user-settings/tokens>) and select
      **Generate New Token**.
   2. Describe it `vscode-spinbox first publish`, then select **Generate Token**.
   3. Copy it now: it is shown once.
5. **Create the namespace** with that token. Its name must match `publisher` in `package.json`,
   including case:

   ```sh
   pnpm exec ovsx create-namespace spin-stack -p <token>
   ```

6. **Hand the token to the first publish.**
   1. In this repository, open **Settings → Environments → publish → Add environment secret**.
   2. Name it `OVSX_PAT` and paste the token as its value.

## 4. The first release

1. **Make sure the VSIX carries a current CLI.** `versions.yaml`'s `spin` entry names a spin
   release that has the four CLIs (linux-amd64, linux-arm64, darwin-amd64, darwin-arm64).
   `task package:all` skips, and says so, any platform the release lacks.
2. **Pick the version.**
   - The Marketplace takes only `major.minor.patch`.
   - A pre-release and a release can never share a version.
   - Its convention is an **odd minor for pre-releases** and an even minor for releases.
   - So the first one is `0.1.0` as a pre-release. Set `"version": "0.1.0"` in `package.json`,
     merge it, then tag `main`:

   ```sh
   git tag v0.1.0-pre && git push origin v0.1.0-pre
   ```

3. **Watch the run.** Actions → **Publish**, approving it if you set a reviewer.
   - Its first job, **GitHub release**, needs no account: it attaches the VSIXs, `SHA256SUMS` and
     their signature to the tag's release before either registry is asked, so the release is
     there to install from even when a registry refuses. The same job pushes those files to
     `ghcr.io/spin-stack/vscode-spinbox-release`, which the first push creates private (step 6).
   - A run that fails halfway is run again whole: both registries skip a version they already
     have.
   - Its first step fails, saying why, if the job has no OIDC token.
   - Each registry refuses with its own message if the publisher, namespace or policy is not set
     up.
4. **Check both listings.**
   - <https://marketplace.visualstudio.com/items?itemName=spin-stack.spinbox>
   - <https://open-vsx.org/extension/spin-stack/spinbox>

## 5. Open VSX: from a token to trusted publishing

1. **Claim the namespace.**
   1. Open an issue at <https://github.com/EclipseFdn/open-vsx.org/issues/new/choose> asking to
      own `spin-stack`.
   2. Once granted, the namespace is *verified*.
   3. Add other people in **Settings → Namespaces**: an *Owner* manages members, a *Contributor*
      only publishes.

   A trusted publisher needs an owner; a contributor is not enough.
2. **Register the trusted publisher.**
   1. Open **Settings → Trusted Publishers**
      (<https://open-vsx.org/user-settings/trusted-publishers>) and select the namespace
      `spin-stack`.
   2. Select the GitHub provider and fill in:

      | Field | Value |
      |---|---|
      | Organization or User name | `spin-stack` |
      | Repository name | `vscode-spinbox` |
      | Workflow filename | `publish.yml` |
      | Environment name | `publish` |

   3. If the dialog offers no GitHub provider, keep the token and look again later.
3. **Drop the token.** Delete the environment secret `OVSX_PAT`, and revoke the token in
   **Settings → Access Tokens**. With no token, `ovsx` exchanges the job's ID token by itself.

## 6. ghcr: make the package public

`spin vscode install` pulls the extension anonymously from
`ghcr.io/spin-stack/vscode-spinbox-release`. GitHub creates a package private on its first push,
and a package linked to a repository takes that repository's access permissions but not its
visibility; nor is there a REST endpoint that changes it. So, once, after
the first run of Publish has pushed the package (step 4):

1. You need the admin role on the package: an owner of `spin-stack` has it on every package of the
   organization.
2. The organization must allow public packages: **spin-stack → Settings → Packages → Package
   creation**, with **Public** checked. `spin-stack/spin-release` is public, so it already is.
3. Open **spin-stack → Packages** (<https://github.com/orgs/spin-stack/packages>), and select
   `vscode-spinbox-release`.
4. Select **Package settings** on the right.
5. Under **Danger Zone**, select **Change visibility**, choose **Public**, and confirm as the
   dialog asks (it has you type the package's name).
6. Check it from a machine with no GitHub login: `spin vscode install` of the spin release that
   release carries installs it, or

   ```sh
   curl -s 'https://ghcr.io/token?scope=repository:spin-stack/vscode-spinbox-release:pull'
   ```

   answers `{"token":...}`; while the package is private it answers `DENIED`.

A public package cannot be made private again. That is what is wanted: everything in it is in
the public registries too, and what the CLI trusts is the signature, not the package.

While the package is private, or before the first push, `spin vscode install` fails with
`no_extension_release`, saying the package is missing or not public.

## Sources

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), VS Code: the publisher, trusted publishing, the PAT retirement, platform-specific and pre-release versions.
- [Publishing Extensions](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions), Open VSX wiki: the Eclipse account, the agreement, tokens, `create-namespace`.
- [Namespace Access](https://github.com/eclipse/openvsx/wiki/Namespace-Access), Open VSX wiki: claiming a namespace, members.
- [Trusted Publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing), Open VSX wiki: the trusted publisher, private repositories.
- [Configuring a package's access control and visibility](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility), GitHub: private on first publish, visibility not inherited, who may change it, public cannot go back.
