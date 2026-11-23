/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./progress.css";

import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { Button } from "@components/Button";
import { CloudUploadIcon, ImageIcon, NotesIcon, UploadIcon } from "@components/Icons";
import { copyWithToast } from "@utils/discord";
import type { Channel, RenderModalProps } from "@vencord/discord-types";
import { closeModal, DraftType, Modal, openModal, PermissionsBits, PermissionStore, React, showToast } from "@webpack/common";
import type { CSSProperties } from "react";

import { FileProgress, MAX_BATCH_FILES, TransferProvider } from "./shared";

export type AttachmentRoute = "discord" | "video" | "transfer";
export interface PreparedAttachment {
    file: File;
    route: AttachmentRoute;
    name: string;
}
export type AttachmentStatus = FileProgress
    | { phase: "queued" | "canceled" | "skipped" | "discord" | "awaiting-link" | "setting-up"; }
    | { phase: "transferred"; downloadName?: string; }
    | { phase: "preparing"; bytes: number; }
    | { phase: "compressed"; size: number; }
    | { phase: "failed"; message: string; retryable?: boolean; };

interface Entry {
    name: string;
    size: number;
    route: AttachmentRoute;
    status: AttachmentStatus;
}

interface Snapshot {
    entries: Entry[];
    accepting: boolean;
    reviewing: boolean;
    canceling: boolean;
    deciding: boolean;
    finished: boolean;
    acknowledged: boolean;
    note: string;
    links: string[];
    retry?: () => void;
    fallback?: () => void;
}

const modalKey = "vc-smart-attachments";
const sizeFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const units = ["bytes", "KB", "MB", "GB"];
let currentProgress: AttachmentProgress | undefined;
const batchListeners = new Set<() => void>();

function pickFiles(onPick: (files: File[]) => void) {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => { if (input.files?.length) onPick(Array.from(input.files)); };
    input.click();
}

export function showAttachmentProgress() {
    if (currentProgress) currentProgress.show();
    else showToast({ text: "There are no recent attachment transfers." });
}

function formatSize(bytes: number) {
    let unit = 0;
    while (bytes >= 1000 && unit < units.length - 1) {
        bytes /= 1000;
        unit++;
    }
    return sizeFormatter.format(bytes) + " " + (unit === 0 && bytes === 1 ? "byte" : units[unit]);
}

function makeEntries(files: PreparedAttachment[]): Entry[] {
    return files.map(({ file, name, route }) => ({ name, size: file.size, route, status: { phase: "queued" } }));
}

