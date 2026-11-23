/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { access, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { IpcMainInvokeEvent } from "electron";

import { createGofileBatch, discardGofileBatch, GofileBatch, listGofileHistory, publishGofileBatch, revokeGofileTransfer } from "./gofile";
import { CHUNK_BYTES, EXPIRY_HOURS, FileProgress, MAX_BATCH_FILES, PublishedUpload, shouldTransfer, TRANSFER_LIMIT_BYTES, TRANSFER_PROVIDERS, TransferExpiry, TransferProvider, VIDEO_TARGET_BYTES } from "./shared";

const exec = promisify(execFile);
const lifetime = 5 * 60_000;
const toolTimeout = 20 * 60_000;
const inputOptions = [
    "-protocol_whitelist", "file",
    "-format_whitelist", "mov,matroska,webm,avi,asf,mpeg,mpegts,mpegvideo,flv,ogg,mxf,rm",
];

interface StagedFile {
    id: string;
    controller: AbortController;
    progress?: FileProgress;
    directory: string;
    handle: Awaited<ReturnType<typeof open>>;
    size: number;
    received: number;
    writing: boolean;
    videoSize?: number;
    timer: ReturnType<typeof setTimeout>;
}

const staged = new Map<number, StagedFile | null>();

async function removeStaging(owner: number, stage: StagedFile) {
    clearTimeout(stage.timer);
    try {
        await stage.handle.close();
    } finally {
        try {
            await rm(stage.directory, { recursive: true, force: true, maxRetries: 3 });
        } finally {
            staged.delete(owner);
        }
    }
}

function expiryTimer(owner: number, stage: StagedFile) {
    return setTimeout(() => {
        if (stage.writing) {
            stage.timer = expiryTimer(owner, stage);
            return;
        }
        void removeStaging(owner, stage).catch(() => {});
    }, lifetime).unref();
}

export async function beginFile({ sender }: IpcMainInvokeEvent, size: number) {
    if (!Number.isSafeInteger(size) || size < 1) {
        throw new Error("Invalid attachment size.");
    }
    const owner = sender.id;
    if (staged.has(owner)) throw new Error("Another attachment is already being processed.");
    staged.set(owner, null);

    let directory: string | undefined;
    try {
        directory = await mkdtemp(join(tmpdir(), "vencord-attachments-"));
        const handle = await open(join(directory, "input"), "wx", 0o600);
        const stage = { id: randomUUID(), controller: new AbortController(), directory, handle, size, received: 0, writing: false } as StagedFile;
        stage.timer = expiryTimer(owner, stage);
        staged.set(owner, stage);
        return stage.id;
    } catch (error) {
        staged.delete(owner);
        if (directory) await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

export function getProgress({ sender }: IpcMainInvokeEvent, id: string) {
    const stage = staged.get(sender.id);
    if (stage?.id === id) return stage.progress;
}

export function cancelFile({ sender }: IpcMainInvokeEvent, id: string) {
    const stage = staged.get(sender.id);
    if (stage?.id === id) stage.controller.abort();
}

export async function appendChunk({ sender }: IpcMainInvokeEvent, chunk: ArrayBuffer) {
    const stage = staged.get(sender.id);
    if (!stage || stage.writing || !(chunk instanceof ArrayBuffer)
        || chunk.byteLength < 1 || chunk.byteLength > CHUNK_BYTES
        || stage.received + chunk.byteLength > stage.size) {
        throw new Error("Invalid attachment chunk.");
    }

    stage.writing = true;
    try {
        await stage.handle.writeFile(Buffer.from(chunk));
        stage.received += chunk.byteLength;
    } finally {
        stage.writing = false;
        stage.timer.refresh();
    }
}

export async function discardFile({ sender }: IpcMainInvokeEvent) {
    const stage = staged.get(sender.id);
    if (stage && !stage.writing) {
        stage.writing = true;
        await removeStaging(sender.id, stage).catch(() => {});
    }
}

export async function readVideoChunk({ sender }: IpcMainInvokeEvent, id: string, offset: number) {
    const stage = staged.get(sender.id);
    if (!stage?.videoSize || stage.id !== id || stage.writing
        || !Number.isSafeInteger(offset) || offset < 0 || offset >= stage.videoSize) {
        throw new Error("Invalid compressed video chunk.");
    }
    stage.controller.signal.throwIfAborted();
    stage.writing = true;
    try {
        const handle = await open(join(stage.directory, "compressed.mp4"), "r");
        try {
            const data = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stage.videoSize - offset));
            const { bytesRead } = await handle.read(data, 0, data.length, offset);
            return data.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    } finally {
        stage.writing = false;
        stage.timer.refresh();
    }
}

async function runTool(
    tool: "ffmpeg" | "ffprobe",
    args: string[],
    timeout: number,
    signal: AbortSignal,
    onOutput?: (text: string) => void
) {
    let executable: string = tool;
    if (process.platform === "win32" && process.env.LOCALAPPDATA) {
        const wingetPath = join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", tool + ".exe");
        try {
            await access(wingetPath);
            executable = wingetPath;
        } catch {
            // Fall back to PATH.
        }
    }

    try {
        const run = exec(executable, args, { signal, timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
        if (onOutput) run.child.stdout?.on("data", onOutput);
        return (await run).stdout;
    } catch (error) {
        if (signal.aborted) throw new Error("Canceled.");
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; };
        if (failure.code === "ENOENT") throw new Error("Install FFmpeg and FFprobe, then relaunch Discord.");
        if (failure.killed) throw new Error("Video compression timed out.");
        throw new Error(tool + " could not read or encode this video.");
    }
}

async function encodeVideo(stage: StagedFile, maxBytes: number) {
    const { directory, controller: { signal } } = stage;
    const source = join(directory, "input");
    const output = join(directory, "compressed.mp4");
    stage.progress = { phase: "analyzing" };
    const probe = JSON.parse(await runTool("ffprobe", [
        "-v", "error", ...inputOptions, "-show_entries", "format=duration:stream=codec_type:stream_disposition=attached_pic",
        "-of", "json", source,
    ], 30_000, signal)) as {
        format?: { duration?: string; };
        streams?: Array<{ codec_type: string; disposition?: { attached_pic?: number; }; }>;
    };
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0
        || !probe.streams?.some(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic)) {
        throw new Error("Could not determine the video's duration or main video stream.");
    }

    const hasAudio = probe.streams.some(stream => stream.codec_type === "audio");
    const budget = Math.floor(maxBytes * 8 * 0.96 / duration / 1000);
    const audioRate = hasAudio ? Math.min(96, Math.max(24, Math.floor(budget / 5))) : 0;
    let videoRate = budget - audioRate;
    if (videoRate < 24) throw new Error("This video is too long to fit the attachment limit.");

    const deadline = Date.now() + toolTimeout;
    for (let attempt = 0; attempt < 3 && videoRate >= 24; attempt++) {
        const longEdge = videoRate >= 1200 ? 1280 : videoRate >= 600 ? 960 : videoRate >= 250 ? 640 : 426;
        const scale = "'min(iw," + longEdge + ")':'min(ih," + longEdge + ")':force_original_aspect_ratio=decrease:force_divisible_by=2";
        const passLog = join(directory, "pass");
        const base = [
            "-hide_banner", "-v", "error", "-nostdin", "-y", "-progress", "pipe:1", "-stats_period", "0.3",
            ...inputOptions, "-i", source,
            "-map", "0:V:0", "-map_metadata", "-1", "-map_chapters", "-1",
            "-vf", "scale=" + scale, "-fpsmax", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-preset", "fast", "-b:v", videoRate + "k", "-passlogfile", passLog,
        ];
        const encodePass = (pass: 1 | 2, args: string[]) => {
            let lastFraction = 0;
            let partialLine = "";
            stage.progress = { phase: "encoding", pass, attempt: attempt + 1, fraction: 0 };
            return runTool("ffmpeg", [...base, "-pass", String(pass), ...args], Math.max(1, deadline - Date.now()), signal, text => {
                const lines = (partialLine + text).split("\n");
                partialLine = lines.pop() ?? "";
                for (const line of lines) {
                    const timeUs = /^out_time_us=(\d+)\s*$/.exec(line);
                    if (timeUs) lastFraction = Math.max(lastFraction, Math.min(Number(timeUs[1]) / (duration * 1_000_000), 0.99));
                }
                stage.progress = { phase: "encoding", pass, attempt: attempt + 1, fraction: lastFraction };
            });
        };
        await encodePass(1, ["-an", "-f", "null", "-"]);
        await encodePass(2, [
            ...(hasAudio ? ["-map", "0:a:0", "-c:a", "aac", "-b:a", audioRate + "k", "-ac", "2"] : ["-an"]),
            "-movflags", "+faststart", output,
        ]);

        stage.progress = { phase: "checking" };
        const { size } = await stat(output);
        if (size > 0 && size <= maxBytes) return size;
        videoRate = Math.floor(videoRate * maxBytes / size * 0.9);
    }

    throw new Error("The compressed video still exceeds the attachment limit.");
}

async function verifyDownload(link: string, file: Blob, signal: AbortSignal, provider: TransferProvider) {
    const [expectedByte] = new Uint8Array(await file.slice(0, 1).arrayBuffer());
    let reason = "the download host could not be reached";

    // A successful upload can precede publication on the separate download host.
    for (const wait of [0, 500, 1200, 2500, 4500]) {
        if (wait) await delay(wait, undefined, { signal });
        try {
            const response = await fetch(link, {
                headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" },
                cache: "no-store",
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(6_000)]),
            });
            const validSize = response.status === 206
                ? response.headers.get("content-range") === `bytes 0-0/${file.size}`
                : response.status === 200 && response.headers.get("content-length") === String(file.size);
            if (!validSize || !response.body) {
                await response.body?.cancel().catch(() => {});
                reason = response.ok ? "the download had the wrong size" : `the download returned HTTP ${response.status}`;
                if ([401, 403, 410, 451].includes(response.status)) break;
                continue;
            }

            const reader = response.body.getReader();
            try {
                const { value } = await reader.read();
                if (value?.[0] === expectedByte) return;
                reason = "the downloaded bytes did not match the file";
            } finally {
                await reader.cancel().catch(() => {});
            }
        } catch {
            signal.throwIfAborted();
            reason = "the download host could not be reached";
        }
    }
    throw new Error(`${provider} returned a link, but ${reason}. Try attaching the original file again.`);
}

