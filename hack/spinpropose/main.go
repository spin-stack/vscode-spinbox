// Command spinpropose is the Bump spin workflow's last step (.github/workflows/bump-spin.yml says
// what and why): versions.yaml's spin, already bumped to -release and checked by task ci and task
// package:all, committed and pushed to spin/next as the app whose token GH_TOKEN is and whose slug
// -app is, and the pull request there opened - or rewritten, when the app has one open:
//
//	GH_TOKEN=<the app's> go run ./hack/spinpropose -release v20261106.01 -app spin-stack-release
//
// As the app so CI and Package run on the pull request, which one opened with a workflow's own
// token would not start, and so spin-stack/shipset, which waits only on what the app proposed,
// sees it. One branch, rewritten by each run: what waits there is always the newest release.
//
// package.json's version moves to the next patch when the one main holds is already tagged, so
// merging the pull request is a release: .github/workflows/tag.yml tags main at the version no tag
// has yet, and that tag publishes.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/spin-stack/vscode-spinbox/hack/release"
)

const branch = "spin/next"

func main() {
	var p proposal
	flag.StringVar(&p.release, "release", "", "the spin release versions.yaml was bumped to")
	flag.StringVar(&p.app, "app", "", "the app's slug, whose token GH_TOKEN is")
	flag.StringVar(&p.spin, "spin", "build/spin", "package:spin's output: a directory per platform with a CLI")
	flag.StringVar(&p.pkg, "package", "package.json", "the extension's manifest, whose version a release is")
	flag.Parse()
	p.run = os.Getenv("GITHUB_SERVER_URL") + "/" + os.Getenv("GITHUB_REPOSITORY") + "/actions/runs/" + os.Getenv("GITHUB_RUN_ID")
	p.sh = shell
	url, err := p.open()
	if err != nil {
		fmt.Fprintln(os.Stderr, "spinpropose:", err)
		os.Exit(1)
	}
	fmt.Println(url)
}

// proposal is one release's pull request: the release, the app, the run that checked it, where
// package:spin put the CLIs, the manifest, and the commands it runs - a test gives its own.
type proposal struct {
	release, app, run, spin, pkg string
	sh                           func(name string, args ...string) (string, error)
}

// shell is a command's standard output, trimmed; what it said on standard error is in the error.
func shell(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output() //nolint:gosec // this command's own git and gh, with the release in their arguments
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return "", fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(exit.Stderr)))
	}
	return strings.TrimSpace(string(out)), err
}

