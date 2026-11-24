import crypto from "node:crypto";
import {
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  validateAuthorizationResponseIssuer,
  type OAuthTokens,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
} from "@modelcontextprotocol/client";
import { McpAuthError } from "../errors/index.js";
import { safeFetch } from "../security/safeFetch.js";

export interface GenerateOAuthUrlParams {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes?: string[];
  state?: string;
  codeChallenge?: string;
}

export class McpAuthService {
  /**
   * Generates a cryptographically secure random state and code verifier for PKCE.
   */
  public static generatePkceChallenge(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    return { codeVerifier, codeChallenge };
  }

  /**
   * Generates a secure random OAuth state string.
   */
  public static generateState(): string {
    return crypto.randomBytes(24).toString("base64url");
  }

  /**
   * Discovers OAuth 2.0 Protected Resource metadata according to RFC 9728.
   */
  public async discoverResourceMetadata(resourceServerUrl: string) {
    try {
      return await discoverOAuthProtectedResourceMetadata(
        resourceServerUrl,
        {},
        ((input: RequestInfo | URL, init?: RequestInit) => safeFetch(input, init)) as any
      );
    } catch (err) {
      throw new McpAuthError(
        `Failed to discover OAuth protected resource metadata for ${resourceServerUrl}: ${(err as Error).message}`
      );
    }
  }

  /**
   * Discovers Authorization Server metadata according to RFC 8414.
   * Enforces issuer validation to prevent authorization server mix-up attacks.
   */
  public async discoverAuthServerMetadata(authorizationServerUrl: string) {
    try {
      return await discoverAuthorizationServerMetadata(authorizationServerUrl, {
        fetchFn: ((input: RequestInfo | URL, init?: RequestInit) => safeFetch(input, init)) as any,
        skipIssuerValidation: false, // Strictly validate issuer
      });
    } catch (err) {
      throw new McpAuthError(
        `Failed to discover authorization server metadata for ${authorizationServerUrl}: ${(err as Error).message}`
      );
    }
  }

  /**
   * Prepares an authorization code URL with PKCE and state protection.
   */
  public buildAuthorizationUrl(params: GenerateOAuthUrlParams): {
    authUrl: string;
    state: string;
    codeVerifier: string;
  } {
    const { authorizationEndpoint, clientId, redirectUri, scopes = ["mcp"] } = params;

    const { codeVerifier, codeChallenge } = McpAuthService.generatePkceChallenge();
    const state = params.state || McpAuthService.generateState();

    const url = new URL(authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return {
      authUrl: url.toString(),
      state,
      codeVerifier,
    };
  }

  /**
   * Exchanges an authorization code for OAuth tokens, validating issuer (RFC 9207) and PKCE code verifier.
   */
  public async exchangeCode(params: {
    authorizationServerUrl: string;
    clientInformation: OAuthClientInformationMixed;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    serverMetadata?: AuthorizationServerMetadata;
    responseIssuer?: string;
  }): Promise<OAuthTokens> {
    const {
      authorizationServerUrl,
      clientInformation,
      code,
      codeVerifier,
      redirectUri,
      serverMetadata,
      responseIssuer,
    } = params;

    // Defense against Authorization Server mix-up attacks (RFC 9207)
    if (responseIssuer) {
      if (serverMetadata?.issuer) {
        try {
          validateAuthorizationResponseIssuer({
            iss: responseIssuer,
            expectedIssuer: serverMetadata.issuer,
            issParameterSupported: Boolean(serverMetadata.authorization_response_iss_parameter_supported),
          });
        } catch (err) {
          throw new McpAuthError(`Authorization server issuer mismatch: ${(err as Error).message}`);
        }
      } else {
        // When metadata issuer is not explicitly given, verify origin consistency with authorizationServerUrl
        const authServerOrigin = new URL(authorizationServerUrl).origin;
        const responseIssuerOrigin = new URL(responseIssuer).origin;
        if (authServerOrigin !== responseIssuerOrigin) {
          throw new McpAuthError(
            `Authorization server issuer mismatch: expected origin "${authServerOrigin}", received "${responseIssuerOrigin}"`
          );
        }
      }
    } else if (serverMetadata?.authorization_response_iss_parameter_supported && serverMetadata.issuer) {
      try {
        validateAuthorizationResponseIssuer({
          iss: undefined,
          expectedIssuer: serverMetadata.issuer,
          issParameterSupported: true,
        });
      } catch (err) {
        throw new McpAuthError(`Authorization server issuer mismatch: ${(err as Error).message}`);
      }
    }

    try {
      const tokens = await exchangeAuthorization(authorizationServerUrl, {
        metadata: serverMetadata,
        clientInformation,
        authorizationCode: code,
        iss: responseIssuer,
        codeVerifier,
        redirectUri,
        fetchFn: ((input: RequestInfo | URL, init?: RequestInit) => safeFetch(input, init)) as any,
      });

      return tokens;
    } catch (err) {
      if (err instanceof McpAuthError) {
        throw err;
      }
      throw new McpAuthError(`Failed to exchange OAuth authorization code: ${(err as Error).message}`);
    }
  }

  /**
   * Safely refreshes an expired OAuth access token.
   */
  public async refreshTokens(params: {
    authorizationServerUrl: string;
    clientInformation: OAuthClientInformationMixed;
    refreshToken: string;
    serverMetadata?: AuthorizationServerMetadata;
    scopes?: string[];
  }): Promise<OAuthTokens> {
    const { authorizationServerUrl, clientInformation, refreshToken, serverMetadata, scopes } = params;

    try {
      const tokens = await refreshAuthorization(authorizationServerUrl, {
        metadata: serverMetadata,
        clientInformation,
        refreshToken,
        scope: scopes?.join(" "),
        fetchFn: ((input: RequestInfo | URL, init?: RequestInit) => safeFetch(input, init)) as any,
      });

      return tokens;
    } catch (err) {
      throw new McpAuthError(`Failed to refresh OAuth tokens: ${(err as Error).message}`);
    }
  }
}
