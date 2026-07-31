import React from "react"
import { Box, Text, render } from "ink"
import {
  AccountPanel,
  ChangesList,
  FileList,
  PublinkList,
  RevisionList,
  ShareList,
  TrashList,
  sortItems,
} from "@kud/pcloud-ink"
import { Table, colors, type Column } from "@kud/ink-ui"
import type {
  PCloudDiffEntry,
  PCloudFolderItem,
  PCloudPublink,
  PCloudRevision,
  PCloudShareItem,
  PCloudTrashItem,
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

// Titled section around a domain component. `list-shares` needs two of these —
// outgoing and incoming — where `ls` needs none, which is the only reason this
// wrapper exists rather than the command calling once() itself.
const section = (
  title: string,
  node: React.ReactElement,
): React.ReactElement => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color={colors.info}>
      {title}
    </Text>
    {node}
  </Box>
)

export const renderShares = (
  shares: PCloudShareItem[],
  direction: "outgoing" | "incoming",
  title: string,
): void =>
  once(
    section(
      title,
      <ShareList
        shares={shares}
        direction={direction}
        rows={shares.length || 1}
      />,
    ),
  )

export const renderTrash = (items: PCloudTrashItem[]): void =>
  once(<TrashList items={items} rows={items.length || 1} />)

export const renderPublinks = (links: PCloudPublink[]): void =>
  once(<PublinkList links={links} rows={links.length || 1} />)

export const renderRevisions = (revisions: PCloudRevision[]): void =>
  once(<RevisionList revisions={revisions} rows={revisions.length || 1} />)

// Pending requests keep the generic table: they carry a different id and the
// permissions bitmask rather than the four booleans, so folding them into
// ShareList would mean a component that renders two unrelated shapes.
export const renderTable = <T extends Record<string, unknown>>(
  data: T[],
  columns: Column<T>[],
  title?: string,
): void =>
  once(
    title ? (
      section(title, <Table data={data} columns={columns} />)
    ) : (
      <Table data={data} columns={columns} />
    ),
  )
