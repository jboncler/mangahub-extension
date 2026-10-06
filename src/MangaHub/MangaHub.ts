import {
    Chapter,
    ChapterDetails,
    ContentRating,
    HomeSection,
    MangaProviding,
    PagedResults,
    SearchRequest,
    SearchResultsProviding,
    Source,
    SourceInfo,
    SourceIntents,
    SourceManga,
    Request,
    Response,
    HomePageSectionsProviding,
    DUISection,
    DUIButton,
    PartialSourceManga,
    SourceInterceptor,
} from "@paperback/types";
import { API_PATH, API_URL, CDN_URL, SOURCE_NAME, SOURCE_VERSION } from "./Common";
import { Parser } from "./Parser";

// MangaHub constants
const SITE_URL = "https://mangahub.io";
const KEY_STORE_NAME = "mhub_key";
// The chapter page we hit to obtain/refresh mhub_access. Real chapter, not the
// homepage — MangaHub's CF is more lenient on established content URLs and
// this page sets mhub_access as a Set-Cookie response header.
const KEY_REFRESH_URL = `${SITE_URL}/chapter/the-last-human/chapter-1?reloadKey=1`;
// Bypass URL is the same chapter page so Paperback's CF-bypass webview ends
// up with a populated mhub_access cookie when the user opens the source.
const BYPASS_URL = KEY_REFRESH_URL;

export const MangaHubInfo: SourceInfo = {
    version: SOURCE_VERSION,
    name: SOURCE_NAME,
    icon: "icon.png",
    author: "jakub",
    authorWebsite: "https://jboncler.github.io/mangahub-extension/",
    description:
        "MangaHub (mangahub.io) source for Paperback 0.8. v1.1.0: rebuilt around the working netsky/MangaHub pattern (CF bypass on a chapter page; mhub_access via stateManager).",
    contentRating: ContentRating.EVERYONE,
    websiteBaseURL: SITE_URL,
    sourceTags: [
        { text: "English", type: "info" as any },
        { text: "GraphQL", type: "default" as any },
    ],
    intents:
        SourceIntents.MANGA_CHAPTERS |
        SourceIntents.HOMEPAGE_SECTIONS |
        SourceIntents.CLOUDFLARE_BYPASS_REQUIRED |
        SourceIntents.SETTINGS_UI,
};

class MangaHubInterceptor implements SourceInterceptor {
    parent: MangaHub;
    constructor(parent: MangaHub) {
        this.parent = parent;
    }
    async interceptRequest(request: Request): Promise<Request> {
        const headers = request.headers ?? {};
        // Use the iOS-default UA the requestManager provides; rotating UAs
        // across requests triggered CF to flag some of them as bots.
        if (!("User-Agent" in headers)) {
            try {
                (headers as any)["User-Agent"] =
                    await this.parent.requestManager.getDefaultUserAgent();
            } catch {
                (headers as any)["User-Agent"] =
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
            }
        }
        // Standard browser-origin headers (MangaHub's CF is happy with these)
        if (!("Referer" in headers)) (headers as any)["Referer"] = `${SITE_URL}/`;
        if (!("Origin" in headers)) (headers as any)["Origin"] = SITE_URL;
        // Attach the mhub_access key as the custom header MangaHub expects.
        const key = await this.parent.getMhubAccess();
        if (key && !("x-mhub-access" in headers)) {
            (headers as any)["x-mhub-access"] = key;
        }
        request.headers = headers;
        return request;
    }
    async interceptResponse(response: Response): Promise<Response> {
        return response;
    }
}

