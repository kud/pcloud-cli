import http from 'http';
import { URL } from 'url';
import open from 'open';

export interface OAuthTokens {
  accessToken: string;
  locationId?: number;
  apiServer?: string;
  userId?: number;
}

export class OAuthFlow {
  private port: number;
  private redirectUri: string;

  constructor(port: number = 3000) {
    this.port = port;
    this.redirectUri = `http://localhost:${port}/oauth/callback`;
  }

  async authenticate(): Promise<OAuthTokens> {
    return new Promise((resolve, reject) => {
      let server: http.Server;

      server = http.createServer(async (req, res) => {
        const url = new URL(req.url!, `http://localhost:${this.port}`);

        if (url.pathname === '/oauth/callback') {
          // pCloud returns the token in the URL fragment (after #)
          // We need to extract it via JavaScript in the browser
          const token = url.searchParams.get('access_token');
          const userId = url.searchParams.get('userid');
          const locationId = url.searchParams.get('locationid');
          const hostname = url.searchParams.get('hostname');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`
              <h1>❌ Authentication Failed</h1>
              <p>${error}</p>
              <p>You can close this window.</p>
            `);
            server.close();
            reject(new Error(error));
            return;
          }

          if (!token) {
            // Token is in the fragment, extract it with JavaScript
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head>
                <title>pCloud Authentication</title>
                <style>
                  body { font-family: system-ui; padding: 40px; text-align: center; }
                  .success { color: #059669; }
                  .spinner { margin: 20px auto; width: 40px; height: 40px; border: 4px solid #e5e7eb; border-top-color: #3b82f6; border-radius: 50%; animation: spin 1s linear infinite; }
                  @keyframes spin { to { transform: rotate(360deg); } }
                </style>
              </head>
              <body>
                <div class="spinner"></div>
                <p>Processing authentication...</p>
                <script>
                  // Extract token from URL fragment
                  const hash = window.location.hash.substring(1);
                  const params = new URLSearchParams(hash);
                  const token = params.get('access_token');
                  const userId = params.get('userid');
                  const locationId = params.get('locationid');
                  const hostname = params.get('hostname');
                  const error = params.get('error');
                  
                  if (error) {
                    window.location.href = '/oauth/callback?error=' + encodeURIComponent(error);
                  } else if (token) {
                    // Send token back to server
                    const tokenParams = new URLSearchParams({
                      access_token: token,
                      userid: userId || '',
                      locationid: locationId || '',
                      hostname: hostname || ''
                    });
                    window.location.href = '/oauth/callback?' + tokenParams.toString();
                  } else {
                    window.location.href = '/oauth/callback?error=No+access+token+received';
                  }
                </script>
              </body>
              </html>
            `);
            return;
          }

          // Token received successfully
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>pCloud Authentication Success</title>
              <style>
                body { font-family: system-ui; padding: 40px; text-align: center; }
                .success { color: #059669; font-size: 48px; }
                h1 { margin-top: 20px; }
              </style>
            </head>
            <body>
              <div class="success">✓</div>
              <h1>Authentication Successful!</h1>
              <p>You can close this window and return to the terminal.</p>
            </body>
            </html>
          `);

          setTimeout(() => {
            server.close();
            resolve({
              accessToken: token,
              userId: userId ? parseInt(userId) : undefined,
              locationId: locationId ? parseInt(locationId) : undefined,
              apiServer: hostname ? `https://${hostname}` : undefined,
            });
          }, 1000);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
      });

      server.listen(this.port, () => {
        const authUrl = this.getAuthorizationUrl();
        console.log('\n🔐 Opening browser for authentication...');
        console.log(`If browser doesn't open, visit: ${authUrl}\n`);
        open(authUrl);
      });

      server.on('error', (error) => {
        reject(error);
      });
    });
  }

  private getAuthorizationUrl(): string {
    // Using implicit flow (token) with a generic client_id
    // pCloud returns token directly in URL fragment
    const params = new URLSearchParams({
      client_id: 'kud@pcloud-cli',
      response_type: 'token',
      redirect_uri: this.redirectUri,
    });

    return `https://my.pcloud.com/oauth2/authorize?${params.toString()}`;
  }
}