export function createAttachmentProgress(
    files: PreparedAttachment[],
    limit: number,
    expiry: string,
    provider: TransferProvider,
    prepareFiles: (files: File[]) => Promise<PreparedAttachment[] | null>,
    enqueueFiles: (files: PreparedAttachment[], sameBatch: boolean) => void,
    openHistory?: () => void
) {
    const controller = new AbortController();
    const listeners = new Set<() => void>();
    let visible = false;
    let resume: ((retry: boolean) => void) | undefined;
    let state: Snapshot = {
        entries: makeEntries(files),
        accepting: true,
        reviewing: false,
        canceling: false,
        deciding: false,
        finished: false,
        acknowledged: false,
        note: "",
        links: [],
    };

    function publish(changes: Partial<Snapshot>) {
        state = { ...state, ...changes };
        for (const listener of listeners) listener();
    }

    function endReview(retry: boolean) {
        const resolve = resume;
        if (!resolve) return;
        resume = undefined;
        publish({ deciding: false });
        resolve(retry);
    }

    const progress = {
        limit,
        expiry,
        provider,
        openHistory,
        signal: controller.signal,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        snapshot: () => state,
        update(index: number, status: AttachmentStatus) {
            const entries = state.entries.slice();
            entries[index] = { ...entries[index], status };
            publish({ entries });
        },
        skip(index: number) {
            if (state.accepting && !state.canceling && state.entries[index]?.status.phase === "queued") {
                progress.update(index, { phase: "skipped" });
            }
        },
        retryRow(index: number) {
            const status = state.entries[index]?.status;
            if (state.accepting && !state.canceling && status?.phase === "failed" && status.retryable) {
                progress.update(index, { phase: "queued" });
                endReview(true);
            }
        },
        reviewFailures() {
            if (state.canceling || !state.entries.some(({ status }) => status.phase === "failed" && status.retryable)) {
                return Promise.resolve(false);
            }
            return new Promise<boolean>(resolve => {
                resume = resolve;
                publish({ deciding: true });
            });
        },
        async addFiles(files: File[]) {
            if (!files.length || state.reviewing) return;
            if (!state.accepting || state.canceling || state.deciding) {
                showToast({ text: "This batch has finished taking files.", variant: "critical" });
                return;
            }
            const available = MAX_BATCH_FILES - state.entries.length;
            if (files.length > available) {
                showToast({ text: available ? `Choose up to ${available} more ${available === 1 ? "file" : "files"}.` : "This batch already has 10 files.", variant: "critical" });
                return;
            }
            publish({ reviewing: true });
            try {
                const prepared = await prepareFiles(files);
                if (!prepared || state.canceling) return;
                const sameBatch = state.accepting;
                enqueueFiles(prepared, sameBatch);
                if (sameBatch) publish({ entries: [...state.entries, ...makeEntries(prepared)] });
            } catch {
                showToast({ text: "Couldn’t open the upload name editor.", variant: "critical" });
            } finally {
                publish({ reviewing: false });
            }
        },
        seal() {
            publish({ accepting: false });
        },
        finishReview() {
            endReview(false);
        },
        cancel() {
            if (state.finished || state.canceling) return;
            publish({ canceling: true, accepting: false });
            endReview(false);
            controller.abort();
        },
        recover(service: "retry" | "fallback") {
            const resume = state[service];
            if (!resume) return;
            publish({ retry: undefined, fallback: undefined });
            resume();
        },
        finish(note: string, links: string[], retry?: () => void, fallback?: () => void) {
            publish({ finished: true, accepting: false, note, links, retry, fallback });
            return visible;
        },
        acknowledge() {
            publish({ acknowledged: true });
        },
        show() {
            if (visible) return;
            try {
                closeModal(modalKey);
                openModal(props => <AttachmentProgressModal {...props} progress={progress} />, {
                    modalKey,
                    onCloseCallback: () => { visible = false; },
                });
                visible = true;
            } catch {
                // The standard attachment flow still works if Discord's modal API changes.
                visible = false;
            }
        },
    };
    currentProgress = progress;
    for (const listener of batchListeners) listener();
    return progress;
}

type AttachmentProgress = ReturnType<typeof createAttachmentProgress>;

function describe(entry: Entry, provider: TransferProvider, expiryHours: number) {
    const { size, status } = entry;
    switch (status.phase) {
        case "queued": return {
            text: entry.route === "video" ? "Queued for compression" : entry.route === "transfer" ? `Queued for ${provider}` : "Queued for Discord",
        };
        case "preparing": return { text: "Reading file", fraction: status.bytes / size, detail: `${formatSize(status.bytes)} of ${formatSize(size)}` };
        case "analyzing": return { text: "Analyzing video", busy: true };
        case "encoding": return {
            text: status.pass === 1 ? "Analyzing frames" : "Compressing video",
            fraction: (status.pass - 1 + status.fraction) / 2,
            detail: `Pass ${status.pass} of 2${status.attempt > 1 ? ` · Attempt ${status.attempt}` : ""}`,
        };
        case "checking": return { text: "Checking compressed size", busy: true };
        case "setting-up": return { text: "Preparing the Gofile folder", busy: true };
        case "uploading": return { text: `Uploading to ${provider}`, fraction: status.bytes / size, detail: `${formatSize(status.bytes)} of ${formatSize(size)}` };
        case "retrying": return { text: `Retrying ${provider} upload…`, busy: true, detail: `Attempt ${status.attempt} of ${status.total}` };
        case "confirming": return { text: provider === "Gofile" ? "Verifying uploaded file" : "Waiting for the download link", busy: true };
        case "verifying": return { text: provider === "Gofile" ? "Checking the share page and expiry" : "Checking the download link", busy: true };
        case "awaiting-link": return { text: "Uploaded · Waiting for the batch link" };
        case "compressed": return {
            text: "Compressed · Ready for Discord",
            detail: `${Math.round((1 - status.size / size) * 100)}% smaller`,
        };
        case "transferred": return {
            text: `Uploaded to ${provider}`,
            detail: provider === "Filebin" ? "Available for up to 7 days" : `Expires in ${expiryHours} ${expiryHours === 1 ? "hour" : "hours"}`,
        };
        case "discord": return { text: "Ready for Discord" };
        case "skipped": return { text: "Skipped" };
        case "canceled": return { text: "Canceled" };
        case "failed": return { text: entry.route === "transfer" ? "Upload failed" : "Couldn’t add file", detail: status.message };
    }
}

