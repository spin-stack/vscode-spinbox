// Command ghrelease lays out under -out what the tag's GitHub release holds, beside the VSIXs
// package:all made (spinbox-<target>.vsix in -vsix), and writes its notes to -notes:
//
//	go run ./hack/ghrelease -spin build/spin -vsix . -out build/release -notes build/release-notes.md -tag v0.3.0 -identity <cert identity>
//
// -out gets every VSIX, spin-release.txt - the one spin release they all carry, as package:spin
// wrote it beside each CLI (-spin/<target>/VERSION) - and SHA256SUMS of those, in sha256sum's
// format. `spin vscode install` finds the release by spin-release.txt and holds the VSIX to
// SHA256SUMS, which task publish:github signs next. VSIXs carrying two releases fail it: one of
// them would be installed by a CLI of the release spin-release.txt names, and not fit it.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// releaseFile and sumsFile are the names spin's internal/vsix reads.
const (
	releaseFile = "spin-release.txt"
	sumsFile    = "SHA256SUMS"
)

type config struct {
	spin, vsix, out, notes, tag, identity string
}

func main() {
	var c config
	flag.StringVar(&c.spin, "spin", "build/spin", "package:spin's output: <target>/VERSION per CLI")
	flag.StringVar(&c.vsix, "vsix", ".", "where package:all wrote spinbox-<target>.vsix")
	flag.StringVar(&c.out, "out", "build/release", "where the release's files are laid out")
	flag.StringVar(&c.notes, "notes", "build/release-notes.md", "where the release's notes are written")
	flag.StringVar(&c.tag, "tag", "", "the tag, v and package.json's version")
	flag.StringVar(&c.identity, "identity", "", "the certificate identity SHA256SUMS is signed under")
	flag.Parse()
	if err := run(c); err != nil {
		fmt.Fprintln(os.Stderr, "ghrelease:", err)
		os.Exit(1)
	}
}

func run(c config) error {
	if c.tag == "" || c.identity == "" {
		return errors.New("-tag and -identity are needed")
	}
	carried, err := carriedRelease(c.spin)
	if err != nil {
		return err
	}
	vsixes, err := filepath.Glob(filepath.Join(c.vsix, "spinbox-*.vsix"))
	if err != nil {
		return err
	}
	if len(vsixes) == 0 {
		return fmt.Errorf("no spinbox-*.vsix in %s: package:all makes them", c.vsix)
	}
	if err := os.RemoveAll(c.out); err != nil {
		return err
	}
	if err := os.MkdirAll(c.out, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(c.out, releaseFile), []byte(carried+"\n"), 0o644); err != nil {
		return err
	}
	names := []string{releaseFile}
	for _, v := range vsixes {
		if err := copyFile(v, filepath.Join(c.out, filepath.Base(v))); err != nil {
			return err
		}
		names = append(names, filepath.Base(v))
	}
	slices.Sort(names)
	var sums strings.Builder
	for _, n := range names {
		sum, err := sha256File(filepath.Join(c.out, n))
		if err != nil {
			return err
		}
		fmt.Fprintf(&sums, "%s  %s\n", sum, n)
	}
	if err := os.WriteFile(filepath.Join(c.out, sumsFile), []byte(sums.String()), 0o644); err != nil {
		return err
	}
	return os.WriteFile(c.notes, []byte(notes(c.tag, carried, c.identity)), 0o644)
}

// carriedRelease is the one release every CLI under dir is.
func carriedRelease(dir string) (string, error) {
	versions, err := filepath.Glob(filepath.Join(dir, "*", "VERSION"))
	if err != nil {
		return "", err
	}
	seen := map[string]bool{}
	for _, v := range versions {
		b, err := os.ReadFile(v)
		if err != nil {
			return "", err
		}
		seen[strings.TrimSpace(string(b))] = true
	}
	releases := slices.Sorted(func(yield func(string) bool) {
		for r := range seen {
			if !yield(r) {
				return
			}
		}
	})
	if len(releases) != 1 || releases[0] == "" {
		return "", fmt.Errorf("the VSIXs must carry one spin release, and %s holds %q", dir, releases)
	}
	return releases[0], nil
}

func notes(tag, carried, identity string) string {
	return fmt.Sprintf("Spinbox for VS Code `%[1]s`. Every VSIX here carries the spin CLI of spin `%[2]s` (`%[3]s`): "+
		"it reaches an installation that runs `%[2]s`.\n\n"+
		"With a spin CLI of that release, `spin vscode install` downloads the VSIX for its machine, checks it, and installs it. By hand:\n\n"+
		"```sh\n"+
		"sha256sum --check --ignore-missing %[4]s\n"+
		"cosign verify-blob --bundle %[4]s.sigstore.json \\\n"+
		"  --certificate-identity %[5]s \\\n"+
		"  --certificate-oidc-issuer https://token.actions.githubusercontent.com %[4]s\n"+
		"code --install-extension spinbox-<linux|darwin>-<x64|arm64>.vsix\n"+
		"```\n", tag, carried, releaseFile, sumsFile, identity)
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func copyFile(from, to string) error {
	b, err := os.ReadFile(from)
	if err != nil {
		return err
	}
	return os.WriteFile(to, b, 0o644)
}
