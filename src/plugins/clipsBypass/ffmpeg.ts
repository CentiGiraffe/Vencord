/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

import { extensionOf, withClipBox } from "./mp4";

const logger = new Logger("ClipsBypass/FFmpeg");

type FFmpegInstance = {
    load(opts: { coreURL: string; wasmURL: string; }): Promise<void>;
    writeFile(name: string, data: Uint8Array): Promise<boolean>;
    exec(args: string[]): Promise<number>;
    readFile(name: string): Promise<Uint8Array | string>;
    deleteFile(name: string): Promise<boolean>;
    terminate(): void;
    on(event: "log", cb: (e: { message: string; }) => void): void;
};

let instance: FFmpegInstance | null = null;
let loading: Promise<FFmpegInstance> | null = null;

export function isFFmpegLoaded(): boolean {
    return instance !== null;
}

/** One shared instance for the whole session. */
export function ensureFFmpeg(baseUrl: string): Promise<FFmpegInstance> {
    if (instance) return Promise.resolve(instance);
    if (!loading) {
        loading = loadFFmpeg(baseUrl).then(ff => {
            instance = ff;
            return ff;
        }).finally(() => {
            loading = null;
        });
    }
    return loading;
}

export function disposeFFmpeg(): void {
    try {
        instance?.terminate();
    } catch {
        /* already gone */
    }
    instance = null;
}

async function blobUrlFor(url: string): Promise<string> {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return URL.createObjectURL(await res.blob());
}

async function loadFFmpeg(baseUrl: string): Promise<FFmpegInstance> {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const revoke: string[] = [];

    try {
        // 1. the worker chunk, served from a blob so it can live on a CDN
        const workerUrl = await blobUrlFor(`${base}814.ffmpeg.js`);
        revoke.push(workerUrl);

        // 2. @ffmpeg/ffmpeg's UMD bundle, with its worker URL baked in
        const res = await fetch(`${base}ffmpeg.js`, { cache: "force-cache" });
        if (!res.ok) throw new Error(`${base}ffmpeg.js → HTTP ${res.status}`);
        let src = await res.text();

        const before = src;
        src = src.replace("new URL(e.p+e.u(814),e.b)", JSON.stringify(workerUrl));
        if (src === before) {
            throw new Error(
                "ffmpeg.js did not contain the expected worker reference — the CDN files changed. "
                + "Point the plugin's ffmpeg base URL at YABDP4Nitro's own /ffmpeg/ folder."
            );
        }

        const wrapperUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        revoke.push(wrapperUrl);

        await injectScript(wrapperUrl, "ffmpegWasmScript");
        // the wrapper has executed; the worker blob must survive until the
        // FFmpeg instance is constructed below, so both URLs are kept for now

        const FFmpegCtor = (window as any).FFmpegWASM?.FFmpeg;
        if (!FFmpegCtor) throw new Error("ffmpeg.js loaded but window.FFmpegWASM.FFmpeg is missing");

        // 3. core js + wasm
        const coreUrl = await blobUrlFor(`${base}ffmpeg-core.js`);
        const wasmUrl = await blobUrlFor(`${base}ffmpeg-core.wasm`);
        revoke.push(coreUrl, wasmUrl);

        const ff = new FFmpegCtor() as FFmpegInstance;
        ff.on("log", ({ message }) => logger.info(message));

        await ff.load({ coreURL: coreUrl, wasmURL: wasmUrl });
        logger.info("ffmpeg.wasm ready");

        // everything the worker needed has been fetched by now
        for (const url of revoke) URL.revokeObjectURL(url);

        return ff;
    } catch (err) {
        for (const url of revoke) {
            try {
                URL.revokeObjectURL(url);
            } catch { /* ignore */ }
        }
        throw err;
    }
}

function injectScript(src: string, id: string): Promise<void> {
    return new Promise((resolve, reject) => {
        document.getElementById(id)?.remove();

        // Discord's bundle chain sometimes defines an AMD `define`; the UMD
        // wrapper would then take the AMD branch and never set window.FFmpegWASM.
        const w = window as any;
        const hadDefine = "define" in w;
        const savedDefine = w.define;
        if (hadDefine) w.define = undefined;

        const script = document.createElement("script");
        script.id = id;
        script.src = src;
        script.onload = () => {
            if (hadDefine) w.define = savedDefine;
            resolve();
        };
        script.onerror = () => {
            if (hadDefine) w.define = savedDefine;
            reject(new Error("failed to evaluate the ffmpeg wrapper script"));
        };
        document.head.appendChild(script);
    });
}

const VIDEO_ARGS = (input: string, output: string) => [
    "-i", input,
    "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", "-dn",
    "-brand", "isom/avc1",
    "-movflags", "+faststart",
    "-map", "0", "-map_metadata", "-1", "-map_chapters", "-1",
    "-map", "-0:t", "-strict", "-2",
    output
];

const AUDIO_ARGS = (input: string, output: string) => [
    "-i", input,
    "-f", "lavfi", "-i", "color=c=black:s=300x100",
    "-shortest", "-fflags", "+shortest",
    "-map", "0:v?", "-map", "1:v", "-map", "0:a",
    "-disposition:v", "default",
    "-brand", "isom/avc1", "-movflags", "+faststart",
    "-map_metadata", "-1", "-dn", "-map_chapters", "-1",
    "-preset", "ultrafast",
    "-c:v", "libx264", "-c:a", "copy",
    "-strict", "-2", "-tune", "stillimage", "-r", "5",
    "-pix_fmt", "yuv420p",
    "-vf", "crop=trunc(iw/2)*2:trunc(ih/2)*2",
    "-max_interleave_delta", "1",
    output
];

/**
 * Remuxes a video (or wraps audio into a still-frame video) into an
 * `isom`-branded MP4 and appends the clip marker.
 */
export async function transcodeToClip(
    file: File,
    kind: "video" | "audio",
    baseUrl: string
): Promise<Uint8Array | null> {
    const ff = await ensureFFmpeg(baseUrl);

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const input = `in_${stamp}.${extensionOf(file.name) || (kind === "audio" ? "audio" : "video")}`;
    const output = `out_${stamp}.mp4`;

    const bytes = new Uint8Array(await file.arrayBuffer());
    await ff.writeFile(input, bytes);

    const args = kind === "video" ? VIDEO_ARGS(input, output) : AUDIO_ARGS(input, output);
    logger.info("ffmpeg " + args.join(" "));

    try {
        await ff.exec(args);

        let data: Uint8Array;
        try {
            const read = await ff.readFile(output);
            data = typeof read === "string" ? new TextEncoder().encode(read) : read;
        } catch {
            throw new Error("ffmpeg produced no output — the codecs in this file cannot be remuxed into MP4");
        }

        if (!data || data.byteLength === 0) throw new Error("ffmpeg output was empty");

        return withClipBox(data);
    } finally {
        // keep the virtual FS clean, ignore failures
        ff.deleteFile(input).catch(() => void 0);
        ff.deleteFile(output).catch(() => void 0);
    }
}
