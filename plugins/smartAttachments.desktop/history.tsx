/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { copyWithToast } from "@utils/discord";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, openModal, React } from "@webpack/common";

import type { GofileHistoryEntry } from "./shared";

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

interface HistoryProps {
    load: () => Promise<GofileHistoryEntry[]>;
    revoke: (id: string) => Promise<GofileHistoryEntry>;
}

function TransferHistory(props: RenderModalProps & HistoryProps) {
    const { load, revoke, ...modal } = props;
    const [entries, setEntries] = React.useState<GofileHistoryEntry[] | null>(null);
    const [confirm, setConfirm] = React.useState<string>();
    const [pending, setPending] = React.useState(false);
    const [problem, setProblem] = React.useState("");
    const [now, setNow] = React.useState(Date.now);

    React.useEffect(() => {
        let active = true;
        load().then(result => { if (active) setEntries(result); }).catch(() => {
            if (active) setProblem("Couldn’t read transfer history on this device.");
        });
        const timer = setInterval(() => setNow(Date.now()), 15_000);
        return () => { active = false; clearInterval(timer); };
    }, [load]);

    async function revokeLink(id: string) {
        setPending(true);
        setProblem("");
        try {
            const updated = await revoke(id);
            setEntries(list => list?.map(entry => entry.id === id ? updated : entry) ?? []);
            setConfirm(undefined);
        } catch {
            setProblem("Couldn’t confirm that Gofile revoked the link. Try again.");
        } finally {
            setPending(false);
        }
    }

    return (
        <Modal
            {...modal}
            size="md"
            title="Transfer History"
            subtitle="Gofile links created on this device"
            actions={[{ text: "Done", variant: "primary", onClick: modal.onClose }]}
        >
            {problem && <p className="vc-sa-name-error" role="alert">{problem}</p>}
            {!entries && !problem && <p className="vc-sa-note" role="status">Loading transfers…</p>}
            {entries?.length === 0 && <p className="vc-sa-note">Gofile uploads will appear here after you share them.</p>}
            {!!entries?.length && (
                <ul className="vc-sa-files">
                    {entries.map(entry => {
                        const expired = entry.expiresAt <= now;
                        const live = !expired && !entry.revokedAt;
                        const status = entry.revokedAt
                            ? `Revoked ${date.format(entry.revokedAt)}`
                            : `${expired ? "Expired" : "Expires"} ${date.format(entry.expiresAt)}`;
                        const files = entry.files.join(", ");
                        return (
                            <li className="vc-sa-file" key={entry.id}>
                                <div className="vc-sa-file-name" title={files}>{entry.files.length === 1 ? files : `${entry.files.length} files`}</div>
                                {entry.files.length > 1 && <p className="vc-sa-history-files vc-sa-file-size" title={files}>{files}</p>}
                                <p className="vc-sa-file-size">{status}</p>
                                {live && (
                                    <div className="vc-sa-history-actions">
                                        {confirm === entry.id ? <>
                                            <span className="vc-sa-capacity" role="status">Revoke access to every file in this transfer?</span>
                                            <Button variant="secondary" size="xs" disabled={pending} onClick={() => setConfirm(undefined)}>Cancel</Button>
                                            <Button variant="dangerPrimary" size="xs" disabled={pending} onClick={() => { void revokeLink(entry.id); }}>
                                                {pending ? "Revoking…" : "Revoke link"}
                                            </Button>
                                        </> : <>
                                            <Button variant="secondary" size="xs" onClick={() => { void copyWithToast(entry.url); }}>Copy link</Button>
                                            <Button variant="dangerSecondary" size="xs" disabled={pending} onClick={() => setConfirm(entry.id)}>Revoke…</Button>
                                        </>}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </Modal>
    );
}

export function showTransferHistory(load: HistoryProps["load"], revoke: HistoryProps["revoke"]) {
    openModal(props => <TransferHistory {...props} load={load} revoke={revoke} />, { modalKey: "vc-smart-attachments-history" });
}

export function TransferHistoryButton({ onClick }: { onClick: () => void; }) {
    return <Button variant="secondary" size="small" onClick={onClick}>Transfer History</Button>;
}
