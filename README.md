# MangaHub extension for Paperback 0.8

A Paperback 0.8 source for [MangaHub](https://mangahub.io). Targets the official MangaHub GraphQL API (`https://api2.mangahub.io/graphql`) and chapter pages served from `imgx.mghcdn.com`.

## What it does

- **Browse**: homepage with "Popular Titles" and "Latest Updates" sections, with "View more" pagination.
- **Search**: full-text search over MangaHub's `/search` GraphQL query, with page metadata.
- **Chapters**: full chapter list per manga via the `manga { chapters }` query.
- **Pages**: page URLs derived from the JSON `pages` field returned by the `chapter` query, joined against the `mghcdn.com` CDN.
- **Self-healing API key**: MangaHub enforces an `mhub_access` cookie that must accompany every GraphQL call. The extension obtains one by hitting the homepage (with optional `reloadKey=1` rotation) and refreshes it on:
  - cold start,
  - expiry (older than 30 minutes),
  - rate-limit or invalid-key response from the API.
- **Cloudflare bypass**: declares `SourceIntents.CLOUDFLARE_BYPASS_REQUIRED` and returns a sensible initial `getCloudflareBypassRequest` so the host app can establish cookies up front.
- **Settings**: a "Refresh API key now" button in source settings to force a key rotation when the user hits issues.

## Layout

```
.
├── package.json
├── tsconfig.json
└── src/MangaHub/
    ├── Common.ts         constants, headers, random UA
    ├── Parser.ts         JSON -> Paperback types
    ├── MangaHub.ts       Source class (interceptor, GraphQL, sections, search)
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