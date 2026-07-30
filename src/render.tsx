import React from "react"
import { render } from "ink"
import { AccountPanel, ChangesList, FileList, sortItems } from "@kud/pcloud-ink"
import type {
  PCloudDiffEntry,
  PCloudFolderItem,
  PCloudUserInfo,
} from "@kud/pcloud"

// One-shot render for non-interactive commands: mount, let Ink paint a single
// frame, unmount. Without the immediate unmount the process would stay alive
// waiting on input that a piped `pcloud ls | head` will never send.
const once = (node: React.ReactElement): void => {
  const { unmount } = render(node)
  unmount()
}

// Every list is rendered unwindowed — a one-shot command should emit all of its
// rows so the output stays greppable and pipeable, unlike the interactive
// browser where the window is the point.
export const renderFileList = (items: PCloudFolderItem[]): void =>
  once(<FileList items={sortItems(items)} rows={items.length || 1} />)

export const renderChanges = (entries: PCloudDiffEntry[]): void =>
  once(<ChangesList entries={entries} rows={entries.length || 1} />)

export const renderAccount = (user: PCloudUserInfo): void =>
  once(<AccountPanel user={user} />)
