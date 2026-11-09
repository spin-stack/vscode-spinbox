// Command releasetag is the Tag workflow's one step (.github/workflows/tag.yml says what and
// why): the commit -sha tagged with the tag package.json's version is released as, when no tag
// has it yet, through the API as the app whose token GH_TOKEN is - a tag one made with the run's
// own token would start no workflow, and this one starts Publish:
//
//	GH_TOKEN=<the app's> go run ./hack/releasetag -repo spin-stack/vscode-spinbox -sha <commit>
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/spin-stack/vscode-spinbox/hack/release"
)

func main() {
	var t tagger
	flag.StringVar(&t.repo, "repo", os.Getenv("GITHUB_REPOSITORY"), "owner/name of the repository to tag")
	flag.StringVar(&t.sha, "sha", os.Getenv("GITHUB_SHA"), "the commit to tag")
	flag.StringVar(&t.pkg, "package", "package.json", "the extension's manifest, whose version a release is")
	flag.Parse()
	t.gh = gh
	said, err := t.tag()
	if err != nil {
		fmt.Fprintln(os.Stderr, "releasetag:", err)
		os.Exit(1)
	}
	fmt.Println(said)
}

// tagger tags one commit of one repository, asking GitHub through gh - a test gives its own.
type tagger struct {
	repo, sha, pkg string
	gh             func(args ...string) (string, error)
}

// gh is the gh command's standard output, trimmed; what it said on standard error is in the error.
func gh(args ...string) (string, error) {
	out, err := exec.Command("gh", args...).Output() //nolint:gosec // gh api, with the repository and the tag in its arguments
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return "", fmt.Errorf("gh %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(exit.Stderr)))
	}
	return strings.TrimSpace(string(out)), err
}

// tag makes the tag, unless one has the version already; its answer says which it was.
func (t tagger) tag() (string, error) {
	if t.repo == "" || t.sha == "" {
		return "", errors.New("-repo and -sha are required")
	}
	m, err := release.Read(t.pkg)
	if err != nil {
		return "", err
	}
	tag, err := release.Tag(m.Version())
	if err != nil {
		return "", fmt.Errorf("%s: %w", t.pkg, err)
	}
	// matching-refs is a prefix match: v0.0.3 would find v0.0.30 too.
	ref := "refs/tags/" + tag
	found, err := t.gh("api", "repos/"+t.repo+"/git/matching-refs/tags/"+tag, "--jq", `.[] | select(.ref == "`+ref+`") | .ref`)
	if err != nil {
		return "", err
	}
	if found != "" {
		return tag + " is tagged already: nothing to release", nil
	}
	if _, err := t.gh("api", "repos/"+t.repo+"/git/refs", "-f", "ref="+ref, "-f", "sha="+t.sha, "--silent"); err != nil {
		return "", err
	}
	return "tagged " + t.sha + " " + tag + ", which Publish releases", nil
}