export class MangaHub extends Source
    implements
        MangaProviding,
        SearchResultsProviding,
        HomePageSectionsProviding {
    readonly parser = new Parser();
    readonly stateManager = App.createSourceStateManager();

    requestManager = App.createRequestManager({
        requestsPerSecond: 2,
        requestTimeout: 20000,
        interceptor: new MangaHubInterceptor(this),
    });

    // -----------------------------
    // Cloudflare bypass: load a
    // chapter page (less CF-aggressive
    // than the homepage) so Paperback
    // captures mhub_access into its
    // cookie store, which the
    // interceptor then re-uses.
    // -----------------------------
    async getCloudflareBypassRequestAsync(): Promise<Request> {
        // Per netsky: pre-store an empty mhub_access so the first request
        // doesn't carry a stale value.
        await this.stateManager.store(KEY_STORE_NAME, "mhub_access=; Max-Age=0; Path=/");
        return App.createRequest({
            url: BYPASS_URL,
            method: "GET",
            headers: {
                Referer: `${SITE_URL}/`,
                "User-Agent": await this.requestManager.getDefaultUserAgent(),
            },
        });
    }

    // -----------------------------
    // mhub_access key management
    // (stored in stateManager, attached
    // to every API request via the
    // interceptor as `x-mhub-access`).
    // -----------------------------
    async getMhubAccess(): Promise<string> {
        const stored = await this.stateManager.retrieve(KEY_STORE_NAME);
        return stored ?? "mhub_access=; Max-Age=0; Path=/";
    }

    async refreshAPIKey(): Promise<void> {
        try {
            // Clear any existing cookies so the server issues a fresh one.
            this.requestManager?.cookieStore?.getAllCookies().forEach((c) => {
                try {
                    this.requestManager?.cookieStore?.removeCookie(c);
                } catch {
                    // ignore
                }
            });
        } catch {
            // ignore
        }

        const request = App.createRequest({
            url: KEY_REFRESH_URL,
            method: "GET",
            headers: {
                Referer: `${SITE_URL}/`,
                "User-Agent": await this.requestManager.getDefaultUserAgent(),
                Cookie: await this.getMhubAccess(),
            },
        });
        try {
            const response = await this.requestManager.schedule(request, 1);
            const setCookie = response.headers?.["Set-Cookie"];
            const match = /mhub_access=([^;]+)/.exec(
                Array.isArray(setCookie) ? setCookie.join(",") : setCookie ?? ""
            );
            if (match && match[1]) {
                const expires = Math.floor(Date.now() / 1000) + 2 * 31 * 24 * 60 * 60;
                await this.stateManager.store(
                    KEY_STORE_NAME,
                    `mhub_access=${match[1]}; Max-Age=${expires}; Path=/`
                );
            }
        } catch (e) {
            console.log(
                `[MangaHub] key refresh failed: ${e instanceof Error ? e.message : e}`
            );
        }
    }

    // -----------------------------
    // GraphQL request helper.
    // Throws on errors so callers can
    // recover (e.g. chapter path will
    // refresh the key on rate-limit).
    // -----------------------------
    private async graphql(query: string): Promise<any> {
        const request = App.createRequest({
            url: API_URL,
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            data: { query },
        });
        const response = await this.requestManager.schedule(request, 1);
        let data: any;
        try {
            data = JSON.parse(response.data ?? "{}");
        } catch (e) {
            throw new Error("Invalid GraphQL response");
        }
        if (data?.errors) {
            const message = data.errors[0]?.message ?? JSON.stringify(data.errors);
            throw new Error(message);
        }
        return data;
    }

    // -----------------------------
    // MangaProviding
    // -----------------------------
    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const query = `{
            manga(x: ${API_PATH}, slug: "${mangaId.replace(/"/g, '\\"')}") {
                id, slug, title, image, author, artist, description, released, status
            }
        }`;
        const data = await this.graphql(query);
        const m = data?.data?.manga ?? data?.manga;
        if (!m) throw new Error(`Manga not found: ${mangaId}`);
        const thumb = m.image
            ? new URL(m.image, "https://thumb.mghcdn.com/").href
            : `https://thumb.mghcdn.com/${m.slug ?? mangaId}.jpg`;
        return App.createSourceManga({
            id: m.slug ?? mangaId,
            mangaInfo: App.createMangaInfo({
                titles: [m.title ?? mangaId],
                image: thumb,
                author: m.author ?? "",
                artist: m.artist ?? "",
                desc: m.description ?? "",
                status: m.status ?? "",
                hentai: false,
                tags: [],
            }),
        });
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const query = `{
            manga(x: ${API_PATH}, slug: "${mangaId.replace(/"/g, '\\"')}") {
                chapters { id, number, title, slug }
            }
        }`;
        const data = await this.graphql(query);
        return this.parser.parseChapterList(data, mangaId);
    }

    async getChapterDetails(
        mangaId: string,
        chapterId: string
    ): Promise<ChapterDetails> {
        const query = `{
            chapter(x: ${API_PATH}, slug: "${mangaId.replace(/"/g, '\\"')}", number: ${chapterId}) {
                pages
            }
        }`;
        let data: any;
        try {
            data = await this.graphql(query);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Rate-limit / invalid-key -> try once more with a fresh key.
            if (/rate\s*limit|api\s*key/i.test(msg)) {
                await this.refreshAPIKey();
                throw new Error(
                    "API LIMIT EXCEEDED! Try redoing the CloudFlare bypass or come back later."
                );
            }
            throw e;
        }
        const pages = this.parser.parsePageList(data, mangaId, chapterId);
        return App.createChapterDetails({
            id: pages.id,
            mangaId: pages.mangaId,
            pages: pages.pages,
        });
    }

    getMangaShareUrl(mangaId: string): string {
        return `${SITE_URL}/manga/${mangaId}`;
    }

    // -----------------------------
    // SearchResultsProviding
    // -----------------------------
    async getSearchResults(
        query: SearchRequest,
        metadata: { offset?: number } | undefined
    ): Promise<PagedResults> {
        const offset = (metadata as any)?.offset ?? 0;
        const term = (query.title ?? "").replace(/"/g, '\\"');
        const gql = `{
            search(x: ${API_PATH}, q: "${term}", genre: "all", mod: ALPHABET, limit: 50, offset: ${offset}) {
                rows { id, slug, title, image, latestChapter }
            }
        }`;
        try {
            const data = await this.graphql(gql);
            const items = this.parser.parseSearchResults(data);
            const next = items.length === 50 ? { offset: offset + 50 } : undefined;
            return App.createPagedResults({ results: items, metadata: next });
        } catch (e) {
            console.log(`[MangaHub] search failed: ${e instanceof Error ? e.message : e}`);
            return App.createPagedResults({ results: [], metadata: undefined });
        }
    }

    async getSearchTags(): Promise<any[]> {
        return [];
    }

    // -----------------------------
    // HomePageSectionsProviding
    //
    // Netsky-style combined query —
    // MangaHub returns multiple lists
    // in a single GraphQL call, so the
    // UI populates from one round-trip.
    // -----------------------------
    async getHomePageSections(
        sectionCallback: (section: HomeSection) => void
    ): Promise<void> {
        const sections: HomeSection[] = [
            App.createHomeSection({
                id: "latest_popular",
                title: "Latest Popular",
                type: "singleRowNormal",
                containsMoreItems: false,
            }),
            App.createHomeSection({
                id: "latest",
                title: "Latest Updates",
                type: "singleRowNormal",
                containsMoreItems: true,
            }),
            App.createHomeSection({
                id: "popular",
                title: "Popular Titles",
                type: "singleRowNormal",
                containsMoreItems: true,
            }),
            App.createHomeSection({
                id: "new",
                title: "New Titles",
                type: "singleRowNormal",
                containsMoreItems: true,
            }),
            App.createHomeSection({
                id: "completed",
                title: "Completed",
                type: "singleRowNormal",
                containsMoreItems: true,
            }),
        ];
        for (const s of sections) sectionCallback(s);

        const query = `query {
            latest_popular: latestPopular(x: ${API_PATH}) {
                id, title, slug, image, latestChapter
            }
            latest: latest(x: ${API_PATH}, limit: 30) {
                id, title, slug, image, latestChapter
            }
            popular: search(x: ${API_PATH}, mod: POPULAR, limit: 30, offset: 0) {
                rows { id, title, slug, image, latestChapter }
            }
            new: search(x: ${API_PATH}, mod: NEW, limit: 30, offset: 0) {
                rows { id, title, slug, image, latestChapter }
            }
            completed: search(x: ${API_PATH}, mod: COMPLETED, limit: 30, offset: 0) {
                rows { id, title, slug, image, latestChapter }
            }
        }`;
        try {
            const data = await this.graphql(query);
            this.populateSection(sections[0]!, data?.data?.latest_popular ?? data?.latest_popular ?? []);
            this.populateSection(sections[1]!, data?.data?.latest ?? data?.latest ?? []);
            this.populateSection(sections[2]!, data?.data?.popular?.rows ?? data?.popular?.rows ?? []);
            this.populateSection(sections[3]!, data?.data?.new?.rows ?? data?.new?.rows ?? []);
            this.populateSection(sections[4]!, data?.data?.completed?.rows ?? data?.completed?.rows ?? []);
        } catch (e) {
            console.log(`[MangaHub] homepage failed: ${e instanceof Error ? e.message : e}`);
        }
        for (const s of sections) sectionCallback(s);
    }

    private populateSection(section: HomeSection, rows: any[]): void {
        const items: PartialSourceManga[] = [];
        for (const r of rows) {
            if (!r?.slug) continue;
            items.push({
                mangaId: r.slug,
                title: r.title ?? r.slug,
                image: r.image
                    ? new URL(r.image, "https://thumb.mghcdn.com/").href
                    : `https://thumb.mghcdn.com/${r.slug}.jpg`,
                subtitle: r.latestChapter ? `Ch. ${r.latestChapter}` : undefined,
            });
        }
        section.items = items;
    }

    async getViewMoreItems(
        homepageSectionId: string,
        metadata: { offset?: number } | undefined
    ): Promise<PagedResults> {
        const offset = (metadata as any)?.offset ?? 0;
        const modMap: Record<string, string> = {
            popular: "POPULAR",
            new: "NEW",
            completed: "COMPLETED",
            latest: "LATEST",
        };
        const mod = modMap[homepageSectionId] ?? "POPULAR";
        const gql = `{
            search(x: ${API_PATH}, q: "", genre: "all", mod: ${mod}, limit: 30, offset: ${offset}) {
                rows { id, title, slug, image, latestChapter }
            }
        }`;
        try {
            const data = await this.graphql(gql);
            const rows = data?.data?.search?.rows ?? data?.search?.rows ?? [];
            const items: PartialSourceManga[] = [];
            for (const r of rows) {
                if (!r?.slug) continue;
                items.push({
                    mangaId: r.slug,
                    title: r.title ?? r.slug,
                    image: r.image
                        ? new URL(r.image, "https://thumb.mghcdn.com/").href
                        : `https://thumb.mghcdn.com/${r.slug}.jpg`,
                    subtitle: r.latestChapter ? `Ch. ${r.latestChapter}` : undefined,
                });
            }
            const next = items.length === 30 ? { offset: offset + 30 } : undefined;
            return App.createPagedResults({ results: items, metadata: next });
        } catch (e) {
            console.log(`[MangaHub] view-more failed: ${e instanceof Error ? e.message : e}`);
            return App.createPagedResults({ results: [], metadata: undefined });
        }
    }

    // -----------------------------
    // Settings UI
    // -----------------------------
    async getSourceMenu(): Promise<DUISection> {
        const helpLabel = App.createLabel({
            id: "help_label",
            label:
                "Cloudflare bypass opens a MangaHub chapter page to set mhub_access. If CF is too strict, sections stay empty. Tap Refresh below to retry the key fetch manually.",
            value: undefined,
        });
        const refreshButton: DUIButton = App.createButton({
            id: "refresh_key",
            label: "Refresh API key",
            value: undefined,
            action: async () => {
                await this.refreshAPIKey();
            },
        });
        return App.createDUISection({
            id: "main",
            header: "MangaHub Settings",
            isHidden: false,
            rows: async () => [helpLabel, refreshButton] as any,
        });
    }
}