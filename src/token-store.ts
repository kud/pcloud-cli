import fs from 'fs';
import path from 'path';
import os from 'os';

export interface StoredTokens {
  accessToken: string;
  apiServer?: string;
  expiresAt?: number;
}

export class TokenStore {
  private tokenPath: string;

  constructor() {
    const configDir = path.join(os.homedir(), '.pcloud-cli');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    this.tokenPath = path.join(configDir, 'tokens.json');
  }

  save(tokens: StoredTokens): void {
    fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2), 'utf-8');
    fs.chmodSync(this.tokenPath, 0o600);
  }

  load(): StoredTokens | null {
    try {
      if (!fs.existsSync(this.tokenPath)) {
        return null;
      }
      const data = fs.readFileSync(this.tokenPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      return null;
    }
  }

  delete(): void {
    if (fs.existsSync(this.tokenPath)) {
      fs.unlinkSync(this.tokenPath);
    }
  }

  exists(): boolean {
    return fs.existsSync(this.tokenPath);
  }
}
