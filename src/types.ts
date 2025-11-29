export interface PCloudConfig {
  username: string;
  password: string;
  apiServer?: string;
}

export interface PCloudAuthResponse {
  result: number;
  auth: string;
  locationid?: number;
  apiserver?: string;
  error?: string;
}

export interface PCloudFile {
  fileid: number;
  name: string;
  path: string;
  isfolder: boolean;
  size?: number;
  modified?: string;
}

export interface PCloudTrashItem extends PCloudFile {
  deletetime: number;
}

export interface PCloudRewindItem {
  fileid: number;
  name: string;
  path: string;
  time: number;
}

export interface PCloudResponse<T = any> {
  result: number;
  error?: string;
  metadata?: T;
  contents?: T[];
}
