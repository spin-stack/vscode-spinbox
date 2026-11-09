package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fake answers gh and git as GitHub would, with open the app's open pull requests and tags the
// remote's tags, and records every command; fail names a command that fails.
type fake struct {
	open string
	tags []string
	fail string
	ran  []string
}

func (f *fake) sh(name string, args ...string) (string, error) {
	cmd := name + " " + strings.Join(args, " ")
	f.ran = append(f.ran, cmd)
	switch {
	case f.fail != "" && strings.HasPrefix(cmd, f.fail):
		return "", errors.New("refused")
	case strings.HasPrefix(cmd, "git ls-remote --tags origin "):
		ref := args[len(args)-1]
		for _, t := range f.tags {
			if "refs/tags/"+t == ref {
				return "1111111111111111111111111111111111111111\t" + ref, nil
			}
		}
		return "", nil
	case strings.HasPrefix(cmd, "gh api /users/"):
		return `{"id":42}`, nil
	case strings.HasPrefix(cmd, "gh pr list"):
		return f.open, nil
	case strings.HasPrefix(cmd, "gh pr create"):
		return "https://github.com/spin-stack/vscode-spinbox/pull/9", nil
	}
	return "", nil
}

// manifest is package.json at 0.0.3, with a dependency's version after the extension's own.
const manifest = `{
  "name": "spinbox",
  "version": "0.0.3",
  "devDependencies": {"x": {"version": "9.9.9"}}
}
`

// world is a run that bumped to v20261106.01 and packaged two platforms, with main's package.json
// at 0.0.3.
func world(t *testing.T, f *fake) proposal {
	t.Helper()
	dir := t.TempDir()
	pkg := filepath.Join(t.TempDir(), "package.json")
	if err := os.WriteFile(pkg, []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"linux-x64", "darwin-arm64"} {
		if err := os.MkdirAll(filepath.Join(dir, target), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return proposal{release: "v20261106.01", app: "spin-stack-release", run: "https://github.com/spin-stack/vscode-spinbox/actions/runs/7", spin: dir, pkg: pkg, sh: f.sh}
}

func ran(f *fake, prefix string) string {
	for _, c := range f.ran {
		if strings.HasPrefix(c, prefix) {
			return c
		}
	}
	return ""
}

// With none of the app's open, the pull request is opened from spin/next, committed as the app,
// and says the release, the run, and every platform packaged.
func TestABumpIsOpenedAsTheAppOnTheOneBranch(t *testing.T) {
	f := &fake{open: "[]"}
	p := world(t, f)
	url, err := p.open()
	if err != nil || url != "https://github.com/spin-stack/vscode-spinbox/pull/9" {
		t.Fatalf("%q, %v", url, err)
	}
	if c := ran(f, "git config user.email"); c != "git config user.email 42+spin-stack-release[bot]@users.noreply.github.com" {
		t.Errorf("committed as %q", c)
	}
	if c := ran(f, "git commit"); !strings.HasSuffix(c, " versions.yaml "+p.pkg) {
		t.Errorf("committed %q, not versions.yaml and package.json", c)
	}
	if ran(f, "git push -q --force origin spin/next") == "" || ran(f, "gh pr edit") != "" {
		t.Errorf("ran %q", f.ran)
	}
	if c := ran(f, "gh pr list"); !strings.Contains(c, "--author app/spin-stack-release") {
		t.Errorf("listed %q, not the app's alone", c)
	}
	c := ran(f, "gh pr create")
	for _, want := range []string{"--head spin/next", "--title versions: spin v20261106.01", "actions/runs/7", "(darwin-arm64, linux-x64)", "releases/tag/v20261106.01"} {
		if !strings.Contains(c, want) {
			t.Errorf("the pull request lacks %q: %s", want, c)
		}
	}
}

// One of the app's open already is rewritten: its title and body say the release it holds now.
func TestAnOpenOneIsRewritten(t *testing.T) {
	f := &fake{open: `[{"number":5,"url":"https://github.com/spin-stack/vscode-spinbox/pull/5"}]`}
	url, err := world(t, f).open()
	if err != nil || url != "https://github.com/spin-stack/vscode-spinbox/pull/5" {
		t.Fatalf("%q, %v", url, err)
	}
	if c := ran(f, "gh pr edit"); !strings.HasPrefix(c, "gh pr edit 5 --title versions: spin v20261106.01 --body ") || ran(f, "gh pr create") != "" {
		t.Errorf("ran %q", f.ran)
	}
}

// A command that fails stops it before anything after it, and no CLI packaged stops it before
// anything is pushed.
func TestAStepThatFailsStopsIt(t *testing.T) {
	f := &fake{open: "[]", fail: "git push"}
	if _, err := world(t, f).open(); err == nil || ran(f, "gh pr") != "" {
		t.Errorf("%v, ran %q", err, f.ran)
	}
	f = &fake{open: "[]"}
	p := world(t, f)
	p.spin = t.TempDir()
	if _, err := p.open(); err == nil || len(f.ran) != 0 {
		t.Errorf("%v, ran %q", err, f.ran)
	}
}

// main's version already tagged moves to the next patch, in package.json and in what the pull
// request says merging it releases; the dependency's version stays.
func TestATaggedVersionMovesToTheNextPatch(t *testing.T) {
	f := &fake{open: "[]", tags: []string{"v0.0.2", "v0.0.3"}}
	p := world(t, f)
	if _, err := p.open(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(p.pkg)
	if err != nil {
		t.Fatal(err)
	}
	if want := strings.Replace(manifest, `"0.0.3"`, `"0.0.4"`, 1); string(got) != want {
		t.Errorf("package.json:\n%s\nwant:\n%s", got, want)
	}
	if c := ran(f, "gh pr create"); !strings.Contains(c, "releases the extension as 0.0.4") || !strings.Contains(c, "`v0.0.4`") {
		t.Errorf("the pull request does not say 0.0.4: %s", c)
	}
}

// A version no tag has yet, as one a person set, is the one released, and package.json is left.
func TestAnUntaggedVersionIsKept(t *testing.T) {
	f := &fake{open: "[]", tags: []string{"v0.0.2"}}
	p := world(t, f)
	if _, err := p.open(); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p.pkg); string(got) != manifest {
		t.Errorf("package.json changed:\n%s", got)
	}
	if c := ran(f, "gh pr create"); !strings.Contains(c, "releases the extension as 0.0.3") {
		t.Errorf("the pull request does not say 0.0.3: %s", c)
	}
}

// A pre-release's version is tagged with -pre, so that is the tag that moves it on.
func TestAPreReleaseMovesOnFromItsTag(t *testing.T) {
	f := &fake{open: "[]", tags: []string{"v0.1.0-pre"}}
	p := world(t, f)
	if err := os.WriteFile(p.pkg, []byte(strings.Replace(manifest, "0.0.3", "0.1.0", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := p.open(); err != nil {
		t.Fatal(err)
	}
	if c := ran(f, "gh pr create"); !strings.Contains(c, "releases the extension as 0.1.1") || !strings.Contains(c, "`v0.1.1-pre`") {
		t.Errorf("the pull request does not say v0.1.1-pre: %s", c)
	}
}
