/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { app, safeStorage } from "electron";

import { GofileHistoryEntry, TransferExpiry } from "./shared";

const api = "https://api.gofile.io";
const folderId = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const shareCode = /^[a-zA-Z0-9]{6,8}$/;
const historyLifetime = 30 * 24 * 60 * 60_000;

interface GofileAccount {
    token: string;
    rootFolder: string;
}

interface HistoryStore {
    account?: GofileAccount;
    entries: GofileHistoryEntry[];
}

export interface GofileBatch {
    id: string;
    token: string;
    expiry: TransferExpiry;
    files: Array<{ name: string; code: string; }>;
    incomplete: boolean;
}

let historyWrites: Promise<unknown> = Promise.resolve();

function historyFile() {
    if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")) {
        throw new Error("Gofile needs secure local storage to save the credential used to revoke your links.");
    }
    return join(app.getPath("userData"), "vencord-smart-attachments.bin");
}

async function readHistory(file: string): Promise<HistoryStore> {
    try {
        return JSON.parse(safeStorage.decryptString(await readFile(file)));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
        throw new Error("SmartAttachments could not read the local transfer history.");
    }
}

function recent(entries: GofileHistoryEntry[]) {
    return entries.filter(entry => (entry.revokedAt ?? entry.expiresAt) > Date.now() - historyLifetime);
}

function changeHistory<T>(change: (store: HistoryStore) => Promise<T>) {
    const operation = historyWrites.then(async () => {
        const file = historyFile();
        const store = await readHistory(file);
        const result = await change(store);
        store.entries = recent(store.entries);
        const temporary = file + "." + randomUUID() + ".tmp";
        try {
            await writeFile(temporary, safeStorage.encryptString(JSON.stringify(store)), { flag: "wx", mode: 0o600 });
            await rename(temporary, file);
        } finally {
            await rm(temporary, { force: true }).catch(() => {});
        }
        return result;
    });
    historyWrites = operation.catch(() => {});
    return operation;
}

async function request<T>(path: string, method: "POST" | "PUT" | "DELETE", body: object, token?: string) {
    const response = await fetch(api + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(12_000),
    });
    const result = await response.json().catch(() => null) as { status?: string; data?: T; } | null;
    if (method === "DELETE" && result?.status === "error-notFound") return;
    if (!response.ok || result?.status !== "ok") throw new Error(`Gofile could not complete this request (HTTP ${response.status}).`);
    return result.data;
}

async function deleteFolder(id: string, token: string) {
    const result = await request<Record<string, { status?: string; } | string>>("/contents", "DELETE", { contentsId: id }, token);
    const entry = result?.[id];
    const status = typeof entry === "string" ? entry : entry?.status;
    if (status?.startsWith("error-") && status !== "error-notFound") {
        throw new Error("Gofile did not confirm that the folder was revoked.");
    }
}

async function setFolder(batch: GofileBatch, attribute: "expiry" | "public", attributeValue: boolean | number) {
    const result = await request<{ id: string; code?: string; expire?: number; }>(
        `/contents/${batch.id}/update`, "PUT", { attribute, attributeValue }, batch.token
    );
    if (result?.id !== batch.id) throw new Error("Gofile did not confirm the folder change.");
    return result;
}

async function setExpiry(batch: GofileBatch) {
    const seconds = Math.floor(Date.now() / 1000) + parseInt(batch.expiry, 10) * 3600;
    if ((await setFolder(batch, "expiry", seconds)).expire !== seconds) {
        throw new Error("Gofile did not confirm the requested expiry.");
    }
    return seconds * 1000;
}

export async function createGofileBatch(expiry: TransferExpiry) {
    await historyWrites;
    const saved = (await readHistory(historyFile())).account;
    const account = saved ?? await changeHistory(async store => {
        if (store.account) return store.account;
        const data = await request<GofileAccount>("/accounts", "POST", {});
        if (!data || !folderId.test(data.rootFolder) || typeof data.token !== "string" || !/^[!-~]{1,1024}$/.test(data.token)) {
            throw new Error("Gofile did not return a usable guest account.");
        }
        return store.account = { token: data.token, rootFolder: data.rootFolder };
    });
    const folder = await request<{ id: string; }>("/contents/createFolder", "POST", {
        parentFolderId: account.rootFolder,
        folderName: "SmartAttachments files",
        public: false,
    }, account.token);
    if (!folder || !folderId.test(folder.id)) throw new Error("Gofile did not return a usable transfer folder.");

    const batch: GofileBatch = { id: folder.id, token: account.token, expiry, files: [], incomplete: false };
    try {
        if ((await setFolder(batch, "public", false)).code) throw new Error("Gofile did not confirm the folder is private.");
        await setExpiry(batch);
        return batch;
    } catch (error) {
        await discardGofileBatch(batch);
        throw error;
    }
}

export async function discardGofileBatch(batch: GofileBatch) {
    await deleteFolder(batch.id, batch.token).catch(() => {});
}

export async function publishGofileBatch(batch: GofileBatch): Promise<GofileHistoryEntry> {
    const expiresAt = await setExpiry(batch);
    const { code } = await setFolder(batch, "public", true);
    const linkCode = batch.files.length === 1 ? batch.files[0].code : code;
    if (!linkCode || !shareCode.test(linkCode)) throw new Error("Gofile did not return a valid share link.");
    const url = `https://gofile.io/d/${linkCode}`;
    const page = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    await page.body?.cancel().catch(() => {});
    if (!page.ok || !/^text\/html\b/i.test(page.headers.get("content-type") ?? "")) {
        throw new Error(`Gofile could not confirm the public share page (HTTP ${page.status}).`);
    }

    const entry = { id: batch.id, url, files: batch.files.map(file => file.name), createdAt: Date.now(), expiresAt };
    await changeHistory(async store => { store.entries.unshift(entry); });
    return entry;
}

export async function listGofileHistory() {
    await historyWrites;
    return recent((await readHistory(historyFile())).entries);
}

export async function revokeGofileTransfer(id: string) {
    return changeHistory(async store => {
        const entry = store.entries.find(item => item.id === id);
        if (!entry || !folderId.test(id) || !store.account) throw new Error("This upload is missing from the local transfer history.");
        if (!entry.revokedAt) {
            await deleteFolder(id, store.account.token);
            entry.revokedAt = Date.now();
        }
        return entry;
    });
}
