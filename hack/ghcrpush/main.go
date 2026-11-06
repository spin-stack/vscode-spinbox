// Command ghcrpush pushes the release task publish:github laid out under -release to the public
// package spin's `spin vscode install` reads, as one OCI artifact of oras, the way spin's release
// pushes its own files to ghcr.io/spin-stack/spin-release:
//
//	go run ./hack/ghcrpush -release build/release -tag v0.3.0 -package ghcr.io/spin-stack/vscode-spinbox-release -source https://github.com/spin-stack/vscode-spinbox
//
// The package exists because this repository is private: its GitHub releases answer 404 to anyone
// without a token, and a public package does not. It is transport and nothing more - the artifact
// holds every VSIX, spin-release.txt, SHA256SUMS and SHA256SUMS.sigstore.json exactly as the
// release has them, and the CLI holds a VSIX to SHA256SUMS and SHA256SUMS to the signature of
// publish.yml at the tag, as it would from the release.
//
// The artifact is tagged twice: with the extension's tag, and with spin-<release>, the spin
// release its VSIXs carry, which is the one tag the CLI asks for - it wants the extension that
// carries its own release, never the newest. A pre-release is tagged spin-<release>-pre instead,
// so a pre-release never takes the tag a release holds: the CLI asks for spin-<release> first.
// The extension's tag is also the manifest's org.opencontainers.image.version, since the CLI needs
// it to know which tag's workflow must have signed, and a tag cannot name another tag.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// The names spin's internal/vsix reads, and the artifact type that tells this package's
// artifacts apart from spin's own (application/vnd.spin-stack.release.file).
const (
	releaseFile   = "spin-release.txt"
	sumsFile      = "SHA256SUMS"
	signatureFile = "SHA256SUMS.sigstore.json"
	artifactType  = "application/vnd.spin-stack.vscode-spinbox.release"
)

// ociTag is the distribution spec's grammar for a tag: a tag outside it is refused by the
// registry only after the login, so it is refused here before anything is asked of it.
var ociTag = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$`)

// oras runs oras with args in dir, and fails when it does.
type oras func(ctx context.Context, dir string, args ...string) error

type config struct {
	release, tag, pkg, source string
	oras                      oras
}

func main() {
	var c config
	flag.StringVar(&c.release, "release", "build/release", "what task publish:github laid out and signed")
	flag.StringVar(&c.tag, "tag", "", "the extension's tag, v and package.json's version")
	flag.StringVar(&c.pkg, "package", "", "the package, ghcr.io/<owner>/<name>")
	flag.StringVar(&c.source, "source", "", "the repository, as org.opencontainers.image.source")
	orasCmd := flag.String("oras", "oras", "the command that runs oras")
	flag.Parse()
	c.oras = command(strings.Fields(*orasCmd))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	err := run(ctx, c)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "ghcrpush:", err)
		os.Exit(1)
	}
}

func command(argv []string) oras {
	return func(ctx context.Context, dir string, args ...string) error {
		if len(argv) == 0 {
			return errors.New("no oras command")
		}
		cmd := exec.CommandContext(ctx, argv[0], append(argv[1:], args...)...) //nolint:gosec // the command the Taskfile names
		cmd.Dir, cmd.Stdout, cmd.Stderr = dir, os.Stderr, os.Stderr
		return cmd.Run()
	}
}

func run(ctx context.Context, c config) error {
	if c.tag == "" || c.pkg == "" || c.source == "" {
		return errors.New("-tag, -package and -source are needed")
	}
	carried, err := os.ReadFile(filepath.Join(c.release, releaseFile)) //nolint:gosec // the release this run laid out
	if err != nil {
		return fmt.Errorf("%s: task publish:github lays it out: %w", releaseFile, err)
	}
	files, err := releaseFiles(c.release)
	if err != nil {
		return err
	}
	tags := tagsOf(c.tag, strings.TrimSpace(string(carried)))
	for _, t := range tags {
		if !ociTag.MatchString(t) {
			return fmt.Errorf("%q is not a tag a registry takes", t)
		}
	}
	// Run in the release's directory with its files by name: oras names each layer by the path it
	// was given (org.opencontainers.image.title), and the CLI looks layers up by file name.
	args := []string{"push", "--no-tty", c.pkg + ":" + strings.Join(tags, ","),
		"--artifact-type", artifactType,
		"--annotation", "org.opencontainers.image.source=" + c.source,
		"--annotation", "org.opencontainers.image.version=" + c.tag}
	if err := c.oras(ctx, c.release, append(args, files...)...); err != nil {
		return fmt.Errorf("oras push: %w", err)
	}
	fmt.Fprintf(os.Stderr, "ghcrpush: %s is %s:%s\n", c.tag, c.pkg, strings.Join(tags, ","))
	return nil
}

// tagsOf is the extension's tag and the tag the CLI of carried asks for. -pre in the tag is a
// pre-release, as the Taskfile's PRE_RELEASE reads it.
func tagsOf(tag, carried string) []string {
	spin := "spin-" + carried
	if strings.Contains(tag, "-pre") {
		spin += "-pre"
	}
	return []string{tag, spin}
}

// releaseFiles is every file of the release by name, once it holds what the CLI demands of it: a
// release missing its signature is one every CLI refuses, so it is not pushed for them to refuse.
func releaseFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []string
	vsix := false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		files = append(files, e.Name())
		vsix = vsix || strings.HasPrefix(e.Name(), "spinbox-") && strings.HasSuffix(e.Name(), ".vsix")
	}
	for _, need := range []string{releaseFile, sumsFile, signatureFile} {
		if !slices.Contains(files, need) {
			return nil, fmt.Errorf("%s has no %s: task publish:github makes and signs it first", dir, need)
		}
	}
	if !vsix {
		return nil, fmt.Errorf("%s has no spinbox-*.vsix", dir)
	}
	return files, nil
}
