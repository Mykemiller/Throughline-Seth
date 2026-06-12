/**
 * Mint a short-lived Hume EVI access token for the browser. The browser uses
 * this to open the EVI WebSocket directly (mic, STT, prosody, turn-taking,
 * barge-in, TTS) — the long-lived HUME_API_KEY / HUME_SECRET_KEY never leave the
 * server. We also hand back the ZDR + BYO-LLM config id to bind the socket to.
 */
import { fetchAccessToken } from 'hume';
import { requireSecrets } from './env.js';

export async function mintHumeAccessToken(): Promise<{ accessToken: string; configId: string }> {
  const { HUME_API_KEY, HUME_SECRET_KEY, HUME_CONFIG_ID } = requireSecrets();
  const accessToken = await fetchAccessToken({ apiKey: HUME_API_KEY, secretKey: HUME_SECRET_KEY });
  if (!accessToken) throw new Error('Hume returned an empty access token');
  return { accessToken, configId: HUME_CONFIG_ID };
}
