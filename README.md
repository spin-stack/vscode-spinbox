# Spinbox for VS Code

The VS Code extension `spin-stack.spinbox`: opens Spinbox workspaces in VS Code over Remote-SSH.
It talks to Spinbox through the `spin` CLI alone, by the JSON contract in
[spin-stack/spin#833](https://github.com/spin-stack/spin/issues/833); `src/cli/contract.ts` is
that contract as types.

## Developing

Needs Go (the tools are pinned in `go.mod`), Node 22 and pnpm.

```sh
go tool task install            # dependencies, through Socket Firewall
go tool task test               # unit tests (Vitest), against the fake spin in test/fake-spin/
go tool task test:integration   # the extension activated in a real VS Code; needs a display
go tool task ci                 # what CI runs
```

F5 in VS Code runs the extension in an Extension Development Host (`.vscode/launch.json`).

`test/fake-spin/spin.cjs` answers every command and every error code of the contract, from
environment variables or a scenario file: its header says how.