// open commits and pushes the bump, and opens the pull request or rewrites the one open; its
// answer is the pull request's URL.
func (p proposal) open() (string, error) {
	if p.release == "" || p.app == "" {
		return "", errors.New("-release and -app are required")
	}
	// The platforms package:all made a VSIX of are the ones the release has a CLI for.
	dirs, err := os.ReadDir(p.spin)
	if err != nil {
		return "", fmt.Errorf("no CLIs to name: %w", err)
	}
	var targets []string
	for _, d := range dirs {
		if d.IsDir() {
			targets = append(targets, d.Name())
		}
	}
	if len(targets) == 0 {
		return "", fmt.Errorf("%s holds no CLI: package:all makes them", p.spin)
	}

	// Committed as the app: the bot's noreply address needs its user id.
	if _, err := p.sh("gh", "auth", "setup-git"); err != nil {
		return "", err
	}
	out, err := p.sh("gh", "api", "/users/"+p.app+"[bot]")
	if err != nil {
		return "", err
	}
	var user struct {
		ID int `json:"id"`
	}
	if err := json.Unmarshal([]byte(out), &user); err != nil || user.ID == 0 {
		return "", fmt.Errorf("gh api /users/%s[bot]: no id in %q", p.app, out)
	}
	version, err := p.version()
	if err != nil {
		return "", err
	}
	title := "versions: spin " + p.release
	// The app's identity on this one commit, never in the checkout's config: written there, every
	// commit made from the checkout after it is the app's too.
	as := []string{"-c", "user.name=" + p.app + "[bot]", "-c", fmt.Sprintf("user.email=%d+%s[bot]@users.noreply.github.com", user.ID, p.app)}
	for _, args := range [][]string{
		{"checkout", "-q", "-B", branch},
		append(as, "commit", "-q", "-m", title, "-m", "The release whose CLI every VSIX carries, checked by " + p.run + ".", "versions.yaml", p.pkg),
		{"push", "-q", "--force", "origin", branch},
	} {
		if _, err := p.sh("git", args...); err != nil {
			return "", err
		}
	}

	// Only the app's own: anyone may open a pull request from a fork's branch of the same name.
	out, err = p.sh("gh", "pr", "list", "--head", branch, "--author", "app/"+p.app, "--state", "open", "--json", "number,url")
	if err != nil {
		return "", err
	}
	var prs []struct {
		Number int    `json:"number"`
		URL    string `json:"url"`
	}
	if err := json.Unmarshal([]byte(out), &prs); err != nil {
		return "", fmt.Errorf("gh pr list: %w", err)
	}
	tag, err := release.Tag(version)
	if err != nil {
		return "", err
	}
	b := body(p.release, p.run, version, tag, targets)
	if len(prs) == 0 {
		return p.sh("gh", "pr", "create", "--head", branch, "--base", "main", "--title", title, "--body", b)
	}
	// The branch was just rewritten: its title and body say what it holds now.
	if _, err := p.sh("gh", "pr", "edit", strconv.Itoa(prs[0].Number), "--title", title, "--body", b); err != nil {
		return "", err
	}
	return prs[0].URL, nil
}

// version is the extension's version the pull request releases: package.json's when no tag has
// it yet, as when a person set one by hand, or else the patch after it, written to package.json.
func (p proposal) version() (string, error) {
	m, err := release.Read(p.pkg)
	if err != nil {
		return "", err
	}
	tag, err := release.Tag(m.Version())
	if err != nil {
		return "", fmt.Errorf("%s: %w", p.pkg, err)
	}
	tagged, err := p.sh("git", "ls-remote", "--tags", "origin", "refs/tags/"+tag)
	if err != nil || tagged == "" {
		return m.Version(), err
	}
	next, err := release.NextPatch(m.Version())
	if err != nil {
		return "", err
	}
	return next, m.SetVersion(next)
}

// body is the pull request's: the release, what the run checked, and what is left to a person.
func body(release, run, version, tag string, targets []string) string {
	return "Moves versions.yaml's spin to [spin " + release + "](https://github.com/spin-stack/spin/releases/tag/" + release + "): " +
		"the release whose CLI every VSIX carries, which speaks only to an installation of that same release.\n\n" +
		"Checked by [the run that proposed it](" + run + "):\n\n" +
		"- `task ci`: the gate, the install through Socket Firewall, lint, typecheck, the unit tests and the package.\n" +
		"- `task package:all`: the CLI of " + release + " for every platform it has one for (" + strings.Join(targets, ", ") + "), " +
		"pulled from ghcr.io/spin-stack/spin-release and held by cosign to what spin's release workflow signed and attested of " +
		release + ", and a VSIX of each.\n\n" +
		"Left to whoever merges it, as versions.yaml's note says: the CLI's contract against `src/cli/contract.ts`, " +
		"and the extension tried against an installation of " + release + ".\n\n" +
		"Merging it releases the extension as " + version + ": `.github/workflows/tag.yml` tags main `" + tag + "`, " +
		"and that tag publishes it to the GitHub release, ghcr and the Marketplace.\n\n" +
		"spin-stack/shipset dispatches this for each spin release (`.github/workflows/bump-spin.yml`); " +
		"a newer one rewrites this branch and this pull request, commits added here included.\n"
}
