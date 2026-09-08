/**
 * kanbot web UI — vanilla, no framework, no local-state cleverness.
 * The board is the source of truth: any activity event refetches it.
 */

const state = {
  board: { lanes: [], cards: [], members: [] },
  owner: null,
  openCardId: null,
  openCard: null,
};

/* ------------------------------------------------------------------- utils */

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

function toast(message) {
  const node = el("div", "toast", message);
  $("#toasts").append(node);
  setTimeout(() => node.remove(), 5200);
}

function memberById(id) {
  return state.board.members.find((m) => m.id === id) ?? null;
}

function laneById(id) {
  return state.board.lanes.find((l) => l.id === id) ?? null;
}

function memberLabel(id) {
  const m = memberById(id);
  if (!m) return "someone";
  return m.kind === "agent" ? `🤖 ${m.name}` : m.name;
}

function when(ts) {
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isClaimed(card) {
  return card.claimedBy && card.claimExpiresAt && card.claimExpiresAt > Date.now();
}

/* ------------------------------------------------------------------ badges */

function badgesFor(card) {
  const badges = [];

  if (isClaimed(card)) {
    const m = memberById(card.claimedBy);
    const kind = m?.kind === "agent" ? "agent" : "human";
    badges.push({
      cls: `badge ${kind}`,
      text: kind === "agent" ? `🤖 ${m?.name ?? "agent"}` : `${m?.name ?? "someone"} working`,
    });
  }
  if (card.spec) badges.push({ cls: "badge spec", text: "spec" });
  if (card.waitingOn) {
    badges.push({ cls: "badge attn", text: `waiting: ${memberById(card.waitingOn)?.name ?? "?"}` });
  }
  if (card.refs?.branch) badges.push({ cls: "badge ref", text: `⑂ ${card.refs.branch}` });
  if (card.refs?.prUrl) badges.push({ cls: "badge ref", text: "PR", href: card.refs.prUrl });
  return badges;
}

function renderBadges(container, card) {
  for (const b of badgesFor(card)) {
    if (b.href) {
      const a = el("a", b.cls, b.text);
      a.href = b.href;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.addEventListener("click", (e) => e.stopPropagation());
      container.append(a);
    } else {
      container.append(el("span", b.cls, b.text));
    }
  }
}

/* ------------------------------------------------------------------ render */

function render() {
  renderMembers();
  renderAttention();
  renderLanes();
}

function renderMembers() {
  const host = $("#members");
  host.replaceChildren();
  for (const m of state.board.members) {
    host.append(el("span", `chip ${m.kind}`, m.kind === "agent" ? `🤖 ${m.name}` : m.name));
  }
}

/**
 * The owner's attention queue. In this workflow the human is the bottleneck by design,
 * so what needs their attention is the most important thing the board can show.
 */
function renderAttention() {
  const section = $("#attention");
  const list = $("#attention-list");
  const mine = state.owner
    ? state.board.cards.filter((c) => c.waitingOn === state.owner.id)
    : [];

  section.hidden = mine.length === 0;
  $("#attention-count").textContent = String(mine.length);
  list.replaceChildren();

  for (const card of mine) {
    const btn = el("button", "attn-card");
    btn.append(el("div", "t", card.title));
    btn.append(el("div", "n", card.waitingNote ?? "needs your attention"));
    btn.append(el("div", "l", laneById(card.laneId)?.name ?? ""));
    btn.addEventListener("click", () => openCard(card.id));
    list.append(btn);
  }
}

function renderLanes() {
  const host = $("#lanes");
  host.replaceChildren();

  for (const lane of state.board.lanes) {
    const cards = state.board.cards.filter((c) => c.laneId === lane.id);

    const node = el("section", "lane");
    node.dataset.laneId = lane.id;
    if (lane.humanOnlyEntry) node.classList.add("gated");

    const head = el("div", "lane-head");
    head.append(el("span", "lane-name", lane.name));
    if (lane.stage) head.append(el("span", "lane-tag stage", lane.stage));
    if (lane.humanOnlyEntry) head.append(el("span", "lane-tag gate", "gate"));
    head.append(el("span", "lane-count", String(cards.length)));
    node.append(head);

    const list = el("div", "lane-cards");
    if (cards.length === 0) list.append(el("div", "lane-empty", "—"));
    for (const card of cards) list.append(renderCard(card));
    node.append(list);

    // HTML5 drag & drop: the drop is just a move performed as the owner.
    node.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      node.classList.add("drop-target");
    });
    node.addEventListener("dragleave", (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove("drop-target");
    });
    node.addEventListener("drop", async (e) => {
      e.preventDefault();
      node.classList.remove("drop-target");
      const cardId = e.dataTransfer.getData("text/plain");
      if (!cardId) return;
      try {
        await post(`/api/cards/${cardId}/move`, { laneId: lane.id, actorId: state.owner?.id });
        await refreshBoard();
      } catch (err) {
        toast(err.message);
      }
    });

    host.append(node);
  }
}

function renderCard(card) {
  const node = el("article", "card");
  node.draggable = true;
  node.dataset.cardId = card.id;
  if (card.waitingOn) node.classList.add("waiting");
  else if (isClaimed(card) && memberById(card.claimedBy)?.kind === "agent") {
    node.classList.add("claimed-agent");
  }

  node.append(el("div", "card-title", card.title));
  const badges = el("div", "card-badges");
  renderBadges(badges, card);
  if (badges.childElementCount > 0) node.append(badges);

  node.addEventListener("click", () => openCard(card.id));
  node.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", card.id);
    e.dataTransfer.effectAllowed = "move";
    node.classList.add("dragging");
  });
  node.addEventListener("dragend", () => node.classList.remove("dragging"));
  return node;
}

