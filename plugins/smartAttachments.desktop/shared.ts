/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const VIDEO_TARGET_BYTES = 20_000_000;
export const TRANSFER_LIMIT_BYTES = 1_000_000_000;
export const CHUNK_BYTES = 4 * 1024 * 1024;
export const EXPIRY_HOURS = ["1h", "12h", "24h", "72h"] as const;
export type TransferExpiry = typeof EXPIRY_HOURS[number];
export const INSERT_LINKS_EVENT = "SMART_ATTACHMENTS_INSERT_LINKS";
export const MAX_BATCH_FILES = 10;
export const TRANSFER_PROVIDERS = ["Gofile", "Filebin", "Litterbox"] as const;
export type TransferProvider = typeof TRANSFER_PROVIDERS[number];

export function shouldTransfer(size: number, name: string, provider: TransferProvider, threshold = VIDEO_TARGET_BYTES) {
    return size > threshold || (size > 0 && provider === "Gofile" && /\.exe$/i.test(name));
}

export interface TransferLink {
    name: string;
    url: string;
}

export interface PublishedUpload {
    url: string;
    downloadName?: string;
}

export interface GofileHistoryEntry {
    id: string;
    url: string;
    files: string[];
    createdAt: number;
    expiresAt: number;
    revokedAt?: number;
}

export function formatExpiry(expiry: TransferExpiry) {
    const hours = parseInt(expiry, 10);
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function formatTransferLink({ name, url }: TransferLink) {
    const label = name.replace(/[\r\n\u2028\u2029]+/g, " ");
    if (!/[\\[\]@_*~`<>|]/.test(label)) return `[${label}](${url})`;

    const longestTickRun = Math.max(0, ...(label.match(/`+/g) ?? []).map(run => run.length));
    const fence = "`".repeat(longestTickRun + 1);
    const pad = label.startsWith("`") || label.endsWith("`") ? " " : "";
    const literal = fence + pad + label + pad + fence;
    // Brackets can break the outer link, and mentions can fail Discord's link-label validation.
    return /[\\[\]@<>]/.test(label) ? `${literal}\n${url}` : `[${literal}](${url})`;
}

export type FileProgress =
    | { phase: "analyzing" | "checking" | "confirming" | "verifying"; }
    | { phase: "encoding"; pass: 1 | 2; attempt: number; fraction: number; }
    | { phase: "retrying"; attempt: number; total: number; }
    | { phase: "uploading"; bytes: number; };

export function isVideo(file: Pick<File, "type" | "name">) {
    return file.type.startsWith("video/")
        || /\.(?:mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|mpe|ts|mts|m2ts|flv|3gp|3g2|ogv|vob|asf|mxf|rm|rmvb)$/i.test(file.name);
}
