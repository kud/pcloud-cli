import React from "react"
import { render } from "ink"
import { PCloudBrowser } from "@kud/pcloud-ink"

// The browser itself lives in @kud/pcloud-ink so that cockpit can mount the
// same component rather than shelling out to `pcloud browse`. All that remains
// here is the terminal lifecycle, which only a standalone CLI should own.
export const startBrowse = async (): Promise<void> => {
  const { unmount, waitUntilExit } = render(
    <PCloudBrowser onExit={() => unmount()} />,
    { alternateScreen: true },
  )
  await waitUntilExit()
}
