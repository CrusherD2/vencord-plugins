/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BrowserWindow, dialog, IpcMainInvokeEvent, net } from "electron";
import { writeFile } from "fs/promises";
import { basename, join } from "path";

const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

function parseAttachmentUrl(url: string) {
    const parsedURL = new URL(url);
    if (!ALLOWED_HOSTS.has(parsedURL.hostname)) throw new Error(`Disallowed host: ${parsedURL.hostname}`);
    if (parsedURL.protocol !== "https:") throw new Error(`Disallowed protocol: ${parsedURL.protocol}`);
    return parsedURL;
}

function fileNameFromUrl(url: URL, index: number) {
    const raw = decodeURIComponent(url.pathname.split("/").pop() || `image-${index}`);
    return basename(raw).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || `image-${index}`;
}

function uniqueName(used: Set<string>, name: string) {
    const key = name.toLowerCase();
    if (!used.has(key)) {
        used.add(key);
        return name;
    }

    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let next = name;
    let i = 1;
    do {
        next = `${base} (${i})${ext}`;
        i++;
    } while (used.has(next.toLowerCase()));

    used.add(next.toLowerCase());
    return next;
}

export async function saveAttachments(e: IpcMainInvokeEvent, urls: string[]) {
    const parsed = urls.map(parseAttachmentUrl);
    const parent = BrowserWindow.fromWebContents(e.sender);
    const options = {
        title: "Choose where to save the images",
        buttonLabel: "Save",
        properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">
    };
    const { canceled, filePaths } = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);

    if (canceled || !filePaths[0]) return { canceled: true, saved: 0, failed: 0 };

    const directory = filePaths[0];
    const used = new Set<string>();
    let saved = 0;
    let failed = 0;

    for (let i = 0; i < parsed.length; i++) {
        try {
            const response = await net.fetch(parsed[i].toString());
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const name = uniqueName(used, fileNameFromUrl(parsed[i], i));
            await writeFile(join(directory, name), Buffer.from(await response.arrayBuffer()));
            saved++;
        } catch {
            failed++;
        }
    }

    return { canceled: false, saved, failed };
}