function multipartUpload(
    stage: StagedFile,
    file: Blob,
    fileName: string,
    fileField: string,
    fields: Record<string, string>,
    hash?: ReturnType<typeof createHash>,
    authorization?: string
) {
    const boundary = "SmartAttachments-" + randomUUID();
    const uploadName = fileName.replaceAll('"', "%22");
    const prefix = Object.entries(fields).map(([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ).join("")
        + `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${uploadName}"\r\n`
        + "Content-Type: application/octet-stream\r\n\r\n";
    const payload = new Blob([prefix, file, `\r\n--${boundary}--\r\n`]);
    const prefixBytes = Buffer.byteLength(prefix);
    return async (url: string) => {
        let streamed = 0;
        let sending = true;
        stage.progress = { phase: "uploading", bytes: 0 };
        const body = payload.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                const firstFileByte = prefixBytes - streamed;
                const lastFileByte = firstFileByte + file.size;
                if (hash && firstFileByte < chunk.byteLength && lastFileByte > 0) {
                    hash.update(chunk.subarray(Math.max(0, firstFileByte), Math.min(lastFileByte, chunk.byteLength)));
                }
                streamed += chunk.byteLength;
                if (sending) stage.progress = { phase: "uploading", bytes: Math.min(file.size, Math.max(0, streamed - prefixBytes)) };
                controller.enqueue(chunk);
            },
            flush() {
                if (sending) stage.progress = { phase: "confirming" };
            },
        }));
        const request: RequestInit & { duplex: "half"; } = {
            method: "POST",
            body,
            duplex: "half",
            headers: {
                "Content-Type": "multipart/form-data; boundary=" + boundary,
                "Content-Length": String(payload.size),
                ...(authorization ? { Authorization: authorization } : {}),
            },
            redirect: "error",
            signal: AbortSignal.any([stage.controller.signal, AbortSignal.timeout(10 * 60_000)]),
        };
        try {
            return await fetch(url, request);
        } finally {
            sending = false;
        }
    };
}

