/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { showToast,UserStore } from "@webpack/common";

import { disposeFFmpeg, ensureFFmpeg, transcodeToClip } from "./ffmpeg";
import {
    ClipData,
    clipKind,
    CLIPS_MAX_SIZE,
    fixForClip,
    formatBytes,
    makeClipData,
    mp4Name
} from "./mp4";

const logger = new Logger("ClipsBypass");

/** Runtime switch: only the *behaviour* is gated, the webpack patches stay applied. */
let active = false;

const FFMPEG_URL = "https://cdn.jsdelivr.net/gh/riolubruh/YABDP4Nitro@main/ffmpeg/";

const settings = definePluginSettings({
    thresholdMB: {
        type: OptionType.SLIDER,
        description: "Files larger than this (MiB) are sent as clips. Smaller files upload normally.",
        default: 20,
        markers: [8, 10, 20, 25, 50, 100],
        stickToMarkers: false
    },
    convertNonMp4: {
        type: OptionType.BOOLEAN,
        description: "Remux non-MP4 video and wrap audio with ffmpeg.wasm (~32 MiB, downloaded once)",
        default: true
    },
    ffmpegBaseUrl: {
        type: OptionType.STRING,
        description: "Folder holding 814.ffmpeg.js, ffmpeg.js, ffmpeg-core.js and ffmpeg-core.wasm",
        default: FFMPEG_URL
    },
    toasts: {
        type: OptionType.BOOLEAN,
        description: "Toast when a file gets converted",
        default: true
    }
});

/** Settings are read from inside patched code, where a throw would take the drop handler down. */
function setting<K extends keyof typeof settings.def>(key: K, fallback: typeof settings.def[K]["default"]) {
    try {
        return settings.store[key] ?? fallback;
    } catch {
        return fallback;
    }
}

function toast(text: string, variant: "success" | "critical" | "default" = "default") {
    if (!setting("toasts", true)) return;
    showToast({ text, variant });
}

function asClipItem(item: any, original: File, bytes: Uint8Array): any {
    const userId = UserStore.getCurrentUser()?.id;
    const clip: ClipData = makeClipData(original, userId);

    const file = new File([bytes.buffer as ArrayBuffer], mp4Name(original.name), {
        type: "video/mp4",
        lastModified: original.lastModified
    });

    logger.info(`"${original.name}" (${formatBytes(original.size)}) -> clip ${file.name} (${formatBytes(file.size)})`);
    toast(`Sent as clip — ${formatBytes(file.size)}`, "success");

    return {
        ...item,
        file,
        clip,
        // keeps the HEIC/JXR converter from touching the item again
        imageConversionEvaluated: true
    };
}

export default definePlugin({
    name: "ClipsBypass",
    description: "Upload up to 100 MB by sending big videos as Discord Clips (port of YABDP4Nitro's Clips plugin)",
    tags: ["Media", "Utility"],
    authors: [Devs.YG],
    settings,

    patches: [
        {
            // module 409481:  let i=0x1400000; function r(e){return Math.max(i,e)}
            // The per-user/per-guild attachment limit. Everything reads it:
            //   - fJ()  the drop/paste gate            (e.size > C(guildId))
            //   - MessageAttachmentUploadTarget.getMaxFileSize()  the upload gate
            //     CloudUpload.upload() -> currentSize > getMaxFileSize(channelId)
            find: /let \i=0x1400000;function \i\(\i\)\{return Math\.max\(\i,\i\)\}/,
            replacement: {
                match: /function (\i)\((\i)\)\{return Math\.max\((\i),\2\)\}/,
                replace: "function $1($2){return Math.max($self.maxFileSizeLimit(),$3,$2)}"
            }
        },
        {
            // module 111542, N(): async function l(e){let t=a(e); …
            // Runs on every dropped/pasted file, before UploadManager.addFiles().
            find: /platform!==\i\.x\.WEB\|\|!0===\i\.imageConversionEvaluated/,
            replacement: {
                match: /async function (\i)\((\i)\)\{let (\i)=(\i)\(\2\);/,
                replace: "async function $1($2){const __clip=await $self.maybeClipify($2);if(__clip)return __clip;let $3=$4($2);"
            }
        }
    ],

    start() {
        active = true;
    },

    stop() {
        active = false;
        disposeFFmpeg();
    },

    /** Patched into the size gate. 0 keeps Discord's own limit. */
    maxFileSizeLimit(): number {
        return active ? CLIPS_MAX_SIZE : 0;
    },

    /**
     * Patched into the per-file prepare step.
     * Returns a replacement item, or null to leave the file alone.
     */
    async maybeClipify(item: any): Promise<any | null> {
        if (!active) return null;

        const file: File | undefined = item?.file;
        if (!(file instanceof File) || item.clip) return null;
        if (item.platform !== undefined && item.platform !== 1) return null;

        const threshold = Math.max(1, setting("thresholdMB", 20)) * 1024 * 1024;
        if (file.size <= threshold) return null;

        if (file.size > CLIPS_MAX_SIZE) {
            toast(`"${file.name}" is ${formatBytes(file.size)} — clips stop at 100 MiB`, "critical");
            return null;
        }

        const kind = clipKind(file);
        if (kind === "other") return null;

        try {
            if (kind === "video") {
                // Fast path: MP4/MOV already — rewrite the brand, append the marker.
                // No re-encode, no download, works for any H.264/H.265 MP4.
                const fixed = fixForClip(new Uint8Array(await file.arrayBuffer()));
                if (fixed) return asClipItem(item, file, fixed);
            }

            if (!setting("convertNonMp4", true)) {
                toast(`"${file.name}" is not an MP4 — enable ffmpeg conversion or re-encode it`, "critical");
                return null;
            }

            toast(`Converting "${file.name}"…`, "default");
            const converted = await transcodeToClip(file, kind === "audio" ? "audio" : "video", setting("ffmpegBaseUrl", FFMPEG_URL));
            if (converted) return asClipItem(item, file, converted);

            return null;
        } catch (err) {
            logger.error("clip conversion failed", err);
            toast(`Could not convert "${file.name}" — see the console`, "critical");
            return null;
        }
    },

    // exposed for the "ffmpeg warm up" console command
    async warmFFmpeg() {
        await ensureFFmpeg(setting("ffmpegBaseUrl", FFMPEG_URL));
    }
});
