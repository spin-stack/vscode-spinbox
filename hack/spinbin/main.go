// Command spinbin puts the spin CLI a VSIX carries under -out, one directory per VS Code target
// (-out/linux-x64/spin), each checked before it is put there:
//
//	go run ./hack/spinbin -version v20261105.01 -out build/spin -cosign 'go run ...cosign@v3.1.4'
//
// The binaries come from spin's public package (ghcr.io/spin-stack/spin-release), where a release
// pushes each file beside its Sigstore bundles. The package is transport and nothing more: a file
// is the release's only when cosign says spin's release workflow at main signed it and attested
// SLSA provenance of it, and that provenance says this version - every release is signed by the
// same workflow at the same ref, so without the version an older release's CLI would pass. A
// file that fails is not left under -out, and the command fails. A target the release has no CLI
// for is skipped, and said.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
)

// Who signs a release: spin's internal/installation/release, the same coordinates spin update
// holds a CLI to. Exact, not a pattern: a pattern is another branch or workflow passing.
const (
	identity   = "https://github.com/spin-stack/spin/.github/workflows/release.yml@refs/heads/main"
	issuer     = "https://token.actions.githubusercontent.com"
	repository = "https://github.com/spin-stack/spin"
	workflow   = ".github/workflows/release.yml"
	ref        = "refs/heads/main"

	registry = "https://ghcr.io"
	pkg      = "spin-stack/spin-release"

	// Nothing a registry answers is read without a bound: a CLI is tens of megabytes, a bundle
	// tens of kilobytes.
	maxBinary = 512 << 20
	maxBundle = 1 << 20
)

// platform is a release's name for a machine and VS Code's for the same one.
type platform struct{ release, target string }

// platforms are every target the extension is published for. The release says which of them it
// has a CLI for.
var platforms = []platform{
	{"linux-amd64", "linux-x64"},
	{"linux-arm64", "linux-arm64"},
	{"darwin-arm64", "darwin-arm64"},
	{"darwin-amd64", "darwin-x64"},
}

// errAbsent is a release with no CLI for a platform.
var errAbsent = errors.New("not in the release")

// cosign runs cosign with args, and fails when it refuses.
type cosign func(ctx context.Context, args ...string) error

func main() {
	version := flag.String("version", "", "the spin release, v20261105.01")
	out := flag.String("out", "", "where each target's directory is made")
	cosignCmd := flag.String("cosign", "cosign", "the command that runs cosign")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	err := run(ctx, config{
		version: *version, out: *out, registry: registry, platforms: platforms,
		cosign: command(strings.Fields(*cosignCmd)), log: os.Stderr,
	})
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "spinbin:", err)
		os.Exit(1)
	}
}

func command(argv []string) cosign {
	return func(ctx context.Context, args ...string) error {
		if len(argv) == 0 {
			return errors.New("no cosign command")
		}
		cmd := exec.CommandContext(ctx, argv[0], append(argv[1:], args...)...) //nolint:gosec // the command the Taskfile names
		cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
		return cmd.Run()
	}
}

type config struct {
	version, out, registry string
	platforms              []platform
	cosign                 cosign
	log                    io.Writer
}

