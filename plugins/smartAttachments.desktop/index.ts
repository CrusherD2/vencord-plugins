/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { UploadIcon } from "@components/Icons";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { findByCodeLazy, findByPropsLazy } from "@webpack";
import { ComponentDispatch, DraftStore, DraftType, React, showToast, UploadHandler } from "@webpack/common";

import { showTransferHistory, TransferHistoryButton } from "./history";
import { reviewAttachmentNames } from "./names";
import { AttachmentRoute, AttachmentStatus, createAttachmentButton, createAttachmentProgress, PreparedAttachment, showAttachmentProgress } from "./progress";
import { CHUNK_BYTES, EXPIRY_HOURS, formatTransferLink, INSERT_LINKS_EVENT, isVideo, MAX_BATCH_FILES, shouldTransfer, TRANSFER_LIMIT_BYTES, TransferLink, TransferProvider, VIDEO_TARGET_BYTES } from "./shared";

const native = VencordNative.pluginHelpers.SmartAttachments as PluginNative<typeof import("./native")>;

function openGofileHistory() {
    showTransferHistory(native.getTransferHistory, native.revokeTransfer);
}

const settings = definePluginSettings({
    externalUploads: {
        type: OptionType.BOOLEAN,
        description: "Include non-video files in external uploads. Gofile also handles .exe files.",
        default: true,
    },
    sizePolicy: {
        type: OptionType.SELECT,
        description: "Size limit used before compression or external upload",
        options: [
            { label: "Match this chat’s Discord limit", value: "discord", default: true },
            { label: "20 MB target", value: "20mb" },
        ],
    },
    transferProvider: {
        type: OptionType.SELECT,
        description: "External upload service",
        options: [
            { label: "Gofile (.exe support, configurable expiry)", value: "Gofile", default: true },
            { label: "Filebin (up to 7 days, link holders can delete)", value: "Filebin" },
            { label: "Litterbox (configurable expiry)", value: "Litterbox" },
        ],
    },
    expiry: {
        type: OptionType.SELECT,
        description: "Default link expiry for Gofile and Litterbox. You can change it for each batch.",
        options: EXPIRY_HOURS.map(value => ({ label: value, value, default: value === "72h" })),
    },
});

interface UploadOptions {
    filesMetadata?: unknown[];
    isThumbnail?: boolean;
    requireConfirm?: boolean;
}

type DiscordDraftType = Parameters<typeof DraftStore.getDraft>[1];
type UploadPrompt = (files: File[], channel: Channel, draftType: DiscordDraftType, options?: UploadOptions) => Promise<void>;

interface LinkInsertEvent {
    channelId: string;
    text: string;
    inserted: boolean;
}

interface ComposerProps {
    channel?: Channel;
    disabled?: boolean;
    type?: { drafts?: { type: DiscordDraftType; }; };
}

interface InsertTextArgs {
    plainText: string;
    rawText: string;
}

const getDiscordUploadLimit = findByCodeLazy(".getUserMaxFileSize(", ".getGuild(", "return Math.max(") as
    (guildId?: string) => number;

const DraftActions = findByPropsLazy("clearDraft", "saveDraft");
let queue = Promise.resolve();

function discordUploadLimit(channel: Channel) {
    try {
        const limit = getDiscordUploadLimit(channel.getGuildId());
        return Number.isSafeInteger(limit) && limit > 0 ? limit : VIDEO_TARGET_BYTES;
    } catch {
        return VIDEO_TARGET_BYTES;
    }
}

