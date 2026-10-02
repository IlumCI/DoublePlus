import { useCallback, useEffect, useState } from "react";
import { useSignMessage } from "wagmi";

import { useWallet } from "../lib/useWallet";
import type { Venture } from "./client";
import { ago, short } from "./ui";

/**
 * The token's chat: a thread per coin, served by the API worker in api/
 * (Cloudflare Worker over Supabase). Reading is open; posting needs one
 * wallet signature per week (no gas) and is rate-limited by the worker,
 * more loosely for holders and the dev. Hidden entirely when the API isn't
 * configured, so other deployments are unaffected.
 */

const API = String(import.meta.env.VITE_VENTURE_API_URL ?? "").replace(/\/$/, "");
export const COMMENTS_ENABLED = API !== "";

export interface Comment { id: number; author: string; body: string; holder: boolean; is_dev: boolean; created_at: string }

/** Must match api/src/lib.ts authMessage exactly: the worker verifies this text. */
function authMessage(address: string, issuedAt: string): string {
  return [
    "doubleplus.fun comments",
    "",
    `Sign in as ${address.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
    "",
    "This signature only proves you own this wallet. It cannot move funds.",
  ].join("\n");
}

const sessionKey = (a: string) => `dp-session:${a.toLowerCase()}`;
function readSession(a: string): string | null {
  try {
    const raw = localStorage.getItem(sessionKey(a));
    if (!raw) return null;
    const { token, expires } = JSON.parse(raw) as { token: string; expires: number };
    return expires > Date.now() / 1000 + 60 ? token : null;
  } catch { return null; }
}
function writeSession(a: string, token: string, expires: number) {
  try { localStorage.setItem(sessionKey(a), JSON.stringify({ token, expires })); } catch { /* private mode: sign again next time */ }
}
function dropSession(a: string) {
  try { localStorage.removeItem(sessionKey(a)); } catch { /* ignore */ }
}

/** Polled thread for one token. */
export function useComments(token: string) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/comments?token=${token.toLowerCase()}`);
      if (!r.ok) throw new Error(String(r.status));
      setComments(((await r.json()) as { comments: Comment[] }).comments);
      setError(null);
    } catch {
      setError("Chat is unreachable right now.");
    }
  }, [token]);
  useEffect(() => {
    if (!COMMENTS_ENABLED) return;
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 15_000);
    return () => clearInterval(id);
  }, [load]);
  return { comments, error, reload: load, setComments };
}

export function Comments({ v }: { v: Venture }) {
  const { address, isConnected, connectFirst } = useWallet();
  const { signMessageAsync } = useSignMessage();
  const { comments, error, setComments } = useComments(v.address);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!COMMENTS_ENABLED) return null;

  const signIn = async (a: string): Promise<string | null> => {
    const issuedAt = new Date().toISOString();
    const signature = await signMessageAsync({ message: authMessage(a, issuedAt) });
    const r = await fetch(`${API}/auth`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: a, issuedAt, signature }),
    });
    const j = (await r.json()) as { token?: string; expires?: number; error?: string };
    if (!r.ok || !j.token || !j.expires) throw new Error(j.error ?? "sign-in failed");
    writeSession(a, j.token, j.expires);
    return j.token;
  };

  const send = async () => {
    if (!address) { connectFirst(); return; }
    const text = draft.trim();
    if (!text) return;
    setBusy(true); setNote(null);
    try {
      let token = readSession(address) ?? (await signIn(address));
      const post = (t: string) => fetch(`${API}/comments`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ token: v.address, body: text }),
      });
      let r = await post(token!);
      if (r.status === 401) { dropSession(address); token = await signIn(address); r = await post(token!); }
      const j = (await r.json()) as { comment?: Comment; error?: string };
      if (!r.ok || !j.comment) throw new Error(j.error ?? "could not post");
      setComments((c) => [j.comment!, ...(c ?? [])]);
      setDraft("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNote(/rejected|denied/i.test(msg) ? "Signature cancelled." : msg);
    } finally {
      setBusy(false);
    }
  };

  const left = 280 - [...draft].length;
  return (
    <div className="dp-chat">
      <div className="dp-chat-compose">
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={600} rows={3}
          placeholder={isConnected ? `Say something about $${v.symbol}…` : "Connect a wallet to chat"}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} aria-label="Comment" />
        <div className="dp-chat-row">
          <span className={left < 0 ? "dp-chat-over" : "dp-chat-left"}>{left}</span>
          {note && <span className="dp-chat-note">{note}</span>}
          <button className="dp-action" onClick={send} disabled={busy || left < 0 || (isConnected && !draft.trim())}>
            {!isConnected ? "Connect to chat" : busy ? "Posting…" : readSession(address ?? "") ? "Post" : "Sign in & post"}
          </button>
        </div>
        <p className="dp-chat-hint">One signature a week signs you in. No gas, and it can't move funds. Holders and the dev get badges.</p>
      </div>
      {error && !comments && <p className="dp-chat-empty">{error}</p>}
      {comments && comments.length === 0 && <p className="dp-chat-empty">No messages yet. Start the thread.</p>}
      <ol className="dp-chat-list">
        {(comments ?? []).map((c) => (
          <li key={c.id}>
            <div className="dp-chat-meta">
              <b className="dp-mono">{short(c.author as `0x${string}`)}</b>
              {c.is_dev && <span className="dp-badge dp-chat-dev">dev</span>}
              {c.holder && !c.is_dev && <span className="dp-badge dp-chat-holder">holder</span>}
              <span className="dp-chat-ago">{ago(Math.floor(Date.parse(c.created_at) / 1000))} ago</span>
            </div>
            <p>{c.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
