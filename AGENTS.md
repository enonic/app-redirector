# AGENTS.md

This file provides guidance to AI agents like Claude and Copilot when working with code in this repository.

## Description

`com.enonic.app.redirector` is an Enonic XP application for editorially managed URL redirection, derived from the Enonic
TypeScript starter (https://github.com/enonic/starter-ts). Requires Enonic XP 8.1.1+ and runs on the GraalJS engine.

Editors manage redirects in Content Studio as content. Front ends ask XP whether an incoming path should redirect, through
a Guillotine extension that returns the target URL and status code; the front end performs the actual redirect.

Target features:

* Content types for redirect collections and rules
* Default collection expected as `_redirects` within target projects, with a site-level `<site>/_redirects` taking precedence
* Guillotine API extension for front-ends to quickly resolve redirection (single or bulk)
* Management APIs for exporting and importing collections and rules
* Preview that demonstrates rule resolving and end-result
* Custom validator that checks rule on save (to avoid loops / conflicts)
* Ability for front-end developers to test rules in "draft" mode (before publishing)
* Global vs local collections
* Optional dynamic rule creation when content is moved (TBD)
* Sites and projects may select their rule set explicitly: a `ContentSelector` (restricted to `${app}:ruleSet`) in the app
  config form in `cms/cms.yaml`, read by the resolver with `getSiteConfig` / the project's `siteConfig`. Planned resolution
  order: `ruleSet` argument, site config, `${site}/_redirects`, project config, `/_redirects`, else `null`. Sharing across
  sites works within one project; across projects use layers (an inherited rule set), since content references never cross
  repositories

## Build system

Gradle is the primary build tool, with a Node.js plugin for npm integration. Builds require a contextual Enonic XP sandbox,
which holds the XP version and the Java compiler needed to package the app into a JAR.

`xpVersion` in `gradle.properties` declares the target XP version (`8.1.1`). The `@enonic-types/*` packages in `package.json`
track the same version; never install types newer than the XP the app is deployed to.

Library dependencies in `build.gradle` use Gradle version catalogs: XP's own libraries come from the `xplibs` catalog
(`include xplibs.content`), generated from `xpVersion` by the `com.enonic.xp.settings` plugin; Enonic Market libraries are
declared in `gradle/libs.versions.toml` and referenced as `libs.<alias>` (`include libs.http.client`). Never hardcode library
coordinates or versions in `build.gradle`.

`build.gradle` declares `app { scriptEngine = 'GraalJS' }`, which sets the `X-Script-Engine` manifest header so XP runs the
app on GraalJS instead of Nashorn.

Use the **Enonic CLI** for build and deploy; it wires the build to the correct sandbox. Direct `./gradlew` or `npm` commands
are fine for TypeScript-only tasks (type checking, linting, testing).

## Commands

### Enonic CLI (preferred for build & deploy)

```bash
enonic dev                    # Build, deploy, and watch for changes
enonic project build          # Full build (wired to the sandbox's compiler)
enonic project deploy         # Build and deploy to the linked sandbox (.enonic)
```

`.npmrc` disables npm's audit and fund requests; an unreachable audit endpoint stalls every `npm install`.

### npm scripts (TypeScript tooling)

```bash
npm run build                 # Server + assets in one tsdown run (tsdown.config.mts)
npm run check                 # Types + lint concurrently
npm run check:types           # Type check only
npm run lint                  # oxlint (configured in .oxlintrc.json)
npm test                      # All tests (server + client Jest projects)
npm run cov                   # Tests with coverage
```

The app has no client-side sources yet, so there is no `check:types:client` script; add it back (the starter has it) together
with the first file under `src/main/resources/assets/`.

### Gradle (used internally by Enonic CLI)

```bash
./gradlew build               # npm install + check + test + build + jar
./gradlew build -Penv=dev     # Development build (NODE_ENV=development); `enonic dev` passes this automatically
./gradlew check               # Type checking + linting only
./gradlew test                # Tests only
```

## CI/CD

`.github/workflows/build.yml` builds on every push with `enonic/action-app-build@v2`, which provides the XP version, Enonic CLI
and Java compiler. On other CI platforms, use the `enonic/enonic-ci` Docker image and run `enonic project build` inside it.

## Architecture

### Dual build: server vs. client

Both targets are defined in `tsdown.config.mts` (an array of two configs; a target with no source files is skipped):

**Server** (`src/main/resources/**/*.ts`, excluding `assets/`):
- Target: ES2022, CommonJS format, `platform: 'neutral'`. GraalJS runs modern syntax, so no re-lowering to ES5.
- Output: `build/resources/main/`
- Runtime-provided modules are marked `external` by rule (`isRuntimeModule`), not by list: an absolute import (`/lib/xp/*`,
  `/lib/http-client`, …) is bundled only when it is a source file of this app, otherwise it is left to the XP runtime. A
  mistyped specifier is caught by `check:types` (TS2307), not by the bundler.
- tsconfig: `src/main/resources/tsconfig.json`

**Client** (`src/main/resources/assets/**/*.ts`): Target ES2023, ESM, `platform: 'browser'`, minified in production. Output
`build/resources/main/assets/`, tsconfig `src/main/resources/assets/tsconfig.json`. Empty today.

### Runtime constraints (GraalJS)

XP loads every file as a CommonJS module on both engines: no ES module loading, no `async`/`await`, no Node.js APIs
(`process`, `Buffer`, `node_modules` resolution). Write synchronous code and use the XP libraries for HTTP, storage and the
rest. Module-level state is per script context; treat top-level state as read-only. Register event listeners and disposers
from `main.ts`, not from request handlers. Convert values explicitly at the Java bridge boundary (`__.toScriptValue`,
`__.toNativeObject`) and call bean setters rather than assigning properties.

### TypeScript toolchain

TypeScript 7 (native compiler) is used for type checking only (`tsc --noEmit`); transpilation is done by tsdown (Oxc).
Linting is **oxlint**, not ESLint, and Jest transpiles with **@swc/jest**, not ts-jest. Do not add ts-jest, ts-node or
typescript-eslint: they require the TypeScript compiler API that the TS7 package no longer exports.

### Path mappings

Server tsconfig maps `/lib/xp/<name>` → `node_modules/@enonic-types/lib-<name>` (one explicit entry per XP library plus a
wildcard; together with `.vscode/settings.json` this makes auto-import suggest the runtime-correct `/lib/xp/<name>`), and
`/*` → `./src/main/resources/*`. Add an entry here and in `src/jest/server/tsconfig.json` when installing a new
`@enonic-types/lib-*` package. Jest maps `/lib/redirector` to `src/main/resources/lib/redirector` for server tests and
`/assets/(.*)` for client tests.

### Source layout (Enonic XP 8 conventions)

Under `src/main/resources/`:
- `enonic.yaml` - application descriptor
- `cms/cms.yaml` - CMS descriptor; there is no `site.yaml`, the app has no site mappings
- `cms/content-types/rule/`, `cms/content-types/ruleSet/` - the two content types (descriptors only)
- `admin/extensions/rule-tester/` - Content Studio Live View extension (`contentstudio.liveview`, `auto: "true"`,
  `order: "60"`, `allowContentType: "com.enonic.app.redirector:*"`) that renders the Rule and RuleSet testers in the
  preview pane. `HEAD` answers the Automatic-mode probe (200 for the two types, 418 otherwise); `GET` loads the content
  with `lib-content` inside a `lib-context` run for the `repo`/`branch` parameters and renders via `lib/tester.ts`.
  The tester form posts back to `req.contextPath` and carries Content Studio's query parameters as hidden fields.
- `lib/tester.ts` - HTML rendering for the two testers; `lib/redirector.ts` - matching and trace logic shared by the
  testers and the Guillotine extension
- `guillotine/guillotine.ts` - Guillotine extension adding the `redirect` field. Rule set resolution: the `ruleSet` argument,
  else `${site}/_redirects` for the nearest site of `localContext.scopeKey` (Guillotine 9; absent or `/` means project root),
  else `/_redirects`. Any failure in the lookup is logged and returns `null`
- `admin/tools/`, `admin/widgets/`, `tasks/`, `services/`, `error/`, `i18n/` - empty placeholders
- `assets/` - client-side code (separate build target, empty)

### Testing

Two Jest projects: **server** (`src/jest/server/`, Node environment, XP globals mocked in `setupFile.ts`) and **client**
(`src/jest/client/`, jsdom). Tests import `describe`/`it`/`expect`/`jest` from `@jest/globals`; there is no `@types/jest`.
SWC does not hoist `jest.mock()`: use `jest.doMock()` followed by `require()` inside the test. Test files use
`*.spec.ts`, `*.test.ts`, `*.spec.tsx`, `*.test.tsx`.

### Content model notes

`ruleSet` (super type `base:folder`) restricts children to `${app}:rule`; order of rules is the manual sort order, first
match wins. `rule` has option sets `source` (prefix / exact / regex) and `target` (content reference / relative path /
external URL), a `statusCode` combo box (301, 302, 410) and a note. Option set selections are stored as `_selected`.
The display name expression cannot read `_selected` or referenced content (Content Studio limitation), so names for
content targets end at the status code.
