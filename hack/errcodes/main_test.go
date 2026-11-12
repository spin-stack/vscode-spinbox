package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// spinSrc is errcode.go as spin writes it: the codes, then errorActions.
const spinSrc = `package cmd

type errorCode string

const (
	codeNotSignedIn errorCode = "not_signed_in"
	// The key this machine logs in with is none the control plane certifies.
	codeKeyNotEnrolled errorCode = "key_not_enrolled"
	codeInternal       errorCode = "internal"
)

const muxPersist = "10m"

var errorActions = map[errorCode]string{
	codeNotSignedIn:    "login",
	codeKeyNotEnrolled: "add_key",
	codeInternal:       "details",
}
`

const contractSrc = `export type Action = "login" | "add_key" | "details"

export const ACTION_OF = {
  not_signed_in: "login",
  key_not_enrolled: "add_key",
  internal: "details",
} as const satisfies Record<ErrorCode, Action>
`

func TestSpinActions(t *testing.T) {
	got, err := spinActions([]byte(spinSrc))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"not_signed_in": "login", "key_not_enrolled": "add_key", "internal": "details"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: got %q, want %q", k, got[k], v)
		}
	}
}

func TestContractActions(t *testing.T) {
	got, err := contractActions(contractSrc)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got["key_not_enrolled"] != "add_key" {
		t.Fatalf("got %v", got)
	}
}

// The contract this repository holds parses: the check is never green for reading nothing.
func TestTheContractParses(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "src", "cli", "contract.ts"))
	if err != nil {
		t.Fatal(err)
	}
	got, err := contractActions(string(src))
	if err != nil {
		t.Fatal(err)
	}
	if got["internal"] != "details" {
		t.Fatalf("ACTION_OF read as %v", got)
	}
}

func TestDiff(t *testing.T) {
	for _, tc := range []struct {
		name     string
		contract string
		want     []string
	}{
		{name: "the same", contract: contractSrc},
		{
			name:     "a code spin added",
			contract: strings.Replace(contractSrc, "  key_not_enrolled: \"add_key\",\n", "", 1),
			want:     []string{"spin writes key_not_enrolled (add_key), which the contract lacks"},
		},
		{
			name:     "a code spin dropped",
			contract: strings.Replace(contractSrc, "  internal:", "  no_key_held: \"add_key\",\n  internal:", 1),
			want:     []string{"the contract has no_key_held, which spin no longer writes"},
		},
		{
			name:     "another action",
			contract: strings.Replace(contractSrc, `not_signed_in: "login"`, `not_signed_in: "details"`, 1),
			want:     []string{"not_signed_in: spin pairs login, the contract details"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spin, err := spinActions([]byte(spinSrc))
			if err != nil {
				t.Fatal(err)
			}
			contract, err := contractActions(tc.contract)
			if err != nil {
				t.Fatal(err)
			}
			got := diff(spin, contract)
			if strings.Join(got, "|") != strings.Join(tc.want, "|") {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestRefused(t *testing.T) {
	for _, tc := range []struct{ name, spin, contract, want string }{
		{"no table in spin", "package cmd\n", contractSrc, "no errorActions"},
		{"a key that is no constant", strings.Replace(spinSrc, "codeInternal:       \"details\"", "\"internal\": \"details\"", 1), contractSrc, "no constant"},
		{"no table in the contract", spinSrc, "export const X = {}\n", "no ACTION_OF"},
		{"an entry that is no pair", spinSrc, strings.Replace(contractSrc, `  internal: "details",`, `  ...MORE,`, 1), "no `code"},
		{"a table that does not end", spinSrc, "export const ACTION_OF = {\n  internal: \"details\",", "does not end"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			spin, contract := filepath.Join(dir, "errcode.go"), filepath.Join(dir, "contract.ts")
			if err := os.WriteFile(spin, []byte(tc.spin), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(contract, []byte(tc.contract), 0o600); err != nil {
				t.Fatal(err)
			}
			err := check(spin, contract)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want an error holding %q", err, tc.want)
			}
		})
	}
}
