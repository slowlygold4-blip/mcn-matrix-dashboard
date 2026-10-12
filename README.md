# MCN Matrix Dashboard — source review edition

This repository contains the application source for a local-first MCN account
monitoring dashboard. It is a **source-review copy**, not a hosted data service.
It intentionally excludes the owner's account lists, SQLite database, browser
login state, imported spreadsheets, audit logs, private evidence, and historical
development archives. Do not commit any of those materials.

## Develop

- Node.js 24 or newer, Python 3, and a local writable data directory are required.
- Run `npm ci`, then `npm test` or `npm run check`.
- Start the local service with `npm start` and open `http://127.0.0.1:4188/`.
- Copy `.env.example` to a local `.env` only if your own supervisor loads it;
  `npm start` does not automatically read that file.
- Public-platform collection can fail because of access limits or login
  requirements. Never invent missing observations or bypass access controls.

## Contributing

Please open an issue describing the bug and evidence, then submit a pull
request with tests. The owner reviews and merges changes. A public repository
does not grant write access to the running dashboard or its private data.

This repository is not currently licensed for reuse outside this project.
Third-party components and their licenses are listed in
`THIRD_PARTY_NOTICES.md`.
