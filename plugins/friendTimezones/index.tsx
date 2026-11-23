/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { get, set } from "@api/DataStore";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { Menu, React, Tooltip, useEffect, useState } from "@webpack/common";

import managedStyle from "./styles.css?managed";

const STORAGE_KEY = "FriendTimezones";
const logger = new Logger("FriendTimezones");

interface TimedMessage {
    timestamp: unknown;
    author?: { id: string; };
}

let zones: Record<string, string> = {};
const listeners = new Set<() => void>();

function emit() {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function useZones() {
    return React.useSyncExternalStore(subscribe, () => zones);
}

function useNow() {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 30_000);
        return () => clearInterval(id);
    }, []);
    return now;
}

function formatTime(date: Date, timeZone: string) {
    return new Intl.DateTimeFormat(undefined, {
        timeZone,
        hour: "numeric",
        minute: "2-digit"
    }).format(date);
}

const TIMEZONES = [
    { value: "Pacific/Honolulu", label: "HST · Hawaii" },
    { value: "America/Anchorage", label: "AKST · Alaska" },
    { value: "America/Los_Angeles", label: "PST · Pacific" },
    { value: "America/Denver", label: "MST · Mountain" },
    { value: "America/Phoenix", label: "MST · Arizona" },
    { value: "America/Chicago", label: "CST · Central" },
    { value: "America/New_York", label: "EST · Eastern" },
    { value: "America/Halifax", label: "AST · Atlantic" },
    { value: "America/St_Johns", label: "NST · Newfoundland" },
    { value: "America/Mexico_City", label: "CST · Mexico" },
    { value: "America/Bogota", label: "COT · Colombia" },
    { value: "America/Lima", label: "PET · Peru" },
    { value: "America/Santiago", label: "CLT · Chile" },
    { value: "America/Sao_Paulo", label: "BRT · Brazil" },
    { value: "America/Argentina/Buenos_Aires", label: "ART · Argentina" },
    { value: "Europe/London", label: "GMT · UK" },
    { value: "Europe/Lisbon", label: "WET · Portugal" },
    { value: "Europe/Paris", label: "CET · Central Europe" },
    { value: "Europe/Athens", label: "EET · Eastern Europe" },
    { value: "Europe/Istanbul", label: "TRT · Turkey" },
    { value: "Europe/Moscow", label: "MSK · Moscow" },
    { value: "Asia/Dubai", label: "GST · Gulf" },
    { value: "Asia/Karachi", label: "PKT · Pakistan" },
    { value: "Asia/Kolkata", label: "IST · India" },
    { value: "Asia/Bangkok", label: "ICT · Thailand" },
    { value: "Asia/Singapore", label: "SGT · Singapore" },
    { value: "Asia/Shanghai", label: "CST · China" },
    { value: "Asia/Hong_Kong", label: "HKT · Hong Kong" },
    { value: "Asia/Tokyo", label: "JST · Japan" },
    { value: "Asia/Seoul", label: "KST · Korea" },
    { value: "Australia/Perth", label: "AWST · Western Australia" },
    { value: "Australia/Adelaide", label: "ACST · Central Australia" },
    { value: "Australia/Sydney", label: "AEST · Eastern Australia" },
    { value: "Pacific/Auckland", label: "NZST · New Zealand" },
    { value: "UTC", label: "UTC" }
];

function zoneLabel(zone: string) {
    return TIMEZONES.find(option => option.value === zone)?.label ?? zone;
}

async function saveTimezone(userId: string, zone: string) {
    if (zone) zones = { ...zones, [userId]: zone };
    else {
        zones = { ...zones };
        delete zones[userId];
    }

    emit();
    await set(STORAGE_KEY, zones);
}

function shortLabel(zone: string) {
    return zoneLabel(zone).split(" · ")[0];
}

const timezoneMenu: NavContextMenuPatchCallback = (children, props?: { user?: { id?: string; }; }) => {
    const userId = props?.user?.id;
    if (!userId) return;

    const current = zones[userId];

    children.push(
        <Menu.MenuItem
            id="vc-friend-timezone"
            label={current ? `Timezone: ${shortLabel(current)}` : "Timezone"}
        >
            <Menu.MenuRadioItem
                id="vc-friend-timezone-none"
                group="vc-friend-timezone"
                label="Not set"
                checked={!current}
                action={() => saveTimezone(userId, "")}
            />
            {TIMEZONES.map(option => (
                <Menu.MenuRadioItem
                    key={option.value}
                    id={`vc-friend-timezone-${option.value}`}
                    group="vc-friend-timezone"
                    label={option.label}
                    checked={current === option.value}
                    action={() => saveTimezone(userId, option.value)}
                />
            ))}
        </Menu.MenuItem>
    );
};

