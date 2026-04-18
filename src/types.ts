export interface PCloudConfig {
  username: string
  password: string
  apiServer?: string
}

export interface PCloudAuthResponse {
  result: number
  auth: string
  locationid?: number
  apiserver?: string
  error?: string
}

export interface PCloudFile {
  fileid: number
  name: string
  path: string
  isfolder: boolean
  size?: number
  modified?: string
}

export interface PCloudTrashItem extends PCloudFile {
  deletetime: number
}

export interface PCloudRewindItem {
  fileid: number
  name: string
  path: string
  time: number
}

export interface PCloudResponse<T = any> {
  result: number
  error?: string
  metadata?: T
  contents?: T[]
}

export interface PCloudUserInfo {
  result: number
  email: string
  quota: number
  usedquota: number
  plan: number
  error?: string
}

export interface PCloudFolderItem {
  fileid?: number
  folderid?: number
  name: string
  isfolder: boolean
  size?: number
  modified?: string
  created?: string
  contenttype?: string
}

export interface PCloudFolderMetadata {
  folderid: number
  name: string
  path: string
  contents?: PCloudFolderItem[]
}

export interface PCloudFolderResponse {
  result: number
  error?: string
  metadata?: PCloudFolderMetadata
}

export interface PCloudFileLinkResponse {
  result: number
  error?: string
  hosts: string[]
  path: string
}

export interface PCloudChecksumResponse {
  result: number
  error?: string
  sha256: string
  sha1: string
  md5: string
}

export interface PCloudShareItem {
  sharerequestid?: number
  folderid: number
  foldername?: string
  mail?: string
  permissions?: number
  status?: string
}

export interface PCloudSharesResponse {
  result: number
  error?: string
  shares: PCloudShareItem[]
}

export interface PCloudPublink {
  code: string
  link: string
  fileid?: number
  folderid?: number
  name?: string
  expire?: string
  downloads?: number
  maxdownloads?: number
}

export interface PCloudPublinkResponse {
  result: number
  error?: string
  link: string
  code: string
}

export interface PCloudPublinksResponse {
  result: number
  error?: string
  publinks: PCloudPublink[]
}

export interface PCloudRevision {
  revisionid: number
  size: number
  created?: string
  modified?: string
}

export interface PCloudRevisionsResponse {
  result: number
  error?: string
  revisions: PCloudRevision[]
}

export interface PCloudZipLinkResponse {
  result: number
  error?: string
  hosts: string[]
  path: string
}
