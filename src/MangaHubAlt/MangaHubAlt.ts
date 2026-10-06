import {
    SourceManga,
    Chapter,
    ChapterDetails,
    HomeSection,
    SearchRequest,
    PagedResults,
    SourceInfo,
    BadgeColor,
    TagSection,
    Tag,
    ContentRating,
    PartialSourceManga,
    Request,
    Response,
    SourceIntents,
    ChapterProviding,
    MangaProviding,
    SearchResultsProviding,
    HomePageSectionsProviding
} from '@paperback/types'

import {
    parseChapters,
    parseMangaDetails,
    parseViewMore,
    parseHomeSections,
    parseSearch
} from './MangahubParser'

import {
    ChapterCryptoParams,
    decryptPages,
    getEncryptedKeyId,
    isEncryptedPages
} from './MangahubCrypto'

const MH_DOMAIN = 'https://mangahub.io'
const MH_API_DOMAIN = 'https://api.mghcdn.com/graphql'
const MH_CDN_DOMAIN = 'https://imgx.mghcdn.com'

export const MangaHubAltInfo: SourceInfo = {
    version: '3.2.2',
    name: 'MangaHub (Alt)',
    icon: 'icon.png',
    author: 'jakub',
    authorWebsite: 'https://jboncler.github.io/mangahub-extension/',
    description:
        'MangaHub (mangahub.io) for Paperback 0.8. Same as netsky/Mangahub but bundled with optional AES-GCM decrypt (PR #123); falls back to plaintext pages when encryption is unavailable.',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: MH_DOMAIN,
    sourceTags: [
        {
            text: "Alt",
            type: BadgeColor.YELLOW
        }
    ],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED
}

export class Mangahub implements SearchResultsProviding, MangaProviding, ChapterProviding, HomePageSectionsProviding {

