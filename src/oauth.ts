import http from "http"
import { URL } from "url"
import open from "open"

export interface OAuthTokens {
  accessToken: string
  locationId?: number
  apiServer?: string
  userId?: number
}

export class OAuthFlow {
  private port: number
  private redirectUri: string
  private clientId: string
  private clientSecret: string

  constructor(clientId: string, clientSecret: string, port: number = 3000) {
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.port = port
    this.redirectUri = `http://localhost:${port}/oauth/callback`
  }

  async authenticate(): Promise<OAuthTokens> {
    return new Promise((resolve, reject) => {
      let server: http.Server

      server = http.createServer(async (req, res) => {
        const url = new URL(req.url!, `http://localhost:${this.port}`)

        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404, { "Content-Type": "text/plain" })
          res.end("Not found")
          return
        }

        const code = url.searchParams.get("code")
        const error = url.searchParams.get("error")

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" })
          res.end(
            `<h1>Authentication Failed</h1><p>${error}</p><p>You can close this window.</p>`,
          )
          server.close()
          reject(new Error(error))
          return
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" })
          res.end(`<h1>Authentication Failed</h1><p>No code received.</p>`)
          server.close()
          reject(new Error("No authorization code received"))
          return
        }

        try {
          const tokens = await this.exchangeCode(code)

          res.writeHead(200, { "Content-Type": "text/html" })
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
          `)

          setTimeout(() => {
            server.close()
            resolve(tokens)
          }, 1000)
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html" })
          res.end(
            `<h1>Token Exchange Failed</h1><p>${err instanceof Error ? err.message : "Unknown error"}</p>`,
          )
          server.close()
          reject(err)
        }
      })

      server.listen(this.port, () => {
        const authUrl = this.getAuthorizationUrl()
        console.log("\n🔐 Opening browser for authentication...")
        console.log(`If browser doesn't open, visit: ${authUrl}\n`)
        open(authUrl)
      })

      server.on("error", (error) => {
        reject(error)
      })
    })
  }

  private async exchangeCode(code: string): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
    })

    const response = await fetch(
      `https://api.pcloud.com/oauth2_token?${params.toString()}`,
    )
    const data = (await response.json()) as Record<string, unknown>

    if (data.error || (typeof data.result === "number" && data.result !== 0)) {
      throw new Error(String(data.error || data.result))
    }

    return {
      accessToken: String(data.access_token),
      userId: typeof data.uid === "number" ? data.uid : undefined,
      locationId:
        typeof data.locationid === "number" ? data.locationid : undefined,
      apiServer: data.hostname ? `https://${data.hostname}` : undefined,
    }
  }

  private getAuthorizationUrl(): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
    })

    return `https://my.pcloud.com/oauth2/authorize?${params.toString()}`
  }
}