async function processFile(
    file: File,
    operation: Parameters<typeof native.finishFile>[0],
    signal: AbortSignal,
    report: (status: AttachmentStatus) => void
) {
    if ("fileName" in operation && file.size > TRANSFER_LIMIT_BYTES) {
        throw new Error("SmartAttachments supports transfers up to 1 GB.");
    }
    signal.throwIfAborted();
    report({ phase: "preparing", bytes: 0 });
    const id = await native.beginFile(file.size);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    const cancel = () => { void native.cancelFile(id).catch(() => {}); };
    const poll = async () => {
        try {
            const status = await native.getProgress(id);
            if (!finished && status) report(status);
        } catch {
            // Progress is optional and the native operation reports its own result.
        } finally {
            if (!finished) timer = setTimeout(poll, 220);
        }
    };
    try {
        for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
            signal.throwIfAborted();
            const end = Math.min(offset + CHUNK_BYTES, file.size);
            const chunk = await file.slice(offset, end).arrayBuffer();
            signal.throwIfAborted();
            await native.appendChunk(chunk);
            report({ phase: "preparing", bytes: end });
        }
        signal.throwIfAborted();
        signal.addEventListener("abort", cancel, { once: true });
        report("maxBytes" in operation ? { phase: "analyzing" } : { phase: "uploading", bytes: 0 });
        timer = setTimeout(poll, 220);
        const result = await native.finishFile(operation);
        if (!("maxBytes" in operation)) return result;

        const size = "videoSize" in result ? result.videoSize : "byteLength" in result ? result.byteLength : 0;
        if (!size || size > operation.maxBytes) throw new Error("The encoder did not return a video within the size limit.");
        const chunks: BlobPart[] = [];
        if ("videoSize" in result) {
            for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
                signal.throwIfAborted();
                const chunk = await native.readVideoChunk(id, offset);
                if (chunk.byteLength !== Math.min(CHUNK_BYTES, size - offset)) throw new Error("The compressed video could not be read.");
                chunks.push(new Uint8Array(chunk));
            }
        } else if ("byteLength" in result) {
            chunks.push(new Uint8Array(result));
        }
        const name = file.name.replace(/\.[^.]+$/, "") || "video";
        return new File(chunks, name + "-compressed.mp4", { type: "video/mp4" });
    } finally {
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        await native.discardFile().catch(() => {});
    }
}

async function addLinksToDraft(channelId: string, links: TransferLink[]) {
    const event: LinkInsertEvent = { channelId, text: links.map(formatTransferLink).join("\n"), inserted: false };
    try {
        ComponentDispatch.dispatch(INSERT_LINKS_EVENT, event);
        if (!event.inserted) {
            const type = DraftType.ChannelMessage;
            const existing = DraftStore.getDraft(channelId, type);
            DraftActions.saveDraft(channelId, existing ? existing + "\n" + event.text : event.text, type, DraftStore.getDraftCommand(channelId, type));
        }
        return links.length === 1 ? "Download link added to the original chat draft." : "Download links added to the original chat draft.";
    } catch {
        try {
            await copyToClipboard(links.map(link => link.url).join("\n"));
            return "Couldn’t update the draft. Copied the download links to the clipboard.";
        } catch {
            return "Couldn’t update the draft. Use the copy button to retrieve the download links.";
        }
    }
}

function errorMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");
}

interface BatchPolicy {
    limit: number;
    transferThreshold: number;
    externalUploads: boolean;
    expiry: typeof EXPIRY_HOURS[number];
    provider: TransferProvider;
}

function routeFile(file: File, { limit, transferThreshold, externalUploads, provider }: BatchPolicy): AttachmentRoute {
    if (isVideo(file)) return file.size > limit ? "video" : "discord";
    return externalUploads && shouldTransfer(file.size, file.name, provider, transferThreshold) ? "transfer" : "discord";
}

function planAttachments(files: File[], policy: BatchPolicy): PreparedAttachment[] {
    return files.map(file => ({ file, route: routeFile(file, policy), name: file.name }));
}

function warnBatchLimit() {
    showToast({ text: `Choose up to ${MAX_BATCH_FILES} files per batch.`, variant: "critical" });
}

async function openFromComposer(files: File[], channel: Channel) {
    if (files.length > MAX_BATCH_FILES) {
        warnBatchLimit();
        return;
    }
    const prompt = UploadHandler.promptToUpload as unknown as UploadPrompt;
    try {
        await prompt(files, channel, DraftType.ChannelMessage);
    } catch (error) {
        showToast({ text: "Couldn’t add files. " + errorMessage(error), variant: "critical" });
    }
}