async function uploadToLitterbox(stage: StagedFile, fileName: string, expiry: typeof EXPIRY_HOURS[number]) {
    const file = await openAsBlob(join(stage.directory, "input"));
    const { signal } = stage.controller;
    const send = multipartUpload(stage, file, fileName, "fileToUpload", { reqtype: "fileupload", time: expiry });
    const retryDelays = [1100, 2800];
    for (let attempt = 0; ; attempt++) {
        const response = await send("https://litterbox.catbox.moe/resources/internals/api.php");
        if (response.ok) {
            const link = (await response.text()).trim();
            if (!/^https:\/\/litter\.catbox\.moe\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(link)) {
                throw new Error("Litterbox did not return a download link.");
            }
            stage.progress = { phase: "verifying" };
            await verifyDownload(link, file, signal, "Litterbox");
            return link;
        }

        await response.body?.cancel().catch(() => {});
        const { status } = response;
        if (![408, 429, 500, 502, 503, 504].includes(status)) {
            throw new Error(`Litterbox rejected the file (HTTP ${status}).`);
        }
        const retryAfter = response.headers.get("retry-after")?.trim();
        const requestedWait = retryAfter && /^\d+$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Math.max(0, Date.parse(retryAfter ?? "") - Date.now()) || 0;
        if (attempt >= retryDelays.length || requestedWait > 15_000) {
            const explanation = status === 429 ? "Litterbox rate-limited this upload"
                : status === 408 ? "Litterbox timed out on this upload"
                    : "Litterbox couldn’t complete this upload";
            throw new Error(`${explanation} (HTTP ${status}).`);
        }
        stage.progress = { phase: "retrying", attempt: attempt + 2, total: retryDelays.length + 1 };
        await delay(Math.max(requestedWait, retryDelays[attempt]), undefined, { signal });
    }
}

