package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

const pkg = "ghcr.io/spin-stack/vscode-spinbox-release"

// aRelease is what task publish:github leaves under build/release, but the files named in
// without, and carrying the spin release carries.
func aRelease(t *testing.T, carries string, without ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{releaseFile, sumsFile, signatureFile, "spinbox-linux-x64.vsix", "spinbox-darwin-arm64.vsix"} {
		if slices.Contains(without, name) {
			continue
		}
		body := "the " + name
		if name == releaseFile {
			body = carries + "\n"
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// pushed is one oras run, as the stand-in for oras saw it.
type pushed struct {
	dir  string
	args []string
}

// The artifact is pushed as every file of the release by name, from the release's directory, under
// the extension's tag and the tag the CLI carried asks for - spin-<release> for a release and
// spin-<release>-pre for a pre-release - with the extension's tag as its version; a release that
// is not whole, or a tag no registry takes, pushes nothing.
func TestTheReleaseIsPushedUnderTheTagTheCLIOfItsSpinReleaseAsksFor(t *testing.T) {
	for _, tc := range []struct {
		name, tag, carries string
		without            []string
		wantRef            string
	}{
		{name: "a release", tag: "v0.4.0", carries: "v20261106.01", wantRef: pkg + ":v0.4.0,spin-v20261106.01"},
		{name: "a pre-release", tag: "v0.3.0-pre", carries: "v20261106.01", wantRef: pkg + ":v0.3.0-pre,spin-v20261106.01-pre"},
		{name: "no signature", tag: "v0.4.0", carries: "v20261106.01", without: []string{signatureFile}},
		{name: "no SHA256SUMS", tag: "v0.4.0", carries: "v20261106.01", without: []string{sumsFile}},
		{name: "no spin-release.txt", tag: "v0.4.0", carries: "v20261106.01", without: []string{releaseFile}},
		{name: "no VSIX", tag: "v0.4.0", carries: "v20261106.01", without: []string{"spinbox-linux-x64.vsix", "spinbox-darwin-arm64.vsix"}},
		{name: "a spin release no tag can hold", tag: "v0.4.0", carries: "v2026 1106"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := aRelease(t, tc.carries, tc.without...)
			var runs []pushed
			err := run(t.Context(), config{release: dir, tag: tc.tag, pkg: pkg, source: "https://github.com/spin-stack/vscode-spinbox",
				oras: func(_ context.Context, dir string, args ...string) error {
					runs = append(runs, pushed{dir, args})
					return nil
				}})
			if tc.wantRef == "" {
				if err == nil || len(runs) != 0 {
					t.Fatalf("pushed what the CLI would refuse or no registry takes: err %v, runs %q", err, runs)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if len(runs) != 1 {
				t.Fatalf("oras ran %d times, not once", len(runs))
			}
			flags := []string{"push", "--no-tty", tc.wantRef,
				"--artifact-type", artifactType,
				"--annotation", "org.opencontainers.image.source=https://github.com/spin-stack/vscode-spinbox",
				"--annotation", "org.opencontainers.image.version=" + tc.tag}
			want := append(slices.Clone(flags), releaseFile, sumsFile, signatureFile, "spinbox-darwin-arm64.vsix", "spinbox-linux-x64.vsix")
			got := slices.Clone(runs[0].args)
			// The files in any order: oras pushes a layer per file, and the CLI finds each by name.
			slices.Sort(want[len(flags):])
			slices.Sort(got[min(len(flags), len(got)):])
			if !slices.Equal(got, want) {
				t.Fatalf("oras %q\nwant %q", got, want)
			}
			if runs[0].dir != dir {
				t.Fatalf("oras ran in %s, not the release's directory, so its layers are not named by file", runs[0].dir)
			}
		})
	}
}

// An oras that fails fails the command: a release the package lacks is a CLI that cannot install
// it, and the run says so rather than passing.
func TestAFailedPushFailsTheCommand(t *testing.T) {
	err := run(t.Context(), config{release: aRelease(t, "v20261106.01"), tag: "v0.4.0", pkg: pkg, source: "s",
		oras: func(context.Context, string, ...string) error { return os.ErrPermission }})
	if err == nil {
		t.Fatal("a push oras failed passed")
	}
}
