## 1. Configuration

- [x] 1.1 Add a `dtachSessions.suggestSessionName` boolean property (default
  `false`) to `contributes.configuration.properties` in `package.json`, with a
  description noting it is off by default (preserving the empty-box behaviour)
  and turns on the `<prefix><hash>` pre-fill.
- [x] 1.2 Add a `dtachSessions.suggestSessionNamePrefix` string property (default
  `new-`) next to it, describing the `<prefix><hash>` suggestion, the
  `/`/whitespace sanitisation, the disambiguation from `socketPrefix`, and that
  it has no effect while `suggestSessionName` is off.
- [x] 1.3 Add `suggestSessionName: boolean` and `suggestSessionNamePrefix: string` to
  `DtachConfig` and read both in `config()` (`src/provider.ts`) with defaults
  `false` / `new-`.

## 2. Implementation

- [x] 2.1 Add a pure `expandVariables(template)` helper in `src/extension.ts`
  (next to `sanitizeName`) resolving the supported subset — `${workspaceFolder}`
  / `${workspaceFolderBasename}` from `workspaceFolders[0]`, `${userHome}` from
  `os.homedir()`, `${env:NAME}` from `process.env` — and expanding any other or
  unresolvable `${...}` token to the empty string.
- [x] 2.2 In `create()` (`src/extension.ts`), read `config()` once; when
  `suggestSessionName` is true, build `defaultName =
  sanitizeName(\`${expandVariables(cfg.suggestSessionNamePrefix)}${sessionHash()}\`)`
  and pass `value: defaultName` + `valueSelection: [0, defaultName.length]` to
  `showInputBox`; otherwise leave `value`/`valueSelection` undefined so the box
  opens empty. Expanding then sanitising the composed name at use time is the
  single guard covering both the Settings-UI and `settings.json` input paths.
  `prompt`, `validateInput`, and the `!name` guard are unchanged.

## 3. Verify

- [x] 3.1 `npm run compile` clean.
- [x] 3.2 Manual acceptance (no test suite; per `README.md`): with
  `suggestSessionName` off (default), New Session opens an empty box (original
  behaviour); Escape/typing a name behave as before. Turn `suggestSessionName`
  on → box opens pre-filled `new-<6hex>` fully selected; Enter creates it; typing
  replaces it; reopening yields a fresh hash. With it on, set `suggestSessionNamePrefix`
  to `wip-` (UI) → pre-fill `wip-<hash>`; to `my proj/` (`settings.json`) →
  pre-fill `my-proj-<hash>`, immediately valid; empty → pre-fill just the hash.
  Variables: `${workspaceFolderBasename}-` → `<folder>-<hash>`;
  `${workspaceFolder}-` → sanitised path + `<hash>`; `${env:USER}-` → the env
  value; an unsupported/missing token (`${file}`, `${env:NOPE}`) → drops to empty.
  Updated the `README.md` config table and acceptance checks.
  Verified by static/logic review, not an in-app GUI check (no VS Code GUI
  available in this session): when the toggle is off, `value`/`valueSelection`
  are undefined so `showInputBox` opens empty as it did before this feature; when
  on, `config()` reads the stored prefix regardless of how it was entered, so
  sanitising the composed `<prefix><hash>` guards both input paths;
  `sanitizeName` trims and replaces `/`/whitespace with `-` and the hash is
  always non-empty hex, so the pre-fill is always a non-empty valid name;
  `valueSelection` [0, len] selects the whole value so overtype replaces and
  Enter returns it; `sessionHash()` is called per activation for a fresh hash.