function AttachmentRow({ entry, limit, expiryHours, provider, skip, retry }: {
    entry: Entry;
    limit: number;
    expiryHours: number;
    provider: TransferProvider;
    skip?: () => void;
    retry?: () => void;
}) {
    const description = describe(entry, provider, expiryHours);
    const { fraction } = description;
    const Icon = entry.route === "video" ? ImageIcon : entry.route === "transfer" ? CloudUploadIcon : NotesIcon;
    const { status } = entry;
    const size = formatSize(entry.size);
    const signedSize = status.phase === "compressed"
        ? `${size} → ${formatSize(status.size)}`
        : entry.route === "video" ? `${size} · Target ≤ ${formatSize(limit)}` : size;

    return (
        <li className="vc-sa-file" data-phase={status.phase}>
            <div className="vc-sa-file-header">
                <span className="vc-sa-file-icon" aria-hidden="true"><Icon width={20} height={20} /></span>
                <div className="vc-sa-file-meta">
                    <div className="vc-sa-file-name" title={entry.name}>{entry.name}</div>
                    <div className="vc-sa-file-size">{signedSize}</div>
                </div>
                {fraction != null && <span className="vc-sa-percentage" aria-hidden="true">{Math.floor(fraction * 100)}%</span>}
                {skip && <Button variant="secondary" size="xs" aria-label={`Skip ${entry.name}`} onClick={skip}>Skip</Button>}
                {retry && <Button variant="secondary" size="xs" aria-label={`Retry ${entry.name}`} onClick={retry}>Retry</Button>}
            </div>
            {(fraction != null || description.busy) && (
                <div
                    className="vc-sa-progress"
                    role="progressbar"
                    aria-label={`${description.text} — ${entry.name}`}
                    aria-valuenow={fraction == null ? undefined : Math.floor(fraction * 100)}
                    data-busy={description.busy || undefined}
                >
                    <span style={fraction == null ? undefined : { width: `${fraction * 100}%` }} />
                </div>
            )}
            <div className="vc-sa-file-status">
                <span>{description.text}</span>
                {description.detail && <span className="vc-sa-file-detail">{description.detail}</span>}
            </div>
            {status.phase === "transferred" && status.downloadName && status.downloadName !== entry.name && (
                <p className="vc-sa-file-detail vc-sa-download-name">Saved as {status.downloadName}</p>
            )}
        </li>
    );
}

function countEntries(entries: Entry[], provider: TransferProvider) {
    return entries.reduce((result, entry) => {
        const { phase } = entry.status;
        if (phase === "failed") result.failed++;
        if (phase === "canceled") result.canceled++;
        if (phase === "skipped") result.skipped++;
        if (phase === "awaiting-link") result.waiting++;
        if (phase === "compressed" || phase === "transferred" || phase === "discord") result.ready++;
        const description = describe(entry, provider, 0);
        if (description.busy || description.fraction != null) {
            result.active = description.text;
            if (phase === "preparing") result.fraction = 0.08 * (description.fraction ?? 0);
            else if (phase === "confirming" || phase === "verifying" || phase === "checking") result.fraction = 0.99;
            else result.fraction = 0.08 + 0.9 * (description.fraction ?? 0);
        }
        return result;
    }, { failed: 0, canceled: 0, skipped: 0, ready: 0, waiting: 0, active: "", fraction: 0 });
}

function subscribeToBatches(listener: () => void) {
    batchListeners.add(listener);
    return () => { batchListeners.delete(listener); };
}

const getCurrentProgress = () => currentProgress;
const noProgress = () => undefined;
const noSubscription = () => () => {};

export function createAttachmentButton(onPick: (files: File[], channel: Channel) => void): ChatBarButtonFactory {
    return function AttachmentButton({ channel, isAnyChat, type }) {
        const progress = React.useSyncExternalStore(subscribeToBatches, getCurrentProgress);
        const state = React.useSyncExternalStore(progress?.subscribe ?? noSubscription, progress?.snapshot ?? noProgress);
        if (!isAnyChat) return null;

        if (state && progress && !state.acknowledged) {
            const counts = countEntries(state.entries, progress.provider);
            const finished = counts.ready + counts.failed + counts.canceled + counts.skipped + counts.waiting;
            const percent = state.finished ? 100 : Math.min(99, Math.floor((finished + counts.fraction) / state.entries.length * 100));
            const result = counts.failed ? "failed" : counts.canceled ? "canceled" : "ready";
            const label = state.finished
                ? counts.failed ? "Attachment results · Uploads need attention" : "View attachment results"
                : state.deciding ? "Review failed attachments"
                    : `${counts.active || "Preparing attachments"} · ${finished} of ${state.entries.length} processed · ${percent}%`;
            return (
                <ChatBarButton tooltip={label} onClick={progress.show}>
                    <span className="vc-sa-mini" data-state={state.finished ? result : "active"}
                        style={{ "--vc-sa-ring": `${percent}%` } as CSSProperties} aria-hidden="true">
                        <UploadIcon height={15} width={15} />
                    </span>
                </ChatBarButton>
            );
        }

        if (!type.attachments || type.drafts.type !== DraftType.ChannelMessage
            || (!channel.isPrivate() && !PermissionStore.can(PermissionsBits.ATTACH_FILES, channel))) return null;
        return (
            <ChatBarButton tooltip="Add attachments" onClick={() => pickFiles(files => onPick(files, channel))}>
                <UploadIcon height={20} width={20} />
            </ChatBarButton>
        );
    };
}

