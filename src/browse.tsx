import React, { useState, useEffect } from "react"
import { Box, Text, useInput, useWindowSize, render } from "ink"
import { Spinner } from "@inkjs/ui"
import Image, { TerminalInfoProvider } from "ink-picture"
import open from "open"
import { execFileSync } from "child_process"
import fs from "fs"
import {
  PCloudAPI,
  PCloudFolderItem,
  PCloudTrashItem,
  PCloudRewindItem,
} from "@kud/pcloud-sdk"
import { TokenStore } from "@kud/pcloud-auth"

type Phase =
  | "loading"
  | "browsing"
  | "confirming"
  | "executing"
  | "result"
  | "imagePreviewing"
type Mode = "files" | "trash" | "rewind"

const parentPath = (path: string): string => {
  if (path === "/") return "/"
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/"))
  return parent === "" ? "/" : parent
}

const buildAPI = (): PCloudAPI => {
  const tokenStore = new TokenStore()
  const tokens = tokenStore.load()
  if (!tokens) {
    console.error("Not authenticated. Run `pcloud login` first.")
    process.exit(1)
  }
  const apiServer = tokens.hostname
    ? `https://${tokens.hostname}`
    : "https://eapi.pcloud.com"
  const api = new PCloudAPI(apiServer)
  api.setAccessToken(tokens.access_token, apiServer)
  return api
}

const sortItems = (items: PCloudFolderItem[]): PCloudFolderItem[] => [
  ...items
    .filter((i) => i.isfolder)
    .sort((a, b) => a.name.localeCompare(b.name)),
  ...items
    .filter((i) => !i.isfolder)
    .sort((a, b) => a.name.localeCompare(b.name)),
]

const FOLDER_ICON = "\uF07C "
const FILE_ICON = "\uF016 "

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const formatDate = (modified: string | undefined): string => {
  if (!modified) return ""
  return modified.slice(0, 10)
}

const IMAGE_EXTS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
])
const isImageFile = (name: string): boolean =>
  IMAGE_EXTS.has(name.split(".").pop()?.toLowerCase() ?? "")

const breadcrumbSegments = (
  path: string,
): { label: string; last: boolean }[] => {
  if (path === "/") return [{ label: "/", last: true }]
  const parts = path.split("/").filter(Boolean)
  return [
    { label: "/", last: false },
    ...parts.map((part, i) => ({ label: part, last: i === parts.length - 1 })),
  ]
}

const Header = ({
  path,
  mode,
  rewindTarget,
}: {
  path: string
  mode: Mode
  rewindTarget: PCloudFolderItem | null
}) => {
  if (mode === "trash") {
    return (
      <Box backgroundColor="red" paddingX={1} width="100%">
        <Text color="white" bold>
          {" "}
          \uD83D\uDDD1 Trash
        </Text>
      </Box>
    )
  }

  if (mode === "rewind") {
    return (
      <Box backgroundColor="magenta" paddingX={1} width="100%">
        <Text color="white" bold>
          {" "}
          \u23EA Rewind: {rewindTarget?.name ?? ""}
        </Text>
      </Box>
    )
  }

  const segments = breadcrumbSegments(path)
  return (
    <Box paddingX={1} width="100%">
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {i === 0 ? (
            <Text color="cyan" dimColor>
              {seg.label}{" "}
            </Text>
          ) : (
            <>
              {i > 1 && (
                <Text color="white" dimColor>
                  {" "}
                  /{" "}
                </Text>
              )}
              <Text color="white" bold={seg.last} dimColor={!seg.last}>
                {seg.label}
              </Text>
            </>
          )}
        </React.Fragment>
      ))}
    </Box>
  )
}

type KeyHint = { key: string; label: string }

const KeyBadge = ({ hint }: { hint: KeyHint }) => (
  <Box marginRight={2}>
    <Text backgroundColor="blueBright" color="white" bold>
      {` ${hint.key} `}
    </Text>
    <Text color="white" dimColor>
      {` ${hint.label}`}
    </Text>
  </Box>
)

type HintPair = { key: string; label: string }

