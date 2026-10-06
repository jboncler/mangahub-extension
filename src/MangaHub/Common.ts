// Constants and enums for MangaHub
export const SITE_URL = "https://mangahub.io";
export const API_URL = "https://api.mghcdn.com/graphql";
export const CDN_URL = "https://imgx.mghcdn.com";
export const API_PATH = "m01";
export const SOURCE_NAME = "MangaHub";
export const SOURCE_ID = "MangaHub";
export const SOURCE_VERSION = "1.0.6";

export const DEFAULT_HEADERS = {
    "x-origin": SITE_URL,
    "x-referer": `${SITE_URL}/`,
    "Accept-Language": "en-US,en;q=0.9",
};

export const ROTATING_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];

export function getRandomUserAgent(): string {
    return ROTATING_USER_AGENTS[Math.floor(Math.random() * ROTATING_USER_AGENTS.length)];
}

export function randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export const RATE_LIMIT_CHECK_PATTERN = /(api)?\s*rate\s*limit\s*(excessed)?|api\s*key\s*(invalid)?/i;