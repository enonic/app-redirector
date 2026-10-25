# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An Enonic XP application based on TypeScript starter named `com.enonic.app.redirector`. Requires Enonic XP 7.16.1+. The project is a Gradle-based build that delegates to npm/tsup for TypeScript compilation.

## Purpose

This application will (once completed) provide functionality that enables powerful editorially managed URL-redirection

Target features:

* Content types for redirect collections and rules
* Default collection expected as /_redirects/ within target projects
* Guillotine API extension for front-ends to quickly resolve redirection (single or bulk) 
* Management APIs for exporting and importing collections and rules
* Preview that demonstrates rule resolving and end-result
* Custom validator that checks rule on save (to avoid loops / conflicts)
* Ability for front-end developers to test rules in "draft" mode (before publishing)
* Support recursive collections. Global vs local collections
* Optional dynamic rule creation when content is moved (TBD)
* Sites may optionally specify target rule collection

## Build Commands

```bash
# Full build (Gradle orchestrates npm)
./gradlew build

# Development mode (continuous deploy on file changes)
./gradlew dev

# Individual npm tasks
npm run build              # Build server + client code
npm run check              # Type checking + linting
npm run lint               # ESLint only
npm run test               # Run all tests (client + server)
npm run cov                # Tests with coverage

# Type checking only
npm run check:types:server # Server-side types
npm run check:types:assets # Client-side types

# Gradle equivalents
./gradlew test             # Runs npmTest
./gradlew check            # Runs npmCheck (types + lint)
```

## Architecture

### Two-Environment Build

The codebase compiles to two different targets:

- **Server-side** (`src/main/resources/` except `assets/`): Compiled to **CommonJS, ES5** via tsup. Runs on Enonic XP's Nashorn engine. Has XP globals (`app`, `log`, `require`, `__`). External XP libraries (`/lib/xp/*`) are not bundled.
- **Client-side** (`src/main/resources/assets/`): Compiled to **ESM, modern JS** via tsup. Runs in the browser. Minified in production, sourcemaps in production only.

Each environment has its own `tsconfig.json`:
- `src/main/resources/tsconfig.json` - server (ES5, no DOM libs)
- `src/main/resources/assets/tsconfig.json` - client (DOM libs)

### Build Pipeline

Gradle (orchestrator) -> npm tasks -> tsup (esbuild-based bundler) -> JAR packaging

The `tsup/` directory contains build configs: `server.ts` (CJS output), `client.ts` (ESM output), `build.js` (orchestrator), `check.js` (type checking).

### Source Layout (Enonic XP conventions)

Under `src/main/resources/`:
- `site/pages/*/`, `site/parts/*/`, `site/layouts/*/` - page/part/layout controllers
- `site/content-types/`, `site/mixins/`, `site/x-data/` - content schemas
- `services/*/` - REST service controllers
- `tasks/*/` - background task controllers
- `lib/` - shared server-side libraries
- `assets/` - client-side code (separate build target)
- `admin/tools/`, `admin/widgets/` - admin UI components
- `i18n/` - internationalization
- `error/` - error page handlers

## Testing

Jest with two project configurations:
- **CLIENT** (`src/jest/client/`): jsdom environment, for browser-side tests
- **SERVER** (`src/jest/server/`): node environment, mocks XP globals (`log`, `app`) via `setupFile.ts`

Test files use `*.spec.ts`, `*.test.ts`, `*.spec.tsx`, `*.test.tsx` extensions.

Module paths in tests are mapped via `moduleNameMapper` in `jest.config.ts`:
- Server: `/lib/myproject/(.*)` -> `src/main/resources/lib/myproject/$1`
- Client: `/assets/(.*)` -> `src/main/resources/assets/$1`

## Key Constraints

- Server code must be CommonJS (no ES module syntax) targeting ES5 for Nashorn
- XP library imports use absolute paths (e.g., `/lib/xp/content`) and are marked external in the bundler
- Gradle downloads Node.js v22.15.1 automatically; no global Node install required
- `processResources` excludes `.ts`, `.tsx`, and `.json` files from the JAR