function queueBatch(
    items: PreparedAttachment[],
    channel: Channel,
    draftType: DiscordDraftType,
    options: UploadOptions | undefined,
    policy: BatchPolicy,
    reviewNames = false
) {
    queue = queue.then(async () => {
        const prepared = reviewNames
            ? await reviewAttachmentNames(items, policy.provider, policy.expiry, "Upload", true)
            : { items, expiry: policy.expiry };
        if (prepared) await processBatch(prepared.items, channel, draftType, options, { ...policy, expiry: prepared.expiry });
    }).catch(error => {
        showToast({ text: "Could not finish adding attachments. " + errorMessage(error), variant: "critical" });
    });
    return queue;
}

async function processBatch(
    items: PreparedAttachment[],
    channel: Channel,
    draftType: DiscordDraftType,
    options: UploadOptions | undefined,
    policy: BatchPolicy
) {
    const { limit: maxBytes, transferThreshold, expiry, provider } = policy;
    const work = items.map((item, index) => ({
        ...item,
        metadata: options?.filesMetadata?.[index],
    }));
    const progress = createAttachmentProgress(
        items, maxBytes, expiry, provider,
        async selected => (await reviewAttachmentNames(planAttachments(selected, policy), provider, expiry, "Add to queue"))?.items ?? null,
        (selected, sameBatch) => {
            if (sameBatch) work.push(...selected.map(item => ({ ...item, metadata: undefined })));
            else void queueBatch(selected, channel, draftType, undefined, policy);
        },
        provider === "Gofile" ? openGofileHistory : undefined
    );
    progress.show();
    const attachments = new Map<number, { file: File; metadata: unknown; }>();
    const links = new Map<number, TransferLink>();
    const errors = new Map<number, string>();
    const retryFiles = new Map<number, PreparedAttachment>();
    const gofileFiles = new Map<number, string>();
    let gofileStarted = false;

    for (;;) {
        const index = progress.snapshot().entries.findIndex(({ status }) => status.phase === "queued");
        if (index < 0) {
            if (await progress.reviewFailures() || progress.snapshot().entries.some(({ status }) => status.phase === "queued")) continue;
            break;
        }
        const { file, name, route, metadata: originalMetadata } = work[index];
        retryFiles.delete(index);
        errors.delete(index);
        const report: Parameters<typeof processFile>[3] = status => progress.update(index, status);
        try {
            if (route === "discord") {
                attachments.set(index, { file, metadata: originalMetadata });
                report({ phase: "discord" });
            } else if (progress.signal.aborted) {
                report({ phase: "canceled" });
            } else if (route === "video") {
                const result = await processFile(file, { maxBytes }, progress.signal, report);
                if (!(result instanceof File)) throw new Error("The encoder did not return a video.");
                attachments.set(index, { file: result, metadata: originalMetadata });
                report({ phase: "compressed", size: result.size });
            } else {
                const fileName = provider === "Litterbox" ? file.name : name;
                if (provider === "Litterbox" && /\.exe$/i.test(fileName)) {
                    throw new Error("Litterbox doesn’t accept .exe uploads. Select Gofile in SmartAttachments settings, then attach the file again.");
                }
                if (provider === "Gofile") {
                    if (file.size > TRANSFER_LIMIT_BYTES) throw new Error("SmartAttachments supports transfers up to 1 GB.");
                    if ([...gofileFiles.values()].some(saved => saved.toLowerCase() === fileName.toLowerCase())) {
                        throw new Error("This filename is already in the Gofile batch. Choose a different name and attach it again.");
                    }
                    report({ phase: "setting-up" });
                    try {
                        progress.signal.throwIfAborted();
                        if (!gofileStarted) {
                            await native.beginGofileBatch(expiry);
                            gofileStarted = true;
                        }
                        const result = await processFile(file, { fileName, expiry, provider, transferThreshold }, progress.signal, report);
                        if (!("gofileName" in result)) throw new Error("Gofile did not return the saved filename.");
                        gofileFiles.set(index, result.gofileName);
                        report({ phase: "awaiting-link" });
                    } catch (error) {
                        if (gofileStarted && await native.discardUnverifiedGofileBatch().catch(() => false)) {
                            gofileStarted = false;
                            for (const previous of gofileFiles.keys()) {
                                progress.update(previous, { phase: progress.signal.aborted ? "canceled" : "queued" });
                            }
                            gofileFiles.clear();
                        }
                        throw error;
                    }
                    continue;
                }
                const result = await processFile(file, { fileName, expiry, provider, transferThreshold }, progress.signal, report);
                if (!("url" in result)) throw new Error("The transfer did not return a link.");
                links.set(index, { name, url: result.url });
                report({ phase: "transferred", downloadName: result.downloadName });
            }
        } catch (error) {
            if (progress.signal.aborted) {
                report({ phase: "canceled" });
            } else {
                const message = errorMessage(error);
                const retryable = route === "video" || route === "transfer"
                    && /Could not reach|HTTP (?:408|429|50[02347])|upload receipt/.test(message);
                if (retryable) retryFiles.set(index, { file, route, name });
                errors.set(index, file.name + " was skipped. " + message);
                report({ phase: "failed", message, retryable });
            }
        }
    }

    progress.seal();
    if (gofileStarted) {
        for (const index of gofileFiles.keys()) progress.update(index, { phase: "verifying" });
        try {
            const batch = await native.finishGofileBatch();
            if (batch) {
                const name = batch.files.length === 1 ? batch.files[0] : `${batch.files.length} files on Gofile`;
                links.set(Math.min(...gofileFiles.keys()), { name, url: batch.url });
                for (const [index, downloadName] of gofileFiles) progress.update(index, { phase: "transferred", downloadName });
            } else if (gofileFiles.size) {
                throw new Error("Gofile did not return the batch link.");
            }
        } catch (error) {
            const message = errorMessage(error);
            if (progress.signal.aborted) {
                for (const index of gofileFiles.keys()) progress.update(index, { phase: "canceled" });
            } else {
                errors.set(-1, "The Gofile batch could not be shared. " + message);
                for (const index of gofileFiles.keys()) progress.update(index, { phase: "failed", message });
                retryFiles.clear();
                work.forEach((item, index) => {
                    if (item.route === "transfer" && item.file.size <= TRANSFER_LIMIT_BYTES && progress.snapshot().entries[index].status.phase !== "skipped") {
                        retryFiles.set(index, item);
                    }
                });
            }
        }
    }
    work.length = 0;
    const failedFiles = [...retryFiles].filter(([index]) => progress.snapshot().entries[index].status.phase === "failed").map(([, item]) => item);
    const retry = failedFiles.length && (provider !== "Gofile" || !links.size)
        ? () => { void queueBatch(failedFiles, channel, draftType, undefined, policy); } : undefined;
    const fallbackFiles = failedFiles.filter(item => item.route === "transfer");
    const fallback = provider === "Litterbox" && fallbackFiles.length
        ? () => { void queueBatch(fallbackFiles, channel, draftType, undefined, { ...policy, provider: "Filebin" }); }
        : undefined;
    const draftLinks = [...links].sort(([a], [b]) => a - b).map(([, link]) => link);
    const note = draftLinks.length ? await addLinksToDraft(channel.id, draftLinks) : "";
    const urls = draftLinks.map(link => link.url);
    try {
        if (attachments.size) {
            // Vencord's declaration omits Discord's optional fourth argument and Promise return.
            const prompt = UploadHandler.promptToUpload as unknown as UploadPrompt;
            const ready = [...attachments].sort(([a], [b]) => a - b).map(([, attachment]) => attachment);
            await prompt(ready.map(item => item.file), channel, draftType,
                options?.filesMetadata ? { ...options, filesMetadata: ready.map(item => item.metadata) } : options);
        }
    } catch (error) {
        const message = "Discord couldn’t add the attachments. " + errorMessage(error);
        progress.snapshot().entries.forEach(({ status }, index) => {
            if (status.phase === "discord" || status.phase === "compressed") {
                progress.update(index, { phase: "failed", message: "Discord couldn’t add this attachment." });
            }
        });
        if (!progress.finish([note, message].filter(Boolean).join(" "), urls, retry, fallback)) {
            showToast({ text: message, variant: "critical" });
        }
        return;
    }
    if (!progress.finish(note, urls, retry, fallback)) {
        if (note) showToast({ text: note });
        for (const [index, text] of errors) {
            if (index < 0 || progress.snapshot().entries[index].status.phase === "failed") showToast({ text, variant: "critical" });
        }
        if (progress.signal.aborted) showToast({ text: "Remaining attachment tasks canceled." });
        else if (attachments.size && !errors.size) showToast({ text: "Attachments ready for Discord.", variant: "success" });
    }
}

