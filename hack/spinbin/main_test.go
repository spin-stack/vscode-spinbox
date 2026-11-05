package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const version = "v20261105.01"

// release is a package as the registry serves it: each platform's CLI and its bundles.
type release map[string]files

type files struct {
	bin, sig, prov []byte
	// served stands in for the CLI's bytes on the wire, where the registry alters them.
	served []byte
}

func provenanceOf(v, repo, path, ref string) []byte {
	statement, _ := json.Marshal(map[string]any{"predicate": map[string]any{"buildDefinition": map[string]any{
		"externalParameters": map[string]any{
			"version":  v,
			"workflow": map[string]string{"repository": repo, "path": path, "ref": ref},
		},
	}}})
	b, _ := json.Marshal(map[string]any{"dsseEnvelope": map[string]string{"payload": base64.StdEncoding.EncodeToString(statement)}})
	return b
}

func good(bin string) files {
	return files{bin: []byte(bin), sig: []byte("sig"), prov: provenanceOf(version, repository, workflow, ref)}
}

func digest(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}

func serve(t *testing.T, r release) *httptest.Server {
	t.Helper()
	blobs := map[string][]byte{}
	mux := http.NewServeMux()
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = fmt.Fprint(w, `{"token":"t"}`)
	})
	mux.HandleFunc("/v2/"+pkg+"/manifests/{tag}", func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Authorization") != "Bearer t" {
			http.Error(w, "no token", http.StatusUnauthorized)
			return
		}
		name, _ := strings.CutPrefix(req.PathValue("tag"), version+"-")
		f, ok := r[name]
		if !ok {
			http.NotFound(w, req)
			return
		}
		var layers []map[string]any
		for title, b := range map[string][]byte{name: f.bin, name + ".sigstore.json": f.sig, name + ".provenance.sigstore.json": f.prov} {
			served := b
			if title == name && f.served != nil {
				served = f.served
			}
			blobs[digest(b)] = served
			layers = append(layers, map[string]any{"digest": digest(b), "annotations": map[string]string{"org.opencontainers.image.title": title}})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"layers": layers})
	})
	mux.HandleFunc("/v2/"+pkg+"/blobs/{digest}", func(w http.ResponseWriter, req *http.Request) {
		b, ok := blobs[req.PathValue("digest")]
		if !ok {
			http.NotFound(w, req)
			return
		}
		_, _ = w.Write(b)
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

// cosignThat is a cosign that holds a file to the release workflow's identity, as the real one
// does, and refuses what refuse names: a subcommand.
func cosignThat(refuse string) cosign {
	return func(_ context.Context, args ...string) error {
		who := []string{"--certificate-identity", identity, "--certificate-oidc-issuer", issuer}
		if !slices.Equal(args[len(args)-len(who):], who) {
			return fmt.Errorf("cosign: identity %v", args)
		}
		if args[0] == refuse {
			return errors.New("cosign: none of the expected identities matched")
		}
		return nil
	}
}

func TestOnlyACheckedCLIOfTheReleaseIsPutUnderItsTarget(t *testing.T) {
	both := platforms[:3:3] // linux-amd64, linux-arm64, darwin-arm64
	cases := []struct {
		name    string
		release release
		refuse  string
		want    map[string]string // target -> the CLI's bytes; absent targets have no file
		err     string
		said    string
	}{
		{
			name:    "every CLI the release has is checked and placed",
			release: release{"spin-linux-amd64": good("linux"), "spin-darwin-arm64": good("darwin")},
			want:    map[string]string{"linux-x64": "linux", "darwin-arm64": "darwin"},
			said:    "has no spin-linux-arm64, so there is no linux-arm64 VSIX",
		},
		{
			name:    "a CLI whose signature cosign refuses is not placed",
			release: release{"spin-linux-amd64": good("linux")},
			refuse:  "verify-blob",
			err:     "refused its signature",
		},
		{
			name:    "a CLI whose provenance cosign refuses is not placed",
			release: release{"spin-linux-amd64": good("linux")},
			refuse:  "verify-blob-attestation",
			err:     "refused its provenance",
		},
		{
			name: "a CLI another release built is not placed",
			release: release{"spin-linux-amd64": {
				bin: []byte("linux"), sig: []byte("sig"), prov: provenanceOf("v20261001.01", repository, workflow, ref),
			}},
			err: `of "v20261001.01", not of ` + version,
		},
		{
			name: "a CLI another workflow built is not placed",
			release: release{"spin-linux-amd64": {
				bin: []byte("linux"), sig: []byte("sig"), prov: provenanceOf(version, repository, ".github/workflows/ci.yml", ref),
			}},
			err: "not by " + repository,
		},
		{
			name: "a CLI the registry alters is not placed",
			release: release{"spin-linux-amd64": {
				bin: []byte("linux"), served: []byte("linuX"), sig: []byte("sig"), prov: provenanceOf(version, repository, workflow, ref),
			}},
			err: "the registry answered",
		},
		{
			name:    "a release with no CLI for any platform fails",
			release: release{},
			err:     "a CLI for none",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := t.TempDir()
			var log bytes.Buffer
			err := run(t.Context(), config{
				version: version, out: out, registry: serve(t, tc.release).URL,
				platforms: both, cosign: cosignThat(tc.refuse), log: &log,
			})
			if tc.err == "" && err != nil {
				t.Fatalf("run: %v", err)
			}
			if tc.err != "" && (err == nil || !strings.Contains(err.Error(), tc.err)) {
				t.Fatalf("run = %v, want an error saying %q", err, tc.err)
			}
			if !strings.Contains(log.String(), tc.said) {
				t.Errorf("said %q, want %q in it", log.String(), tc.said)
			}
			for _, p := range both {
				path := filepath.Join(out, p.target, "spin")
				got, err := os.ReadFile(path)
				want, ok := tc.want[p.target]
				switch {
				case !ok && err == nil:
					t.Errorf("%s holds %q, want nothing", path, got)
				case ok && err != nil:
					t.Errorf("%s: %v, want %q", path, err, want)
				case ok && string(got) != want:
					t.Errorf("%s holds %q, want %q", path, got, want)
				}
				if fi, err := os.Stat(path); ok && err == nil && fi.Mode().Perm()&0o111 == 0 {
					t.Errorf("%s is %v, want it executable", path, fi.Mode())
				}
				versionFile := filepath.Join(out, p.target, "VERSION")
				v, err := os.ReadFile(versionFile)
				switch {
				case !ok && err == nil:
					t.Errorf("%s holds %q, want nothing", versionFile, v)
				case ok && string(v) != version+"\n":
					t.Errorf("%s holds %q (%v), want %q", versionFile, v, err, version+"\n")
				}
			}
			if left, _ := filepath.Glob(filepath.Join(out, ".pull-*")); len(left) != 0 {
				t.Errorf("left %v behind", left)
			}
		})
	}
}
