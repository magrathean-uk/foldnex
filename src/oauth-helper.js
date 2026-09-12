/**
 * Foldnex - OAuth & Authentication Helper
 * Manages OAuth flows via chrome.identity for AI services and OpenAI-compatible auth.
 */

export class OAuthHelper {
  /**
   * Get Chrome's generated OAuth redirect URI
   * Format: https://<extension-id>.chromiumapp.org/
   */
  static getRedirectUri() {
    return chrome.identity.getRedirectURL();
  }

  /**
   * Launch generic OAuth2 flow with an authorization URL
   * @param {Object} options
   * @param {string} options.authUrl - The provider's authorization URL
   * @param {string} options.clientId - OAuth client ID
   * @param {string} options.scope - Space-separated scopes
   * @returns {Promise<{ code?: string, token?: string, error?: string }>}
   */
  static async launchAuthFlow({ authUrl, clientId, scope }) {
    const redirectUri = this.getRedirectUri();
    const state = Math.random().toString(36).substring(2, 15);

    const url = new URL(authUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'token'); // Implicit grant or code
    url.searchParams.set('scope', scope);
    url.searchParams.set('state', state);

    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        {
          url: url.toString(),
          interactive: true
        },
        (redirectResponse) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (!redirectResponse) {
            return reject(new Error('Authentication was cancelled or failed to redirect.'));
          }

          try {
            // Parse token from hash fragment or query string
            const responseUrl = new URL(redirectResponse);
            const hashParams = new URLSearchParams(responseUrl.hash.substring(1));
            const queryParams = responseUrl.searchParams;

            const token = hashParams.get('access_token') || queryParams.get('access_token');
            const code = queryParams.get('code') || hashParams.get('code');
            const returnedState = hashParams.get('state') || queryParams.get('state');

            if (!returnedState || returnedState !== state) {
              return reject(new Error('OAuth state validation failed: state parameter missing or mismatched.'));
            }

            if (token) {
              resolve({ token });
            } else if (code) {
              resolve({ code });
            } else {
              reject(new Error('No token or authorization code found in response URL'));
            }
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  }

  /**
   * Save verified access token securely to local storage
   */
  static async saveOpenAIToken(token) {
    await chrome.storage.local.set({ openaiOAuthToken: token });
  }

  /**
   * Clear access token
   */
  static async clearOpenAIToken() {
    await chrome.storage.local.remove('openaiOAuthToken');
  }
}
