import https from 'https';
import http from 'http';
import { URL, URLSearchParams } from 'url';
import { PCloudAuthResponse, PCloudResponse } from './types';

export class PCloudAPI {
  private auth?: string;
  private accessToken?: string;
  private apiServer: string;

  constructor(apiServer: string = 'https://api.pcloud.com') {
    this.apiServer = apiServer;
  }

  setAccessToken(accessToken: string, apiServer?: string): void {
    this.accessToken = accessToken;
    if (apiServer) {
      this.apiServer = apiServer;
    }
  }

  async authenticate(username: string, password: string): Promise<void> {
    const response = await this.request<PCloudAuthResponse>('userinfo', {
      getauth: 1,
      logout: 1,
      username,
      password,
    });

    if (response.result !== 0) {
      throw new Error(`Authentication failed: ${response.error || 'Unknown error'}`);
    }

    this.auth = response.auth;
    if (response.apiserver) {
      this.apiServer = `https://${response.apiserver}`;
    }
  }

  async listTrash(): Promise<PCloudResponse> {
    return this.request('listtrash', this.getAuthParams());
  }

  async restoreFromTrash(fileid: number): Promise<PCloudResponse> {
    return this.request('trash_clear', {
      ...this.getAuthParams(),
      fileid,
    });
  }

  async listRewindFiles(path: string): Promise<PCloudResponse> {
    return this.request('listrewindevents', {
      ...this.getAuthParams(),
      path,
    });
  }

  async restoreFromRewind(fileid: number, topath: string): Promise<PCloudResponse> {
    return this.request('file_restore', {
      ...this.getAuthParams(),
      fileid,
      topath,
    });
  }

  private getAuthParams(): Record<string, string> {
    if (this.accessToken) {
      return { access_token: this.accessToken };
    }
    if (this.auth) {
      return { auth: this.auth };
    }
    return {};
  }

  async request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    const url = new URL(this.apiServer);
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }

    url.pathname = `/${method}`;
    url.search = searchParams.toString();

    return new Promise((resolve, reject) => {
      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(error);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }
}