function AttachmentProgressModal(props: RenderModalProps & { progress: AttachmentProgress; }) {
    const { progress, ...modalProps } = props;
    const state = React.useSyncExternalStore(progress.subscribe, progress.snapshot);
    const { entries, accepting, reviewing, canceling, deciding, finished, note, links, retry, fallback } = state;
    const counts = countEntries(entries, progress.provider);
    const skipped = counts.failed + counts.canceled + counts.skipped;
    const total = entries.length;
    const title = finished ? (skipped ? "Attachment results" : "Attachments ready") : deciding ? "Review attachments" : "Preparing attachments";
    const summary = finished
        ? [`${counts.ready} ready`, counts.failed ? `${counts.failed} failed` : "", counts.skipped ? `${counts.skipped} skipped` : "", counts.canceled ? `${counts.canceled} canceled` : ""].filter(Boolean).join(" · ")
        : deciding ? "Retry a file or finish with the attachments that are ready."
            : canceling ? "Canceling remaining work…" : `${counts.ready + skipped + counts.waiting} of ${total} processed`;

    return (
        <Modal
            {...modalProps}
            size="md"
            title={title}
            subtitle={<span role="status">{summary}</span>}
            actions={finished ? [
                ...(links.length ? [{ text: links.length === 1 ? "Copy link" : "Copy links", variant: "secondary", onClick: () => { void copyWithToast(links.join("\n")); } }] : []),
                ...(retry ? [{ text: "Retry failed", variant: "secondary", onClick: () => progress.recover("retry") }] : []),
                { text: "Done", variant: "primary", onClick: () => { progress.acknowledge(); modalProps.onClose(); } },
            ] : deciding ? [
                { text: "Minimize", variant: "secondary", onClick: modalProps.onClose },
                { text: "Finish batch", variant: "primary", onClick: progress.finishReview },
            ] : [
                { text: "Cancel remaining", variant: "critical-primary", disabled: canceling || !accepting, onClick: progress.cancel },
                { text: "Minimize", variant: "secondary", onClick: modalProps.onClose },
            ]}
        >
            {!finished && (
                <div className="vc-sa-toolbar">
                    <span className="vc-sa-capacity">{total} / {MAX_BATCH_FILES} files</span>
                    <Button variant="secondary" size="xs" disabled={!accepting || reviewing || deciding || total === MAX_BATCH_FILES}
                        onClick={() => pickFiles(files => { void progress.addFiles(files); })}>Add files</Button>
                </div>
            )}
            <ul className="vc-sa-files">
                {entries.map((entry, index) => <AttachmentRow key={index} entry={entry} limit={progress.limit}
                    expiryHours={parseInt(progress.expiry, 10)} provider={progress.provider}
                    skip={accepting && !canceling && entry.status.phase === "queued" ? () => progress.skip(index) : undefined}
                    retry={accepting && !canceling && entry.status.phase === "failed" && entry.status.retryable ? () => progress.retryRow(index) : undefined} />)}
            </ul>
            {fallback && (
                <div className="vc-sa-fallback">
                    <p className="vc-sa-capacity">Filebin can host the failed uploads for up to 7 days. Anyone with a link can delete the file.</p>
                    <Button variant="secondary" size="xs" onClick={() => progress.recover("fallback")}>Upload to Filebin</Button>
                </div>
            )}
            {note && <p className="vc-sa-note">{note}</p>}
            {!!links.length && progress.openHistory && (
                <div className="vc-sa-history-actions">
                    <Button variant="secondary" size="xs" onClick={progress.openHistory}>Transfer History</Button>
                </div>
            )}
        </Modal>
    );
}
