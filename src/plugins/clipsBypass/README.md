# ClipsBypass

Raises the attachment limit to 100 MB by sending files as Discord Clips.

Clips are a first-class Discord upload type with a 100 MB cap; the client already contains the
whole code path. The plugin routes files above your normal limit through it: the size-limit
function returns 100 MB, and the upload gets an `isom`-branded MP4 with Discord's 24-byte clip
marker appended, plus the clip metadata.

MP4/MOV needs no re-encoding (an 8-byte brand rewrite and a 24-byte append). Other formats and
audio go through ffmpeg.wasm.

| setting | default | meaning |
| --- | --- | --- |
| Threshold (MiB) | 20 | files larger than this are sent as clips |
| Convert non-MP4 | on | use ffmpeg.wasm for mkv/webm/audio |
| ffmpeg base URL | jsDelivr mirror | where the four ffmpeg.wasm files are fetched from |
| Toasts | on | show a toast when a file is converted |

## How it works

Two webpack patches:

1. the per-user/per-guild attachment limit (`Math.max(20 MiB, guild limit)`), which both the
   drop gate and the upload gate read;
2. the per-file prepare hook, which already exists for HEIC/JXR images. It hands the upload a
   rewritten File and a `clip` object, and `CloudUpload` copies that onto the upload, so the
   attachment request goes out with `is_clip: true`.

Verified against the current Discord web bundle with `tools/verify-patches.cjs`; if a Discord
update moves either anchor, that script says so in one run.
