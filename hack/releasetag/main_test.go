package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// remote answers gh as GitHub would with tags the repository's tags, and records each call.
type remote struct {
	tags []string
	fail bool
	ran  []string
}

func (r *remote) gh(args ...string) (string, error) {
	cmd := strings.Join(args, " ")
	r.ran = append(r.ran, cmd)
	if r.fail {
		return "", errors.New("refused")
	}
	if strings.Contains(cmd, "/git/matching-refs/tags/") {
		for _, tag := range r.tags {
			if strings.Contains(cmd, `"refs/tags/`+tag+`"`) {
				return "refs/tags/" + tag, nil
			}
		}
	}
	return "", nil
}

func at(t *testing.T, version string, r *remote) tagger {
	t.Helper()
	pkg := filepath.Join(t.TempDir(), "package.json")
	if err := os.WriteFile(pkg, []byte(`{"version": "`+version+`"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return tagger{repo: "spin-stack/vscode-spinbox", sha: "abc", pkg: pkg, gh: r.gh}
}

// A version no tag has is tagged at the commit, -pre for an odd minor.
func TestAnUntaggedVersionIsTagged(t *testing.T) {
	for version, tag := range map[string]string{"0.0.4": "v0.0.4", "0.1.0": "v0.1.0-pre"} {
		r := &remote{tags: []string{"v0.0.3", "v0.0.40"}}
		if _, err := at(t, version, r).tag(); err != nil {
			t.Fatal(err)
		}
		if want := "api repos/spin-stack/vscode-spinbox/git/refs -f ref=refs/tags/" + tag + " -f sha=abc --silent"; r.ran[len(r.ran)-1] != want {
			t.Errorf("%s: ran %q", version, r.ran)
		}
	}
}

// A version tagged already makes no tag, and a version that is no release fails before GitHub is asked.
func TestNothingIsTaggedTwiceOrMisnamed(t *testing.T) {
	r := &remote{tags: []string{"v0.0.3"}}
	if said, err := at(t, "0.0.3", r).tag(); err != nil || len(r.ran) != 1 || !strings.Contains(said, "already") {
		t.Errorf("%q, %v, ran %q", said, err, r.ran)
	}
	r = &remote{}
	if _, err := at(t, "0.0.3-pre", r).tag(); err == nil || len(r.ran) != 0 {
		t.Errorf("%v, ran %q", err, r.ran)
	}
	r = &remote{fail: true}
	if _, err := at(t, "0.0.4", r).tag(); err == nil || len(r.ran) != 1 {
		t.Errorf("%v, ran %q", err, r.ran)
	}
}
