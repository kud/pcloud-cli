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

// Shared output primitives. Every command prints through these so that colour
// and glyph are decided in one place — and always together.
//
// Accessibility is the reason they are paired, not decoration: a green tick and
// a red cross are the same shape to anyone who cannot separate the hues, and
// colour is stripped entirely when output is piped or NO_COLOR is set. The
// glyph and the wording therefore carry the meaning on their own, and the
// colour only reinforces it. Nothing here may become colour-only.

const say = (icon: string, color: string, message: string): void =>
  once(
    <Text>
      <Text color={color} bold>
        {`${icon} `}
      </Text>
      <Text>{message}</Text>
    </Text>,
  )

/** A thing that happened. */
export const ok = (message: string): void => say("✓", colors.success, message)

/** A thing that did not happen, or will not. */
export const fail = (message: string): void => say("✗", colors.error, message)

/** A thing that happened but deserves a second look. */
export const warn = (message: string): void => say("!", colors.warning, message)

/** Context. Never a finding. */
export const note = (message: string): void =>
  once(<Text color={colors.muted}>{`  ${message}`}</Text>)

export const heading = (title: string): void =>
  once(
    <Box marginTop={1}>
      <Text bold color={colors.accent}>
        {title}
      </Text>
    </Box>,
  )

/** A value worth copying — a link, a path, an id. Printed bare so it pipes. */
export const value = (text: string): void => once(<Text>{text}</Text>)

export type Field = { label: string; value: string }

// The indent is its own box, outside the measured width. Folding it into the
// width means the longest label fills the column exactly and welds itself to
// the value — "Remote/Appdata", "Credentialsession token". Same trap as `fit`
// in the list components, and this is the third place it has appeared: a
// fixed-width column has to exceed its longest content, never equal it.
export const fields = (rows: Field[]): void => {
  const width = Math.max(...rows.map((row) => row.label.length)) + 2
  once(
    <Box flexDirection="column">
      {rows.map((row) => (
        <Box key={row.label}>
          <Box width={2} flexShrink={0}>
            <Text> </Text>
          </Box>
          <Box width={width} flexShrink={0}>
            <Text color={colors.muted}>{row.label}</Text>
          </Box>
          <Text>{row.value}</Text>
        </Box>
      ))}
    </Box>,
  )
}

/**
 * The shape every destructive command shares: what would happen, then either a
 * dry-run notice or the result. Keeping it in one place is what stops one
 * command growing an --apply flag and another quietly not having one.
 */
export const plan = (title: string, rows: Field[], footer: string[]): void => {
  heading(title)
  fields(rows)
  once(
    <Box flexDirection="column" marginTop={1}>
      {footer.map((line) => (
        <Text key={line} color={colors.muted}>{`  ${line}`}</Text>
      ))}
    </Box>,
  )
}

export type DoctorFault = {
  area: string
  detail: string
  fix?: string
}

export type DoctorLine = {
  glyph: "ok" | "warn" | "bad" | "note"
  label: string
  detail?: string
}

export type DoctorSection = {
  title: string
  lines: DoctorLine[]
  /** Printed dim beneath the lines — context, not a finding. */
  footnote?: string
}

export type DoctorReport = {
  faults: DoctorFault[]
  summary: { label: string; value: string }[]
  sections: DoctorSection[]
}

const GLYPH: Record<DoctorLine["glyph"], { icon: string; color: string }> = {
  ok: { icon: "✓", color: colors.success },
  warn: { icon: "!", color: colors.warning },
  bad: { icon: "✗", color: colors.error },
  note: { icon: "·", color: colors.muted },
}

// Wide enough for "Credential" plus its two-space indent plus a gutter. At 12
// the longest label filled the column exactly and welded itself to the value —
// the same trap `fit` exists for in the list components.
const LABEL_WIDTH = 14

// doctor is a report rather than a list, so it gets its own component instead
// of the generic Table: the verdict, the summary and the evidence want
// different weights, and a table would flatten all three into one.
const Doctor = ({ report }: { report: DoctorReport }) => (
  <Box flexDirection="column">
    <Box marginBottom={1}>
      <Text bold color={colors.accent}>
        pCloud doctor
      </Text>
    </Box>

    {/* The verdict leads. Reading twenty green ticks to find one stuck sync
        pair at the bottom is the wrong way round — what is wrong goes first,
        and everything below it is evidence for that. */}
    {report.faults.length === 0 ? (
      <Text color={colors.success}>{"  ✓ no problems found"}</Text>
    ) : (
      <>
        <Text color={colors.error} bold>
          {`  ✗ ${report.faults.length} problem${report.faults.length === 1 ? "" : "s"} found`}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {report.faults.map((fault) => (
            <Box key={fault.area + fault.detail} flexDirection="column">
              <Box>
                <Box width={LABEL_WIDTH}>
                  <Text color={colors.error} bold>
                    {`  ${fault.area}`}
                  </Text>
                </Box>
                <Text wrap="truncate-end">{fault.detail}</Text>
              </Box>
              {fault.fix && (
                <Box>
                  <Box width={LABEL_WIDTH}>
                    <Text> </Text>
                  </Box>
                  <Text color={colors.info}>{`→ ${fault.fix}`}</Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      </>
    )}

    <Box marginTop={1} flexDirection="column">
      {report.summary.map((row) => (
        <Box key={row.label}>
          <Box width={LABEL_WIDTH}>
            <Text color={colors.muted}>{`  ${row.label}`}</Text>
          </Box>
          <Text>{row.value}</Text>
        </Box>
      ))}
    </Box>

    {report.sections
      .filter((section) => section.lines.length > 0)
      .map((section) => {
        // Width per section rather than one global constant: an endpoint list
        // and a sync-pair list have nothing to say to each other's columns,
        // and sizing to the widest label overall would strand one of them in
        // whitespace. Plus two, so the longest label still gets a gutter.
        const width =
          Math.max(...section.lines.map((line) => line.label.length)) + 2
        return (
          <Box key={section.title} marginTop={1} flexDirection="column">
            <Text bold color={colors.muted}>
              {section.title}
            </Text>
            {section.lines.map((line, i) => (
              <Box key={`${line.label}-${i}`}>
                <Text color={GLYPH[line.glyph].color}>
                  {`  ${GLYPH[line.glyph].icon} `}
                </Text>
                <Box width={width} flexShrink={0}>
                  <Text wrap="truncate-end">{line.label}</Text>
                </Box>
                {line.detail && (
                  <Text color={colors.muted} wrap="truncate-end">
                    {line.detail}
                  </Text>
                )}
              </Box>
            ))}
            {section.footnote && (
              <Text color={colors.muted}>{`  ${section.footnote}`}</Text>
            )}
          </Box>
        )
      })}
  </Box>
)

export const renderDoctor = (report: DoctorReport): void =>
  once(<Doctor report={report} />)

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