const gofileBatches = new Map<number, Promise<GofileBatch>>();

export async function beginGofileBatch({ sender }: IpcMainInvokeEvent, expiry: TransferExpiry) {
    if (!EXPIRY_HOURS.includes(expiry) || gofileBatches.has(sender.id)) throw new Error("Invalid Gofile batch.");
    const batch = createGofileBatch(expiry);
    gofileBatches.set(sender.id, batch);
    try {
        await batch;
    } catch (error) {
        if (gofileBatches.get(sender.id) === batch) gofileBatches.delete(sender.id);
        throw error;
    }
}

export async function finishGofileBatch({ sender }: IpcMainInvokeEvent) {
    const pending = gofileBatches.get(sender.id);
    if (!pending) return;
    gofileBatches.delete(sender.id);
    const batch = await pending;
    let published = false;
    try {
        if (batch.incomplete) throw new Error("Gofile could not verify all uploads to this folder.");
        if (!batch.files.length) return;
        const result = await publishGofileBatch(batch);
        published = true;
        return result;
    } finally {
        if (!published) await discardGofileBatch(batch);
    }
}

export async function discardUnverifiedGofileBatch({ sender }: IpcMainInvokeEvent) {
    const pending = gofileBatches.get(sender.id);
    if (!pending) return false;
    const batch = await pending;
    if (!batch.incomplete || gofileBatches.get(sender.id) !== pending) return false;
    gofileBatches.delete(sender.id);
    await discardGofileBatch(batch);
    return true;
}

export async function getTransferHistory(_event: IpcMainInvokeEvent) {
    return listGofileHistory();
}

export async function revokeTransfer(_event: IpcMainInvokeEvent, id: string) {
    return revokeGofileTransfer(id);
}

