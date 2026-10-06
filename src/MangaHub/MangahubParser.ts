// Parser functions extracted from netsky's existing 0.8 MangaHub source
// (gh-pages branch). Used by MangaHub.ts for manga details, chapter list,
// homepage sections, search results, and view-more.

import {
    Chapter,
    HomeSection,
    PartialSourceManga,
    SourceManga,
    Tag,
    TagSection,
} from "@paperback/types";

const MH_CDN_THUMBS_DOMAIN = "https://thumb.mghcdn.com";

const HTML_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
    ndash: "-",
    mdash: "-",
    hellip: "...",
    laquo: "\u00ab",
    raquo: "\u00bb",
    copy: "\u00a9",
    reg: "\u00ae",
    trade: "\u2122",
};

export function decode(input: string): string {
    if (!input) return "";
    let out = input;
    // Replace numeric entities (&#nnn; / &#xHH;), then named ones.
    out = out.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)));
    out = out.replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCharCode(parseInt(n, 16)));
    out = out.replace(/&([a-zA-Z]+);/g, (_m, name) => HTML_ENTITIES[name] ?? `&${name};`);
    return out;
}

export function parseMangaDetails(data: any, mangaId: string): SourceManga {
    const titles: string[] = [];
    titles.push(decode(data.title ?? ""));
    if (data.alternativeTitle) {
        for (const t of String(data.alternativeTitle).split(/[|;]/)) {
            if (!t.trim()) continue;
            titles.push(decode(t.trim()));
        }
    }
    const author = decode(data.author ?? "");
    const artist = decode(data.artist ?? "");
    const description = decode(data.description ?? "No description available");
    const arrayTags: Tag[] = [];
    if (typeof data.genres === "string") {
        for (const tag of data.genres.split(",")) {
            const label = tag.trim();
            const id = label.toLowerCase().replace(/\s+/g, "-");
            if (!id || !label) continue;
            arrayTags.push({ id, label });
        }
    } else if (Array.isArray(data.genres)) {
        for (const tag of data.genres) {
            const label = String(tag.title ?? tag);
            const id = String(tag.slug ?? label).toLowerCase();
            if (!id || !label) continue;
            arrayTags.push({ id, label });
        }
    }
    const tagSections: TagSection[] = [
        App.createTagSection({
            id: "0",
            label: "genres",
            tags: arrayTags.map((x) => App.createTag(x)),
        }),
    ];
    let status = "Ongoing";
    const rawStatus = String(data.status ?? "").toUpperCase();
    if (rawStatus === "COMPLETED") status = "Completed";
    else if (rawStatus === "ONGOING") status = "Ongoing";
    return App.createSourceManga({
        id: mangaId,
        mangaInfo: App.createMangaInfo({
            titles,
            image: data?.image ? `${MH_CDN_THUMBS_DOMAIN}/${data.image}` : "",
            status,
            author,
            artist,
            tags: tagSections,
            desc: description,
            hentai: Boolean(data?.isPorn) || Boolean(data?.isSoftPorn),
        }),
    });
}

export function parseChapters(data: any[], mangaId: string): Chapter[] {
    const chapters: Chapter[] = [];
    for (const ch of data ?? []) {
        const number = ch.number;
        const title = ch.title ? ch.title : "Chapter " + number;
        const date = ch.date ? new Date(ch.date) : new Date(0);
        chapters.push(
            App.createChapter({
                id: String(number),
                name: title,
                langCode: "🇬🇧",
                chapNum: number,
                time: date,
            })
        );
    }
    if (chapters.length === 0) {
        throw new Error(`Couldn't find any chapters for mangaId: ${mangaId}!`);
    }
    return chapters;
}

function toPartial(manga: any, collectedIds: number[]): PartialSourceManga | null {
    const title = manga.title ?? "";
    const id = manga.slug ?? "";
    if (!id || !title || collectedIds.includes(manga.id)) return null;
    const image = manga?.image ? `${MH_CDN_THUMBS_DOMAIN}/${manga.image}` : "";
    const subtitle = manga?.latestChapter ? "Chapter " + manga.latestChapter : "";
    collectedIds.push(manga.id);
    return App.createPartialSourceManga({
        image,
        title: decode(title),
        mangaId: id,
        subtitle,
    });
}

export function parseHomeSections(data: any, sectionCallback: (section: HomeSection) => void): void {
    const root = data?.data ?? {};
    const finalSections = [
        {
            id: "popular_manga",
            title: "Popular Manga",
            containsMoreItems: true,
            type: "singleRowLarge",
            data: root.popular?.rows ?? [],
        },
        {
            id: "popular_update",
            title: "Popular Updates",
            containsMoreItems: false,
            type: "singleRowNormal",
            data: root.latest_popular ?? [],
        },
        {
            id: "latest_update",
            title: "Latest Updates",
            containsMoreItems: true,
            type: "singleRowNormal",
            data: root.latest ?? [],
        },
        {
            id: "new_manga",
            title: "New Manga",
            containsMoreItems: true,
            type: "singleRowNormal",
            data: root.new?.rows ?? [],
        },
        {
            id: "completed_manga",
            title: "Completed Manga",
            containsMoreItems: true,
            type: "singleRowNormal",
            data: root.completed?.rows ?? [],
        },
    ];
    const collectedIds: number[] = [];
    for (const s of finalSections) {
        const items: PartialSourceManga[] = [];
        for (const m of s.data ?? []) {
            const item = toPartial(m, collectedIds);
            if (item) items.push(item);
        }
        const section = App.createHomeSection({
            id: s.id,
            title: s.title,
            containsMoreItems: s.containsMoreItems,
            type: s.type as any,
        });
        section.items = items;
        sectionCallback(section);
    }
}

export function parseViewMore(homepageSectionId: string, data: any): PartialSourceManga[] {
    const root = data?.data ?? {};
    let mangaData: any[] = [];
    switch (homepageSectionId) {
        case "latest_update":
            mangaData = root.latest?.rows ?? [];
            break;
        case "popular_manga":
            mangaData = root.popular?.rows ?? [];
            break;
        case "new_manga":
            mangaData = root.new?.rows ?? [];
            break;
        case "completed_manga":
            mangaData = root.completed?.rows ?? [];
            break;
    }
    const out: PartialSourceManga[] = [];
    const collectedIds: number[] = [];
    for (const m of mangaData) {
        const item = toPartial(m, collectedIds);
        if (item) out.push(item);
    }
    return out;
}

export function parseSearch(data: any): PartialSourceManga[] {
    const root = data?.data ?? {};
    const rows = root.search?.rows ?? [];
    const out: PartialSourceManga[] = [];
    const collectedIds: number[] = [];
    for (const m of rows) {
        const item = toPartial(m, collectedIds);
        if (item) out.push(item);
    }
    return out;
}