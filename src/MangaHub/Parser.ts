import {
    Chapter,
    ChapterDetails,
    PartialSourceManga,
    TagSection,
} from "@paperback/types";
import { CDN_URL, SOURCE_NAME } from "./Common";

// MangaHub raw search response shape
export interface SearchRow {
    id: string;
    slug: string;
    title: string;
}

export interface SearchResponse {
    data?: {
        search?: {
            rows?: SearchRow[];
        };
    };
    search?: {
        rows?: SearchRow[];
    };
}

// MangaHub raw chapter list
export interface RawChapter {
    id: string;
    number: string | number;
    title: string;
    slug: string;
}

export interface MangaResponse {
    data?: {
        manga?: {
            chapters?: RawChapter[];
        };
    };
    manga?: {
        chapters?: RawChapter[];
    };
}

// MangaHub raw chapter pages
export interface PagesParsed {
    p: string; // path prefix on cdn
    i: string[]; // image filenames
}

export interface ChapterResponse {
    data?: {
        chapter?: {
            pages?: string; // JSON-stringified PagesData
        };
    };
    chapter?: {
        pages?: string;
    };
}

export class Parser {
    parseSearchResults(json: SearchResponse): PartialSourceManga[] {
        const rows = json?.data?.search?.rows ?? json?.search?.rows ?? [];
        const items: PartialSourceManga[] = [];
        for (const m of rows) {
            if (!m.slug || !m.title) continue;
            items.push({
                mangaId: m.slug,
                title: m.title,
                image: `https://thumb.mghcdn.com/${m.slug}.jpg`,
                subtitle: undefined,
            });
        }
        return items;
    }

    parseChapterList(json: MangaResponse, mangaId: string): Chapter[] {
        const chapters = json?.data?.manga?.chapters ?? json?.manga?.chapters ?? [];
        const result: Chapter[] = [];
        for (const c of chapters) {
            const num = String(c.number ?? c.id ?? "");
            if (!num) continue;
            const title = `Ch. ${num}${c.title ? ` - ${c.title}` : ""}`;
            const chapNum = Number(num);
            result.push({
                id: num,
                chapNum: isNaN(chapNum) ? 0 : chapNum,
                name: title.trim(),
                volume: 0,
                group: SOURCE_NAME,
                time: new Date(0),
                sortingIndex: 0,
                langCode: "en",
            });
        }
        return result;
    }

    parsePageList(
        json: ChapterResponse,
        mangaId: string,
        chapterId: string
    ): ChapterDetails {
        const raw = json?.data?.chapter?.pages ?? json?.chapter?.pages ?? "{}";
        let parsed: PagesParsed;
        try {
            parsed = JSON.parse(raw) as PagesParsed;
        } catch {
            parsed = { p: "", i: [] };
        }
        const pages = (parsed.i ?? []).map((name) => {
            const fullPath = parsed.p + name;
            return new URL(fullPath, CDN_URL).href;
        });
        return {
            id: chapterId,
            mangaId: mangaId,
            pages: pages,
        };
    }

    parseTagsFromSections(): TagSection[] {
        // No remote genre list surfaced by current MangaHub GraphQL.
        return [];
    }
}