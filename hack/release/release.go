// Package release is what a version of the extension is released as: the tag that publishes it,
// and the version after it. hack/spinpropose moves package.json past a tagged version, and
// hack/releasetag tags one no tag has yet; both name the tag here, so they agree on it.
package release

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
)

// versionField is package.json's own version, the first one in it: dependencies carry none.
var versionField = regexp.MustCompile(`"version":\s*"([^"]+)"`)

// semver is major.minor.patch, the one shape the Marketplace takes.
var semver = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)$`)

// Manifest is package.json as read: its bytes, and where its version is in them.
type Manifest struct {
	path       string
	b          []byte
	start, end int
}

// Read reads the manifest at path.
func Read(path string) (*Manifest, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	m := versionField.FindSubmatchIndex(b)
	if m == nil {
		return nil, fmt.Errorf("%s has no version", path)
	}
	return &Manifest{path: path, b: b, start: m[2], end: m[3]}, nil
}

// Version is the manifest's version.
func (m *Manifest) Version() string { return string(m.b[m.start:m.end]) }

// SetVersion writes version over the manifest's, and nothing else of it.
func (m *Manifest) SetVersion(version string) error {
	out := append(append(append([]byte{}, m.b[:m.start]...), version...), m.b[m.end:]...)
	return os.WriteFile(m.path, out, 0o644) //nolint:gosec // package.json, as git checked it out
}

// Tag is the tag that publishes version: v and the version, with -pre after it for an odd minor,
// the Marketplace's convention for a pre-release.
func Tag(version string) (string, error) {
	m := semver.FindStringSubmatch(version)
	if m == nil {
		return "", fmt.Errorf("version %q is not major.minor.patch", version)
	}
	if minor, _ := strconv.Atoi(m[2]); minor%2 == 1 {
		return "v" + version + "-pre", nil
	}
	return "v" + version, nil
}

// NextPatch is a version Tag took, with its patch one more.
func NextPatch(version string) (string, error) {
	m := semver.FindStringSubmatch(version)
	if m == nil {
		return "", fmt.Errorf("version %q is not major.minor.patch", version)
	}
	patch, _ := strconv.Atoi(m[3])
	return m[1] + "." + m[2] + "." + strconv.Itoa(patch+1), nil
}
