/**
 * Thin HTTP client for the board. The daemon uses exactly the primitives a human
 * uses in the browser — no agent-only side channels.
 */
import type { BoardSnapshot, Card, CardDetail, Lane, Member } from "@kanbot/shared";

export class BoardClient {
  constructor(private readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 200) };
      }
    }
    if (!res.ok) {
      const message =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : `${res.status} ${res.statusText}`;
      throw new Error(`${method} ${path}: ${message}`);
    }
    return data as T;
  }

  join(name: string): Promise<Member> {
    return this.request<Member>("/api/members", "POST", { name, kind: "agent" });
  }

  board(): Promise<BoardSnapshot> {
    return this.request<BoardSnapshot>("/api/board", "GET");
  }

  card(id: string): Promise<CardDetail> {
    return this.request<CardDetail>(`/api/cards/${id}`, "GET");
  }

  claim(cardId: string, actorId: string, ttlSec: number): Promise<{ card: Card; expiresAt: number }> {
    return this.request(`/api/cards/${cardId}/claim`, "POST", { actorId, ttlSec });
  }

  heartbeat(cardId: string, actorId: string, ttlSec = 120): Promise<unknown> {
    return this.request(`/api/cards/${cardId}/heartbeat`, "POST", { actorId, ttlSec });
  }

  release(cardId: string, actorId: string, reason?: string): Promise<Card> {
    return this.request<Card>(`/api/cards/${cardId}/release`, "POST", { actorId, reason });
  }

  comment(cardId: string, text: string, actorId: string): Promise<unknown> {
    return this.request(`/api/cards/${cardId}/comment`, "POST", { text, actorId });
  }

  postSpec(cardId: string, markdown: string, actorId: string): Promise<Card> {
    return this.request<Card>(`/api/cards/${cardId}/spec`, "POST", { markdown, actorId });
  }

  setRefs(
    cardId: string,
    refs: { branch?: string; prUrl?: string },
    actorId: string,
  ): Promise<Card> {
    return this.request<Card>(`/api/cards/${cardId}/refs`, "POST", { ...refs, actorId });
  }

  move(cardId: string, laneId: string, actorId: string): Promise<Card> {
    return this.request<Card>(`/api/cards/${cardId}/move`, "POST", { laneId, actorId });
  }

  attention(cardId: string, note: string, actorId: string): Promise<Card> {
    return this.request<Card>(`/api/cards/${cardId}/attention`, "POST", { note, actorId });
  }
}

export function laneByName(lanes: Lane[], name: string): Lane {
  const lane = lanes.find((l) => l.name === name);
  if (!lane) throw new Error(`board has no lane named "${name}"`);
  return lane;
}
