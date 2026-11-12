// Command errcodes holds the extension's error codes to the spin CLI's: every code, and the action
// it pairs with, in errorActions of spin's cmd/cli/cmd/errcode.go is ACTION_OF in
// src/cli/contract.ts, and nothing else is. A code spin adds or drops is a failure here, not an
// envelope the extension quietly reads as internal (task contract:spin reads spin's file at the
// release versions.yaml pins):
//
//	go run ./hack/errcodes -spin errcode.go -contract src/cli/contract.ts
package main

import (
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

func main() {
	spinPath := flag.String("spin", "", "spin's cmd/cli/cmd/errcode.go")
	contractPath := flag.String("contract", "src/cli/contract.ts", "the extension's contract")
	flag.Parse()
	if err := check(*spinPath, *contractPath); err != nil {
		fmt.Fprintln(os.Stderr, "errcodes:", err)
		os.Exit(1)
	}
	fmt.Println("errcodes: the contract's codes are spin's")
}

func check(spinPath, contractPath string) error {
	spinSrc, err := os.ReadFile(spinPath)
	if err != nil {
		return err
	}
	contractSrc, err := os.ReadFile(contractPath)
	if err != nil {
		return err
	}
	spin, err := spinActions(spinSrc)
	if err != nil {
		return fmt.Errorf("%s: %w", spinPath, err)
	}
	contract, err := contractActions(string(contractSrc))
	if err != nil {
		return fmt.Errorf("%s: %w", contractPath, err)
	}
	if d := diff(spin, contract); len(d) > 0 {
		return errors.New("the contract is not spin's:\n  " + strings.Join(d, "\n  "))
	}
	return nil
}

// spinActions reads errorActions: each key a constant of type errorCode, each value its action.
func spinActions(src []byte) (map[string]string, error) {
	f, err := parser.ParseFile(token.NewFileSet(), "errcode.go", src, 0)
	if err != nil {
		return nil, err
	}
	codes := map[string]string{}
	var table *ast.CompositeLit
	for _, decl := range f.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok {
			continue
		}
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, name := range vs.Names {
				if i >= len(vs.Values) {
					continue
				}
				switch gen.Tok {
				case token.CONST:
					if s, ok := stringLit(vs.Values[i]); ok {
						codes[name.Name] = s
					}
				case token.VAR:
					if lit, ok := vs.Values[i].(*ast.CompositeLit); ok && name.Name == "errorActions" {
						table = lit
					}
				}
			}
		}
	}
	if table == nil {
		return nil, errors.New("no errorActions")
	}
	actions := map[string]string{}
	for _, elt := range table.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			return nil, errors.New("errorActions holds an entry that is no key and value")
		}
		key, ok := kv.Key.(*ast.Ident)
		if !ok {
			return nil, errors.New("errorActions has a key that is no constant")
		}
		code, ok := codes[key.Name]
		if !ok {
			return nil, fmt.Errorf("errorActions names %s, which is no string constant", key.Name)
		}
		action, ok := stringLit(kv.Value)
		if !ok {
			return nil, fmt.Errorf("errorActions pairs %s with no string", code)
		}
		actions[code] = action
	}
	return actions, nil
}

func stringLit(e ast.Expr) (string, bool) {
	lit, ok := e.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", false
	}
	s, err := strconv.Unquote(lit.Value)
	return s, err == nil
}

var (
	tableStart = regexp.MustCompile(`(?m)^export const ACTION_OF = \{$`)
	tableEntry = regexp.MustCompile(`^\s*([a-z_]+): "([a-z_]+)",?$`)
)

// contractActions reads ACTION_OF, one `code: "action",` to a line, up to its closing brace.
func contractActions(src string) (map[string]string, error) {
	start := tableStart.FindStringIndex(src)
	if start == nil {
		return nil, errors.New("no ACTION_OF")
	}
	actions := map[string]string{}
	for _, line := range strings.Split(src[start[1]:], "\n")[1:] {
		if strings.HasPrefix(line, "}") {
			return actions, nil
		}
		m := tableEntry.FindStringSubmatch(line)
		if m == nil {
			return nil, fmt.Errorf("ACTION_OF holds %q, which is no `code: \"action\",`", line)
		}
		actions[m[1]] = m[2]
	}
	return nil, errors.New("ACTION_OF does not end")
}

// diff says, sorted, each code one side has and the other lacks, and each the two pair otherwise.
func diff(spin, contract map[string]string) []string {
	var out []string
	for code, action := range spin {
		got, ok := contract[code]
		switch {
		case !ok:
			out = append(out, fmt.Sprintf("spin writes %s (%s), which the contract lacks", code, action))
		case got != action:
			out = append(out, fmt.Sprintf("%s: spin pairs %s, the contract %s", code, action, got))
		}
	}
	for code := range contract {
		if _, ok := spin[code]; !ok {
			out = append(out, fmt.Sprintf("the contract has %s, which spin no longer writes", code))
		}
	}
	sort.Strings(out)
	return out
}
