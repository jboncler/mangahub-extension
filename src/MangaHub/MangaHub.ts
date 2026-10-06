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
import {
    API_PATH,
    API_URL,
    DEFAULT_HEADERS,
    RATE_LIMIT_CHECK_PATTERN,
    SITE_URL,
    SOURCE_NAME,
    SOURCE_VERSION,
    getRandomUserAgent,
    randomInt,
} from "./Common";
import { Parser } from "./Parser";

const KEY_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const RATE_LIMIT_BACKOFF_MS = 60 * 1000; // 60 seconds

export const MangaHubInfo: SourceInfo = {
    version: SOURCE_VERSION,
    name: SOURCE_NAME,
    icon: "icon.png",
    author: "jakub",
    authorWebsite: "https://jboncler.github.io/mangahub-extension/",
    description:
        "MangaHub (mangahub.io) source for Paperback 0.8. v1.0.5: CF bypass restored, now targets a manga page (less CF-aggressive than the homepage) like netsky's extension.",
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

interface KeyCache {
    mhubAccess: string | null;
    fetchedAt: number;
    useReloadKeyParam: boolean;
}

class MangaHubInterceptor implements SourceInterceptor {
    stateManager: any;
    parent: MangaHub;
    constructor(parent: MangaHub, stateManager: any) {
        this.parent = parent;
        this.stateManager = stateManager;
    }
    async interceptRequest(request: Request): Promise<Request> {
        const headers = request.headers ?? {};
        for (const k of Object.keys(DEFAULT_HEADERS)) {
            if (!(k in headers)) (headers as any)[k] = (DEFAULT_HEADERS as any)[k];
        }
        const key = await this.parent.getCachedKey();
        if (key && !("x-mhub-access" in headers)) {
            (headers as any)["x-mhub-access"] = key;
        }
        // Use one fixed desktop User-Agent for all API traffic; rotating UAs
        // across requests triggered Cloudflare to flag some of them as bots.
        if (!("User-Agent" in headers)) {
            (headers as any)["User-Agent"] =
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
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
        interceptor: new MangaHubInterceptor(this, this.stateManager),
    });

    private keyCache: KeyCache = {
        mhubAccess: null,
        fetchedAt: 0,
        useReloadKeyParam: false,
    };
    private keyFetchInFlight: Promise<string | null> | null = null;

    // -----------------------------
    // Cloudflare bypass marker
    //
    // Paperback will load this URL in an in-app webview until the page is
    // "fully loaded" (real content, not a CF interstitial). On success it
    // copies the cookies set during that load (notably `mhub_access`) into
    // this source's requestManager cookie store, which is what API calls then
    // pick up. We point at a real manga page rather than the bare homepage
    // because MangaHub's Cloudflare config challenges `/` harder than an
    // established content URL.
    // -----------------------------
    getCloudflareBypassRequest(): Request {
        return App.createRequest({
            url: `${SITE_URL}/manga/one-piece_142`,
            method: "GET",
            headers: {
                ...DEFAULT_HEADERS,
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
                "x-user-agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
                "x-sec-fetch-dest": "document",
                "x-sec-fetch-mode": "navigate",
                "Upgrade-Insecure-Requests": "1",
            },
        });
    }

    // -----------------------------
    // Key management (mhub_access cookie)
    // -----------------------------
    private isKeyExpired(): boolean {
        return (
            !this.keyCache.mhubAccess ||
            Date.now() - this.keyCache.fetchedAt > KEY_REFRESH_INTERVAL_MS
        );
    }

    async getCachedKey(): Promise<string | null> {
        if (this.keyFetchInFlight) {
            return this.keyFetchInFlight;
        }
        if (this.isKeyExpired()) {
            this.keyFetchInFlight = this.refreshApiKey().finally(() => {
                this.keyFetchInFlight = null;
            });
            return this.keyFetchInFlight;
        }
        return this.keyCache.mhubAccess;
    }

    private async refreshApiKey(force = false): Promise<string | null> {
        const url =
            force && this.keyCache.useReloadKeyParam
                ? `${SITE_URL}/?reloadKey=1`
                : SITE_URL;

        const request = App.createRequest({
            url,
            method: "GET",
            headers: {
                ...DEFAULT_HEADERS,
                // Desktop UA is more trusted by Cloudflare than mobile; mobile
                // webviews often get an unsolvable "verify if human" page.
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
                "x-user-agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
                "x-sec-fetch-dest": "document",
                "x-sec-fetch-mode": "navigate",
                "Upgrade-Insecure-Requests": "1",
            },
        });

        try {
            const response = await this.requestManager.schedule(request, 5);
            const body = response.data ?? "";
            // Detect Cloudflare challenge HTML. The body starts with `<!DOCTYPE`
            // and contains "Just a moment..." — if so, treat as no key.
            if (/<!DOCTYPE/i.test(body) || /Just a moment/i.test(body)) {
                console.log(
                    "[MangaHub] homepage returned Cloudflare challenge; no key obtained"
                );
                return this.keyCache.mhubAccess;
            }
            const setCookies: string[] = [];
            const headers = response.headers ?? {};
            for (const k of Object.keys(headers)) {
                if (k.toLowerCase() === "set-cookie") {
                    const v = (headers as any)[k];
                    if (Array.isArray(v)) setCookies.push(...v);
                    else if (v) setCookies.push(v as string);
                }
            }
            for (const cookie of setCookies) {
                const match = cookie.match(/(?:^|;\s*)mhub_access=([^;]+)/);
                if (match && match[1]) {
                    const newKey = decodeURIComponent(match[1]);
                    if (newKey && newKey !== this.keyCache.mhubAccess) {
                        this.keyCache = {
                            mhubAccess: newKey,
                            fetchedAt: Date.now(),
                            useReloadKeyParam: this.keyCache.useReloadKeyParam,
                        };
                        return newKey;
                    }
                }
            }
        } catch (e) {
            console.log(
                `[MangaHub] key fetch failed: ${e instanceof Error ? e.message : e}`
            );
        }

        if (!force) {
            this.keyCache.useReloadKeyParam = !this.keyCache.useReloadKeyParam;
            return this.refreshApiKey(true);
        }

        return this.keyCache.mhubAccess;
    }

    private checkResponseError(response: Response): void {
        if (response.status === 403 || response.status === 503) {
            throw new Error("Cloudflare Bypass Required");
        }
        if (response.status === 429) {
            throw new Error("API rate limit exceeded");
        }
    }

    // -----------------------------
    // GraphQL request with rate-limit recovery
    // -----------------------------
    private async graphql(query: string): Promise<any> {
        const initUseReload = this.keyCache.useReloadKeyParam;
        let lastError: Error | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await this.getCachedKey();
                const request = App.createRequest({
                    url: API_URL,
                    method: "POST",
                    headers: {
                        ...DEFAULT_HEADERS,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                    data: JSON.stringify({ query }),
                });
                const response = await this.requestManager.schedule(request, 5);
                // Soft-handle Cloudflare bypass: don't throw on 403/503 here,
                // because Paperback renders its own bypass flow and retries on
                // its own. Throwing here aborts the section/search with no UI
                // recovery path. Instead, surface the situation as a soft error
                // that callers can either retry or ignore.
                if (response.status === 403 || response.status === 503) {
                    throw new Error("__CF_BYPASS_NEEDED__");
                }
                if (response.status === 429) {
                    throw new Error("API rate limit exceeded");
                }
                const data = JSON.parse(response.data ?? "{}");
                const errors = data.errors ?? data.error;
                if (errors) {
                    const message = Array.isArray(errors)
                        ? errors[0]?.message ?? JSON.stringify(errors)
                        : (errors as any).message ?? JSON.stringify(errors);
                    throw new Error(String(message));
                }
                return data;
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                lastError = new Error(msg);
                // Cloudflare challenge isn't fixable via key rotation; let it
                // bubble up immediately so the caller can show a useful empty
                // state instead of backing off uselessly.
                if (msg === "__CF_BYPASS_NEEDED__") {
                    throw lastError;
                }
                if (RATE_LIMIT_CHECK_PATTERN.test(msg)) {
                    if (attempt > 0 && initUseReload === this.keyCache.useReloadKeyParam) {
                        this.keyCache.useReloadKeyParam = !this.keyCache.useReloadKeyParam;
                    } else if (attempt > 0) {
                        throw lastError;
                    }
                    await new Promise((r) => setTimeout(r, RATE_LIMIT_BACKOFF_MS));
                    await this.refreshApiKey(true);
                } else {
                    throw lastError;
                }
            }
        }
        throw lastError ?? new Error("GraphQL request failed");
    }

    // -----------------------------
    // Recently-viewed cookie update (parity with hakuneko - stored for reference)
    // -----------------------------
    private async updateRecentlyCookie(chapterNumber: string | number): Promise<void> {
        const now = Date.now();
        const value = encodeURIComponent(
            `{"${now - randomInt(0, 1200)}":{"mangaID":${randomInt(
                1,
                30000,
            )},"number":${Number(chapterNumber) - 1}}}`
        );
        await this.stateManager.store("recently_cookie", value);
    }

    // -----------------------------
    // MangaProviding
    // -----------------------------
    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const query = `{
            manga(x: ${API_PATH}, slug: "${mangaId.replace(/"/g, '\\"')}") {
                id, slug, title, image, author, artist, description, released, status, serialization, type
            }
        }`;
        const data = await this.graphql(query);
        const m = data?.data?.manga ?? data?.manga;
        if (!m) {
            throw new Error(`Manga not found: ${mangaId}`);
        }
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
        await this.updateRecentlyCookie(chapterId);
        const query = `{
            chapter(x: ${API_PATH}, slug: "${mangaId.replace(/"/g, '\\"')}", number: ${chapterId}) {
                pages
            }
        }`;
        const data = await this.graphql(query);
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
        metadata: { page?: number } | undefined
    ): Promise<PagedResults> {
        const page = (metadata as any)?.page ?? 1;
        const term = (query.title ?? "").replace(/"/g, '\\"');
        const offset = (page - 1) * 50;
        const gql = `{
            search(x: ${API_PATH}, q: "${term}", genre: "all", mod: ALPHABET, limit: 50, offset: ${offset}) {
                rows { id, slug, title }
            }
        }`;
        try {
            const data = await this.graphql(gql);
            const items: PartialSourceManga[] = this.parser.parseSearchResults(data);
            const nextPage = items.length === 50 ? { page: page + 1 } : undefined;
            return App.createPagedResults({ results: items, metadata: nextPage });
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
    // -----------------------------
    async getHomePageSections(
        sectionCallback: (section: HomeSection) => void
    ): Promise<void> {
        const popular = App.createHomeSection({
            id: "popular",
            title: "Popular Titles",
            type: "singleRowNormal",
            containsMoreItems: true,
        });
        const latest = App.createHomeSection({
            id: "latest",
            title: "Latest Updates",
            type: "singleRowNormal",
            containsMoreItems: true,
        });

        // Let the app render the empty sections first
        sectionCallback(popular);
        sectionCallback(latest);

        try {
            const popularItems = await this.fetchHome("POPULAR", 1);
            popular.items = popularItems;
            sectionCallback(popular);
        } catch (e) {
            console.log(`[MangaHub] popular section failed: ${e instanceof Error ? e.message : e}`);
        }
        try {
            const latestItems = await this.fetchHome("LATEST", 1);
            latest.items = latestItems;
            sectionCallback(latest);
        } catch (e) {
            console.log(`[MangaHub] latest section failed: ${e instanceof Error ? e.message : e}`);
        }
    }

    async getViewMoreItems(
        homepageSectionId: string,
        metadata: { page?: number } | undefined
    ): Promise<PagedResults> {
        const page = (metadata as any)?.page ?? 1;
        const order = homepageSectionId === "latest" ? "LATEST" : "POPULAR";
        const items = await this.fetchHome(order, page);
        const nextPage = items.length === 50 ? { page: page + 1 } : undefined;
        return App.createPagedResults({ results: items, metadata: nextPage });
    }

    private async fetchHome(order: string, page: number): Promise<PartialSourceManga[]> {
        const offset = (page - 1) * 20;
        const gql = `{
            search(x: ${API_PATH}, q: "", genre: "all", mod: ${order}, limit: 20, offset: ${offset}) {
                rows { id, slug, title }
            }
        }`;
        const data = await this.graphql(gql);
        return this.parser.parseSearchResults(data);
    }

    // -----------------------------
    // Settings UI: refresh API key on demand + help
    // -----------------------------
    async getSourceMenu(): Promise<DUISection> {
        const helpLabel = App.createLabel({
            id: "help_label",
            label:
                "First open: Paperback will run a Cloudflare bypass on a manga page — wait for it to finish. If sections still don't load, the CF check is unusually strict; open mangahub.io in Safari once, then tap Refresh.",
            value: undefined,
        });
        const helpLink = App.createLink({
            id: "help_link",
            label: "Open mangahub.io in Safari (fallback)",
            value: SITE_URL,
        });
        const refreshButton: DUIButton = App.createButton({
            id: "refresh_key",
            label: "Refresh API key",
            value: undefined,
            action: async () => {
                this.keyCache = {
                    mhubAccess: null,
                    fetchedAt: 0,
                    useReloadKeyParam: false,
                };
                await this.refreshApiKey();
            },
        });
        return App.createDUISection({
            id: "main",
            header: "MangaHub Settings",
            isHidden: false,
            rows: async () => [helpLabel, helpLink, refreshButton] as any,
        });
    }
}