async function uploadToGofile(senderId: number, stage: StagedFile, fileName: string) {
    const pending = gofileBatches.get(senderId);
    if (!pending) throw new Error("Gofile batch has not been started.");
    const batch = await pending;
    if (batch.incomplete || batch.files.length >= MAX_BATCH_FILES) throw new Error("Gofile could not continue this batch.");
    if (batch.files.some(file => file.name.toLowerCase() === fileName.toLowerCase())) {
        throw new Error("Gofile already has a file with this name in the batch. Choose a different name and attach it again.");
    }
    const file = await openAsBlob(join(stage.directory, "input"));
    const hash = createHash("md5");
    const send = multipartUpload(stage, file, fileName, "file", { folderId: batch.id }, hash, `Bearer ${batch.token}`);
    batch.incomplete = true;
    const response = await send("https://upload.gofile.io/uploadfile");
    const receipt = await response.json().catch(() => null) as {
        status?: string;
        data?: { parentFolder?: string; name?: string; code?: string; size?: number; md5?: string; };
    } | null;
    if (!response.ok || receipt?.status !== "ok") {
        throw new Error(`Gofile rejected the file (HTTP ${response.status}).`);
    }
    const { parentFolder, name, code, size, md5 } = receipt.data ?? {};
    if (parentFolder !== batch.id || size !== file.size || md5 !== hash.digest("hex")
        || typeof name !== "string" || !name || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name)
        || typeof code !== "string" || !/^[a-zA-Z0-9]{6,8}$/.test(code)
        || batch.files.some(file => file.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("Gofile returned an upload receipt that doesn’t match the file or folder.");
    }
    batch.files.push({ name, code });
    batch.incomplete = false;
    return { gofileName: name };
}

async function uploadToFilebin(stage: StagedFile, fileName: string): Promise<PublishedUpload> {
    const { signal } = stage.controller;
    const id = randomUUID().replaceAll("-", "");
    const page = `https://filebin.net/${id}`;
    const url = `${page}/${encodeURIComponent(fileName)}`;
    const file = await openAsBlob(join(stage.directory, "input"));
    const hash = createHash("sha256");
    let bytes = 0;
    stage.progress = { phase: "uploading", bytes };
    const body = file.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            hash.update(chunk);
            bytes += chunk.byteLength;
            stage.progress = { phase: "uploading", bytes };
            controller.enqueue(chunk);
        },
        flush() {
            stage.progress = { phase: "confirming" };
        },
    }));
    const request: RequestInit & { duplex: "half"; } = {
        method: "POST",
        body,
        duplex: "half",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(file.size) },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
    };

    let uploaded = false;
    try {
        const response = await fetch(url, request);
        if (response.status !== 201) {
            if (response.status === 403 && /\.exe$/i.test(fileName)) {
                const reason = await response.text();
                if (/illegal file extension/i.test(reason)) {
                    throw new Error("Filebin doesn’t accept .exe uploads. Select Gofile in SmartAttachments settings, then attach the file again.");
                }
                throw new Error("Filebin rejected the file (HTTP 403).");
            }
            await response.body?.cancel().catch(() => {});
            throw new Error(`Filebin rejected the file (HTTP ${response.status}).`);
        }
        uploaded = true;
        const saved = await response.json() as { file?: { filename: string; bytes: number; sha256: string; }; };
        const digest = hash.digest("hex");
        if (saved.file?.bytes !== file.size || saved.file.sha256 !== digest) {
            throw new Error("Filebin returned an upload receipt that doesn’t match the file.");
        }

        stage.progress = { phase: "verifying" };
        const listing = await fetch(page, {
            headers: { Accept: "application/json" },
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
        });
        if (!listing.ok) {
            await listing.body?.cancel().catch(() => {});
            throw new Error(`Filebin couldn’t verify the share link (HTTP ${listing.status}).`);
        }
        const published = await listing.json() as {
            bin?: { id: string; expired_at: string; };
            files?: Array<{ filename: string; bytes: number; sha256: string; }>;
        };
        if (published.bin?.id !== id || !(Date.parse(published.bin.expired_at) > Date.now())
            || !published.files?.some(item => item.filename === saved.file?.filename && item.bytes === file.size && item.sha256 === digest)) {
            throw new Error("Filebin did not list the verified file at the share link.");
        }
        const downloadUrl = `${page}/${encodeURIComponent(saved.file.filename)}`;
        const options: RequestInit = {
            redirect: "manual",
            signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
        };
        let download = await fetch(downloadUrl, options);
        if (download.status === 200 && download.headers.get("content-type")?.includes("text/html")) {
            const cookie = download.headers.getSetCookie().map(value => value.split(";")[0]).find(value => value.startsWith("verified="));
            await download.body?.cancel().catch(() => {});
            if (!cookie) throw new Error("Filebin did not return its download confirmation cookie.");
            download = await fetch(downloadUrl, { ...options, headers: { Cookie: cookie } });
        }
        const location = download.headers.get("location");
        await download.body?.cancel().catch(() => {});
        if (download.status !== 302 || !location) {
            throw new Error(`Filebin didn’t make the file available for download (HTTP ${download.status}).`);
        }
        const storage = new URL(location);
        if (storage.origin !== "https://storage.filebin.net" || storage.username || storage.password) {
            throw new Error("Filebin returned an unexpected storage address.");
        }
        await verifyDownload(storage.href, file, signal, "Filebin");
        return { url: page, downloadName: saved.file.filename };
    } catch (error) {
        if (uploaded) {
            await fetch(page, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(4_000) })
                .then(response => response.body?.cancel()).catch(() => {});
        }
        throw error;
    }
}

