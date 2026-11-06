package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fake answers gh and git as GitHub would, with open the app's open pull requests, and records
// every command; fail names a command that fails.
type fake struct {
	open string
	fail string
	ran  []string
}

func (f *fake) sh(name string, args ...string) (string, error) {
	cmd := name + " " + strings.Join(args, " ")
	f.ran = append(f.ran, cmd)
	switch {
	case f.fail != "" && strings.HasPrefix(cmd, f.fail):
		return "", errors.New("refused")
	case strings.HasPrefix(cmd, "gh api /users/"):
		return `{"id":42}`, nil
	case strings.HasPrefix(cmd, "gh pr list"):
		return f.open, nil
	case strings.HasPrefix(cmd, "gh pr create"):
		return "https://github.com/spin-stack/vscode-spinbox/pull/9", nil
	}
	return "", nil
}

// world is a run that bumped to v20261106.01 and packaged two platforms.
func world(t *testing.T, f *fake) proposal {
	t.Helper()
	dir := t.TempDir()
	for _, target := range []string{"linux-x64", "darwin-arm64"} {
		if err := os.MkdirAll(filepath.Join(dir, target), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return proposal{release: "v20261106.01", app: "spin-stack-release", run: "https://github.com/spin-stack/vscode-spinbox/actions/runs/7", spin: dir, sh: f.sh}
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
	url, err := world(t, f).open()
	if err != nil || url != "https://github.com/spin-stack/vscode-spinbox/pull/9" {
		t.Fatalf("%q, %v", url, err)
	}
	if c := ran(f, "git config user.email"); c != "git config user.email 42+spin-stack-release[bot]@users.noreply.github.com" {
		t.Errorf("committed as %q", c)
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