/* ------------------------------------------------------------------- modal */

const EVENT_TEXT = {
  card_created: () => "created this card",
  card_moved: (d) => `moved it ${d.from} → ${d.to}`,
  spec_posted: (d) => `posted a spec (${d.chars} chars)`,
  refs_updated: (d) =>
    `attached ${[d.branch && `branch ${d.branch}`, d.prUrl && `PR ${d.prUrl}`]
      .filter(Boolean)
      .join(", ")}`,
  claimed: () => "claimed the card",
  released: (d) => (d.reason ? `released the card — ${d.reason}` : "released the card"),
  claim_expired: () => "claim expired; the card is free again",
  attention_requested: (d) => `handed it to ${d.toName}: ${d.note}`,
  attention_cleared: () => "attention request cleared",
  member_joined: (d) => `joined the board as ${d.kind}`,
};

function renderEvent(activity) {
  const member = memberById(activity.memberId);
  const kind = member?.kind === "agent" ? "agent" : "human";
  const node = el("div", `ev ${activity.type === "comment" ? "comment" : ""}`);
  node.append(el("span", `ev-who ${kind}`, member ? (kind === "agent" ? `🤖 ${member.name}` : member.name) : "system"));

  const what = el("span", "ev-what");
  if (activity.type === "comment") {
    what.textContent = activity.data.text ?? "";
  } else {
    const fn = EVENT_TEXT[activity.type];
    const em = el("em", null, fn ? fn(activity.data ?? {}) : activity.type);
    what.append(em);
  }
  node.append(what);
  node.append(el("span", "ev-when", when(activity.createdAt)));
  return node;
}

async function openCard(cardId) {
  state.openCardId = cardId;
  await refreshCard();
  $("#modal").hidden = false;
}

function closeCard() {
  state.openCardId = null;
  state.openCard = null;
  $("#modal").hidden = true;
}

async function refreshCard() {
  if (!state.openCardId) return;
  try {
    state.openCard = await api(`/api/cards/${state.openCardId}`);
  } catch (err) {
    toast(err.message);
    closeCard();
    return;
  }
  renderModal();
}

function renderModal() {
  const detail = state.openCard;
  if (!detail) return;
  const { card, activity } = detail;
  const host = $("#modal-body");
  host.replaceChildren();

  host.append(el("div", "m-lane", laneById(card.laneId)?.name ?? ""));
  host.append(el("h2", "m-title", card.title));

  const badges = el("div", "m-badges");
  renderBadges(badges, card);
  if (badges.childElementCount > 0) host.append(badges);

  if (card.waitingOn && card.waitingOn === state.owner?.id) {
    const callout = el("div", "m-callout");
    callout.append(el("div", "k", "Waiting on you"));
    callout.append(el("div", null, card.waitingNote ?? "needs your attention"));
    host.append(callout);
  }

  if (card.body?.trim()) {
    const section = el("div", "m-section");
    section.append(el("div", "m-h", "Body"));
    section.append(el("div", "m-body", card.body));
    host.append(section);
  }

  if (card.spec) {
    const section = el("div", "m-section");
    section.append(el("div", "m-h", "Spec"));
    section.append(el("pre", "m-spec", card.spec));
    host.append(section);
  }

  const feedSection = el("div", "m-section");
  feedSection.append(el("div", "m-h", "Activity"));
  const feed = el("div", "feed");
  for (const a of activity) feed.append(renderEvent(a));
  feedSection.append(feed);

  const composer = el("div", "composer");
  const textarea = el("textarea");
  textarea.placeholder = "Comment… (⌘/Ctrl+Enter to send)";
  const send = el("button", "btn btn-primary", "Comment");
  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    textarea.value = "";
    try {
      await post(`/api/cards/${card.id}/comment`, { text, actorId: state.owner?.id });
      await refreshCard();
    } catch (err) {
      toast(err.message);
    }
  };
  send.addEventListener("click", submit);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  });
  composer.append(textarea, send);
  feedSection.append(composer);
  host.append(feedSection);

  feed.scrollTop = feed.scrollHeight;
}

/* -------------------------------------------------------------------- data */

async function refreshBoard() {
  state.board = await api("/api/board");
  if (!state.owner) {
    state.owner = state.board.members.find((m) => m.kind === "human") ?? null;
  }
  render();
}

async function addIdea() {
  const title = prompt("Idea — one line:");
  if (!title || !title.trim()) return;
  const body = prompt("Any context? (optional)") ?? "";
  try {
    await post("/api/cards", { title: title.trim(), body });
    await refreshBoard();
  } catch (err) {
    toast(err.message);
  }
}

/* --------------------------------------------------------------------- run */

function connect() {
  const source = new EventSource("/api/events");
  const live = $("#live");
  source.addEventListener("open", () => live.classList.add("on"));
  source.addEventListener("error", () => live.classList.remove("on"));
  source.addEventListener("activity", async () => {
    // No local-state cleverness: an event means "something changed", so refetch.
    try {
      await refreshBoard();
      if (state.openCardId) await refreshCard();
    } catch (err) {
      console.error(err);
    }
  });
}

$("#add-idea").addEventListener("click", addIdea);
$("#modal").addEventListener("click", (e) => {
  if (e.target.hasAttribute("data-close")) closeCard();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal").hidden) closeCard();
});

refreshBoard().then(connect).catch((err) => toast(err.message));