function TimeBadge({ userId }: { userId?: string; }) {
    const zone = useZones()[userId ?? ""];
    const now = useNow();
    if (!userId || !zone) return null;

    let time: string;
    try {
        time = formatTime(now, zone);
    } catch {
        return null;
    }

    return (
        <Tooltip text={`Current time · ${zoneLabel(zone)}`}>
            {props => (
                <span {...props} className="vc-friend-time-badge">
                    {time}
                </span>
            )}
        </Tooltip>
    );
}

function CurrentTime({ message }: { message?: TimedMessage; }) {
    return <TimeBadge userId={message?.author?.id} />;
}

function VoiceTime({ userId }: { userId?: string; }) {
    return <TimeBadge userId={userId} />;
}

export default definePlugin({
    name: "FriendTimezones",
    description: "Set a friend's timezone from their profile menu, then see their current time next to their name in chat, DMs, and calls",
    authors: [{ name: "CrusherD2", id: 0n }],
    tags: ["Friends", "Chat"],
    enabledByDefault: true,
    managedStyle,

    patches: [
        {
            find: 'navId:"user-profile-overflow-menu"',
            replacement: {
                match: /\{user:(\i),guildId:\i,viewProfileItem:\i,appContext:\i,popoutTargetRef:\i[\s\S]{0,20000}?navId:"user-profile-overflow-menu"/,
                replace: "$&,contextMenuAPIArguments:[{user:$1}]"
            }
        },
        {
            find: "showTimestampOnHover:",
            all: true,
            replacement: {
                match: /\(0,(\i)\.jsx\)\("span",\{id:(\i),className:(\i),children:(\i)\}\)(?=,\i&&!\i&&\(0,\1\.jsx\)\(\i\.\i,\{id:\(0,\i\.\i\)\((\i)\),timestamp:\i\.timestamp)/,
                replace: '(0,$1.jsx)("span",{id:$2,className:$3,children:[$4,$self.currentTime({message:$5})]})'
            }
        },
        {
            find: "disableGuildProfile:!0",
            all: true,
            replacement: {
                match: /primaryGuild:(\i)\.primaryGuild,userId:\1\.id,contextGuildId:\i.{0,80}?disableGuildProfile:!0.{0,220}?userId:\1\.id\}\)\}\}\)/g,
                replace: "$&,$self.voiceTime({userId:$1.id})"
            }
        },
        {
            find: "VOICE_PANEL",
            all: true,
            replacement: {
                match: /children:\[(\i)\?\?(\i)\.Ay\.getName\((\i)\),/,
                replace: "children:[$1??$2.Ay.getName($3),$self.voiceTime({userId:$3.id}),"
            }
        },
        {
            find: "PrivateChannel.renderAvatar",
            replacement: {
                match: /,(\i)=(\i)\?\(0,(\i)\.jsxs\)\(\3\.Fragment,\{children:\[(\i),\(0,\3\.jsx\)\(\i\.Ay,\{primaryGuild:(\i)\?\.primaryGuild,userId:\5\?\.id,inline:!0,disableGuildProfile:!0,className:\i\(\)\(\i\.\i,\{\[\i\.\i\]:\i\}\)\}\)\]\}\):\4/,
                replace: (match, name, _cond, jsx, _nameNode, user) => {
                    const expr = match.slice(match.indexOf("=") + 1);
                    return `,${name}=(0,${jsx}.jsxs)(${jsx}.Fragment,{children:[${expr},$self.voiceTime({userId:${user}?.id})]})`;
                }
            }
        },
        {
            find: "renderFollowButton:this.renderFollowButton",
            replacement: {
                match: /\(0,\i\.\i\)\(\{channel:(\i),channelName:\i,parentChannel:\i,guild:\i,hasVideo:\i,isAppChannelChatExpanded:\i,handleContextMenu:this\.handleContextMenu,handleParentContextMenu:this\.handleParentContextMenu,handleClick:\i,handleParentClick:\i,renderFollowButton:this\.renderFollowButton\}\)/,
                replace: "$&,$1.isDM()&&!$1.isSystemDM()?$self.voiceTime({userId:$1.getRecipientId()}):null"
            }
        }
    ],

    contextMenus: {
        "user-profile-overflow-menu": timezoneMenu,
        "user-context": timezoneMenu
    },

    currentTime: ErrorBoundary.wrap(CurrentTime, { noop: true }),
    voiceTime: ErrorBoundary.wrap(VoiceTime, { noop: true }),

    async start() {
        try {
            zones = await get<Record<string, string>>(STORAGE_KEY) ?? {};
            emit();
        } catch (error) {
            logger.error("Failed to load timezones", error);
        }
    }
});
