/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { saveFile } from "@utils/web";
import { showToast, Tooltip } from "@webpack/common";

import managedStyle from "./styles.css?managed";

const Native = VencordNative.pluginHelpers.DownloadAllImages as PluginNative<typeof import("./native")>;
const logger = new Logger("DownloadAllImages");

interface MosaicMediaItem {
    type?: string;
    downloadUrl?: string;
    contentType?: string;
    originalItem?: {
        url?: string;
        content_type?: string;
    };
}

function imageUrl(entry: { item?: MosaicMediaItem; }) {
    const item = entry?.item;
    if (!item) return null;

    const contentType = item.contentType ?? item.originalItem?.content_type;
    const isImage = item.type === "IMAGE" || contentType?.startsWith("image/");
    if (!isImage) return null;

    return item.downloadUrl || item.originalItem?.url || null;
}

function fileNameFromUrl(url: string) {
    try {
        return decodeURIComponent(new URL(url).pathname.split("/").pop() || "image");
    } catch {
        return "image";
    }
}

async function saveInBrowser(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.blob();
    saveFile(new File([data], fileNameFromUrl(url), { type: data.type || "application/octet-stream" }));
}

async function downloadAll(urls: string[]) {
    if (!IS_DISCORD_DESKTOP) {
        let failed = 0;
        for (let i = 0; i < urls.length; i++) {
            try {
                if (i > 0) await new Promise(resolve => setTimeout(resolve, 300));
                await saveInBrowser(urls[i]);
            } catch (error) {
                failed++;
                logger.error("Failed to download image", error);
            }
        }

        if (failed > 0) {
            showToast({
                text: failed === urls.length
                    ? "Couldn't download the images"
                    : `Couldn't download ${failed} of ${urls.length} images`,
                variant: "critical"
            });
        }
        return;
    }

    try {
        const result = await Native.saveAttachments(urls);
        if (result.canceled) return;

        if (result.failed > 0) {
            showToast({
                text: result.saved === 0
                    ? "Couldn't download the images"
                    : `Saved ${result.saved} images, couldn't save ${result.failed}`,
                variant: "critical"
            });
            return;
        }

        showToast({ text: `Saved ${result.saved} images` });
    } catch (error) {
        logger.error("Failed to download images", error);
        showToast({ text: "Couldn't download the images", variant: "critical" });
    }
}

function DownloadIcon() {
    return (
        <svg aria-hidden width="20" height="20" fill="none" viewBox="0 0 24 24">
            <path fill="currentColor" d="M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM3 20a1 1 0 1 0 0 2h18a1 1 0 1 0 0-2H3Z" />
        </svg>
    );
}

export default definePlugin({
    name: "DownloadAllImages",
    description: "Adds a download button on image collages that saves every image from that message",
    authors: [{ name: "CrusherD2", id: 0n }],
    tags: ["Media", "Utility"],
    enabledByDefault: true,
    managedStyle,

    patches: [
        {
            find: "return{visualMediaItems:",
            replacement: {
                match: /children:(\(0,\i\.jsx\)\(\i,\{visualMediaItems:(\i),maxWidth:\i\}\))/,
                replace: "children:[$1,$self.renderDownloadAll({items:$2})]"
            }
        }
    ],

    renderDownloadAll: ErrorBoundary.wrap(({ items }: { items?: Array<{ item?: MosaicMediaItem; }>; }) => {
        const urls = (items ?? []).map(imageUrl).filter(url => url != null);
        if (urls.length < 2) return null;

        return (
            <Tooltip text="Download all images" position="left">
                {props => (
                    <button
                        {...props}
                        type="button"
                        className="vc-download-all-images"
                        aria-label="Download all images"
                        onClick={event => {
                            props.onClick();
                            event.preventDefault();
                            event.stopPropagation();
                            downloadAll(urls);
                        }}
                    >
                        <DownloadIcon />
                    </button>
                )}
            </Tooltip>
        );
    }, { noop: true })
});