const HintRow = ({ hints }: { hints: HintPair[] }) => (
  <Box>
    {hints.map((h, i) => (
      <Box key={h.key} marginRight={i < hints.length - 1 ? 2 : 0}>
        <Text color="white" bold>
          {h.key}
        </Text>
        <Text dimColor> {h.label}</Text>
      </Box>
    ))}
  </Box>
)

const FILES_PRIMARY: HintPair[] = [
  { key: "\u2191\u2193", label: "navigate" },
  { key: "\u2192", label: "open folder" },
  { key: "\u2190", label: "go back" },
  { key: "enter", label: "open file" },
]

const FILES_SECONDARY: HintPair[] = [
  { key: "t", label: "trash" },
  { key: "v", label: "rewind" },
  { key: "l", label: "link" },
  { key: "d", label: "delete" },
  { key: "r", label: "reload" },
  { key: "q", label: "quit" },
]

const SECONDARY_PRIMARY: HintPair[] = [
  { key: "\u2191\u2193", label: "navigate" },
  { key: "\u2190", label: "back" },
]

const SECONDARY_SECONDARY: HintPair[] = [
  { key: "r", label: "restore" },
  { key: "q", label: "quit" },
]

const Footer = ({ count, mode }: { count: number; mode: Mode }) => {
  const primary = mode === "files" ? FILES_PRIMARY : SECONDARY_PRIMARY
  const secondary = mode === "files" ? FILES_SECONDARY : SECONDARY_SECONDARY
  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderColor="gray"
      borderTop={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    >
      <Box>
        <HintRow hints={primary} />
        <Box flexGrow={1} />
        <Text color="cyan" dimColor>
          {count} items
        </Text>
      </Box>
      <HintRow hints={secondary} />
    </Box>
  )
}

const ItemRow = ({
  item,
  selected,
}: {
  item: PCloudFolderItem
  selected: boolean
}) => {
  const indicator = selected ? "\u276F" : " "
  const icon = item.isfolder ? FOLDER_ICON : FILE_ICON
  const sizeLabel = item.isfolder ? "-" : formatSize(item.size ?? 0)
  const dateLabel = formatDate(item.modified)

  return (
    <Box>
      <Text color="cyan" bold={selected}>
        {indicator}{" "}
      </Text>
      <Text
        color={item.isfolder ? "yellow" : "white"}
        dimColor={!item.isfolder}
      >
        {icon}
      </Text>
      <Text bold={selected} color="white">
        {item.name}
      </Text>
      <Box flexGrow={1} />
      <Text dimColor color={item.isfolder ? "white" : "cyan"}>
        {sizeLabel}
        {"  "}
      </Text>
      <Text dimColor color="white">
        {dateLabel}
      </Text>
    </Box>
  )
}

const MD_EXTS = new Set(["md", "mdx", "markdown"])
const isMarkdownFile = (name: string): boolean =>
  MD_EXTS.has(name.split(".").pop()?.toLowerCase() ?? "")

const Preview = ({
  item,
  imageUrl,
  markdownLines,
}: {
  item: PCloudFolderItem | undefined
  imageUrl?: string
  markdownLines?: string[]
}) => {
  const { columns = 80, rows = 24 } = useWindowSize()
  const panelWidth = Math.max(10, Math.floor(columns * 0.45) - 4)
  const imageHeight = Math.max(10, rows - 10)

  return (
    <Box
      flexBasis="45%"
      flexDirection="column"
      borderLeft={true}
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      {item === undefined ? (
        <Text dimColor color="gray">
          No selection
        </Text>
      ) : (
        <>
          {imageUrl && (
            <Box height={imageHeight} flexDirection="column">
              <Image
                src={imageUrl}
                width={panelWidth}
                height={imageHeight}
                protocol="halfBlock"
                alt="loading…"
              />
            </Box>
          )}
          {markdownLines && markdownLines.length > 0 && (
            <Box flexDirection="column">
              {markdownLines.map((line, i) => (
                <Text key={i} wrap="truncate-end">
                  {line}
                </Text>
              ))}
            </Box>
          )}
          {!imageUrl && !markdownLines && (
            <Text color="white" bold wrap="wrap">
              {item.name}
            </Text>
          )}
          <Box marginTop={imageUrl || markdownLines ? 1 : 0}>
            {item.isfolder ? (
              <Text color="yellow" bold>
                DIR
              </Text>
            ) : (
              <Text color="cyan" bold>
                FILE
              </Text>
            )}
          </Box>
          {!item.isfolder && item.size !== undefined && (
            <Text dimColor color="white">
              {formatSize(item.size)}
            </Text>
          )}
          <Text dimColor color="white">
            {formatDate(item.modified)}
          </Text>
          <Box>
            <Text dimColor color="gray">
              {"id "}
            </Text>
            <Text dimColor color="gray">
              {item.isfolder
                ? String(item.folderid ?? "")
                : String(item.fileid ?? "")}
            </Text>
          </Box>
          <Text dimColor color="gray">
            ────────────────
          </Text>
          <Text dimColor color="gray">
            {item.isfolder ? "\u2192 enter to open" : "enter to open"}
          </Text>
        </>
      )}
    </Box>
  )
}

