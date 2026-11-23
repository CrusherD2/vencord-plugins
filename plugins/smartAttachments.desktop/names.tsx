/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React } from "@webpack/common";

import type { PreparedAttachment } from "./progress";
import { EXPIRY_HOURS, formatExpiry, TransferExpiry, TransferProvider } from "./shared";

const nameBytes = new TextEncoder();

function splitName(name: string) {
    const suffix = name.match(/(?:\.tar\.(?:gz|bz2|xz|zst)|\.[^.]+)$/i)?.[0] ?? "";
    return suffix && suffix.length < name.length
        ? { base: name.slice(0, -suffix.length), suffix }
        : { base: name, suffix: "" };
}

function reviewName(value: string | undefined, original: string) {
    const { base, suffix } = splitName(original);
    let stem = value?.trim() || base;
    if (suffix && stem.toLowerCase().endsWith(suffix.toLowerCase())) stem = stem.slice(0, -suffix.length);
    const name = (stem || base) + suffix;
    if (name === original) return { name };
    if (/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(name) || /[. ]$/.test(name)) {
        return { name, error: "Use a filename without slashes, reserved symbols, or a trailing period." };
    }
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) {
        return { name, error: "Choose a filename that isn’t reserved by Windows." };
    }
    if (name.length > 255 || nameBytes.encode(name).length > 255) {
        return { name, error: "Choose a shorter filename." };
    }
    return { name };
}

interface ReviewedAttachments {
    items: PreparedAttachment[];
    expiry: TransferExpiry;
}

function ReviewNamesModal(props: RenderModalProps & {
    items: PreparedAttachment[];
    provider: TransferProvider;
    expiry: TransferExpiry;
    chooseExpiry: boolean;
    acceptText: string;
    onAccept(review: ReviewedAttachments): void;
}) {
    const { items, provider, acceptText, onAccept, chooseExpiry, expiry: defaultExpiry, ...modalProps } = props;
    const [values, setValues] = React.useState<Record<number, string>>({});
    const [expiry, setExpiry] = React.useState(defaultExpiry);
    const id = React.useId();
    const transfers = items.flatMap((item, index) => item.route === "transfer" ? [{
        item, index, ...splitName(item.file.name), ...reviewName(values[index], item.file.name),
    }] : []);
    const hasErrors = transfers.some(entry => Boolean(entry.error));
    const confirm = () => {
        if (hasErrors) return;
        const named = items.slice();
        for (const { index, item, name } of transfers) named[index] = { ...item, name };
        onAccept({ items: named, expiry });
        modalProps.onClose();
    };

    return (
        <Modal
            {...modalProps}
            size="md"
            title={transfers.length === 1 ? "Review upload" : "Review uploads"}
            subtitle={provider === "Gofile" ? (transfers.length === 1 ? "The file will be shared through Gofile." : "These files will share one Gofile link.")
                : provider === "Litterbox" ? "These names appear in Discord. Litterbox assigns its own download filenames."
                    : "These names appear in Discord and on the Filebin download page."}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                {
                    text: acceptText,
                    variant: "primary",
                    disabled: hasErrors,
                    onClick: confirm,
                },
            ]}
        >
            <div className="vc-sa-upload-form">
                <div className="vc-sa-name-list">
                    {transfers.map(({ item, index, base, suffix, error }) => (
                        <div key={index} className="vc-sa-name-row">
                            <label className="vc-sa-name-label" htmlFor={`${id}-${index}`} title={item.file.name}>
                                {transfers.length === 1 ? "Download filename" : item.file.name}
                            </label>
                            <div className="vc-sa-name-field">
                                <input
                                    id={`${id}-${index}`}
                                    type="text"
                                    value={values[index] ?? base}
                                    placeholder={base}
                                    aria-invalid={Boolean(error)}
                                    aria-describedby={[suffix && `${id}-extension-${index}`, error && `${id}-error-${index}`].filter(Boolean).join(" ") || undefined}
                                    onChange={event => {
                                        const { value } = event.currentTarget;
                                        setValues(previous => ({ ...previous, [index]: value }));
                                    }}
                                    onKeyDown={event => {
                                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            confirm();
                                        }
                                    }}
                                />
                                {suffix && <span className="vc-sa-name-extension" id={`${id}-extension-${index}`}>{suffix}</span>}
                            </div>
                            {error && <p className="vc-sa-name-error" id={`${id}-error-${index}`}>{error}</p>}
                        </div>
                    ))}
                </div>
                {chooseExpiry && provider !== "Filebin" && (
                    <fieldset className="vc-sa-expiry">
                        <legend className="vc-sa-name-label">Link expires after</legend>
                        <div className="vc-sa-expiry-options">
                            {EXPIRY_HOURS.map(value => (
                                <label key={value}>
                                    <input type="radio" name={`${id}-expiry`} value={value} checked={expiry === value} onChange={() => setExpiry(value)} />
                                    <span>{formatExpiry(value)}</span>
                                </label>
                            ))}
                        </div>
                    </fieldset>
                )}
                {provider === "Filebin" && <p className="vc-sa-form-note">Anyone with the Filebin link can delete the file. Filebin may replace some punctuation in the filename.</p>}
                {provider === "Gofile" && <p className="vc-sa-form-note">Anyone with the link can download. You can revoke access in Transfer History.</p>}
            </div>
        </Modal>
    );
}

export function reviewAttachmentNames(items: PreparedAttachment[], provider: TransferProvider, expiry: TransferExpiry, acceptText: string, chooseExpiry = false) {
    if (!items.some(item => item.route === "transfer")) return Promise.resolve({ items, expiry });
    return new Promise<ReviewedAttachments | null>(resolve => {
        openModal(props => <ReviewNamesModal {...props} items={items} provider={provider} expiry={expiry}
            chooseExpiry={chooseExpiry} acceptText={acceptText} onAccept={resolve} />, {
            onCloseCallback: () => resolve(null),
        });
    });
}