    requestManager = App.createRequestManager({
        requestsPerSecond: 2,
        requestTimeout: 15000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        'Referer': `${MH_DOMAIN}/`,
                        'Origin': `${MH_DOMAIN}`,
                        'User-Agent': await this.requestManager.getDefaultUserAgent(),
                        'x-mhub-access': await this.getMhubAccess()
                    }
                }
                return request
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                return response
            }
        }
    });

    stateManager = App.createSourceStateManager()

    // Returns ONLY the token value (the API expects the bare token in x-mhub-access,
    // not a "mhub_access=...; Max-Age=...; Path=/" cookie string).
    getMhubAccess = async (): Promise<string> => {
        // 1. Prefer the live cookie (set by the Cloudflare bypass webview or a refresh)
        const cookie = this.getMhubCookie()
        if (cookie?.value) return cookie.value

        // 2. Fall back to the stored token (also handles the old "mhub_access=xyz; ..." format)
        const stored: string = (await this.stateManager.retrieve('mhub_key')) ?? ''
        const match = /mhub_access=([^;]*)/.exec(stored)
        return (match ? match[1] : stored) ?? ''
    }

    getMhubCookie() {
        return this.requestManager?.cookieStore?.getAllCookies()
            .find(x => x.name === 'mhub_access' && x.value)
    }

    getMangaShareUrl(mangaId: string): string { return `${MH_DOMAIN}/manga/${mangaId}` }

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const data = await this.apiQuery(`query {
                    manga(x: m01, slug: "${mangaId}") {
                        title
                        alternativeTitle
                        author
                        artist
                        image
                        status
                        genres
                        description
                        isPorn
                        isSoftPorn
                    }
                 }`,
        (d) => !!d?.data?.manga,
        `manga details for ${mangaId}`,
        `${MH_DOMAIN}/manga/${mangaId}`)

        return parseMangaDetails(data.data.manga, mangaId)
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const data = await this.apiQuery(`query {
                    manga(x: m01, slug: "${mangaId}") {
                        title
                        chapters {
                          number
                          title
                          slug
                          date
                        }
                    }
                 }`,
        (d) => Array.isArray(d?.data?.manga?.chapters) && d.data.manga.chapters.length > 0,
        `chapter list for ${mangaId}`,
        `${MH_DOMAIN}/manga/${mangaId}`)

        return parseChapters(data.data.manga.chapters, mangaId)
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const data = await this.apiQuery(`query {
                    chapter(x: m01, slug: "${mangaId}", number: ${Number(chapterId)}) {
                      pages
                      title
                      slug
                    }
                  }`,
        (d) => !!d?.data?.chapter?.pages,
        `chapter ${chapterId} of ${mangaId}`,
        `${MH_DOMAIN}/chapter/${mangaId}/chapter-${chapterId}`)

        let pagesString: string = data.data.chapter.pages
        if (isEncryptedPages(pagesString)) {
            pagesString = await this.decryptChapterPages(pagesString)
        }

        let parsedPages: any
        try {
            parsedPages = JSON.parse(pagesString)
        } catch (e) {
            throw new Error(`Failed to parse pages for mangaId:${mangaId} chapterId:${chapterId} - ${e}`)
        }

        // The site has used a few shapes for this: {p, i[]}, a plain array, or an object of paths
        let paths: string[] = []
        if (Array.isArray(parsedPages)) {
            paths = parsedPages.map(String)
        } else if (parsedPages && Array.isArray(parsedPages.i)) {
            const prefix: string = parsedPages.p ?? ''
            paths = parsedPages.i.map((img: string) => `${prefix}${img}`)
        } else if (parsedPages && typeof parsedPages === 'object') {
            paths = Object.values(parsedPages).map(String)
        }

        const pages = paths.map(path =>
            /^https?:\/\//.test(path) ? path : `${MH_CDN_DOMAIN}/${path.replace(/^\/+/, '')}`
        )

        if (pages.length == 0) throw new Error(`No pages found for mangaId:${mangaId} chapterId:${chapterId}`)

        return App.createChapterDetails({
            id: chapterId,
            mangaId: mangaId,
            pages: pages
        })
    }

    // Sends one GraphQL request. Returns the parsed JSON, or undefined if the
    // response wasn't JSON (e.g. a Cloudflare / rate-limit HTML page).
    async sendQuery(query: string): Promise<{ status: number, data: any }> {
        const request = App.createRequest({
            url: MH_API_DOMAIN,
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            data: { query }
        })

        const response = await this.requestManager.schedule(request, 1)
        let data: any
        try {
            data = JSON.parse(response.data as string)
        } catch (e) {
            data = undefined
        }
        return { status: response.status, data }
    }

    // Runs a query; if the answer is missing, an error, or not JSON (usually a used-up
    // token), refreshes the token and retries ONCE before giving a descriptive error.
    async apiQuery(query: string, isValid: (data: any) => boolean, what: string, refreshUrl?: string): Promise<any> {
        let result = await this.sendQuery(query)
        if (!result.data?.errors && isValid(result.data)) return result.data

        await this.refreshAPIKey(refreshUrl)
        result = await this.sendQuery(query)
        if (!result.data?.errors && isValid(result.data)) return result.data

        const serverMessage = result.data?.errors?.[0]?.message
        if (serverMessage) {
            throw new Error(`MangaHub refused the request for ${what}: ${serverMessage}\nTry the CloudFlare bypass again or come back later.`)
        }
        if (result.data === undefined) {
            throw new Error(`MangaHub sent an unreadable response (HTTP ${result.status}) for ${what}. You may be rate limited or need to redo the CloudFlare bypass.`)
        }
        throw new Error(`MangaHub returned no data for ${what}. It may have been removed from the site.`)
    }

    async getSearchTags(): Promise<TagSection[]> {
        const request = App.createRequest({
            url: MH_API_DOMAIN,
            method: 'POST',
            headers: {
                'accept': 'application/json',
                'content-type': 'application/json'
            },
            data: {
                query: `query {
                    genres {
                      id
                      slug
                      title
                    }
                }`
            }
        })

        const response = await this.requestManager.schedule(request, 1)
        let data
        try {
            data = JSON.parse(response.data as string)
        } catch (e) {
            throw new Error(`${e}`)
        }

        if (data.data.genres?.length == 0) throw new Error('Failed to parse genres property from data object!')

        const arrayTags: Tag[] = []
        for (const genre of data.data.genres) {
            arrayTags.push({ id: genre.slug, label: genre.title })
        }
        return [App.createTagSection({ id: '0', label: 'genres', tags: arrayTags.map(x => App.createTag(x)) })]
    }

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const request = App.createRequest({
            url: MH_API_DOMAIN,
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            data: {
                query: `query {
                    latest_popular: latestPopular(x: m01) {
                        id
                        title
                        slug
                        image
                        latestChapter
                      }
                      latest: latest(x: m01, limit: 30) {
                        id
                        title
                        slug
                        image
                        latestChapter
                      }
                      popular: search(x: m01, mod: POPULAR, limit: 30) {
                        rows {
                          id
                          title
                          slug
                          image
                          latestChapter
                        }
                      }
                      new: search(x: m01, mod: NEW, limit: 30) {
                        rows {
                          id
                          title
                          slug
                          image
                          latestChapter
                        }
                      }
                      completed: search(x: m01, mod: COMPLETED, limit: 30) {
                        rows {
                          id
                          title
                          slug
                          image
                          latestChapter
                    }
                }
            }`
            }
        })
        const response = await this.requestManager.schedule(request, 1)

        try {
            const data = JSON.parse(response.data as string)
            parseHomeSections(data, sectionCallback)
        } catch (e) {
            throw new Error(`${e}`)
        }
    }

    async getViewMoreItems(homepageSectionId: string, metadata: any): Promise<PagedResults> {
        const offset: number = metadata?.offset ?? 0
        const request = App.createRequest({
            url: MH_API_DOMAIN,
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            data: {
                query: `query {
                    latest: search(x: m01, mod: LATEST, offset: ${offset}) {
                        rows {
                            id
                            title
                            slug
                            image
                            latestChapter
                        }
                      }
                      popular: search(x: m01, mod: POPULAR, offset: ${offset}) {
                        rows {
                            id
                            title
                            slug
                            image
                            latestChapter
                        }
                      }
                      new: search(x: m01, mod: NEW, offset: ${offset}) {
                        rows {
                            id
                            title
                            slug
                            image
                            latestChapter
                        }
                      }
                      completed: search(x: m01, mod: COMPLETED, offset: ${offset}) {
                        rows {
                            id
                            title
                            slug
                            image
                            latestChapter
                    }
                }
            }`
            }
        })

        const response = await this.requestManager.schedule(request, 1)

        let data
        try {
            data = JSON.parse(response.data as string)
        } catch (e) {
            throw new Error(`${e}`)
        }

        const manga = parseViewMore(homepageSectionId, data)
        metadata = { offset: offset + 30 }
        return App.createPagedResults({
            results: manga,
            metadata
        })
    }

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const offset: number = metadata?.offset ?? 0
        const searchTag = query?.includedTags?.map((x: Tag) => x.id)

        const requests = [
            //No Alt Titles
            {
                request: App.createRequest({
                    url: MH_API_DOMAIN,
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    data: {
                        query: `query {
                            search(x: m01, alt: false, q: "${query?.title ? query.title : ''}", genre: "${searchTag[0] ? searchTag[0] : ''}", offset:${offset}) {
                              rows {
                                id
                                title
                                slug
                                image
                                latestChapter
                                genres
                              }
                            }
                          }
                          `
                    }
                })
            },
            {
                request: App.createRequest({
                    url: MH_API_DOMAIN,
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    data: {
                        query: `query {
                            search(x: m01, alt: true, q: "${query?.title ? query.title : ''}", genre: "${searchTag[0] ? searchTag[0] : ''}", offset:${offset}) {
                              rows {
                                id
                                title
                                slug
                                image
                                latestChapter
                                genres
                              }
                            }
                          }
                          `
                    }
                })
            }
        ]

        const promises: Promise<void>[] = []
        let manga: PartialSourceManga[] = []

        for (const req of requests) {
            promises.push(this.requestManager.schedule(req.request, 1).then((response) => {
                let data
                try {
                    data = JSON.parse(response.data as string)
                } catch (e) {
                    throw new Error(`${e}`)
                }
                manga = manga.concat(parseSearch(data))
            }))
        }

        await Promise.all(promises)

        const seen = new Set()
        manga = manga.filter(x => {
            const duplicate = seen.has(x.mangaId)
            seen.add(x.mangaId)
            return !duplicate
        })

        metadata = { offset: offset + 30 }
        return App.createPagedResults({
            results: manga,
            metadata
        })
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        // Remove stored UserAgent
        await this.stateManager.store('userAgent', 'null')

        // Forget the old stored token so the fresh mhub_access cookie
        // the bypass webview receives is the one that gets used
        await this.stateManager.store('mhub_key', '')

        return App.createRequest({
            url: `${MH_DOMAIN}/chapter/the-last-human/chapter-1?reloadKey=1`,
            method: 'GET',
            headers: {
                'Referer': `${MH_DOMAIN}/`,
                'User-Agent': await this.requestManager.getDefaultUserAgent()
            }
        })
    }

    // Cache of chapter decryption keys, keyed by keyId
    cryptoKeys: Record<string, string> = {}

    async decryptChapterPages(pages: string): Promise<string> {
        const keyId = getEncryptedKeyId(pages)

        if (keyId && this.cryptoKeys[keyId]) {
            try {
                return decryptPages(pages, { keys: { [keyId]: this.cryptoKeys[keyId] as string } })
            } catch (e) {
                // Cached key no longer valid, fetch a fresh one below
                delete this.cryptoKeys[keyId]
            }
        }

        const params = await this.fetchChapterCrypto()
        if (params.keys) Object.assign(this.cryptoKeys, params.keys)
        if (params.key && params.keyId) this.cryptoKeys[params.keyId] = params.key

        try {
            return decryptPages(pages, params)
        } catch (e) {
            throw new Error(`Failed to decrypt chapter pages: ${e}`)
        }
    }

    async fetchChapterCrypto(): Promise<ChapterCryptoParams> {
        // Send the site's own cookies (cf_clearance etc.) plus the current access token
        const token = await this.getMhubAccess()
        const cookies = (this.requestManager?.cookieStore?.getAllCookies() ?? [])
            .filter(x => x.domain.includes('mangahub.io') && x.name !== 'mhub_access')
            .map(x => `${x.name}=${x.value}`)
        if (token) cookies.push(`mhub_access=${token}`)

        const request = App.createRequest({
            url: `${MH_DOMAIN}/api/chapter-crypto`,
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                ...(cookies.length ? { 'Cookie': cookies.join('; ') } : {})
            }
        })

        const response = await this.requestManager.schedule(request, 1)

        let params: ChapterCryptoParams
        try {
            params = JSON.parse(response.data as string)
        } catch (e) {
            throw new Error(`Could not get the chapter decryption key (HTTP ${response.status}). Try the CloudFlare bypass again.`)
        }

        if (!params?.key && !params?.keys) throw new Error('Chapter decryption key response was empty')
        return params
    }

    async refreshAPIKey(refreshUrl?: string): Promise<void> {
        // Only drop the stale mhub_access cookie. Do NOT wipe every cookie,
        // that also deletes cf_clearance and undoes the Cloudflare bypass.
        const cookieStore = this.requestManager?.cookieStore
        cookieStore?.getAllCookies()
            .filter(x => x.name === 'mhub_access')
            .forEach(x => cookieStore.removeCookie(x))
        await this.stateManager.store('mhub_key', '')

        // Visiting a chapter page with reloadKey=1 makes the site issue a new token
        const pageUrl = refreshUrl ?? `${MH_DOMAIN}/chapter/the-last-human/chapter-1`
        const request = App.createRequest({
            url: `${pageUrl}?reloadKey=1`,
            method: 'GET',
            headers: {
                'Referer': `${MH_DOMAIN}/`,
                'User-Agent': await this.requestManager.getDefaultUserAgent()
            }
        })

        const response = await this.requestManager.schedule(request, 1)

        // Header names can come back in any case ("Set-Cookie" vs "set-cookie"),
        // and multiple cookies may arrive as an array
        let mhubKey = ''
        for (const [name, value] of Object.entries(response.headers ?? {})) {
            if (name.toLowerCase() !== 'set-cookie') continue
            const raw = Array.isArray(value) ? value.join('; ') : String(value)
            const match = /mhub_access=([^;]+)/.exec(raw)
            if (match?.[1]) mhubKey = match[1]
        }

        // Paperback may have put it straight into the cookie store instead
        if (!mhubKey) mhubKey = this.getMhubCookie()?.value ?? ''

        if (mhubKey) {
            await this.stateManager.store('mhub_key', mhubKey)
        } else {
            console.log('[Mangahub] refreshAPIKey: no new mhub_access token received')
        }
    }

}
