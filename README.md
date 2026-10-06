# MangaHub extension for Paperback 0.8

A Paperback 0.8 source for [MangaHub](https://mangahub.io). Targets the official MangaHub GraphQL API (`https://api2.mangahub.io` historically; now `https://api.mghcdn.com/graphql`) and chapter pages served from `imgx.mghcdn.com`.

This extension is intended to be installed **alongside** netsky's MangaHub (different source id `MangaHubAlt`), so users can fall back between the two if one of them hits a Cloudflare wall on their IP.

## What it does

- **Browse**: homepage with five sections (Popular Manga, Popular Updates, Latest Updates, New Manga, Completed Manga), with "View more" pagination.
- **Search**: full-text search over MangaHub's `/search` GraphQL query, with both `alt: false` and `alt: true` queries fired in parallel (the standard netsky pattern for better recall).
- **Chapters**: full chapter list per manga via the `manga { chapters }` query.
- **Pages**: plaintext when MangaHub serves them, otherwise fetched from the encrypted `enc:v1:...` payload and decrypted via `https://mangahub.io/api/chapter-crypto` (per netsky PR #123). Cached per `keyId` until the key expires.
- **Self-healing API key**: MangaHub enforces an `mhub_access` cookie that must accompany every GraphQL call. The extension obtains one by hitting a chapter URL, stores it in `stateManager`, and refreshes it on rate-limit / invalid-key responses.
- **Cloudflare bypass**: declares `SourceIntents.CLOUDFLARE_BYPASS_REQUIRED` and points the in-app webview at `/chapter/the-last-human/chapter-1?reloadKey=1` (less CF-aggressive than the homepage).
- **Settings**: a "Refresh API key now" button in source settings to force a key rotation when the user hits issues.

## Layout

```
.
├── package.json
├── tsconfig.json
└── src/MangaHubAlt/
    ├── MangaHubAlt.ts    Source class (interceptor, GraphQL, sections, search, decryption)
    ├── MangahubCrypto.ts AES-GCM decrypt + base64url + UTF-8 helpers
    ├── MangahubParser.ts manga details, chapter list, sections, search parsers
    └── includes/icon.png
```

## Build

```
npm install
npm run bundle
```

The output lands in `bundles/` as `MangaHub/source.js` plus a static `index.html` for hosting on GitHub Pages (or any static host). Add the URL to Paperback as a source repository.

## Caveats

- MangaHub has a hard rate limit (~10 chapters every 20–60 minutes per IP/session). The extension adds a 60 s back-off and rotates the key before retrying, but you will still hit the limit if you binge-read.
- If MangaHub changes the `pages` JSON shape or moves the CDN domain again, the only change required is in `Common.ts` (`API_URL`, `CDN_URL`) and `Parser.ts#parsePageList`.

## License

GPL-3.0.