export default definePlugin({
    name: "SmartAttachments",
    description: "Compress oversized videos locally and add download links for external file transfers.",
    authors: [{ name: "joobert", id: 0n }],
    enabledByDefault: true,
    settings,
    settingsAboutComponent: () => React.createElement(TransferHistoryButton, { onClick: openGofileHistory }),
    start() {
        if (settings.store.transferProvider === "TempSend") settings.store.transferProvider = "Gofile";
    },
    chatBarButton: { icon: UploadIcon, render: createAttachmentButton(openFromComposer) },
    toolboxActions: {
        "Attachment Progress": showAttachmentProgress,
        "Transfer History": openGofileHistory,
    },

    patches: [
        {
            find: "Unexpected mismatch between files and file metadata",
            replacement: {
                match: /async function\((\i),(\i),(\i)\)\{(?=[^]{0,500}Unexpected mismatch between files and file metadata)([^]{0,500}?throw Error\("Unexpected mismatch between files and file metadata"\);)/,
                replace: "$&const smartAttachmentJob=$self.handleAttachments($1,$2,$3,arguments[3]);if(smartAttachmentJob){await smartAttachmentJob;return;}",
            },
        },
        {
            find: "handleSaveCurrentText=",
            replacement: {
                match: /(\(0,\i\.jsx\)\((\i\.\i),\{)event:\i\.\i\.INSERT_TEXT,handler:this\.handleInsertText\}\)/,
                replace: '$&,$1event:"' + INSERT_LINKS_EVENT + '",handler:event=>$self.insertTransferLinks(this.props,this.handleInsertText,event)})',
            },
        },
    ],

    insertTransferLinks(props: ComposerProps, insertText: (text: InsertTextArgs) => void, event: LinkInsertEvent) {
        if (event.inserted || props.disabled || props.channel?.id !== event.channelId
            || props.type?.drafts?.type !== DraftType.ChannelMessage) return;

        const existing = DraftStore.getDraft(event.channelId, DraftType.ChannelMessage);
        const text = existing ? "\n" + event.text : event.text;
        insertText({ plainText: text, rawText: text });
        event.inserted = true;
    },

    handleAttachments(files: FileList | File[], channel: Channel, draftType: DiscordDraftType, options?: UploadOptions) {
        if (!native || draftType !== DraftType.ChannelMessage || options?.isThumbnail || !files.length) return;

        const { externalUploads, expiry, sizePolicy, transferProvider } = settings.store;
        const discordLimit = discordUploadLimit(channel);
        const matchDiscord = sizePolicy !== "20mb";
        const policy: BatchPolicy = {
            limit: Math.min(discordLimit, matchDiscord ? TRANSFER_LIMIT_BYTES : VIDEO_TARGET_BYTES),
            transferThreshold: matchDiscord ? discordLimit : VIDEO_TARGET_BYTES,
            externalUploads: externalUploads ?? true,
            expiry: expiry ?? "72h",
            provider: transferProvider === "Filebin" || transferProvider === "Litterbox" ? transferProvider : "Gofile",
        };
        const items = planAttachments(Array.from(files), policy);
        if (items.every(item => item.route === "discord")) return;
        if (items.length > MAX_BATCH_FILES) {
            warnBatchLimit();
            return Promise.resolve();
        }
        return queueBatch(items, channel, draftType, options, policy, true);
    },
});
