package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func hexOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// The release holds every VSIX and spin-release.txt naming the one release their CLIs are, and
// SHA256SUMS lists each of them as written; VSIXs carrying two releases, or none, make nothing.
func TestTheReleaseNamesTheOneSpinReleaseItsVSIXsCarry(t *testing.T) {
	for _, tc := range []struct {
		name     string
		versions map[string]string
		wantErr  bool
	}{
		{name: "one release", versions: map[string]string{"linux-x64": "v20261105.01\n", "darwin-arm64": "v20261105.01\n"}},
		{name: "two releases", versions: map[string]string{"linux-x64": "v20261105.01\n", "darwin-arm64": "v20261101.01\n"}, wantErr: true},
		{name: "no CLI", versions: map[string]string{}, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			c := config{spin: filepath.Join(dir, "spin"), vsix: dir, out: filepath.Join(dir, "out"),
				notes: filepath.Join(dir, "notes.md"), tag: "v0.3.0", identity: "the identity"}
			for target, v := range tc.versions {
				write(t, filepath.Join(c.spin, target, "VERSION"), v)
				write(t, filepath.Join(dir, "spinbox-"+target+".vsix"), "the VSIX for "+target)
			}
			err := run(c)
			if tc.wantErr {
				if err == nil {
					t.Fatal("made a release of VSIXs that do not carry one spin release")
				}
				if _, serr := os.Stat(filepath.Join(c.out, sumsFile)); !os.IsNotExist(serr) {
					t.Fatal("a SHA256SUMS was written anyway")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(filepath.Join(c.out, releaseFile))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != "v20261105.01\n" {
				t.Fatalf("spin-release.txt is %q", got)
			}
			sums, err := os.ReadFile(filepath.Join(c.out, sumsFile))
			if err != nil {
				t.Fatal(err)
			}
			want := []string{hexOf("v20261105.01\n") + "  " + releaseFile}
			for target := range tc.versions {
				want = append(want, hexOf("the VSIX for "+target)+"  spinbox-"+target+".vsix")
				if _, err := os.Stat(filepath.Join(c.out, "spinbox-"+target+".vsix")); err != nil {
					t.Fatalf("the VSIX for %s is not in the release: %v", target, err)
				}
			}
			for _, line := range want {
				if !strings.Contains(string(sums), line+"\n") {
					t.Errorf("SHA256SUMS lacks %q:\n%s", line, sums)
				}
			}
			if lines := strings.Count(string(sums), "\n"); lines != len(want) {
				t.Errorf("SHA256SUMS lists %d files, not %d", lines, len(want))
			}
			n, err := os.ReadFile(c.notes)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(n), "spin `v20261105.01`") || !strings.Contains(string(n), "the identity") {
				t.Errorf("the notes do not say the release carried and the identity:\n%s", n)
			}
		})
	}
}
