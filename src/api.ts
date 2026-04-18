import {
  PCloudAuthResponse,
  PCloudChecksumResponse,
  PCloudFileLinkResponse,
  PCloudFolderResponse,
  PCloudPublinkResponse,
  PCloudPublinksResponse,
  PCloudResponse,
  PCloudRevisionsResponse,
  PCloudSharesResponse,
  PCloudUserInfo,
  PCloudZipLinkResponse,
} from "./types.js"

export class PCloudAPI {
  private auth?: string
  private accessToken?: string
  private apiServer: string

  constructor(apiServer: string = "https://eapi.pcloud.com") {
    this.apiServer = apiServer
  }

  setAccessToken(accessToken: string, apiServer?: string): void {
    this.accessToken = accessToken
    if (apiServer) {
      this.apiServer = apiServer
    }
  }

  async authenticate(username: string, password: string): Promise<void> {
    const response = await this.request<PCloudAuthResponse>("userinfo", {
      getauth: 1,
      logout: 1,
      username,
      password,
    })

    if (response.result !== 0) {
      throw new Error(
        `Authentication failed: ${response.error || "Unknown error"}`,
      )
    }

    this.auth = response.auth
    if (response.apiserver) {
      this.apiServer = `https://${response.apiserver}`
    }
  }

  async userInfo(): Promise<PCloudUserInfo> {
    return this.request<PCloudUserInfo>("userinfo", this.getAuthParams())
  }

  async listFolder(path: string = "/"): Promise<PCloudFolderResponse> {
    return this.request<PCloudFolderResponse>("listfolder", {
      ...this.getAuthParams(),
      path,
    })
  }

  async stat(path: string): Promise<PCloudResponse> {
    return this.request("stat", {
      ...this.getAuthParams(),
      path,
    })
  }

  async createFolder(path: string): Promise<PCloudFolderResponse> {
    return this.request<PCloudFolderResponse>("createfolderifnotexists", {
      ...this.getAuthParams(),
      path,
    })
  }

  async deleteFolder(folderid: number): Promise<PCloudResponse> {
    return this.request("deletefolderrecursive", {
      ...this.getAuthParams(),
      folderid,
    })
  }

  async copyFile(fileid: number, topath: string): Promise<PCloudResponse> {
    return this.request("copyfile", {
      ...this.getAuthParams(),
      fileid,
      topath,
    })
  }

  async moveFile(fileid: number, topath: string): Promise<PCloudResponse> {
    return this.request("renamefile", {
      ...this.getAuthParams(),
      fileid,
      topath,
    })
  }

  async renameFile(fileid: number, toname: string): Promise<PCloudResponse> {
    return this.request("renamefile", {
      ...this.getAuthParams(),
      fileid,
      toname,
    })
  }

  async deleteFile(fileid: number): Promise<PCloudResponse> {
    return this.request("deletefile", {
      ...this.getAuthParams(),
      fileid,
    })
  }

  async getFileLink(fileid: number): Promise<PCloudFileLinkResponse> {
    return this.request<PCloudFileLinkResponse>("getfilelink", {
      ...this.getAuthParams(),
      fileid,
    })
  }

  async checksumFile(fileid: number): Promise<PCloudChecksumResponse> {
    return this.request<PCloudChecksumResponse>("checksumfile", {
      ...this.getAuthParams(),
      fileid,
    })
  }

  async listRevisions(fileid: number): Promise<PCloudRevisionsResponse> {
    return this.request<PCloudRevisionsResponse>("listrevisions", {
      ...this.getAuthParams(),
      fileid,
    })
  }

  async revertRevision(
    fileid: number,
    revisionid: number,
  ): Promise<PCloudResponse> {
    return this.request("revertrevision", {
      ...this.getAuthParams(),
      fileid,
      revisionid,
    })
  }

  async listShares(): Promise<PCloudSharesResponse> {
    return this.request<PCloudSharesResponse>(
      "listshares",
      this.getAuthParams(),
    )
  }

  async shareFolder(
    folderid: number,
    mail: string,
    permissions: number,
  ): Promise<PCloudResponse> {
    return this.request("sharefolder", {
      ...this.getAuthParams(),
      folderid,
      mail,
      permissions,
    })
  }

  async acceptShare(sharerequestid: number): Promise<PCloudResponse> {
    return this.request("acceptshare", {
      ...this.getAuthParams(),
      sharerequestid,
    })
  }

  async declineShare(sharerequestid: number): Promise<PCloudResponse> {
    return this.request("declineshare", {
      ...this.getAuthParams(),
      sharerequestid,
    })
  }

  async removeShare(sharerequestid: number): Promise<PCloudResponse> {
    return this.request("removeshare", {
      ...this.getAuthParams(),
      sharerequestid,
    })
  }

  async getFilePublink(
    fileid: number,
    expire?: string,
    maxdownloads?: number,
  ): Promise<PCloudPublinkResponse> {
    return this.request<PCloudPublinkResponse>("getfilepublink", {
      ...this.getAuthParams(),
      fileid,
      ...(expire !== undefined && { expire }),
      ...(maxdownloads !== undefined && { maxdownloads }),
    })
  }

  async getFolderPublink(
    folderid: number,
    expire?: string,
  ): Promise<PCloudPublinkResponse> {
    return this.request<PCloudPublinkResponse>("getfolderpublink", {
      ...this.getAuthParams(),
      folderid,
      ...(expire !== undefined && { expire }),
    })
  }

  async listPublinks(): Promise<PCloudPublinksResponse> {
    return this.request<PCloudPublinksResponse>(
      "listpublinks",
      this.getAuthParams(),
    )
  }

  async deletePublink(code: string): Promise<PCloudResponse> {
    return this.request("deletepublink", {
      ...this.getAuthParams(),
      code,
    })
  }

  async getZipLink(
    fileids: number[],
    folderids?: number[],
    filename?: string,
  ): Promise<PCloudZipLinkResponse> {
    return this.request<PCloudZipLinkResponse>("getziplink", {
      ...this.getAuthParams(),
      fileids: fileids.join(","),
      ...(folderids !== undefined && { folderids: folderids.join(",") }),
      ...(filename !== undefined && { filename }),
    })
  }

  async listTrash(): Promise<PCloudResponse> {
    return this.request("trash_list", this.getAuthParams())
  }

  async restoreFromTrash(fileid: number): Promise<PCloudResponse> {
    return this.request("trash_restore", {
      ...this.getAuthParams(),
      fileid,
    })
  }

  async listRewindFiles(path: string): Promise<PCloudResponse> {
    return this.request("listrewindevents", {
      ...this.getAuthParams(),
      path,
    })
  }

  async restoreFromRewind(
    fileid: number,
    topath: string,
  ): Promise<PCloudResponse> {
    return this.request("file_restore", {
      ...this.getAuthParams(),
      fileid,
      topath,
    })
  }

  private getAuthParams(): Record<string, string> {
    if (this.accessToken) {
      return { access_token: this.accessToken }
    }
    if (this.auth) {
      return { auth: this.auth }
    }
    return {}
  }

  async request<T = any>(
    method: string,
    params: Record<string, any> = {},
  ): Promise<T> {
    const url = new URL(`${this.apiServer}/${method}`)

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, String(value))
      }
    }

    const response = await fetch(url.toString())
    const text = await response.text()
    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(
        `pCloud API returned non-JSON (HTTP ${response.status}) for ${method}: ${text.slice(0, 200)}`,
      )
    }
  }
}