const ImagePreview = ({
  imagePath,
  onExit,
}: {
  imagePath: string
  onExit: () => void
}) => {
  useEffect(() => {
    process.stdout.write("\x1b[H")
    try {
      execFileSync("imgcat", [imagePath], { stdio: "inherit" })
    } catch {
      process.stdout.write(
        "  imgcat not available — install with: brew install imgcat\n",
      )
    }
    process.stdout.write("\n  press any key to return\n")
  }, [imagePath])

  useInput(() => onExit())

  return <Box />
}

const Browse = () => {
  const [phase, setPhase] = useState<Phase>("loading")
  const [mode, setMode] = useState<Mode>("files")
  const [path, setPath] = useState("/")
  const [items, setItems] = useState<PCloudFolderItem[]>([])
  const [cursor, setCursor] = useState(0)
  const [confirmAction, setConfirmAction] = useState("")
  const [pendingAction, setPendingAction] = useState<
    (() => Promise<void>) | null
  >(null)
  const [resultMessage, setResultMessage] = useState("")
  const [resultIsError, setResultIsError] = useState(false)
  const [trashItems, setTrashItems] = useState<PCloudTrashItem[]>([])
  const [rewindItems, setRewindItems] = useState<PCloudRewindItem[]>([])
  const [rewindTarget, setRewindTarget] = useState<PCloudFolderItem | null>(
    null,
  )
  const api = React.useMemo(() => buildAPI(), [])
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)
  const [previewImageItem, setPreviewImageItem] = useState<string | null>(null)
  const [previewMarkdownLines, setPreviewMarkdownLines] = useState<
    string[] | null
  >(null)
  const [previewMarkdownItem, setPreviewMarkdownItem] = useState<string | null>(
    null,
  )

  useEffect(() => {
    if (phase !== "browsing") return
    const selected = items[cursor]
    if (!selected || selected.isfolder || !selected.fileid) {
      setPreviewImageUrl(null)
      setPreviewImageItem(null)
      setPreviewMarkdownLines(null)
      setPreviewMarkdownItem(null)
      return
    }

    if (isImageFile(selected.name) && previewImageItem !== selected.name) {
      setPreviewImageUrl(null)
      setPreviewImageItem(null)
      api
        .getFileLink(selected.fileid)
        .then((res) => {
          if (!res.hosts || !res.path) return
          setPreviewImageUrl(`https://${res.hosts[0]}${res.path}`)
          setPreviewImageItem(selected.name)
        })
        .catch(() => {})
      return
    }

    if (
      isMarkdownFile(selected.name) &&
      previewMarkdownItem !== selected.name
    ) {
      setPreviewMarkdownLines(null)
      setPreviewMarkdownItem(null)
      const ext = selected.name.split(".").pop()?.toLowerCase() ?? "md"
      const tmpPath = `/tmp/pcloud-preview.${ext}`
      api
        .getFileLink(selected.fileid)
        .then(async (res) => {
          if (!res.hosts || !res.path) return
          const url = `https://${res.hosts[0]}${res.path}`
          const imgRes = await fetch(url)
          const buf = await imgRes.arrayBuffer()
          fs.writeFileSync(tmpPath, Buffer.from(buf))
          try {
            const out = execFileSync(
              "glow",
              ["--no-pager", "-w", "40", tmpPath],
              {
                stdio: ["ignore", "pipe", "ignore"],
                env: {
                  ...process.env,
                  COLORTERM: "truecolor",
                  TERM: "xterm-256color",
                },
              },
            ).toString()
            setPreviewMarkdownLines(out.split("\n").slice(0, 30))
            setPreviewMarkdownItem(selected.name)
          } catch {
            setPreviewMarkdownLines(["glow not installed"])
            setPreviewMarkdownItem(selected.name)
          }
        })
        .catch(() => {})
      return
    }

    if (!isImageFile(selected.name) && !isMarkdownFile(selected.name)) {
      setPreviewImageUrl(null)
      setPreviewImageItem(null)
      setPreviewMarkdownLines(null)
      setPreviewMarkdownItem(null)
    }
  }, [cursor, items, phase])

  const showResult = (message: string, isError = false) => {
    setResultMessage(message)
    setResultIsError(isError)
    setPhase("result")
  }

  const runAction = async (action: () => Promise<void>) => {
    setPhase("executing")
    try {
      await action()
    } catch (err) {
      showResult(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
        true,
      )
    }
  }

  const loadFiles = (targetPath: string) => {
    setPhase("loading")
    api
      .listFolder(targetPath)
      .then((response) => {
        const contents = response.metadata?.contents ?? []
        setItems(sortItems(contents))
        setCursor(0)
        setPhase("browsing")
      })
      .catch((err) => {
        console.error(`Error: ${err instanceof Error ? err.message : err}`)
        process.exit(1)
      })
  }

  const loadTrash = () => {
    setPhase("loading")
    api
      .listTrash()
      .then((response) => {
        if (response.result === 1000) {
          setItems([])
          setCursor(0)
          showResult(
            "⚠ Trash requires a session token — not supported with OAuth access tokens.",
            true,
          )
          return
        }
        const raw: PCloudTrashItem[] = (response.contents ??
          []) as PCloudTrashItem[]
        setTrashItems(raw)
        const mapped: PCloudFolderItem[] = raw.map((item) => ({
          fileid: item.fileid,
          name: item.name,
          isfolder: false,
          size: item.size,
          modified: new Date(item.deletetime * 1000).toISOString().slice(0, 10),
        }))
        setItems(mapped)
        setCursor(0)
        setPhase("browsing")
      })
      .catch((err) => {
        console.error(`Error: ${err instanceof Error ? err.message : err}`)
        process.exit(1)
      })
  }

  const loadRewind = (target: PCloudFolderItem, currentPath: string) => {
    setPhase("loading")
    const filePath =
      currentPath === "/" ? `/${target.name}` : `${currentPath}/${target.name}`
    api
      .listRewindFiles(filePath)
      .then((response) => {
        const raw: PCloudRewindItem[] = (response.contents ??
          []) as PCloudRewindItem[]
        setRewindItems(raw)
        const mapped: PCloudFolderItem[] = raw.map((item) => ({
          fileid: item.fileid,
          name: new Date(item.time * 1000)
            .toISOString()
            .slice(0, 16)
            .replace("T", " "),
          isfolder: false,
          modified: new Date(item.time * 1000).toISOString().slice(0, 10),
        }))
        setItems(mapped)
        setCursor(0)
        setPhase("browsing")
      })
      .catch((err) => {
        console.error(`Error: ${err instanceof Error ? err.message : err}`)
        process.exit(1)
      })
  }

  useEffect(() => {
    loadFiles(path)
  }, [path])

  const enterSelected = () => {
    const selected = items[cursor]
    if (selected?.isfolder) {
      const next =
        path === "/" ? `/${selected.name}` : `${path}/${selected.name}`
      setPath(next)
    }
  }

  const goUp = () => {
    if (path !== "/") setPath(parentPath(path))
  }

  const returnToFiles = () => {
    setMode("files")
    setTrashItems([])
    setRewindItems([])
    setRewindTarget(null)
    loadFiles(path)
  }

  const triggerConfirm = (label: string, action: () => Promise<void>) => {
    setConfirmAction(label)
    setPendingAction(() => action)
    setPhase("confirming")
  }

  useInput((input, key) => {
    if (phase === "result") {
      setPhase("browsing")
      return
    }

    if (phase === "confirming") {
      if (input === "y" && pendingAction) {
        const action = pendingAction
        setPendingAction(null)
        runAction(action)
      } else if (input === "n") {
        setPendingAction(null)
        setPhase("browsing")
      }
      return
    }

    if (phase !== "browsing") return

    if (input === "q") process.exit(0)
    if (key.downArrow) setCursor((c) => Math.min(items.length - 1, c + 1))
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1))

    if (mode === "files") {
      const selected = items[cursor]
      if (input === "r") loadFiles(path)
      if (key.rightArrow) enterSelected()
      if (key.leftArrow) goUp()
      if (key.return && !selected?.isfolder) {
        const id = selected?.fileid
        if (id !== undefined) {
          runAction(async () => {
            const res = await api.getFileLink(id)
            if (!res.hosts || !res.path)
              throw new Error(res.error ?? "Failed to get link")
            await open(`https://${res.hosts[0]}${res.path}`)
            showResult(`✓ Opened in browser`)
          })
        }
        return
      }
      if (key.return && selected?.isfolder) enterSelected()

      if (input === "t") {
        setMode("trash")
        loadTrash()
        return
      }

      if (!selected) return

      if (input === "v" && !selected.isfolder) {
        setRewindTarget(selected)
        setMode("rewind")
        loadRewind(selected, path)
        return
      }

      if (input === "d") {
        const label = `Delete "${selected.name}"?`
        if (selected.isfolder && selected.folderid !== undefined) {
          const id = selected.folderid
          triggerConfirm(label, async () => {
            const res = await api.deleteFolder(id)
            if (res.result !== 0) throw new Error(res.error ?? "Delete failed")
            showResult(`\u2713 Deleted "${selected.name}"`)
            loadFiles(path)
          })
        } else if (!selected.isfolder && selected.fileid !== undefined) {
          const id = selected.fileid
          triggerConfirm(label, async () => {
            const res = await api.deleteFile(id)
            if (res.result !== 0) throw new Error(res.error ?? "Delete failed")
            showResult(`\u2713 Deleted "${selected.name}"`)
            loadFiles(path)
          })
        }
        return
      }

      if (
        input === "o" &&
        !selected.isfolder &&
        selected.fileid !== undefined
      ) {
        const id = selected.fileid
        runAction(async () => {
          const res = await api.getFileLink(id)
          if (!res.hosts || !res.path)
            throw new Error(res.error ?? "Failed to get link")
          await open(`https://${res.hosts[0]}${res.path}`)
          showResult(`✓ Opened in browser`)
        })
        return
      }

      if (
        input === "l" &&
        !selected.isfolder &&
        selected.fileid !== undefined
      ) {
        const id = selected.fileid
        runAction(async () => {
          const res = await api.getFileLink(id)
          if (!res.hosts || !res.path)
            throw new Error(res.error ?? "Failed to get link")
          showResult(`https://${res.hosts[0]}${res.path}`)
        })
        return
      }

      if (
        input === "p" &&
        !selected.isfolder &&
        selected.fileid !== undefined
      ) {
        const id = selected.fileid
        runAction(async () => {
          const res = await api.getFilePublink(id)
          if (res.result !== 0)
            throw new Error(res.error ?? "Failed to get public link")
          showResult(res.link)
        })
        return
      }
    }

    if (mode === "trash") {
      if (key.leftArrow || key.escape) {
        returnToFiles()
        return
      }

      if (input === "r") {
        const trashItem = trashItems[cursor]
        if (!trashItem) return
        runAction(async () => {
          const res = await api.restoreFromTrash(trashItem.fileid)
          if (res.result === 1000)
            throw new Error(
              "⚠ Trash requires a session token — not supported with OAuth access tokens.",
            )
          if (res.result !== 0) throw new Error(res.error ?? "Restore failed")
          showResult(`\u2713 Restored "${trashItem.name}"`)
          loadTrash()
        })
        return
      }
    }

    if (mode === "rewind") {
      if (key.leftArrow || key.escape) {
        returnToFiles()
        return
      }

      if (input === "r" && rewindTarget) {
        const rewindItem = rewindItems[cursor]
        if (!rewindItem) return
        const target = rewindTarget
        const filePath =
          path === "/" ? `/${target.name}` : `${path}/${target.name}`
        runAction(async () => {
          const res = await api.restoreFromRewind(rewindItem.fileid, filePath)
          if (res.result !== 0) throw new Error(res.error ?? "Restore failed")
          showResult(`\u2713 Restored "${target.name}"`)
        })
        return
      }
    }
  })

  const { rows: terminalRows = 24 } = useWindowSize()
  const visibleCount = Math.max(5, terminalRows - 8)
  const windowStart = Math.min(
    Math.max(0, cursor - Math.floor(visibleCount / 2)),
    Math.max(0, items.length - visibleCount),
  )
  const windowEnd = Math.min(windowStart + visibleCount, items.length)
  const visibleItems = items.slice(windowStart, windowEnd)
  const aboveCount = windowStart
  const belowCount = items.length - windowEnd

  if (phase === "loading" || phase === "executing") {
    return (
      <Spinner
        label={phase === "executing" ? "Executing\u2026" : "Loading\u2026"}
      />
    )
  }

  return (
    <Box flexDirection="column">
      <Header path={path} mode={mode} rewindTarget={rewindTarget} />
      <Box flexDirection="row" flexGrow={1} marginTop={1}>
        <Box flexDirection="column" flexGrow={1}>
          {items.length === 0 ? (
            <Box justifyContent="center">
              <Text dimColor color="white">
                {"  Empty"}
              </Text>
            </Box>
          ) : (
            <>
              {aboveCount > 0 && (
                <Box paddingX={2}>
                  <Text color="yellow" dimColor>
                    \u2191 {aboveCount} more
                  </Text>
                </Box>
              )}
              {visibleItems.map((item, i) => (
                <ItemRow
                  key={`${item.name}-${windowStart + i}`}
                  item={item}
                  selected={windowStart + i === cursor}
                />
              ))}
              {belowCount > 0 && (
                <Box paddingX={2}>
                  <Text color="yellow" dimColor>
                    \u2193 {belowCount} more
                  </Text>
                </Box>
              )}
            </>
          )}
        </Box>
        <Preview
          item={items[cursor]}
          imageUrl={
            previewImageItem === items[cursor]?.name
              ? (previewImageUrl ?? undefined)
              : undefined
          }
          markdownLines={
            previewMarkdownItem === items[cursor]?.name
              ? (previewMarkdownLines ?? undefined)
              : undefined
          }
        />
      </Box>
      {phase === "confirming" && (
        <Box marginTop={1} paddingX={1} flexDirection="column">
          <Box>
            <Text color="yellow" bold>
              {`  \u26A0  ${confirmAction}  `}
            </Text>
          </Box>
          <Box>
            <Box marginRight={2}>
              <Text backgroundColor="green" color="white" bold>{` y `}</Text>
              <Text color="white" dimColor>{` confirm`}</Text>
            </Box>
            <Box>
              <Text backgroundColor="red" color="white" bold>{` n `}</Text>
              <Text color="white" dimColor>{` cancel`}</Text>
            </Box>
          </Box>
        </Box>
      )}
      {phase === "result" && (
        <Box marginTop={1} paddingX={1}>
          <Text color={resultIsError ? "red" : "green"} bold>
            {resultMessage}
          </Text>
          <Text color="white" dimColor>
            {"  (any key to dismiss)"}
          </Text>
        </Box>
      )}
      <Footer count={items.length} mode={mode} />
    </Box>
  )
}

export const startBrowse = async (): Promise<void> => {
  const { waitUntilExit } = render(
    <TerminalInfoProvider>
      <Browse />
    </TerminalInfoProvider>,
    { alternateScreen: true },
  )
  await waitUntilExit()
}