func run(ctx context.Context, c config) error {
	if c.version == "" || c.out == "" {
		return errors.New("-version and -out are both required")
	}
	if err := os.MkdirAll(c.out, 0o755); err != nil {
		return err
	}
	work, err := os.MkdirTemp(c.out, ".pull-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(work) }() // what was pulled, checked or not; the kept ones were renamed out
	r := &client{base: c.registry}
	if err := r.login(ctx); err != nil {
		return err
	}
	var got int
	for _, p := range c.platforms {
		err := one(ctx, c, r, p, work)
		if errors.Is(err, errAbsent) {
			fmt.Fprintf(c.log, "spinbin: %s has no spin-%s, so there is no %s VSIX\n", c.version, p.release, p.target)
			continue
		}
		if err != nil {
			return fmt.Errorf("spin-%s of %s: %w", p.release, c.version, err)
		}
		fmt.Fprintf(c.log, "spinbin: spin-%s of %s is checked, for %s\n", p.release, c.version, p.target)
		got++
	}
	if got == 0 {
		return fmt.Errorf("%s has a CLI for none of the extension's platforms", c.version)
	}
	return nil
}

// one pulls p's CLI and bundles into work, checks them, and only then moves the CLI to
// out/<target>/spin.
func one(ctx context.Context, c config, r *client, p platform, work string) error {
	name := "spin-" + p.release
	layers, err := r.manifest(ctx, c.version+"-"+name)
	if err != nil {
		return err
	}
	bin := filepath.Join(work, name)
	sig, prov := bin+".sigstore.json", bin+".provenance.sigstore.json"
	for file, limit := range map[string]int64{bin: maxBinary, sig: maxBundle, prov: maxBundle} {
		if err := r.blob(ctx, layers[filepath.Base(file)], limit, file); err != nil {
			return fmt.Errorf("%s: %w", filepath.Base(file), err)
		}
	}
	if err := check(ctx, c.cosign, c.version, bin, sig, prov); err != nil {
		return err
	}
	dir := filepath.Join(c.out, p.target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.Chmod(bin, 0o755); err != nil { //nolint:gosec // a program
		return err
	}
	return os.Rename(bin, filepath.Join(dir, "spin"))
}

// check is the whole of what makes bin this release's: the workflow's signature over its bytes,
// its SLSA provenance over the same digest, and that provenance naming this version.
func check(ctx context.Context, cosign cosign, version, bin, sig, prov string) error {
	who := []string{"--certificate-identity", identity, "--certificate-oidc-issuer", issuer}
	if err := cosign(ctx, append([]string{"verify-blob", bin, "--bundle", sig}, who...)...); err != nil {
		return fmt.Errorf("cosign refused its signature: %w", err)
	}
	digest, err := sum(bin)
	if err != nil {
		return err
	}
	args := []string{"verify-blob-attestation", "--type", "slsaprovenance1", "--digest", digest, "--digestAlg", "sha256", "--bundle", prov}
	if err := cosign(ctx, append(args, who...)...); err != nil {
		return fmt.Errorf("cosign refused its provenance: %w", err)
	}
	return provenance(prov, version)
}

// provenance is whether the attestation cosign just checked says the release workflow at main
// built version. cosign checked the envelope's signature; what it says is read here.
func provenance(path, version string) error {
	raw, err := os.ReadFile(path) //nolint:gosec // a file this command wrote
	if err != nil {
		return err
	}
	var b struct {
		DSSEEnvelope struct {
			Payload string `json:"payload"`
		} `json:"dsseEnvelope"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return fmt.Errorf("its provenance is not a bundle: %w", err)
	}
	payload, err := base64.StdEncoding.DecodeString(b.DSSEEnvelope.Payload)
	if err != nil {
		return fmt.Errorf("its provenance's payload: %w", err)
	}
	var s struct {
		Predicate struct {
			BuildDefinition struct {
				ExternalParameters struct {
					Version  string `json:"version"`
					Workflow struct {
						Repository string `json:"repository"`
						Path       string `json:"path"`
						Ref        string `json:"ref"`
					} `json:"workflow"`
				} `json:"externalParameters"`
			} `json:"buildDefinition"`
		} `json:"predicate"`
	}
	if err := json.Unmarshal(payload, &s); err != nil {
		return fmt.Errorf("its provenance's statement: %w", err)
	}
	e := s.Predicate.BuildDefinition.ExternalParameters
	switch {
	case e.Workflow.Repository != repository || e.Workflow.Path != workflow || e.Workflow.Ref != ref:
		return fmt.Errorf("built by %s/%s at %s, not by %s/%s at %s",
			e.Workflow.Repository, e.Workflow.Path, e.Workflow.Ref, repository, workflow, ref)
	case e.Version != version:
		return fmt.Errorf("its provenance says it is of %q, not of %s", e.Version, version)
	}
	return nil
}

func sum(path string) (string, error) {
	f, err := os.Open(path) //nolint:gosec // a file this command wrote
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }() // read only
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// client is an anonymous pull from an OCI registry, which is all a public package asks.
type client struct{ base, token string }

func (c *client) get(ctx context.Context, path, accept string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, http.NoBody)
	if err != nil {
		return nil, err
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	return http.DefaultClient.Do(req)
}

func (c *client) login(ctx context.Context) error {
	resp, err := c.get(ctx, "/token?scope="+url.QueryEscape("repository:"+pkg+":pull"), "")
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }() // read below
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("the registry's token: %s", resp.Status)
	}
	var answer struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBundle)).Decode(&answer); err != nil {
		return fmt.Errorf("the registry's token: %w", err)
	}
	c.token = answer.Token
	return nil
}

// manifest is the digest of each file of a tag, by name.
func (c *client) manifest(ctx context.Context, tag string) (map[string]string, error) {
	resp, err := c.get(ctx, "/v2/"+pkg+"/manifests/"+tag, "application/vnd.oci.image.manifest.v1+json")
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }() // read below
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, fmt.Errorf("%w: %s has no %s", errAbsent, pkg, tag)
	default:
		return nil, fmt.Errorf("%s of %s answered %s", tag, pkg, resp.Status)
	}
	var m struct {
		Layers []struct {
			Digest      string            `json:"digest"`
			Annotations map[string]string `json:"annotations"`
		} `json:"layers"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxBundle)).Decode(&m); err != nil {
		return nil, fmt.Errorf("the manifest of %s: %w", tag, err)
	}
	layers := make(map[string]string, len(m.Layers))
	for _, l := range m.Layers {
		layers[l.Annotations["org.opencontainers.image.title"]] = l.Digest
	}
	return layers, nil
}

// blob writes the blob digest names to path, and fails when its bytes are not that digest's: the
// registry is not trusted with them, but a truncated download is better said here than by cosign.
func (c *client) blob(ctx context.Context, digest string, limit int64, path string) error {
	want, ok := strings.CutPrefix(digest, "sha256:")
	if !ok {
		return fmt.Errorf("the package has no such file (digest %q)", digest)
	}
	resp, err := c.get(ctx, "/v2/"+pkg+"/blobs/"+digest, "")
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }() // read below
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", digest, resp.Status)
	}
	f, err := os.Create(path) //nolint:gosec // under the command's own work directory
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, limit))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("the registry answered %s for %s", got, digest)
	}
	return nil
}
