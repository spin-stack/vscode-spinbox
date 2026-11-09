package release

import (
	"os"
	"path/filepath"
	"testing"
)

// An odd minor's tag is a pre-release's, and only major.minor.patch has a tag or a next patch.
func TestTagAndNextPatch(t *testing.T) {
	for in, want := range map[string]string{"0.0.3": "v0.0.3", "0.1.0": "v0.1.0-pre", "1.2.9": "v1.2.9", "0.11.4": "v0.11.4-pre"} {
		if got, err := Tag(in); err != nil || got != want {
			t.Errorf("Tag(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"1.2", "1.2.x", "1.2.3-pre", "v1.2.3"} {
		if got, err := Tag(in); err == nil {
			t.Errorf("Tag(%q) = %q, want an error", in, got)
		}
		if got, err := NextPatch(in); err == nil {
			t.Errorf("NextPatch(%q) = %q, want an error", in, got)
		}
	}
	if got, err := NextPatch("1.2.9"); err != nil || got != "1.2.10" {
		t.Errorf("NextPatch(1.2.9) = %q, %v", got, err)
	}
}

// The manifest's own version is read and written, and a dependency's after it is left.
func TestManifestVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "package.json")
	const before = "{\n  \"version\": \"0.0.3\",\n  \"x\": {\"version\": \"9.9.9\"}\n}\n"
	if err := os.WriteFile(path, []byte(before), 0o644); err != nil {
		t.Fatal(err)
	}
	m, err := Read(path)
	if err != nil || m.Version() != "0.0.3" {
		t.Fatalf("%v, %v", m, err)
	}
	if err := m.SetVersion("0.0.4"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != "{\n  \"version\": \"0.0.4\",\n  \"x\": {\"version\": \"9.9.9\"}\n}\n" {
		t.Errorf("package.json:\n%s", got)
	}
}
