/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** Discord's hard cap for one clip upload. */
export const CLIPS_MAX_SIZE = 100 * 1024 * 1024;

/** Discord's snowflake epoch (2015-01-01T00:00:00Z). */
export const SNOWFLAKE_EPOCH = 1420070400000n;

/** App id the official client reports for clips. */
export const CLIP_APPLICATION_ID = "1301689862256066560";

/**
 * The trailer Discord's clip validator looks for: a 24 byte ISO-BMFF `uuid`
 * box carrying `a1c85299-3346-4db8-88f0-83f57a75a5ef`.
 *
 * The 4 byte size field is deliberately bogus (11822 bytes) — that is exactly
 * what the working "send as clip" tools append, so it is reproduced verbatim
 * instead of being "fixed".
 */
export const CLIP_BOX: Uint8Array = Uint8Array.from(
    atob("AAAuLnV1aWShyFKZM0ZNuIjwg/V6daXv"),
    c => c.charCodeAt(0)
);

export type ClipKind = "video" | "audio" | "other";

const VIDEO_EXT = new Set([
    "mp4", "m4v", "mov", "qt", "mkv", "webm", "avi", "wmv", "flv", "ogv", "3gp", "ts", "m2ts"
]);
const AUDIO_EXT = new Set([
    "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "aiff", "aif", "wma", "mid"
]);

export function clipKind(file: { name: string; type: string; }): ClipKind {
    const type = (file.type || "").toLowerCase();
    const ext = extensionOf(file.name);

    if (type.startsWith("video/") || VIDEO_EXT.has(ext)) return "video";
    if (type.startsWith("audio/") || AUDIO_EXT.has(ext)) return "audio";
    return "other";
}

export function extensionOf(name: string): string {
    const m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? m[1].toLowerCase() : "";
}

/** "holiday clip.mov" -> "holiday clip.mp4" */
export function mp4Name(name: string): string {
    const base = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
    return `${base || "clip"}.mp4`;
}

/** The `clip` object the client serialises into `is_clip` / `clip_*` form fields. */
export interface ClipData {
    id: bigint;
    createdAt: number;
    version: number;
    applicationName: string;
    applicationId: string;
    users: string[];
    clipMethod: string;
    length: number;
    thumbnail: string;
    filepath: string;
    name: string;
}

export function makeClipData(original: { name: string; size: number; }, userId: string): ClipData {
    const now = Date.now();
    const base = original.name.includes(".")
        ? original.name.slice(0, original.name.lastIndexOf("."))
        : original.name;

    return {
        id: (BigInt(now) - SNOWFLAKE_EPOCH) << 22n,
        createdAt: now,
        version: 3,
        applicationName: "",
        applicationId: CLIP_APPLICATION_ID,
        users: userId ? [userId] : [],
        clipMethod: "manual",
        length: original.size,
        thumbnail: "",
        filepath: "",
        name: base || "clip"
    };
}

/* ------------------------------------------------------------------ */
/* MP4 box surgery                                                     */
/* ------------------------------------------------------------------ */

function readU32(b: Uint8Array, o: number): number {
    return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

function readFourCC(b: Uint8Array, o: number): string {
    return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function writeFourCC(b: Uint8Array, o: number, s: string): void {
    for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i) & 0xff;
}

/**
 * Walks the first few top level boxes looking for `ftyp`.
 * Returns null for anything that is not ISO base media (MKV, AVI, …).
 */
export function findFtyp(bytes: Uint8Array): { offset: number; size: number; } | null {
    let off = 0;

    for (let i = 0; i < 4; i++) {
        if (off + 8 > bytes.byteLength) return null;

        const size = readU32(bytes, off);
        const type = readFourCC(bytes, off + 4);

        if (type === "ftyp") {
            if (size < 16 || off + size > bytes.byteLength) return null;
            return { offset: off, size };
        }

        // a file that starts with something else is not ISO-BMFF at all
        if (i === 0 && !["free", "skip", "wide", "moov", "mdat", "styp", "pdin"].includes(type)) return null;

        if (size < 8 || off + size > bytes.byteLength) return null;
        off += size;
    }

    return null;
}

/**
 * Turns an ISO-BMFF file into something Discord accepts as a clip:
 *  - `ftyp` major brand rewritten to `isom` (in place, so no offset shifts)
 *  - `isom` added to the compatible brand list when it is missing
 *  - the clip marker box appended
 *
 * Returns null when the input is not an MP4/MOV-family file.
 */
export function fixForClip(input: Uint8Array): Uint8Array | null {
    if (input.byteLength < 32) return null;

    const ftyp = findFtyp(input);
    if (!ftyp) return null;

    const out = new Uint8Array(input.byteLength + CLIP_BOX.byteLength);
    out.set(input, 0);

    writeFourCC(out, ftyp.offset + 8, "isom");

    // compatible brands live after major_brand (4) + minor_version (4)
    const brandsStart = ftyp.offset + 16;
    const brandsEnd = ftyp.offset + ftyp.size;
    let hasIsom = false;
    for (let p = brandsStart; p + 4 <= brandsEnd; p += 4) {
        if (readFourCC(out, p) === "isom") {
            hasIsom = true;
            break;
        }
    }
    if (!hasIsom && brandsEnd - 4 >= brandsStart) writeFourCC(out, brandsEnd - 4, "isom");

    out.set(CLIP_BOX, input.byteLength);
    return out;
}

/** Appends the clip marker to an already-`isom` MP4 (ffmpeg output). */
export function withClipBox(input: Uint8Array): Uint8Array {
    const out = new Uint8Array(input.byteLength + CLIP_BOX.byteLength);
    out.set(input, 0);
    out.set(CLIP_BOX, input.byteLength);
    return out;
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