export async function finishFile(
    { sender }: IpcMainInvokeEvent,
    operation: { maxBytes: number; } | { fileName: string; expiry: TransferExpiry; provider?: TransferProvider; transferThreshold?: number; }
): Promise<Buffer | PublishedUpload | { gofileName: string; } | { videoSize: number; }> {
    const stage = staged.get(sender.id);
    if (!stage || stage.writing || stage.videoSize || stage.received !== stage.size) throw new Error("Incomplete attachment.");
    stage.writing = true;
    clearTimeout(stage.timer);
    try {
        stage.controller.signal.throwIfAborted();
        await stage.handle.close();
        if ("maxBytes" in operation) {
            const { maxBytes } = operation;
            if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > TRANSFER_LIMIT_BYTES) {
                throw new Error("Invalid video size cap.");
            }
            const videoSize = await encodeVideo(stage, maxBytes);
            if (videoSize <= VIDEO_TARGET_BYTES) return await readFile(join(stage.directory, "compressed.mp4"));
            stage.videoSize = videoSize;
            return { videoSize };
        }

        const { fileName, expiry, provider = "Litterbox", transferThreshold = VIDEO_TARGET_BYTES } = operation;
        if (typeof fileName !== "string" || !fileName || fileName.length > 255 || /[\\/\x00-\x1f\x7f]/.test(fileName)
            || !EXPIRY_HOURS.includes(expiry) || !TRANSFER_PROVIDERS.includes(provider)
            || !Number.isSafeInteger(transferThreshold) || transferThreshold < 1
            || !shouldTransfer(stage.size, fileName, provider, transferThreshold) || stage.size > TRANSFER_LIMIT_BYTES) {
            throw new Error("Invalid transfer request.");
        }
        try {
            if (provider === "Filebin") return await uploadToFilebin(stage, fileName);
            if (provider === "Gofile") return await uploadToGofile(sender.id, stage, fileName);
            return { url: await uploadToLitterbox(stage, fileName, expiry) };
        } catch (error) {
            if (stage.controller.signal.aborted) throw new Error("Canceled.");
            if (error instanceof Error && error.message.startsWith(provider + " ")) throw error;
            throw new Error(`Could not reach ${provider}. Check your network before trying again.`);
        }
    } finally {
        if (stage.videoSize) {
            stage.writing = false;
            stage.timer = expiryTimer(sender.id, stage);
        } else {
            await removeStaging(sender.id, stage).catch(() => {});
        }
    }
}
